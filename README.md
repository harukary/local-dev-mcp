# local-dev-mcp

Local MCP server for letting ChatGPT operate selected local development projects through MCP tools.

The server is designed around a project registry. Only registered project roots are accessible, and each project can define denied paths such as `.env`, `.ssh`, `secrets`, and `credentials`.

The intended workflow is:

1. A local developer runs this server on their machine.
2. ChatGPT connects to the server through MCP, usually through the HTTP transport and a tunnel.
3. ChatGPT can inspect and operate only the projects listed in the local project registry.

Codex, Claude Code, and similar coding agents are useful for setting up this repository on the user's machine. They are not the primary runtime client this project was built for.

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

4. Edit `config/projects.local.yaml` for the user's machine.

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
       write_policy: allow
       approval_mode: catastrophic_only
       denied_paths:
         - .env
         - .env.*
         - .npmrc
         - .ssh
         - secrets
         - credentials
       redaction_profile: default
   ```

5. Validate the setup:

   ```bash
   pnpm typecheck
   pnpm test
   ```

6. Start the local HTTP server:

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

7. If the user wants ChatGPT to connect from outside the machine, configure a tunnel.

   This repo includes `scripts/tunnel.sh` for Cloudflare Tunnel. It requires these `.env` values:

   ```bash
   LOCAL_DEV_MCP_PUBLIC_ORIGIN=https://your-tunnel.example.com
   LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID=your-tunnel-id
   LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE=/absolute/path/to/credentials.json
   LOCAL_DEV_MCP_PROJECTS_CONFIG=/absolute/path/to/local-dev-mcp/config/projects.local.yaml
   ```

   If those values are not already available, stop and ask the user for the tunnel details or ask whether they want only local HTTP setup for now. Do not invent tunnel IDs, hostnames, or credential paths.

8. Give the user the ChatGPT connection target:

   - Local HTTP endpoint: `http://127.0.0.1:3456/mcp`
   - Public tunnel endpoint: `${LOCAL_DEV_MCP_PUBLIC_ORIGIN}/mcp`

   ChatGPT should use the HTTP MCP endpoint. Stdio is mainly useful for local MCP clients and debugging.

9. Report back with:

   - The absolute path of `config/projects.local.yaml`
   - The selected project IDs
   - Whether `pnpm typecheck` and `pnpm test` passed
   - Whether only local HTTP is ready or the public tunnel is also ready
   - The ChatGPT MCP endpoint to use

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

### Manual Setup

```bash
pnpm install
cp .env.example .env
cp config/projects.yaml config/projects.local.yaml
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

`scripts/tunnel.sh` can start the HTTP server and a Cloudflare Tunnel. Configure these values in `.env` first:

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
