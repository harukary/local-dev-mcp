#!/bin/bash
set -euo pipefail

MODE="run"
case "${1:-}" in
  "") ;;
  --doctor) MODE="doctor"; shift ;;
  --run) MODE="run"; shift ;;
  -h|--help)
    cat <<'USAGE'
usage: tunnel.sh [--run|--doctor]

Runs the official OpenAI tunnel-client against the loopback local-dev-mcp endpoint.
Configuration may be supplied through environment variables or private files.

Required:
  LOCAL_DEV_MCP_OPENAI_TUNNEL_ID or LOCAL_DEV_MCP_OPENAI_TUNNEL_ID_FILE
  LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY or LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE
  LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN or LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE

Defaults for file-backed service operation:
  ~/.local-dev-mcp/openai-tunnel/tunnel-id
  ~/.local-dev-mcp/openai-tunnel/runtime-api-key
  ~/.local-dev-mcp/openai-tunnel/mcp-token

Optional:
  LOCAL_DEV_MCP_TUNNEL_CLIENT_BIN=/absolute/path/to/tunnel-client
  LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_ADDR=127.0.0.1:3460
  LOCAL_DEV_MCP_OPENAI_TUNNEL_STARTUP_WAIT=30s
  LOCAL_DEV_MCP_OPENAI_TUNNEL_LOG_LEVEL=info
  PORT=3456
USAGE
    exit 0
    ;;
  *) echo "Unknown argument: $1" >&2; exit 64 ;;
esac
if [ "$#" -ne 0 ]; then
  echo "usage: tunnel.sh [--run|--doctor]" >&2
  exit 64
fi

PORT="${PORT:-3456}"
STATE_DIR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR:-$HOME/.local-dev-mcp/openai-tunnel}"
DEFAULT_TUNNEL_ID_FILE="$STATE_DIR/tunnel-id"
DEFAULT_API_KEY_FILE="$STATE_DIR/runtime-api-key"
DEFAULT_MCP_TOKEN_FILE="$STATE_DIR/mcp-token"
HEALTH_ADDR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_ADDR:-127.0.0.1:3460}"
STARTUP_WAIT="${LOCAL_DEV_MCP_OPENAI_TUNNEL_STARTUP_WAIT:-30s}"
LOG_LEVEL="${LOCAL_DEV_MCP_OPENAI_TUNNEL_LOG_LEVEL:-info}"
HEADER_NAME="X-Local-Dev-MCP-Tunnel-Token"


expand_home() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#~/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

read_trimmed_file() {
  local path
  path="$(expand_home "$1")"
  if [ ! -f "$path" ]; then
    return 1
  fi
  tr -d '\r\n' < "$path"
}

TUNNEL_ID="${LOCAL_DEV_MCP_OPENAI_TUNNEL_ID:-}"
TUNNEL_ID_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_ID_FILE:-$DEFAULT_TUNNEL_ID_FILE}"
if [ -z "$TUNNEL_ID" ]; then
  TUNNEL_ID="$(read_trimmed_file "$TUNNEL_ID_FILE" || true)"
fi
if [[ ! "$TUNNEL_ID" =~ ^tunnel_[0-9a-f]{32}$ ]]; then
  echo "[openai-tunnel] Tunnel ID is required and must match tunnel_<32 lowercase hex chars>." >&2
  exit 1
fi

resolve_secret_ref() {
  local inline_name="$1"
  local file_name="$2"
  local default_file="$3"
  local inline_value="${!inline_name:-}"
  local configured_file="${!file_name:-$default_file}"

  if [ -n "$inline_value" ] && [ "${!file_name+x}" = "x" ] && [ -n "${!file_name}" ]; then
    echo "[openai-tunnel] $inline_name and $file_name are mutually exclusive." >&2
    return 1
  fi
  if [ -n "$inline_value" ]; then
    printf 'env:%s' "$inline_name"
    return 0
  fi

  local expanded
  expanded="$(expand_home "$configured_file")"
  if [ ! -f "$expanded" ]; then
    echo "[openai-tunnel] Secret file not found: $expanded" >&2
    return 1
  fi
  printf 'file:%s' "$expanded"
}

API_KEY_REF="$(resolve_secret_ref LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE "$DEFAULT_API_KEY_FILE")"
MCP_TOKEN_REF="$(resolve_secret_ref LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE "$DEFAULT_MCP_TOKEN_FILE")"

TUNNEL_CLIENT_BIN="${LOCAL_DEV_MCP_TUNNEL_CLIENT_BIN:-${TUNNEL_CLIENT_BIN:-}}"
if [ -z "$TUNNEL_CLIENT_BIN" ]; then
  TUNNEL_CLIENT_BIN="$(command -v tunnel-client || true)"
fi
if [ -z "$TUNNEL_CLIENT_BIN" ] && [ -x "$HOME/.local-dev-mcp/bin/tunnel-client" ]; then
  TUNNEL_CLIENT_BIN="$HOME/.local-dev-mcp/bin/tunnel-client"
fi
if [ -z "$TUNNEL_CLIENT_BIN" ] || [ ! -x "$TUNNEL_CLIENT_BIN" ]; then
  echo "[openai-tunnel] tunnel-client was not found. Install an official release or set LOCAL_DEV_MCP_TUNNEL_CLIENT_BIN." >&2
  exit 1
fi

COMMON_ARGS=(
  --control-plane.tunnel-id "$TUNNEL_ID"
  --control-plane.api-key "$API_KEY_REF"
  --mcp.server-url "http://127.0.0.1:$PORT/mcp"
  --mcp.extra-headers "$HEADER_NAME: $MCP_TOKEN_REF"
  --mcp.discovery-extra-headers "$HEADER_NAME: $MCP_TOKEN_REF"
  --mcp.startup-wait-timeout "$STARTUP_WAIT"
  --health.listen-addr "$HEALTH_ADDR"
)

if [ "$MODE" = "doctor" ]; then
  exec "$TUNNEL_CLIENT_BIN" doctor "${COMMON_ARGS[@]}" --explain
fi

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "[openai-tunnel] local-dev-mcp is not healthy at http://127.0.0.1:$PORT/healthz" >&2
  exit 1
fi

echo "[openai-tunnel] Starting tunnel-client for $TUNNEL_ID -> http://127.0.0.1:$PORT/mcp" >&2
exec "$TUNNEL_CLIENT_BIN" run \
  "${COMMON_ARGS[@]}" \
  --log.level "$LOG_LEVEL" \
  --log.format struct-text
