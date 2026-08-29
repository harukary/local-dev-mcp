#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR:-$HOME/.local-dev-mcp/openai-tunnel}"
TOKEN_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE:-$STATE_DIR/mcp-token}"
RUNTIME_DIR="${LOCAL_DEV_MCP_RUNTIME_DIR:-$HOME/.local-dev-mcp/runtime}"
export LOCAL_DEV_MCP_SERVER_LOCK_DIR="${LOCAL_DEV_MCP_SERVER_LOCK_DIR:-$RUNTIME_DIR/openai-tunnel-server.lock}"
export LOCAL_DEV_MCP_IOS_AGENT_STATE_DIR="${LOCAL_DEV_MCP_IOS_AGENT_STATE_DIR:-$RUNTIME_DIR/openai-tunnel-agent-device-ios}"
export LOCAL_DEV_MCP_ANDROID_AGENT_STATE_DIR="${LOCAL_DEV_MCP_ANDROID_AGENT_STATE_DIR:-$RUNTIME_DIR/openai-tunnel-agent-device-android}"

if [ -n "${LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN:-}" ]; then
  unset LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE
elif [ ! -f "$TOKEN_FILE" ]; then
  echo "[openai-tunnel-server] MCP tunnel token file not found: $TOKEN_FILE" >&2
  exit 1
else
  export LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE="$TOKEN_FILE"
fi

export LOCAL_DEV_MCP_AUTH_MODE=openai-tunnel
exec /bin/bash "$PROJECT_DIR/scripts/server.sh"
