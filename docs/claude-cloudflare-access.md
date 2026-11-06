# Claude through Cloudflare Access

## Purpose and security boundary

Claude connects to the existing loopback MCP server through a dedicated Cloudflare Tunnel and self-hosted Cloudflare Access application. The original ChatGPT Secure MCP Tunnel and its subject authorization remain independent.

- Claude MCP URL: `https://<dedicated-hostname>/mcp`
- Cloudflare Access: self-hosted application, Allow policy for the exact intended account, Managed OAuth enabled
- Cloudflare Tunnel: HTTPS traffic forwarded to `http://127.0.0.1:3456` with the origin Host header rewritten to `127.0.0.1`
- local-dev-mcp: verifies the `Cf-Access-Jwt-Assertion` signature, issuer, audience, expiry and RS256 signing algorithm using Cloudflare's published keys
- Development Mac: MCP listener stays bound to the loopback interface

A Tunnel alone provides **no authentication**. Never expose this MCP endpoint through an unprotected public ingress, and do not weaken ChatGPT authorization to connect Claude.

## Cloudflare setup

1. Create a dedicated Access self-hosted application with a policy allowing only the intended exact account address. Do not use Allow Everyone.
2. Enable **Managed OAuth** in the Access application's Additional settings and allow the Claude callback URI: `https://claude.ai/api/mcp/auth_callback`. Save and re-read the configuration.
3. Copy the application's Audience (AUD) identifier.
4. Create a dedicated Cloudflare Tunnel on the development Mac and publish the hostname to `http://127.0.0.1:3456`; set `httpHostHeader: 127.0.0.1`. The bundled `cloudflare-tunnel.sh` uses `--protocol http2` for the connector-to-Cloudflare leg, avoiding unreliable QUIC/UDP connections on restricted or unstable networks.
5. Store the Tunnel connector token in a private mode 0600 file, such as `~/.cloudflared/local-dev-mcp-claude.token`. Run the separate LaunchAgent with `LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ENABLE=1` when using `scripts/install-launchd.sh --activate`. The connector reads the token file rather than placing the token in the LaunchAgent or command-line arguments.
6. Add the published `https://<dedicated-hostname>/mcp` endpoint as a Claude custom connector and complete the OAuth sign-in.

## MCP server setup

Set both non-secret Access settings when generating the server LaunchAgent:

```sh
LOCAL_DEV_MCP_CLOUDFLARE_TEAM_DOMAIN=<team>.cloudflareaccess.com
LOCAL_DEV_MCP_CLOUDFLARE_AUDIENCE=<Access-application-AUD>
```

Supply them again when regenerating LaunchAgents. Supplying only one setting is an error. With neither setting present, the existing OpenAI-only HTTP authentication remains in effect. Keep the previously configured ChatGPT Personal and Business Tunnel enable flags when reactivating the service.

## Inspecting Claude request metadata

Set `LOCAL_DEV_MCP_CLOUDFLARE_REQUEST_DIAGNOSTICS=1` when activating the MCP server to enable diagnostics for **successfully authenticated Cloudflare POST /mcp requests only**. The default is disabled. Records appear as `[Cloudflare MCP metadata]` in the rotating `logs/mcp-server.log` file, which is mode 0600.

The diagnostic record contains:

- Every accepted HTTP header **name** and a bounded structural summary of non-sensitive values. Non-sensitive strings are recorded only as length and a process-keyed HMAC fingerprint. Known `Mcp-Method` names and strictly formatted `Mcp-Protocol-Version` dates are also shown as safe literal protocol values.
- Explicit redaction for authorization, JWT/assertion, cookies, credentials, emails, client IP addresses, forwarded IP addresses and other sensitive headers. No raw header values are saved.
- The MCP method, including `server/discover` (modern protocol detection), and a redacted fingerprint for unknown methods.
- The JSON-RPC request ID's type, length and fingerprint; top-level and `params` key names; and a bounded, recursive shape of top-level and `params._meta` fields, including nested client info and capabilities extensions.
- Only the top-level **key names** of tool arguments, never the argument values or nested argument contents. Sensitive metadata fields such as messages, prompts, command, tokens and credentials are marked redacted without their values.
- `captureId`, a random server-process identifier. Fingerprints can be compared only within the **same** `captureId` because the HMAC key is regenerated on every restart. No fingerprint secret is written to disk.

To determine whether Claude provides a conversation identifier, collect multiple tool calls in **two different Claude chats after this diagnostic is enabled**, preferably without restarting the MCP service between the chats. Compare whether an opaque identifier is stable within one chat but differs between chats. A constant fingerprint that is shared across chats may reflect the Claude client or Cloudflare account, **not** a chat identifier. A value that changes on every request is also not usable as a persistent chat ID.

For review, parse only the structured diagnostic JSON following the `[Cloudflare MCP metadata]` prefix. Never print raw server logs, MCP payloads, Cloudflare tokens or user data in the conversation. The diagnostic is a narrowly scoped observation aid and does not change the MCP session or project-selection behavior.

After collection, deactivate diagnostics by regenerating and activating the LaunchAgents without `LOCAL_DEV_MCP_CLOUDFLARE_REQUEST_DIAGNOSTICS=1`. Keep the other active Access and Tunnel settings.

## Claude project and work-context selection

Claude does not send a verified chat ID. After connecting, start a work context with `project.select({ "project_id": "local-dev-mcp" })`. Preserve the returned `context_id` and include it in subsequent project-scoped calls, for example `workspace.read({ "context_id": "ctx_...", "path": "README.md" })`. A new `project.select` without that ID creates a separate context. The project and working directory remain fixed for the lifetime of each context; supplying the existing ID only reloads the same scope's instructions. To work on another project or worktree, create a new context. Missing or unauthorized IDs are rejected rather than selecting a shared default project.

Claude receives its own `tools/list` schema. ChatGPT attachment ingestion (`artifact.receive`) and resource links (`artifact.link` and `resources/read`) are unavailable on Claude until a context-safe transfer contract is supported. Direct scoped `workspace.*`, `image.read`, and `artifact.read` remain available. The complete runtime contract is documented in [Claude work contexts](claude-work-context-design.md).

## Connection verification

- Verify the Access application's intended hostname, restrictive policy, audience, Managed OAuth setting and Claude callback allowlist.
- Confirm unauthenticated remote and loopback MCP calls are rejected.
- Verify an invalid Cloudflare JWT, wrong issuer, wrong audience and expired JWT are rejected.
- After changing the Cloudflare Access team domain or MCP hostname, inspect the current OAuth discovery issuer, authorization/token endpoint hosts, Access application audience, and registered Claude callback URI. Existing Claude connector OAuth credentials may be tied to the former issuer or resource; disconnect and re-add the custom connector at the current MCP URL if a fresh Reconnect still shows an expired connection request. Do not reuse an OAuth consent URL from an earlier attempt.
- Verify Claude can call a read-only tool after OAuth sign-in.
- Verify the original ChatGPT Secure MCP Tunnel still accepts an actual ChatGPT MCP tool call.

The older server SDK may not recognize the modern `server/discover` request. Modern MCP clients can probe it and then fall back to the legacy initialize handshake. An unsuccessful discovery probe is not proof of a failed authenticated tool call; compare the subsequent client requests and actual tool results.
