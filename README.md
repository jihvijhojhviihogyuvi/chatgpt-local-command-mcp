# ChatGPT Local Command MCP

Tool-only ChatGPT app/MCP server for running local shell commands, background processes, and filesystem operations from ChatGPT.

This server exposes `/mcp` over HTTP. It intentionally has no command allowlist or path allowlist, but it is not unattended by default:

- `/mcp` requires a shared secret.
- Every command, background process start/kill, and mutating filesystem operation requires local terminal approval unless you set `LOCAL_APPROVAL=0`.
- Commands run with the server user's permissions.

## Tool Surface

- `system_info`: read-only local machine and server context.
- `run_command`: executes a short-lived shell command with optional `cwd`, `timeoutMs`, and `dryRun`.
- `start_background`: starts a long-running shell command without blocking the MCP request.
- `list_background`: lists background processes tracked in memory.
- `get_background_logs`: fetches captured stdout/stderr logs for a background process.
- `kill_background`: stops and removes a tracked background process.
- `list_directory`: lists local files and folders.
- `read_file`: reads a UTF-8 text file.
- `write_file`: creates or overwrites a UTF-8 text file.
- `append_file`: appends UTF-8 text to a file.
- `replace_in_file`: edits a UTF-8 text file by exact text replacement.
- `create_directory`: creates a local directory.
- `delete_path`: deletes a local file or directory.

## Setup

```powershell
cd chatgpt-local-command-mcp
copy .env.example .env
```

Edit `.env` and set a long random `MCP_SHARED_SECRET`.

Generate one with PowerShell:

```powershell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Install and run:

```powershell
npm install
npm run dev
```

Local endpoint:

```text
http://localhost:8787/mcp?token=<MCP_SHARED_SECRET>
```

## Public HTTPS Tunnel

ChatGPT needs a public HTTPS URL for a remote MCP server. Use one tunnel at a time.

### ngrok

```powershell
ngrok http 8787
```

Connect ChatGPT to:

```text
https://<your-ngrok-host>/mcp?token=<MCP_SHARED_SECRET>
```

### serveo

```powershell
ssh -R 80:localhost:8787 serveo.net
```

Connect ChatGPT to:

```text
https://<your-serveo-host>/mcp?token=<MCP_SHARED_SECRET>
```

## ChatGPT Developer Mode

1. Start this server locally.
2. Start ngrok, serveo, or another HTTPS tunnel to port `8787`.
3. In ChatGPT, enable Developer Mode under **Settings → Apps & Connectors → Advanced settings**.
4. Create/connect a remote MCP app using the tunneled `/mcp?token=...` URL.
5. Ask ChatGPT to call `system_info`, then try `run_command` with `dryRun: true`.
6. For real execution, watch this terminal and type `yes` when the local approval prompt appears.

If you change tool descriptions or metadata, reconnect or refresh the app in ChatGPT so it reloads descriptors.

## Disabling Local Approval

Set this only if you accept unattended remote command execution risk:

```env
LOCAL_APPROVAL=0
```

With a public tunnel, anyone who gets the URL and token can run commands, start background processes, and edit files as your user. Rotate `MCP_SHARED_SECRET` after each tunnel session.

## Docs Used

- https://developers.openai.com/apps-sdk/quickstart
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://developers.openai.com/apps-sdk/deploy
