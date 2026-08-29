# local-dev-mcp

日本語版: [README_ja.md](README_ja.md)

Local MCP server for letting ChatGPT operate selected local development projects through MCP tools.

The server is designed around a project registry. Only registered project roots are accessible, and each project can define denied paths such as `.env`, `.ssh`, `secrets`, and `credentials`.

The intended workflow is:

1. A local developer runs this server on their machine.
2. ChatGPT connects to the server through MCP, usually through the HTTP transport and a controlled HTTPS tunnel.
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
- Expose it only through a tightly controlled HTTPS tunnel when ChatGPT needs remote access.
- Register only the project directories you actually want ChatGPT to access.
- Keep `.env`, `.ssh`, credentials, secrets, build outputs, logs, and local-only config out of git and in `denied_paths` where appropriate.

The server provides defense-in-depth, but it is not a hard OS sandbox. The current sandbox type is `host`, so shell commands run on the local machine with the permissions of the user account running this server. Keep the server bound to localhost and use tunnel-side access controls.

Safety controls included in this repo:

- Project registry allowlist: ChatGPT must select from configured projects.
- Workspace file tools reject paths outside the selected project root.
- `denied_paths` blocks configured secret paths for workspace tools and forbidden shell classifications.
- HTTP Host / `X-Forwarded-Host` allowlist can restrict requests to localhost and configured tunnel hosts when `LOCAL_DEV_MCP_PUBLIC_ORIGIN` or `LOCAL_DEV_MCP_ALLOWED_HOSTS` is set.
- Shell risk classification separates read-only, local compute, workspace write, network/dependency, destructive/process-control, and forbidden operations.
- `forbidden` shell commands are blocked, including common secret reads and catastrophic system operations.
- Shell output is redacted for common token, key, and credential patterns before being returned.
- HTTP MCP access uses OAuth bearer tokens. The authorization endpoint is protected by a passphrase.
- The server listens on `127.0.0.1`; external access should be provided by a controlled HTTPS tunnel.

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

### Command-scoped Bitwarden access

`shell.run` can set `credential_scope: "bitwarden"` when a command must use the
Bitwarden Secrets Manager CLI. The server reads the access token from the macOS
Keychain mapping in `${HARUCLAW_HOME:-~/.haru}/.bitwarden.env`, injects it into
that command only, and redacts the exact token from captured output. Credential
access follows the selected project's normal approval policy; requesting the scope
does not by itself force approval. Ordinary shell commands never receive the token.

This means routine reads can stay smooth, while writes and network/dependency operations usually ask for confirmation.

## Features

- Project selection from a YAML registry, with the selected project persisted per chat context
- Bounded workspace read/list/search/patch tools, including large-file range reads and ripgrep-backed text search
- Skills discovery and read tools for ChatGPT (`skills.list`, then `skills.read`)
- Shell command execution with risk classification, approvals, managed async jobs, delta polling, and long-poll status waits
- Typed Git helpers for repository inspection, status, history, commit display, and diffs (`git.inspect`, `git.status`, `git.log`, `git.show`, `git.diff`)
- Browser and mobile actions that can combine an action with a post-action `wait_for` condition to avoid extra fixed sleeps and screenshots
- Mobile simulator / physical-device automation plus Android runtime diagnostics such as foreground-app inspection and bounded logcat reads
- Image read/download helpers, public/private note helpers, Todo helpers, tool schema diagnostics, and compact tool-usage metrics
- OAuth-protected HTTP transport for ChatGPT Apps style clients, including MCP tool-list change notifications

## Physical mobile automation

Physical iOS devices are discovered and operated through `agent-device` with Appium/XCUITest. `mobile.status` reports whether that backend is available. The device must be paired with the Mac and have Developer Mode enabled. UI-reading operations such as `mobile.snapshot`, `mobile.screenshot`, element taps, typing, and swipes also require the installed Xcode to contain device support compatible with the iOS version running on the device. App launch and device discovery may still work when that XCTest runner prerequisite is not met.

Android devices are discovered through ADB. local-dev-mcp resolves `adb` from PATH, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the standard macOS Android SDK location. Accessibility snapshots, element taps, and waits use a dedicated `agent-device` Android session whose PATH is seeded with the resolved platform-tools directory, while screenshots and basic coordinate/input/navigation operations use ADB directly. Physical Android devices require USB debugging authorization.

