#!/bin/bash
set -euo pipefail

TOKEN_FILE="${LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_TOKEN_FILE:-$HOME/.cloudflared/local-dev-mcp-claude.token}"
if [ ! -s "$TOKEN_FILE" ] || [ ! -r "$TOKEN_FILE" ]; then
  echo "[cloudflare-tunnel] Private tunnel token file is not readable." >&2
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo "[cloudflare-tunnel] cloudflared is not installed." >&2
  exit 1
fi

exec cloudflared tunnel --no-autoupdate --loglevel warn run --token-file "$TOKEN_FILE"
