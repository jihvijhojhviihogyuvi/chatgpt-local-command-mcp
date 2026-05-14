import "dotenv/config";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const port = Number(process.env.PORT ?? 8787);

// ---------------- BACKGROUND PROCESS STATE ----------------

type BgProc = {
  id: string;
  command: string;
  cwd: string;
  started: number;
  status: "running" | "exited";
  exitCode?: number;
  logs: string[];
  proc: ReturnType<typeof spawn>;
};

const backgroundProcesses = new Map<string, BgProc>();

function startBackground(command: string, cwd: string) {
  const id = randomUUID();

  const proc = spawn(command, {
    shell: true,
    cwd,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const entry: BgProc = {
    id,
    command,
    cwd,
    started: Date.now(),
    status: "running",
    logs: [],
    proc
  };

  proc.stdout.on("data", d => entry.logs.push(d.toString()));
  proc.stderr.on("data", d => entry.logs.push(`[err] ${d.toString()}`));

  proc.on("close", code => {
    entry.status = "exited";
    entry.exitCode = code ?? undefined;
  });

  backgroundProcesses.set(id, entry);
  return id;
}

// ---------------- MCP SERVER (SINGLETON) ----------------

function createServer() {
  const server = new McpServer({
    name: "Local Command Runner (Fixed Background)",
    version: "0.3.0"
  });

  server.registerTool("system_info", {
    title: "System info",
    description: "Get system info",
    inputSchema: {}
  }, async () => ({
    content: [{ type: "text", text: `os=${os.platform()} arch=${os.arch()}` }]
  }));

  server.registerTool("run_command", {
    title: "Run command",
    description: "Run shell command",
    inputSchema: {
      command: z.string(),
      cwd: z.string().optional()
    }
  }, async ({ command, cwd }) => {
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const proc = spawn(command, { shell: true, cwd: cwd ?? process.cwd() });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", d => stdout += d.toString());
      proc.stderr.on("data", d => stderr += d.toString());

      proc.on("close", () => resolve({ stdout, stderr }));
      proc.on("error", reject);
    });

    return {
      content: [{ type: "text", text: result.stdout || result.stderr || "" }]
    };
  });

  server.registerTool("start_background", {
    title: "Start background",
    description: "Start long running process",
    inputSchema: {
      command: z.string(),
      cwd: z.string().optional()
    }
  }, async ({ command, cwd }) => {
    const id = startBackground(command, cwd ?? process.cwd());
    return { content: [{ type: "text", text: id }] };
  });

  server.registerTool("list_background", {
    title: "List background",
    description: "List background processes",
    inputSchema: {}
  }, async () => ({
    content: [{ type: "text", text: JSON.stringify([...backgroundProcesses.values()], null, 2) }]
  }));

  server.registerTool("get_background_logs", {
    title: "Get logs",
    inputSchema: { id: z.string() }
  }, async ({ id }) => {
    const p = backgroundProcesses.get(id);
    if (!p) return { content: [{ type: "text", text: "not found" }] };
    return { content: [{ type: "text", text: p.logs.join("\n") }] };
  });

  server.registerTool("kill_background", {
    title: "Kill",
    inputSchema: { id: z.string() }
  }, async ({ id }) => {
    const p = backgroundProcesses.get(id);
    if (!p) return { content: [{ type: "text", text: "not found" }] };

    try { p.proc.kill(); } catch {}
    backgroundProcesses.delete(id);

    return { content: [{ type: "text", text: "killed" }] };
  });

  return server;
}

const mcpServer = createServer();

// ---------------- EXPRESS ----------------

const app = express();
app.use(express.json());

app.get("/health", (_, res) => {
  res.json({ ok: true, port });
});

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP error:", err);
    res.status(500).json({ error: "mcp_failed" });
  }
});

app.listen(port, () => {
  console.log(`MCP Background server running on http://localhost:${port}`);
});