The mobile tool set includes device discovery, screenshots, accessibility snapshots, app launch, URL opening, coordinate and element taps, typing, swipes, Home/Back navigation, waits, app stop/restart operations where supported, foreground-app inspection, and bounded Android logs. Prefer accessibility refs from `mobile.snapshot` over coordinate taps when possible.

For condition-driven flows, prefer the `wait_for` option on actions such as app launch, tap, typing, swipe, or browser navigation instead of issuing a separate fixed sleep followed by another observation call. When `wait_for` is supplied and `observe` is omitted, the wait result replaces the default after-action screenshot; set `observe: "after"` when a screenshot is also needed.

`mobile.current_app` and `mobile.logs` currently target Android devices/emulators. `mobile.stop_app` supports Android and iOS Simulator apps; `mobile.restart_app` supports Android and iOS Simulator apps. Physical iOS app termination/restart is not provided by the current backend.

## Efficient Tool Usage And Diagnostics

Prefer typed tools over shell composition when a dedicated tool exists:

- Use `git.inspect` for the common repository-state check instead of combining several read-only Git shell commands.
- Reuse the selected project; repeated `project.select` calls for the same project are unnecessary.
- Use bounded `workspace.read`, `workspace.list`, and ripgrep-backed `workspace.search` instead of broad shell scans. Root-level listings/searches omit common generated artifacts and logs by default unless explicitly included.
- For background `shell.run(async: true)` jobs, reuse the `cursor` returned by `shell.status` to fetch only new output. Set `wait_ms` to wait server-side for output or completion instead of tight polling.
- Use action-level `wait_for` for browser/mobile UI transitions instead of fixed sleeps plus separate wait calls.
- `tool.usage` returns aggregate call counts, failures, durations, per-project counts, and the `shell.run` share. It does not record tool arguments or outputs.

Raw audit logs are bounded and rotate before unbounded growth. Service logs written by the launchd setup rotate independently as described in the Cloudflare Tunnel section.

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
   pnpm run doctor -- config/projects.local.yaml
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

8. If the user wants ChatGPT to connect from outside the machine, configure a controlled HTTPS tunnel.

   Do not expose the HTTP endpoint directly to the public internet. This repo includes `scripts/tunnel.sh` for Cloudflare Tunnel. It requires these `.env` values:

   ```bash
   LOCAL_DEV_MCP_PUBLIC_ORIGIN=https://your-tunnel.example.com
   LOCAL_DEV_MCP_ALLOWED_HOSTS=your-tunnel.example.com
   LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID=your-tunnel-id
   LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE=/absolute/path/to/credentials.json
   LOCAL_DEV_MCP_PROJECTS_CONFIG=/absolute/path/to/local-dev-mcp/config/projects.local.yaml
   ```

   If those values are not already available, stop and ask the user for the tunnel details or ask whether they want only local HTTP setup for now. Do not invent tunnel IDs, hostnames, or credential paths.

9. Give the user the ChatGPT connection target:

   - Local HTTP endpoint for local testing: `http://127.0.0.1:3456/mcp`
   - ChatGPT-reachable tunnel endpoint: `${LOCAL_DEV_MCP_PUBLIC_ORIGIN}/mcp`

   ChatGPT should use the HTTP MCP endpoint that is reachable from the ChatGPT connector flow. Stdio is mainly useful for local MCP clients and debugging.

10. Tell the user to add the app in ChatGPT Developer Mode.

   Codex, Claude Code, and other local coding agents cannot complete this step inside the user's ChatGPT account. Give the user the endpoint from step 9 and ask them to follow [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode) and [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).

   User-facing steps:

   1. Open ChatGPT on the web.
   2. Enable Developer Mode. Depending on the workspace plan and permissions, this is under Settings -> Apps -> Advanced settings -> Developer mode, or Workspace settings -> Apps / Permissions & Roles.
   3. Open Apps settings and choose Create app.
   4. Enter the ChatGPT-reachable MCP endpoint, for example `${LOCAL_DEV_MCP_PUBLIC_ORIGIN}/mcp`.
   5. Choose OAuth authentication.
   6. Click Scan Tools.
   7. When the authorization page opens, enter the `LOCAL_DEV_MCP_PASSPHRASE` value from `.env`.
   8. Wait for the tool scan to finish, then click Create.
   9. Open a new chat and select the draft app from the tools / plus menu or Developer Mode tool picker.
   10. Test with a read-only prompt first, such as "Use local-dev-mcp to list projects."

   Notes for the user:

   - ChatGPT must be able to reach the MCP endpoint. `127.0.0.1` is only for local testing; use a controlled ChatGPT-reachable tunnel endpoint for ChatGPT.
   - App selection applies to one message, not the entire chat. Mention `@local-dev-mcp` again when a later message needs another tool call.
   - Developer Mode and full MCP write/modify support depend on the user's ChatGPT plan, workspace settings, and admin permissions.
   - ChatGPT may ask for confirmation frequently. Review the tool payload before approving write or command execution.

