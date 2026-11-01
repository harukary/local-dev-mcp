# Claude over Cloudflare Access

## Purpose

Expose the existing loopback MCP server to a Claude remote MCP connector using a dedicated Cloudflare Tunnel and a self-hosted Cloudflare Access application. The original OpenAI Secure MCP Tunnel, its token, and ChatGPT subject authorization remain unchanged.

## Architecture

- Claude remote MCP connector: `https://<dedicated-hostname>/mcp`
- Cloudflare Access self-hosted application: an Allow policy restricted to the intended user's exact email address
- Cloudflare Access Managed OAuth: enabled on that Access application
- Dedicated Cloudflare Tunnel: HTTPS ingress forwarded to `http://127.0.0.1:3456`, with HTTP origin Host header set to `127.0.0.1`
- local-dev-mcp: verifies the Access JWT from `Cf-Access-Jwt-Assertion` against Cloudflare's published signing keys, issuer, audience, expiration, and RS256 signature. Without a verified assertion or the existing OpenAI tunnel token, requests receive HTTP 401.

A Cloudflare Tunnel alone is not authentication. Never create a public unprotected ingress to the development MCP server. Keep the MCP process bound to the loopback interface.

## Cloudflare setup

1. Create a self-hosted Access application with a **dedicated hostname** and an Allow policy for the intended exact owner email, rather than Allow Everyone or an existing shared application policy.
2. Open the application's **Additional settings** tab and enable **Managed OAuth**. Add `https://claude.ai/api/mcp/auth_callback` under **Allowed redirect URIs** for Claude's OAuth client, then save and re-read both settings.
3. Copy its **Application Audience (AUD)** tag, which is a public identifier, not a credential.
4. Create a dedicated Cloudflare Tunnel that runs `cloudflared` on the development Mac. In the tunnel's published application route, forward to `http://127.0.0.1:3456` and configure origin `httpHostHeader: 127.0.0.1`. Use the Tunnel/Access-managed DNS route rather than adding unrelated raw DNS entries.
5. Store the Tunnel connector token in a mode 0600 private file, such as `~/.cloudflared/local-dev-mcp-claude.token`. Enable its separate LaunchAgent with `LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ENABLE=1` when running `scripts/install-launchd.sh --activate`. This uses `cloudflared tunnel run --token-file` so credentials are never embedded in plist files or process arguments. Never commit or log the token.
6. Use the dedicated hostname with `/mcp` as the URL when adding a custom connector to Claude.

## MCP server configuration

Set both non-secret environment variables:

```sh
LOCAL_DEV_MCP_CLOUDFLARE_TEAM_DOMAIN=<team>.cloudflareaccess.com
LOCAL_DEV_MCP_CLOUDFLARE_AUDIENCE=<Access-application-AUD>
```

When using the repository's launchd installer, supply both values as part of `pnpm launchd:install` or `pnpm launchd:activate`. The installer places these non-secret values only into the **MCP server LaunchAgent**, not the OpenAI Tunnel clients. Supply them again if you regenerate LaunchAgents. The default MCP server transport remains restricted to localhost.

The Cloudflare authentication path is opt-in: with neither variable set, the original OpenAI-only HTTP behavior remains active. Supplying only one variable is an error.

## Verification

- Confirm the Access application's hostname, restrictive policy, audience, Managed OAuth state, and Claude's allowed callback URI.
- Check that unauthenticated HTTPS requests are rejected by Access before reaching MCP, and anonymous loopback `POST /mcp` continues to receive HTTP 401.
- Check that an altered or expired JWT, wrong application audience, and wrong issuer are rejected.
- Through Claude, connect using OAuth and actually call a **read-only** MCP tool such as `project.list`; confirm the Git/workspace tools available only after successful authentication.
- Re-test an existing ChatGPT MCP tool call through the original OpenAI Secure MCP Tunnel.
- Only then call the Claude connector end-to-end operational.

**Compatibility limitation:** Cloudflare Managed OAuth and Claude.ai have had reports of failures caused by Claude's handling of the OAuth `resource` parameter. Creating an Access application and verifying JWTs locally does not establish that Claude's OAuth flow works. Verify the exact Claude client rather than assuming success. Avoid weakening Access policies or replacing JWT validation with unauthenticated ingress to work around OAuth failures.
