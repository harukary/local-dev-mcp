# local-dev-mcp

日本語版: [README_ja.md](README_ja.md)

Local MCP server for letting ChatGPT operate selected local development projects through MCP tools.

The server is designed around a project registry. Only registered project roots are accessible, and each project can define denied paths such as `.env`, `.ssh`, `secrets`, and `credentials`.

The intended workflow is:

1. A local developer runs this server on their machine.
2. ChatGPT connects to the server through MCP, usually through the HTTP transport and a tunnel.
3. ChatGPT can inspect and operate only the projects listed in the local project registry.

Codex, Claude Code, and similar coding agents are useful for setting up this repository on the user's machine. They are not the primary runtime client this project was built for.

![local-dev-mcp system overview](docs/local-dev-mcp-system-overview-en.png)

## Intended Uses

- Let ChatGPT inspect local code, logs, test output, and project documents without copy-pasting large context into the chat.
- Discuss architecture, implementation plans, bugs, and refactors in ChatGPT using the actual local repository as context.
- Run selected local commands from ChatGPT when the user approves the operation.
- Use ChatGPT alongside Codex or Claude Code: Codex can keep doing direct coding work, while ChatGPT can discuss and inspect local state through this MCP server.
- Save Codex usage for implementation-heavy work by using ChatGPT for local-code-aware discussion, review, and lightweight operations.

## Security Model

This project exposes local development tools to ChatGPT. Treat it as local-machine access infrastructure, not as a public web app.

Recommended deployment:

- Run the MCP server on `127.0.0.1`.
- Prefer OpenAI Secure MCP Tunnel for ChatGPT access. It keeps the MCP server private and uses an outbound-only `tunnel-client` connection to OpenAI.
- Register only the project directories you actually want ChatGPT to access.
- Keep `.env`, `.ssh`, credentials, secrets, build outputs, logs, and local-only config out of git and in `denied_paths` where appropriate.

The server provides defense-in-depth, but it is not a hard OS sandbox. The current sandbox type is `host`, so shell commands run on the local machine with the permissions of the user account running this server. Keep the server bound to localhost and use OpenAI Tunnel / connector access controls.

Safety controls included in this repo:

- Project registry allowlist: ChatGPT must select from configured projects.
- Workspace file tools reject paths outside the selected project root.
- `denied_paths` blocks configured secret paths for workspace tools and forbidden shell classifications.
- Shell risk classification separates read-only, local compute, workspace write, network/dependency, destructive/process-control, and forbidden operations.
- `forbidden` shell commands are blocked, including common secret reads and catastrophic system operations.
- Shell output is redacted for common token, key, and credential patterns before being returned.
- HTTP MCP access uses OAuth bearer tokens. The authorization endpoint is protected by a passphrase.
- The server listens on `127.0.0.1`; ChatGPT access should go through OpenAI Secure MCP Tunnel or another controlled private path.

Important limitations:

- A determined command can still be dangerous if the user approves it. Review shell commands before approving.
- Static risk classification is conservative but not perfect.
- This does not replace OS-level sandboxing, container isolation, filesystem permissions, or network ACLs.
- Do not expose the HTTP endpoint directly to the public internet.

## ChatGPT Approvals

ChatGPT may show frequent confirmation or approval prompts when using MCP tools, especially for local file access, command execution, network/dependency commands, writes, and destructive operations. That is expected and intentional. The prompts are part of ChatGPT's safety model and should be treated as a review point, not as a bug.

For this project, the recommended default is:

- `approval_mode: policy`
- `write_policy: confirm`
- `network_policy: ask`

This means routine reads can stay smooth, while writes and network/dependency operations usually ask for confirmation.

## Features

- Project selection from a YAML registry
- Workspace read, list, search, and patch tools
- Shell command execution with risk classification and approval flow
- Git diff/status helpers
- Browser, mobile simulator, and image read helpers
- OAuth-protected HTTP transport for ChatGPT Apps style clients

## Setup

### Agent Quick Setup For ChatGPT Local Access

If you are Codex, Claude Code, or another coding agent and the user says "set this up for ChatGPT", follow this checklist. The goal is to prepare this local MCP server so ChatGPT can connect to it and operate the user's selected local project roots.

