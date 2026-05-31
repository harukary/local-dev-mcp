#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PORT="${LOCAL_DEV_MCP_PORT:-3456}"
CONFIG_PATH="${LOCAL_DEV_MCP_PROJECTS_CONFIG:-$ROOT_DIR/config/projects.local.yaml}"
TUNNEL_ID="${LOCAL_DEV_MCP_OPENAI_TUNNEL_ID:-${CONTROL_PLANE_TUNNEL_ID:-}}"
HEALTH_LISTEN_ADDR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_ADDR:-127.0.0.1:8080}"
HEALTH_URL_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_URL_FILE:-$ROOT_DIR/generated/openai-tunnel/health.url}"
TUNNEL_CLIENT_BIN="${TUNNEL_CLIENT_BIN:-$ROOT_DIR/generated/openai-tunnel/tunnel-client}"

if [[ -z "$TUNNEL_ID" ]]; then
  echo "[openai-tunnel] LOCAL_DEV_MCP_OPENAI_TUNNEL_ID or CONTROL_PLANE_TUNNEL_ID is required." >&2
  echo "[openai-tunnel] Create a tunnel at https://platform.openai.com/settings/organization/tunnels." >&2
  exit 1
fi

if [[ -z "${CONTROL_PLANE_API_KEY:-}" ]]; then
  echo "[openai-tunnel] CONTROL_PLANE_API_KEY is required." >&2
  echo "[openai-tunnel] Use a runtime API key with Tunnels Read + Use for this tunnel." >&2
  exit 1
fi

if [[ -z "${LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET:-}" ]]; then
  echo "[openai-tunnel] LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET is required." >&2
  echo "[openai-tunnel] Generate one with: node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\"" >&2
  exit 1
fi

if [[ ! -x "$TUNNEL_CLIENT_BIN" ]]; then
  if command -v tunnel-client >/dev/null 2>&1; then
    TUNNEL_CLIENT_BIN="$(command -v tunnel-client)"
  else
    echo "[openai-tunnel] tunnel-client not found." >&2
    echo "[openai-tunnel] Download it from https://github.com/openai/tunnel-client/releases/latest or set TUNNEL_CLIENT_BIN." >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$HEALTH_URL_FILE")"

SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "[openai-tunnel] MCP server already running on 127.0.0.1:$PORT." >&2
else
  echo "[openai-tunnel] Starting MCP server on 127.0.0.1:$PORT..." >&2
  pnpm exec tsx src/index.ts --http "$PORT" "$CONFIG_PATH" &
  SERVER_PID="$!"
  for _ in {1..40}; do
    if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  curl -fsS "http://127.0.0.1:$PORT/" >/dev/null
fi

echo "[openai-tunnel] Starting tunnel-client for tunnel $TUNNEL_ID..." >&2
exec "$TUNNEL_CLIENT_BIN" run \
  --control-plane.tunnel-id "$TUNNEL_ID" \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --mcp.server-url "url=http://127.0.0.1:$PORT/mcp,channel=main" \
  --mcp.extra-headers "X-Local-Dev-MCP-Tunnel-Secret: env:LOCAL_DEV_MCP_TUNNEL_SHARED_SECRET" \
  --health.listen-addr "$HEALTH_LISTEN_ADDR" \
  --health.url-file "$HEALTH_URL_FILE"
