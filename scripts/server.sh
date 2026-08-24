#!/bin/bash
set -euo pipefail

PORT="${PORT:-3456}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DEVICE_BIN="$PROJECT_DIR/node_modules/.bin/agent-device"
IOS_AGENT_STATE_DIR="${LOCAL_DEV_MCP_IOS_AGENT_STATE_DIR:-$HOME/.local-dev-mcp/runtime/agent-device-ios}"
ANDROID_AGENT_STATE_DIR="${LOCAL_DEV_MCP_ANDROID_AGENT_STATE_DIR:-$HOME/.local-dev-mcp/runtime/agent-device-android}"
SERVER_LOCK_DIR="${LOCAL_DEV_MCP_SERVER_LOCK_DIR:-$HOME/.local-dev-mcp/runtime/server.lock}"
MCP_PID=""
CLEANED_UP=0

# shellcheck source=./service-lock.sh
source "$PROJECT_DIR/scripts/service-lock.sh"

PROJECTS_CONFIG="${LOCAL_DEV_MCP_PROJECTS_CONFIG:-}"
if [ -z "$PROJECTS_CONFIG" ]; then
  if [ -f "$PROJECT_DIR/config/projects.local.yaml" ]; then
    PROJECTS_CONFIG="$PROJECT_DIR/config/projects.local.yaml"
  else
    PROJECTS_CONFIG="$PROJECT_DIR/config/projects.yaml"
  fi
fi

cleanup_agent_device_daemons() {
  if [ ! -x "$AGENT_DEVICE_BIN" ]; then
    return
  fi
  "$AGENT_DEVICE_BIN" daemon stop --state-dir "$IOS_AGENT_STATE_DIR" --clean >/dev/null 2>&1 || true
  "$AGENT_DEVICE_BIN" daemon stop --state-dir "$ANDROID_AGENT_STATE_DIR" --clean >/dev/null 2>&1 || true
}

describe_port_owner() {
  if ! command -v lsof >/dev/null 2>&1; then
    return
  fi
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

cleanup() {
  if [ "$CLEANED_UP" -eq 1 ]; then
    return
  fi
  CLEANED_UP=1

  if [ -n "$MCP_PID" ] && kill -0 "$MCP_PID" 2>/dev/null; then
    kill "$MCP_PID" 2>/dev/null || true
    wait "$MCP_PID" 2>/dev/null || true
  fi
  cleanup_agent_device_daemons
  release_service_lock
}
trap cleanup EXIT INT TERM

acquire_service_lock "$SERVER_LOCK_DIR" "server"

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[server] Port $PORT is already in use; refusing to start a competing MCP server." >&2
  describe_port_owner >&2
  exit 75
fi

# src/index.ts loads the project's environment file itself. Keep this wrapper
# free of secret-file handling so launchd only needs a stable executable path.
cleanup_agent_device_daemons

echo "[server] Starting MCP server on port $PORT..." >&2
cd "$PROJECT_DIR"
node --import tsx src/index.ts "$PROJECTS_CONFIG" --http "$PORT" &
MCP_PID=$!

status=0
if wait "$MCP_PID"; then
  status=0
else
  status=$?
fi
MCP_PID=""

if [ "$status" -ne 0 ]; then
  echo "[server] MCP server exited unexpectedly (status: $status)." >&2
fi
exit "$status"