1. Confirm prerequisites:

   ```bash
   node --version
   pnpm --version
   ```

   Use Node.js 22 or newer. If `pnpm` is missing, enable it with Corepack when available:

   ```bash
   corepack enable
   corepack prepare pnpm@latest --activate
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Create local-only config files if they do not already exist:

   ```bash
   test -f .env || cp .env.example .env
   test -f config/projects.local.yaml || cp config/projects.yaml config/projects.local.yaml
   ```

4. Set an OAuth authorization passphrase in `.env`.

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   Put the generated value in:

   ```bash
   LOCAL_DEV_MCP_PASSPHRASE=...
   ```

   Do not print the final `.env` contents back to the user.

5. Edit `config/projects.local.yaml` for the user's machine.

   Replace `/absolute/path/to/your/project` with the absolute path of the project the user wants ChatGPT to operate. If the user did not name a project, ask for the project path before editing. Keep secret-bearing paths in `denied_paths`.

   A minimal single-project entry looks like this:

   ```yaml
   projects:
     my-project:
       display_name: My Project
       host_root: /absolute/path/to/my-project
       sandbox_root: /absolute/path/to/my-project
       sandbox_type: host
       default_shell: /bin/bash
       default_timeout_seconds: 30
       max_timeout_seconds: 300
       network_policy: ask
       write_policy: confirm
       approval_mode: policy
       denied_paths:
         - .env
         - .env.*
         - .npmrc
         - .ssh
         - secrets
         - credentials
       redaction_profile: default
   ```

6. Validate the setup:

   ```bash
   pnpm typecheck
   pnpm test
   ```

7. Start the local HTTP server:

   ```bash
   pnpm dev:http -- config/projects.local.yaml
   ```

   Then verify it responds:

   ```bash
   curl -sS http://127.0.0.1:3456/
   ```

   Expected response:

   ```text
   local-dev-mcp MCP server running.
   ```

8. If the user wants ChatGPT to connect, configure OpenAI Secure MCP Tunnel.

   This is the recommended path for this project. It keeps the MCP server on `127.0.0.1` and lets `tunnel-client` make an outbound HTTPS connection to OpenAI. It requires a tunnel created in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels), plus a runtime API key with Tunnels Read + Use permission.

   ```bash
   LOCAL_DEV_MCP_OPENAI_TUNNEL_ID=tunnel_...
   CONTROL_PLANE_API_KEY=sk-...
   LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET=...
   LOCAL_DEV_MCP_PROJECTS_CONFIG=/absolute/path/to/local-dev-mcp/config/projects.local.yaml
   ```

   Generate `LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET` locally:

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   Then run:

   ```bash
   pnpm tunnel:openai
   ```

   If the OpenAI tunnel ID or runtime API key is not available, stop and ask the user to create them. Do not invent tunnel IDs or API keys, and do not ask the user to paste keys into chat.

9. Give the user the ChatGPT connection target:

   - Local HTTP endpoint for local testing: `http://127.0.0.1:3456/mcp`
   - ChatGPT connector target: choose **Tunnel** in ChatGPT connector settings and select the OpenAI tunnel ID

   Stdio is mainly useful for local MCP clients and debugging.

10. Tell the user to add the app in ChatGPT Developer Mode.

   Codex, Claude Code, and other local coding agents cannot complete this step inside the user's ChatGPT account. Give the user the endpoint from step 9 and ask them to follow [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode) and [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

   User-facing steps:

   1. Open ChatGPT on the web.
   2. Enable Developer Mode. Depending on the workspace plan and permissions, this is under Settings -> Apps -> Advanced settings -> Developer mode, or Workspace settings -> Apps / Permissions & Roles.
   3. Open connector settings and create a custom connector.
   4. Choose **Tunnel** under Connection.
   5. Select the available tunnel, or paste the `LOCAL_DEV_MCP_OPENAI_TUNNEL_ID`.
   6. Scan tools while `pnpm tunnel:openai` is running.
   7. Open a new chat and select the draft connector/app from the tools / plus menu or Developer Mode tool picker.
   8. Test with a read-only prompt first, such as "Use local-dev-mcp to list projects."

   Notes for the user:

   - ChatGPT does not connect directly to `127.0.0.1`. It connects to the OpenAI-hosted tunnel endpoint while `tunnel-client` forwards requests locally.
   - Developer Mode and full MCP write/modify support depend on the user's ChatGPT plan, workspace settings, and admin permissions.
   - ChatGPT may ask for confirmation frequently. Review the tool payload before approving write or command execution.

11. Report back with:

   - The absolute path of `config/projects.local.yaml`
   - The selected project IDs
   - Whether `pnpm typecheck` and `pnpm test` passed
   - Whether only local HTTP is ready or OpenAI Secure MCP Tunnel is also running
   - The OpenAI tunnel ID to select in ChatGPT
   - That the remaining ChatGPT connector/app creation step must be completed by the user

Do not commit or print the contents of `.env`, `.local-dev-mcp`, `logs`, `generated`, `dist`, `node_modules`, or `config/projects.local.yaml`.

For local debugging or non-ChatGPT MCP clients, these connection forms are available:

- Stdio command:

  ```bash
  pnpm dev -- /absolute/path/to/local-dev-mcp/config/projects.local.yaml
  ```

- Local HTTP endpoint after starting the server:

  ```text
  http://127.0.0.1:3456/mcp
  ```

Use the MCP client's native configuration mechanism to register either the stdio command or the HTTP endpoint. Do not hard-code another user's local paths.

## OpenAI Secure MCP Tunnel

OpenAI Secure MCP Tunnel is the recommended ChatGPT connection path for this project. The local MCP server remains private on `127.0.0.1`, and `tunnel-client` keeps an outbound HTTPS connection to OpenAI. Do not create a public HTTPS URL for this server unless you intentionally choose a different deployment model.