11. Report back with:

   - The absolute path of `config/projects.local.yaml`
   - The selected project IDs
   - Whether `pnpm typecheck` and `pnpm test` passed
   - Whether only local HTTP is ready or the public tunnel is also ready
   - The ChatGPT MCP endpoint to use
   - That the remaining ChatGPT Developer Mode app creation step must be completed by the user

Do not commit or print the contents of `.env`, `.local-dev-mcp`, `logs`, `generated`, `dist`, `node_modules`, or `config/projects.local.yaml`.

## Skills access for ChatGPT

ChatGPT does not automatically load Codex/Haru `SKILL.md` files. Use:

1. `skills.list` with an optional registered project `path`.
2. Prefer the exact `SKILL.md` path returned by `skills.list`; `skills.read` also accepts another real, non-symlink path inside an allowed Skill root.

`skills.list` includes project-local `<path>/.agents/skills`, runtime-user `${CODEX_HOME:-~/.haru/.codex}/skills` excluding `.system`, and system `${CODEX_HOME:-~/.haru/.codex}/skills/.system`. Each result includes runtime `scope` and source `origin` (`common`, `private_user`, `project`, `system`, or `unmanaged`). Common and private-user Skills can both have runtime `scope:user`. Symlinks are rejected.

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

## Add The App In ChatGPT Developer Mode

This part must be done by the user in ChatGPT. A local coding agent can prepare the server and provide the endpoint, but it cannot click through the user's ChatGPT workspace settings or approve the app on their behalf.

Prerequisites:

- ChatGPT web access with Developer Mode available for the account/workspace.
- A ChatGPT-reachable MCP endpoint, usually `${LOCAL_DEV_MCP_PUBLIC_ORIGIN}/mcp`.
- `LOCAL_DEV_MCP_PASSPHRASE` set in the local `.env`.

Steps:

1. Open ChatGPT on the web.
2. Enable Developer Mode:
   - User settings path: Settings -> Apps -> Advanced settings -> Developer mode.
   - Workspace/admin path: Workspace settings -> Apps, or Workspace settings -> Permissions & Roles, depending on plan and permissions.
3. Open Apps settings and click Create app.
4. Enter the MCP endpoint, for example:

   ```text
   https://your-trusted-endpoint.example.com/mcp
   ```

5. Choose OAuth authentication.
6. Click Scan Tools.
7. Complete the authorization prompt by entering your `LOCAL_DEV_MCP_PASSPHRASE`.
8. After the tool scan completes, click Create.
9. Confirm the app appears as a draft / developer app.
10. Start a new chat and select the app from the tools / plus menu or Developer Mode tool picker.
11. Test with read-only prompts first:

   ```text
   Use local-dev-mcp to list projects.
   ```

   ```text
   Use local-dev-mcp to select my project, then show the current project.
   ```

App selection applies per message. Mention `@local-dev-mcp` again when a later message needs another local-dev-mcp action.

The server advertises `offline_access` in OAuth discovery and issues refresh tokens. Apps created before this support was added retain older metadata; after upgrading the server, refresh the app metadata/actions in ChatGPT or recreate and reauthorize the app.

Refresh tokens rotate when used. Concurrent refreshes with the same old token replay the same replacement token for 30 seconds, so simultaneous chats do not invalidate one another's connection.

The MCP HTTP transport is stateless. It handles requests through `POST /mcp` and returns `405 Method Not Allowed` with `Allow: POST` for `GET /mcp` because it does not provide a standalone SSE stream.

