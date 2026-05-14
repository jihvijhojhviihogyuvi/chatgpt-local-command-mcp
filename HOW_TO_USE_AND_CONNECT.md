# How To Use And Connect

This app lets ChatGPT connect to a local MCP server at `/mcp` and request shell commands, background processes, and filesystem operations on your computer.

The default setup requires:

- A secret token on the MCP URL.
- A local terminal approval prompt before each command runs.

## 1. Install Dependencies

```powershell
cd C:\Users\james\OneDrive\Documents\Playground\chatgpt-local-command-mcp
npm install
```

## 2. Configure The Secret

Create `.env` from the example:

```powershell
copy .env.example .env
```

Generate a secret:

```powershell
[Convert]::ToHexString((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

Put it in `.env`:

```env
PORT=8787
MCP_SHARED_SECRET=<paste-secret-here>
LOCAL_APPROVAL=1
COMMAND_TIMEOUT_MS=120000
```

## 3. Start The MCP Server

```powershell
npm run dev
```

You should see:

```text
Local Command Runner MCP server listening on http://localhost:8787
MCP endpoint: http://localhost:8787/mcp
Local approval required: yes
```

## 4. Expose It With HTTPS

ChatGPT needs a public HTTPS URL for remote MCP.

### Option A: ngrok

```powershell
ngrok http 8787
```

Use the HTTPS forwarding URL ngrok prints.

Final ChatGPT MCP URL:

```text
https://<ngrok-host>/mcp?token=<MCP_SHARED_SECRET>
```

### Option B: serveo

```powershell
ssh -R 80:localhost:8787 serveo.net
```

Use the HTTPS forwarding URL serveo prints.

Final ChatGPT MCP URL:

```text
https://<serveo-host>/mcp?token=<MCP_SHARED_SECRET>
```

## 5. Connect From ChatGPT

1. Open ChatGPT.
2. Go to **Settings → Apps & Connectors → Advanced settings**.
3. Enable **Developer Mode**.
4. Add/create a remote MCP app.
5. Paste the tunneled MCP URL:

```text
https://<public-host>/mcp?token=<MCP_SHARED_SECRET>
```

6. Save/connect the app.
7. If you change server code or tool descriptions, reconnect or refresh the app.

## 6. Test It

Ask ChatGPT:

```text
Use the Local Command Runner app to show system_info.
```

Then test a dry run:

```text
Use the Local Command Runner app to dry run this command: whoami
```

Then test a real command:

```text
Use the Local Command Runner app to run: whoami
```

When a real command is requested, watch the terminal running `npm run dev`. Type:

```text
yes
```

The command will not run unless you type exactly `yes`.

Test file tools:

```text
Use the Local Command Runner app to list C:\Users\james\OneDrive\Documents\Playground.
```

```text
Use the Local Command Runner app to write a file at C:\tmp\chatgpt-mcp-test.txt with the content "hello from ChatGPT".
```

Test background process tools:

```text
Use the Local Command Runner app to start this in the background: ping 127.0.0.1 -t
```

Then ask:

```text
List background processes, fetch the logs for the process id, then kill it.
```

## 7. Running Without Local Approval

If you want ChatGPT to execute commands, manage background processes, and mutate files without a terminal prompt, set:

```env
LOCAL_APPROVAL=0
```

Restart the server after changing `.env`.

This is risky with any public tunnel. Anyone with the URL and token can execute commands, start persistent processes, and edit/delete files as your Windows user. Rotate `MCP_SHARED_SECRET` after every tunnel session.

## 8. Available Tools

- `system_info`: returns platform, username, hostname, home directory, server working directory, and shell.
- `run_command`: runs short-lived shell commands with optional `cwd`, `timeoutMs`, and `dryRun`.
- `start_background`: starts long-running commands with `spawn(command, { shell: true })`, returns an `id` immediately, and captures stdout/stderr.
- `list_background`: returns all tracked background process IDs, commands, status, start time, exit code, PID, and log count.
- `get_background_logs`: returns logs for a background process by `id`, with optional `tail`.
- `kill_background`: kills a background process by `id` and removes it from the in-memory registry.
- `list_directory`: lists files and folders, optionally recursive.
- `read_file`: reads a UTF-8 text file.
- `write_file`: creates or overwrites a UTF-8 text file.
- `append_file`: appends UTF-8 text to a file.
- `replace_in_file`: edits a UTF-8 text file by exact text replacement.
- `create_directory`: creates a directory.
- `delete_path`: deletes a file or directory.

Example `run_command` inputs:

```json
{
  "command": "dir",
  "cwd": "C:\\Users\\james\\OneDrive\\Documents\\Playground",
  "timeoutMs": 120000,
  "dryRun": false
}
```

Example `write_file` inputs:

```json
{
  "filePath": "C:\\tmp\\chatgpt-mcp-test.txt",
  "content": "hello from ChatGPT\n"
}
```

Example background flow:

```json
{
  "command": "ping 127.0.0.1 -t",
  "cwd": "C:\\Users\\james\\OneDrive\\Documents\\Playground"
}
```

Use the returned `id` with:

```json
{
  "id": "<background-process-id>",
  "tail": 50
}
```

## 9. Stop The Server

Press `Ctrl+C` in the terminal running:

```powershell
npm run dev
```

Stop ngrok or serveo too. The MCP URL stops working once the tunnel is closed.
