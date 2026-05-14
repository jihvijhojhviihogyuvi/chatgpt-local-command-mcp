import "dotenv/config";
import { exec, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
const execAsync = promisify(exec);
const port = Number(process.env.PORT ?? 8787);
const sharedSecret = process.env.MCP_SHARED_SECRET;
const requireLocalApproval = process.env.LOCAL_APPROVAL !== "0";
const defaultTimeoutMs = Number(process.env.COMMAND_TIMEOUT_MS ?? 120_000);
const transports = new Map();
const backgroundProcesses = new Map();
let approvalQueue = Promise.resolve();
const maxBackgroundLogEntries = 2000;
const maxBackgroundLogChunkLength = 20_000;
function createMcpServer() {
    const server = new McpServer({
        name: "Local Command Runner",
        version: "0.1.0"
    });
    server.registerTool("system_info", {
        title: "System info",
        description: "Use this when you need basic information about the local machine before running a command.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async () => ({
        structuredContent: {
            platform: process.platform,
            arch: process.arch,
            hostname: os.hostname(),
            user: os.userInfo().username,
            homeDirectory: os.homedir(),
            serverCwd: process.cwd(),
            defaultShell: process.env.ComSpec ?? process.env.SHELL ?? null,
            localApprovalRequired: requireLocalApproval
        },
        content: [
            {
                type: "text",
                text: `Running on ${process.platform}/${process.arch} as ${os.userInfo().username}. Server cwd: ${process.cwd()}`
            }
        ]
    }));
    server.registerTool("run_command", {
        title: "Run local shell command",
        description: "Use this when the user explicitly asks to run a short-lived shell command on their local device. Use start_background for long-running processes. The server has no command allowlist, but it requires local terminal approval by default.",
        inputSchema: {
            command: z.string().min(1).describe("Shell command to execute."),
            cwd: z
                .string()
                .optional()
                .describe("Working directory. Defaults to the MCP server process directory."),
            timeoutMs: z
                .number()
                .int()
                .min(1_000)
                .max(600_000)
                .optional()
                .describe("Command timeout in milliseconds. Defaults to COMMAND_TIMEOUT_MS."),
            dryRun: z
                .boolean()
                .optional()
                .describe("If true, return what would run without executing it.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    }, async ({ command, cwd, timeoutMs, dryRun }) => {
        const workingDirectory = cwd ? path.resolve(cwd) : process.cwd();
        const effectiveTimeoutMs = timeoutMs ?? defaultTimeoutMs;
        if (dryRun) {
            return {
                structuredContent: {
                    command,
                    cwd: workingDirectory,
                    timeoutMs: effectiveTimeoutMs,
                    executed: false
                },
                content: [
                    {
                        type: "text",
                        text: `Dry run only. Would execute in ${workingDirectory}: ${command}`
                    }
                ]
            };
        }
        const approved = await requestApproval({ command, cwd: workingDirectory, timeoutMs: effectiveTimeoutMs });
        if (!approved) {
            return {
                structuredContent: {
                    command,
                    cwd: workingDirectory,
                    approved: false,
                    exitCode: null
                },
                content: [
                    {
                        type: "text",
                        text: "Command was denied by the local terminal approval prompt."
                    }
                ]
            };
        }
        try {
            const result = await execAsync(command, {
                cwd: workingDirectory,
                timeout: effectiveTimeoutMs,
                windowsHide: true,
                maxBuffer: 10 * 1024 * 1024
            });
            return {
                structuredContent: {
                    command,
                    cwd: workingDirectory,
                    approved: true,
                    exitCode: 0,
                    stdout: truncate(result.stdout),
                    stderr: truncate(result.stderr)
                },
                content: [
                    {
                        type: "text",
                        text: formatCommandResult(command, 0, result.stdout, result.stderr)
                    }
                ]
            };
        }
        catch (error) {
            const commandError = error;
            const exitCode = typeof commandError.code === "number" ? commandError.code : null;
            const timedOut = commandError.killed === true || commandError.signal === "SIGTERM";
            return {
                structuredContent: {
                    command,
                    cwd: workingDirectory,
                    approved: true,
                    exitCode,
                    timedOut,
                    stdout: truncate(commandError.stdout ?? ""),
                    stderr: truncate(commandError.stderr ?? commandError.message)
                },
                content: [
                    {
                        type: "text",
                        text: formatCommandResult(command, exitCode, commandError.stdout ?? "", commandError.stderr ?? commandError.message)
                    }
                ]
            };
        }
    });
    server.registerTool("start_background", {
        title: "Start background process",
        description: "Use this when the user explicitly asks to start a long-running local process without blocking the MCP request. Logs are captured in memory and can be fetched with get_background_logs.",
        inputSchema: {
            command: z.string().min(1).describe("Shell command to start in the background."),
            cwd: z
                .string()
                .optional()
                .describe("Working directory. Defaults to the MCP server process directory.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    }, async ({ command, cwd }) => {
        const workingDirectory = cwd ? path.resolve(cwd) : process.cwd();
        const approved = await requestApproval({
            action: "start_background",
            command,
            cwd: workingDirectory,
            timeoutMs: 0
        });
        if (!approved) {
            return {
                structuredContent: {
                    command,
                    cwd: workingDirectory,
                    approved: false,
                    id: null
                },
                content: [
                    {
                        type: "text",
                        text: "Background process start was denied by the local terminal approval prompt."
                    }
                ]
            };
        }
        const id = randomUUID();
        const childProcess = spawn(command, {
            cwd: workingDirectory,
            shell: true,
            windowsHide: true
        });
        const entry = {
            id,
            command,
            cwd: workingDirectory,
            startedAt: Date.now(),
            status: "running",
            logs: [],
            proc: childProcess
        };
        backgroundProcesses.set(id, entry);
        pushBackgroundLog(entry, `[system] started pid=${childProcess.pid ?? "unknown"}\n`);
        childProcess.stdout?.on("data", (chunk) => {
            pushBackgroundLog(entry, chunk.toString());
        });
        childProcess.stderr?.on("data", (chunk) => {
            pushBackgroundLog(entry, `[err] ${chunk.toString()}`);
        });
        childProcess.on("error", (error) => {
            pushBackgroundLog(entry, `[error] ${error.message}\n`);
            entry.status = "exited";
            entry.exitCode = 1;
        });
        childProcess.on("close", (code) => {
            entry.status = "exited";
            entry.exitCode = code ?? 0;
            pushBackgroundLog(entry, `[system] exited code=${entry.exitCode}\n`);
        });
        return {
            structuredContent: {
                id,
                command,
                cwd: workingDirectory,
                startedAt: entry.startedAt,
                status: entry.status,
                pid: childProcess.pid ?? null
            },
            content: [
                {
                    type: "text",
                    text: `Started background process ${id}${childProcess.pid ? ` (pid ${childProcess.pid})` : ""}.`
                }
            ]
        };
    });
    server.registerTool("list_background", {
        title: "List background processes",
        description: "Use this when you need to see background processes started by this MCP server.",
        inputSchema: {},
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async () => {
        const processes = [...backgroundProcesses.values()].map((entry) => ({
            id: entry.id,
            command: entry.command,
            cwd: entry.cwd,
            status: entry.status,
            startedAt: entry.startedAt,
            exitCode: entry.exitCode ?? null,
            pid: entry.proc.pid ?? null,
            logEntries: entry.logs.length
        }));
        return {
            structuredContent: {
                processes
            },
            content: [
                {
                    type: "text",
                    text: processes
                        .map((entry) => `${entry.id}\t${entry.status}\texit=${entry.exitCode ?? "null"}\tpid=${entry.pid ?? "null"}\t${entry.command}`)
                        .join("\n") || "(no background processes)"
                }
            ]
        };
    });
    server.registerTool("get_background_logs", {
        title: "Get background logs",
        description: "Use this when you need stdout/stderr logs from a background process started by this MCP server.",
        inputSchema: {
            id: z.string().min(1).describe("Background process id returned by start_background."),
            tail: z.number().int().min(1).max(maxBackgroundLogEntries).optional().describe("Return only the last N log entries.")
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async ({ id, tail }) => {
        const entry = backgroundProcesses.get(id);
        if (!entry) {
            return textResult("get_background_logs", `No background process found for id ${id}`, {
                id,
                found: false,
                logs: []
            });
        }
        const logs = tail ? entry.logs.slice(-tail) : entry.logs;
        return {
            structuredContent: {
                id,
                found: true,
                status: entry.status,
                exitCode: entry.exitCode ?? null,
                logs
            },
            content: [
                {
                    type: "text",
                    text: logs.join("") || "(no logs yet)"
                }
            ]
        };
    });
    server.registerTool("kill_background", {
        title: "Kill background process",
        description: "Use this when the user explicitly asks to stop a background process started by this MCP server.",
        inputSchema: {
            id: z.string().min(1).describe("Background process id returned by start_background."),
            signal: z
                .enum(["SIGTERM", "SIGKILL", "SIGINT"])
                .optional()
                .describe("Signal to send. Defaults to SIGTERM.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    }, async ({ id, signal }) => {
        const entry = backgroundProcesses.get(id);
        if (!entry) {
            return textResult("kill_background", `No background process found for id ${id}`, {
                id,
                ok: false,
                found: false
            });
        }
        const approved = await requestApproval({
            action: "kill_background",
            command: `kill ${id} (${entry.command}) with ${signal ?? "SIGTERM"}`,
            cwd: entry.cwd,
            timeoutMs: 0
        });
        if (!approved) {
            return textResult("kill_background", `Kill denied by the local terminal approval prompt: ${id}`, {
                id,
                ok: false,
                found: true,
                approved: false
            });
        }
        if (entry.status === "running") {
            await terminateBackgroundProcess(entry, signal ?? "SIGTERM");
            entry.status = "exited";
            entry.exitCode = entry.exitCode ?? 0;
            pushBackgroundLog(entry, `[system] killed signal=${signal ?? "SIGTERM"}\n`);
        }
        backgroundProcesses.delete(id);
        return textResult("kill_background", `Killed and removed background process ${id}`, {
            id,
            ok: true,
            found: true
        });
    });
    server.registerTool("list_directory", {
        title: "List directory",
        description: "Use this when you need to inspect files and folders on the local device.",
        inputSchema: {
            directory: z.string().optional().describe("Directory to list. Defaults to the MCP server working directory."),
            recursive: z.boolean().optional().describe("If true, recursively list child directories."),
            maxEntries: z.number().int().min(1).max(5000).optional().describe("Maximum entries to return.")
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async ({ directory, recursive, maxEntries }) => {
        const targetDirectory = path.resolve(directory ?? process.cwd());
        const entries = await listDirectory(targetDirectory, Boolean(recursive), maxEntries ?? 500);
        return {
            structuredContent: {
                directory: targetDirectory,
                recursive: Boolean(recursive),
                entries
            },
            content: [
                {
                    type: "text",
                    text: entries.map((entry) => `${entry.type}\t${entry.path}`).join("\n") || "(empty)"
                }
            ]
        };
    });
    server.registerTool("read_file", {
        title: "Read file",
        description: "Use this when you need to read a UTF-8 text file from the local device.",
        inputSchema: {
            filePath: z.string().describe("Path to the file to read."),
            maxBytes: z.number().int().min(1).max(1_000_000).optional().describe("Maximum bytes to return.")
        },
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async ({ filePath, maxBytes }) => {
        const targetPath = path.resolve(filePath);
        const handle = await fs.open(targetPath, "r");
        try {
            const limit = maxBytes ?? 200_000;
            const buffer = Buffer.alloc(limit);
            const result = await handle.read(buffer, 0, limit, 0);
            const content = buffer.subarray(0, result.bytesRead).toString("utf8");
            const stat = await handle.stat();
            return {
                structuredContent: {
                    filePath: targetPath,
                    bytesRead: result.bytesRead,
                    sizeBytes: stat.size,
                    truncated: result.bytesRead < stat.size,
                    content
                },
                content: [
                    {
                        type: "text",
                        text: content || "(empty)"
                    }
                ]
            };
        }
        finally {
            await handle.close();
        }
    });
    server.registerTool("write_file", {
        title: "Write file",
        description: "Use this when the user explicitly asks to create or overwrite a UTF-8 text file on the local device.",
        inputSchema: {
            filePath: z.string().describe("Path to create or overwrite."),
            content: z.string().describe("UTF-8 text content to write.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async ({ filePath, content }) => {
        const targetPath = path.resolve(filePath);
        const approved = await requestApproval({
            action: "write_file",
            command: `overwrite ${targetPath} (${Buffer.byteLength(content, "utf8")} bytes)`,
            cwd: path.dirname(targetPath),
            timeoutMs: 0
        });
        if (!approved) {
            return deniedResult("write_file", targetPath);
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, content, "utf8");
        return textResult("write_file", `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${targetPath}`, {
            filePath: targetPath,
            bytesWritten: Buffer.byteLength(content, "utf8")
        });
    });
    server.registerTool("append_file", {
        title: "Append file",
        description: "Use this when the user explicitly asks to append UTF-8 text to a local file.",
        inputSchema: {
            filePath: z.string().describe("Path to append to."),
            content: z.string().describe("UTF-8 text content to append.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    }, async ({ filePath, content }) => {
        const targetPath = path.resolve(filePath);
        const approved = await requestApproval({
            action: "append_file",
            command: `append ${Buffer.byteLength(content, "utf8")} bytes to ${targetPath}`,
            cwd: path.dirname(targetPath),
            timeoutMs: 0
        });
        if (!approved) {
            return deniedResult("append_file", targetPath);
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.appendFile(targetPath, content, "utf8");
        return textResult("append_file", `Appended ${Buffer.byteLength(content, "utf8")} bytes to ${targetPath}`, {
            filePath: targetPath,
            bytesAppended: Buffer.byteLength(content, "utf8")
        });
    });
    server.registerTool("replace_in_file", {
        title: "Replace in file",
        description: "Use this when the user explicitly asks to edit a local UTF-8 text file by replacing exact text.",
        inputSchema: {
            filePath: z.string().describe("Path to edit."),
            search: z.string().min(1).describe("Exact text to replace."),
            replacement: z.string().describe("Replacement text."),
            replaceAll: z.boolean().optional().describe("If true, replace all occurrences. Defaults to one occurrence.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    }, async ({ filePath, search, replacement, replaceAll }) => {
        const targetPath = path.resolve(filePath);
        const original = await fs.readFile(targetPath, "utf8");
        const occurrences = countOccurrences(original, search);
        if (occurrences === 0) {
            return textResult("replace_in_file", `No occurrences found in ${targetPath}`, {
                filePath: targetPath,
                replacements: 0
            });
        }
        const approved = await requestApproval({
            action: "replace_in_file",
            command: `replace ${replaceAll ? occurrences : 1} occurrence(s) in ${targetPath}`,
            cwd: path.dirname(targetPath),
            timeoutMs: 0
        });
        if (!approved) {
            return deniedResult("replace_in_file", targetPath);
        }
        const updated = replaceAll ? original.split(search).join(replacement) : original.replace(search, replacement);
        await fs.writeFile(targetPath, updated, "utf8");
        return textResult("replace_in_file", `Updated ${targetPath}`, {
            filePath: targetPath,
            replacements: replaceAll ? occurrences : 1
        });
    });
    server.registerTool("create_directory", {
        title: "Create directory",
        description: "Use this when the user explicitly asks to create a local directory.",
        inputSchema: {
            directory: z.string().describe("Directory path to create.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    }, async ({ directory }) => {
        const targetDirectory = path.resolve(directory);
        const approved = await requestApproval({
            action: "create_directory",
            command: `create directory ${targetDirectory}`,
            cwd: path.dirname(targetDirectory),
            timeoutMs: 0
        });
        if (!approved) {
            return deniedResult("create_directory", targetDirectory);
        }
        await fs.mkdir(targetDirectory, { recursive: true });
        return textResult("create_directory", `Created directory ${targetDirectory}`, {
            directory: targetDirectory
        });
    });
    server.registerTool("delete_path", {
        title: "Delete path",
        description: "Use this when the user explicitly asks to delete a local file or directory.",
        inputSchema: {
            targetPath: z.string().describe("File or directory path to delete."),
            recursive: z.boolean().optional().describe("Required for non-empty directories.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false
        }
    }, async ({ targetPath, recursive }) => {
        const resolvedPath = path.resolve(targetPath);
        const approved = await requestApproval({
            action: "delete_path",
            command: `delete ${resolvedPath}${recursive ? " recursively" : ""}`,
            cwd: path.dirname(resolvedPath),
            timeoutMs: 0
        });
        if (!approved) {
            return deniedResult("delete_path", resolvedPath);
        }
        await fs.rm(resolvedPath, { recursive: Boolean(recursive), force: false });
        return textResult("delete_path", `Deleted ${resolvedPath}`, {
            targetPath: resolvedPath,
            recursive: Boolean(recursive)
        });
    });
    return server;
}
async function requestApproval(details) {
    if (!requireLocalApproval) {
        return true;
    }
    const approvalTask = async () => {
        if (!process.stdin.isTTY) {
            console.warn("LOCAL_APPROVAL is enabled but stdin is not interactive; denying command.");
            return false;
        }
        console.log("\nChatGPT requested a local command:");
        if (details.action) {
            console.log(`action: ${details.action}`);
        }
        console.log(`cwd: ${details.cwd}`);
        if (details.timeoutMs > 0) {
            console.log(`timeoutMs: ${details.timeoutMs}`);
        }
        console.log(`command: ${details.command}`);
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        try {
            const answer = await rl.question("Run this command? Type 'yes' to approve: ");
            return answer.trim().toLowerCase() === "yes";
        }
        finally {
            rl.close();
        }
    };
    const result = approvalQueue.then(approvalTask, approvalTask);
    approvalQueue = result.then(() => undefined, () => undefined);
    return result;
}
async function listDirectory(root, recursive, maxEntries) {
    const results = [];
    async function visit(directory) {
        if (results.length >= maxEntries) {
            return;
        }
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxEntries) {
                return;
            }
            const fullPath = path.join(directory, entry.name);
            const type = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
            let sizeBytes = null;
            if (type === "file") {
                sizeBytes = (await fs.stat(fullPath)).size;
            }
            results.push({ path: fullPath, type, sizeBytes });
            if (recursive && entry.isDirectory()) {
                await visit(fullPath);
            }
        }
    }
    await visit(root);
    return results;
}
function countOccurrences(value, search) {
    return value.split(search).length - 1;
}
function textResult(operation, text, structuredContent) {
    return {
        structuredContent: {
            operation,
            ...structuredContent
        },
        content: [
            {
                type: "text",
                text
            }
        ]
    };
}
function deniedResult(operation, targetPath) {
    return textResult(operation, `Operation denied by the local terminal approval prompt: ${targetPath}`, {
        targetPath,
        approved: false
    });
}
function pushBackgroundLog(entry, chunk) {
    const safeChunk = truncate(chunk, maxBackgroundLogChunkLength);
    entry.logs.push(safeChunk);
    if (entry.logs.length > maxBackgroundLogEntries) {
        entry.logs.splice(0, entry.logs.length - maxBackgroundLogEntries);
    }
}
async function terminateBackgroundProcess(entry, signal) {
    if (!entry.proc.pid) {
        return;
    }
    if (process.platform === "win32") {
        try {
            await execAsync(`taskkill /pid ${entry.proc.pid} /t /f`, {
                windowsHide: true,
                timeout: 10_000
            });
            return;
        }
        catch (error) {
            pushBackgroundLog(entry, `[warn] taskkill failed: ${error.message}\n`);
        }
    }
    entry.proc.kill(signal);
}
function truncate(value, maxLength = 20_000) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} characters]`;
}
function formatCommandResult(command, exitCode, stdout, stderr) {
    const output = [
        `Command: ${command}`,
        `Exit code: ${exitCode ?? "unknown"}`,
        "",
        "STDOUT:",
        truncate(stdout || "(empty)"),
        "",
        "STDERR:",
        truncate(stderr || "(empty)")
    ];
    return output.join("\n");
}
function isAuthorized(req) {
    if (!sharedSecret) {
        return false;
    }
    const authHeader = req.header("authorization");
    const bearerToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
    const headerToken = req.header("x-mcp-secret");
    const queryToken = typeof req.query.token === "string" ? req.query.token : undefined;
    return [bearerToken, headerToken, queryToken].some((token) => token === sharedSecret);
}
function addCommonHeaders(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, x-mcp-secret");
    res.header("Access-Control-Expose-Headers", "Mcp-Session-Id, mcp-session-id");
    if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
    }
    next();
}
function requireAuth(req, res, next) {
    if (isAuthorized(req)) {
        next();
        return;
    }
    res.status(401).json({
        error: "Unauthorized",
        message: "Set MCP_SHARED_SECRET on the server and connect with Authorization: Bearer <secret>, x-mcp-secret, or /mcp?token=<secret>."
    });
}
async function main() {
    const app = express();
    app.use(addCommonHeaders);
    app.use(express.json({ limit: "1mb", type: "*/*" }));
    app.get("/", (_req, res) => {
        res.type("text/plain").send("Local Command Runner MCP server. Connect ChatGPT to /mcp with your secret token.");
    });
    app.get("/health", (_req, res) => {
        res.json({
            ok: true,
            mcpPath: "/mcp",
            authConfigured: Boolean(sharedSecret),
            localApprovalRequired: requireLocalApproval,
            backgroundProcessCount: backgroundProcesses.size,
            runningBackgroundProcessCount: [...backgroundProcesses.values()].filter((entry) => entry.status === "running").length
        });
    });
    app.post("/mcp", requireAuth, async (req, res) => {
        try {
            const sessionId = req.header("mcp-session-id");
            let record = sessionId ? transports.get(sessionId) : undefined;
            if (!record && isInitializeRequest(req.body)) {
                const server = createMcpServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (newSessionId) => {
                        transports.set(newSessionId, { server, transport });
                    }
                });
                transport.onclose = () => {
                    if (transport.sessionId) {
                        transports.delete(transport.sessionId);
                    }
                };
                await server.connect(transport);
                record = { server, transport };
            }
            if (!record) {
                res.status(400).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32000,
                        message: "Bad Request: missing or invalid MCP session ID"
                    },
                    id: null
                });
                return;
            }
            await record.transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            console.error("MCP POST error", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: {
                        code: -32603,
                        message: "Internal server error"
                    },
                    id: null
                });
            }
        }
    });
    app.get("/mcp", requireAuth, async (req, res) => {
        const sessionId = req.header("mcp-session-id");
        const record = sessionId ? transports.get(sessionId) : undefined;
        if (!record) {
            res.status(400).send("Missing or invalid MCP session ID");
            return;
        }
        await record.transport.handleRequest(req, res);
    });
    app.delete("/mcp", requireAuth, async (req, res) => {
        const sessionId = req.header("mcp-session-id");
        const record = sessionId ? transports.get(sessionId) : undefined;
        if (!record) {
            res.status(400).send("Missing or invalid MCP session ID");
            return;
        }
        await record.transport.handleRequest(req, res);
    });
    if (!sharedSecret) {
        console.warn("MCP_SHARED_SECRET is not set. /mcp will reject all requests until you set one.");
    }
    app.listen(port, () => {
        console.log(`Local Command Runner MCP server listening on http://localhost:${port}`);
        console.log(`MCP endpoint: http://localhost:${port}/mcp`);
        console.log(`Local approval required: ${requireLocalApproval ? "yes" : "no"}`);
    });
}
main().catch((error) => {
    console.error(error);
    process.exit(1);
});