The server advertises MCP `tools.listChanged` support. `tool.schema` returns the current runtime tool schema/version and also emits a tool-list change notification so clients that honor the capability can refresh their cached tools. If ChatGPT still shows an old schema after a server upgrade, refresh the developer app metadata/actions or recreate and reauthorize the app.

Write and command execution prompts can trigger ChatGPT confirmation dialogs. Review the JSON payload before approving. If ChatGPT cannot connect, verify the endpoint is reachable from ChatGPT, OAuth discovery works, the passphrase is correct, and the server logs show the request.

Official references:

- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
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

Run the setup doctor:

```bash
pnpm run doctor -- config/projects.local.yaml
```

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

## OpenAI Secure MCP Tunnel

Use OpenAI Secure MCP Tunnel when a supported ChatGPT account/workspace or another OpenAI client needs to reach a private local MCP server. In this mode `local-dev-mcp` remains bound to `127.0.0.1`, while the official `tunnel-client` establishes an outbound HTTPS connection to OpenAI. No public MCP URL or inbound firewall rule is required.

This is independent from the existing Cloudflare Tunnel + OAuth path. When `LOCAL_DEV_MCP_AUTH_MODE=openai-tunnel`, the server does not advertise OAuth discovery / authorization / token / registration endpoints. The local hop is protected with `X-Local-Dev-MCP-Tunnel-Token`, and `tunnel-client` sends that header on both normal MCP requests and startup discovery/probe requests.

Install the official `tunnel-client`:

```bash
pnpm tunnel:openai:install
```

By default the installer resolves the official latest release and verifies its checksum, installs it below `~/.local-dev-mcp/tunnel-client/`, and exposes it through `~/.local-dev-mcp/bin/tunnel-client`. Set `LOCAL_DEV_MCP_TUNNEL_CLIENT_VERSION` when a specific release must be pinned.

Long-lived service operation uses this private state directory by default:

```text
~/.local-dev-mcp/openai-tunnel/
├─ tunnel-id
├─ runtime-api-key
└─ mcp-token
```

- `tunnel-id`: Tunnel ID created in OpenAI Platform. Format: `tunnel_` plus 32 lowercase hex characters
- `runtime-api-key`: runtime API key for the Tunnel. Grant at least Tunnels Read + Use
- `mcp-token`: random value used only between `tunnel-client` and the local MCP server. Minimum 32 characters

Keep the state directory owner-only and each file at mode `0600`. Do not put credential values in the repository, plist files, command-line arguments, or normal logs.

Example local-hop token generation:

```bash
mkdir -p ~/.local-dev-mcp/openai-tunnel
chmod 700 ~/.local-dev-mcp/openai-tunnel
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > ~/.local-dev-mcp/openai-tunnel/mcp-token
chmod 600 ~/.local-dev-mcp/openai-tunnel/mcp-token
```

Store the Tunnel ID and runtime API key created in OpenAI Platform in their matching files. Do not paste the values into chat or logs.

Start the MCP server in OpenAI Tunnel auth mode:

```bash
pnpm server:openai-tunnel
```

Run the official client preflight:

```bash
pnpm tunnel:openai:doctor
```

With the local MCP server running and the configuration valid, `mcp_target` and `mcp_server_reachable` should pass. In the non-OAuth configuration, `oauth_metadata` should also pass as "not advertised".

Start the Tunnel:

```bash
pnpm tunnel:openai
```

The `tunnel-client` health / readiness / UI listener defaults to loopback `127.0.0.1:3460`. This remains a separate process and failure domain from the MCP server on `127.0.0.1:3456`.

For long-lived macOS operation, keep the server and OpenAI Tunnel in separate LaunchAgents. Write the plist files first:

```bash
pnpm launchd:install:openai
```

After verifying the state files and Tunnel configuration, activate them:

```bash
scripts/install-openai-tunnel-launchd.sh --activate
```

The default jobs are `io.local-dev-mcp.server` and `io.local-dev-mcp.openai-tunnel`. Tunnel reconnects do not restart the MCP process.

To keep the existing Cloudflare/OAuth service running during migration, use a different label prefix and port. The OpenAI Tunnel server wrapper also uses separate server and mobile-agent lock/state directories, so the two MCP processes do not compete for the same service lock. For example:

```bash
PORT=13461 LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX=io.local-dev-mcp.openai-dev \
  scripts/install-openai-tunnel-launchd.sh --activate
```