User-only OpenAI setup:

1. Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a tunnel and copy its `tunnel_id`.
3. Create a runtime API key with Tunnels Read + Use permission for that tunnel.
4. Keep tunnel management permission limited to yourself or the intended operator group.

Local setup:

1. Download `tunnel-client` from [openai/tunnel-client releases](https://github.com/openai/tunnel-client/releases/latest), or set `TUNNEL_CLIENT_BIN` to an existing binary.
2. Put these values in local `.env`:

   ```bash
   LOCAL_DEV_MCP_OPENAI_TUNNEL_ID=tunnel_...
   CONTROL_PLANE_API_KEY=sk-...
   LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET=...
   LOCAL_DEV_MCP_PROJECTS_CONFIG=/absolute/path/to/local-dev-mcp/config/projects.local.yaml
   ```

3. Start the tunnel:

   ```bash
   pnpm tunnel:openai
   ```

The script starts the local HTTP MCP server if needed, then runs `tunnel-client` with an extra `X-Local-Dev-MCP-Tunnel-Secret` header. The MCP server accepts that header only when it matches `LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET`; otherwise it falls back to normal OAuth bearer-token authentication.

## Add The App In ChatGPT Developer Mode

This part must be done by the user in ChatGPT. A local coding agent can prepare the server and provide the endpoint, but it cannot click through the user's ChatGPT workspace settings or approve the app on their behalf.

Prerequisites:

- ChatGPT web access with Developer Mode available for the account/workspace.
- A running OpenAI Secure MCP Tunnel from `pnpm tunnel:openai`.
- A tunnel that is visible to the ChatGPT workspace/account.

Steps:

1. Open ChatGPT on the web.
2. Enable Developer Mode:
   - User settings path: Settings -> Apps -> Advanced settings -> Developer mode.
   - Workspace/admin path: Workspace settings -> Apps, or Workspace settings -> Permissions & Roles, depending on plan and permissions.
3. Open ChatGPT connector settings and create a custom connector.
4. Choose **Tunnel** under Connection.
5. Select the OpenAI tunnel, or paste the `tunnel_id`.
6. Scan tools while `pnpm tunnel:openai` is running.
7. After the tool scan completes, click Create.
8. Confirm the connector/app appears as a draft / developer app.
9. Start a new chat and select it from the tools / plus menu or Developer Mode tool picker.
10. Test with read-only prompts first:

   ```text
   Use local-dev-mcp to list projects.
   ```

   ```text
   Use local-dev-mcp to select my project, then show the current project.
   ```

Write and command execution prompts can trigger ChatGPT confirmation dialogs. Review the JSON payload before approving. If ChatGPT cannot connect, verify that `tunnel-client` is running, the tunnel is visible to the workspace, the runtime API key has Tunnels Read + Use permission, the shared secret matches, and the local server logs show the request.

Official references:

- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)

### Manual Setup

```bash
pnpm install
cp .env.example .env
cp config/projects.yaml config/projects.local.yaml
```

Set `LOCAL_DEV_MCP_PASSPHRASE` in `.env` before using the OAuth authorization flow:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Edit `config/projects.local.yaml` so every `host_root` and `sandbox_root` points to a local project you want to expose.

Run the HTTP server:

```bash
pnpm dev:http -- config/projects.local.yaml
```

Run with stdio transport:

```bash
pnpm dev -- config/projects.local.yaml
```

## Project Registry

`config/projects.yaml` is a safe example file. Keep local machine paths in `config/projects.local.yaml`, which is ignored by git.

Each project entry supports:

- `display_name`
- `host_root`
- `sandbox_root`
- `sandbox_type`
- `default_shell`
- `default_timeout_seconds`
- `max_timeout_seconds`
- `network_policy`
- `write_policy`
- `approval_mode`
- `denied_paths`
- `redaction_profile`

## Cloudflare Tunnel

`scripts/tunnel.sh` can start the HTTP server and a Cloudflare Tunnel. This is a secondary option kept for users who intentionally want that deployment model. For ChatGPT access, prefer OpenAI Secure MCP Tunnel so the MCP server does not need a public HTTPS origin.

Configure these values in `.env` first:

```bash
LOCAL_DEV_MCP_PUBLIC_ORIGIN=https://your-tunnel.example.com
LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID=your-tunnel-id
LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE=/absolute/path/to/credentials.json
LOCAL_DEV_MCP_PROJECTS_CONFIG=/absolute/path/to/config/projects.local.yaml
```

Then run:

```bash
pnpm tunnel
```

## Safety Notes

- Do not commit `.env`, `.local-dev-mcp`, `logs`, `generated`, or `config/projects.local.yaml`.
- Keep secrets out of registered projects or add their paths to `denied_paths`.
- Review command approvals carefully before allowing write or destructive operations.

## Development

```bash
pnpm typecheck
pnpm test
```