On the ChatGPT side, associate the Tunnel with the intended ChatGPT account/workspace in OpenAI Platform when applicable, then select that Tunnel when creating the custom MCP app in Developer Mode. This repository has also been end-to-end tested with a Pro developer-mode plugin. Secure MCP Tunnel does not require registering a public MCP endpoint URL in ChatGPT.

For normal file handoff from the development host to ChatGPT, prefer `artifact.read`. It embeds the file bytes directly in the MCP tool result as a standard `EmbeddedResource` / `BlobResourceContents`, so the file travels through Secure MCP Tunnel without a public HTTP endpoint. The current per-call raw file limit is 8 MiB; metadata includes the MIME type and SHA-256 digest. Use `workspace.read` for text inspection and `image.read` for image inspection instead of transferring the whole file when the user does not need the artifact itself.

On current ChatGPT clients, the first embedded file returned by a custom plugin may trigger an **Allow file materialization?** confirmation. After approval, ChatGPT materializes the embedded resource as a normal file attachment card (for example, a ZIP appears as a “Zip Archive” card). This materialization happens after the bytes have already traveled through MCP/Secure Tunnel; it does not require `LOCAL_DEV_MCP_PUBLIC_ORIGIN`.

`download.link` remains a legacy/fallback path for files that must be exposed as an ordinary browser URL. That URL is outside normal MCP traffic, so Secure MCP Tunnel does not expose it. Configure a separate HTTPS `LOCAL_DEV_MCP_PUBLIC_ORIGIN` only when that URL-based behavior is required; otherwise `download.link` fails explicitly instead of returning a localhost URL.

## Cloudflare Tunnel

`scripts/tunnel.sh` can start the HTTP server and a Cloudflare Tunnel. Use this only when the tunnel is part of your controlled access path. Do not expose the local MCP server directly.

Run only one launcher instance. The script holds a PID lock at `~/.local-dev-mcp/runtime/tunnel-launcher.lock` and exits with status 75 when another live launcher already owns it. This prevents a manual invocation from competing with a launchd-managed instance and repeatedly reconnecting the Cloudflare Tunnel.

Configure these values in `.env` first:

```bash
LOCAL_DEV_MCP_PUBLIC_ORIGIN=https://your-tunnel.example.com
LOCAL_DEV_MCP_ALLOWED_HOSTS=your-tunnel.example.com
LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID=your-tunnel-id
LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE=/absolute/path/to/credentials.json
LOCAL_DEV_MCP_PROJECTS_CONFIG=/absolute/path/to/config/projects.local.yaml
```

`LOCAL_DEV_MCP_PUBLIC_ORIGIN` is automatically added to the HTTP host allowlist. Use `LOCAL_DEV_MCP_ALLOWED_HOSTS` only for additional trusted proxy hostnames.

Then run:

```bash
pnpm tunnel
```

For long-lived macOS operation, keep the MCP server and Cloudflare Tunnel in separate launchd jobs so a tunnel restart does not restart the MCP process. Write the jobs without changing the running service:

```bash
pnpm run launchd:install
```

Then activate them. If an older combined LaunchAgent is still installed, pass its label so it is booted out before the new server starts:

```bash
scripts/install-launchd.sh --activate --legacy-label your.old.launchd.label
```

The generated jobs are `io.local-dev-mcp.server` and `io.local-dev-mcp.tunnel` by default. They write independently rotating logs to `logs/mcp-server.log` and `logs/cloudflared.log` (10 MiB, five backups by default). The tunnel defaults to protocol `auto` and log level `warn`; set `LOCAL_DEV_MCP_CLOUDFLARE_PROTOCOL=http2` only as a diagnostic fallback when QUIC is unstable.

Use `http://127.0.0.1:3456/healthz` to distinguish server restarts from tunnel-only reconnects: `instance_id` changes only when the MCP process restarts.

## Safety Notes

- Do not commit `.env`, `.local-dev-mcp`, `logs`, `generated`, or `config/projects.local.yaml`.
- Keep secrets out of registered projects or add their paths to `denied_paths`.
- Review command approvals carefully before allowing write or destructive operations.

## Development

```bash
pnpm run doctor -- config/projects.local.yaml
pnpm typecheck
pnpm test
```
