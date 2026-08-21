#!/bin/bash
set -euo pipefail

PORT="${PORT:-3456}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DEVICE_BIN="$PROJECT_DIR/node_modules/.bin/agent-device"
IOS_AGENT_STATE_DIR="${LOCAL_DEV_MCP_IOS_AGENT_STATE_DIR:-$HOME/.local-dev-mcp/runtime/agent-device-ios}"
ANDROID_AGENT_STATE_DIR="${LOCAL_DEV_MCP_ANDROID_AGENT_STATE_DIR:-$HOME/.local-dev-mcp/runtime/agent-device-android}"
LAUNCHER_LOCK_DIR="${LOCAL_DEV_MCP_LAUNCHER_LOCK_DIR:-$HOME/.local-dev-mcp/runtime/tunnel-launcher.lock}"
LAUNCHER_LOCK_OWNED=0

if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

TUNNEL_ID="${LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID:-}"
if [ -n "${LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE:-}" ]; then
  TUNNEL_CREDENTIALS_FILE="$LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE"
elif [ -f "$HOME/.cloudflared/local-dev-mcp.json" ]; then
  TUNNEL_CREDENTIALS_FILE="$HOME/.cloudflared/local-dev-mcp.json"
else
  TUNNEL_CREDENTIALS_FILE="$HOME/.cloudflared/tunnel-credentials.json"
fi
PROJECTS_CONFIG="${LOCAL_DEV_MCP_PROJECTS_CONFIG:-}"

if [ -z "$PROJECTS_CONFIG" ]; then
  if [ -f "$PROJECT_DIR/config/projects.local.yaml" ]; then
    PROJECTS_CONFIG="$PROJECT_DIR/config/projects.local.yaml"
  else
    PROJECTS_CONFIG="$PROJECT_DIR/config/projects.yaml"
  fi
fi

if [ -z "$TUNNEL_ID" ] && [ -f "$TUNNEL_CREDENTIALS_FILE" ]; then
  TUNNEL_ID="$(node -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(j.TunnelID || "")' "$TUNNEL_CREDENTIALS_FILE")"
fi

if [ -z "$TUNNEL_ID" ]; then
  echo "[tunnel] LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID is required, or credentials file must contain TunnelID." >&2
  exit 1
fi

if [ ! -f "$TUNNEL_CREDENTIALS_FILE" ]; then
  echo "[tunnel] Cloudflare tunnel credentials file not found: $TUNNEL_CREDENTIALS_FILE" >&2
  exit 1
fi

release_launcher_lock() {
  if [ "$LAUNCHER_LOCK_OWNED" -ne 1 ]; then
    return
  fi

  local owner_pid
  owner_pid="$(cat "$LAUNCHER_LOCK_DIR/pid" 2>/dev/null || true)"
  if [ "$owner_pid" = "$$" ]; then
    rm -f "$LAUNCHER_LOCK_DIR/pid"
    rmdir "$LAUNCHER_LOCK_DIR" 2>/dev/null || true
  fi
  LAUNCHER_LOCK_OWNED=0
}

acquire_launcher_lock() {
  local attempt owner_pid stale_lock_dir
  mkdir -p "$(dirname "$LAUNCHER_LOCK_DIR")"

  for attempt in 1 2; do
    if mkdir "$LAUNCHER_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$LAUNCHER_LOCK_DIR/pid"
      LAUNCHER_LOCK_OWNED=1
      trap release_launcher_lock EXIT
      return
    fi

    owner_pid="$(cat "$LAUNCHER_LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      echo "[tunnel] Another launcher is already running (pid: $owner_pid)." >&2
      exit 75
    fi

    stale_lock_dir="${LAUNCHER_LOCK_DIR}.stale.$$"
    if mv "$LAUNCHER_LOCK_DIR" "$stale_lock_dir" 2>/dev/null; then
      rm -f "$stale_lock_dir/pid"
      rmdir "$stale_lock_dir" 2>/dev/null || {
        echo "[tunnel] Stale launcher lock is not empty: $stale_lock_dir" >&2
        exit 1
      }
    fi
  done

  echo "[tunnel] Could not acquire launcher lock: $LAUNCHER_LOCK_DIR" >&2
  exit 75
}

cleanup_agent_device_daemons() {
  if [ ! -x "$AGENT_DEVICE_BIN" ]; then
    return
  fi
  "$AGENT_DEVICE_BIN" daemon stop --state-dir "$IOS_AGENT_STATE_DIR" --clean >/dev/null 2>&1 || true
  "$AGENT_DEVICE_BIN" daemon stop --state-dir "$ANDROID_AGENT_STATE_DIR" --clean >/dev/null 2>&1 || true
}

# local-dev-mcp exclusively owns these state directories. Clear retained
# runners/leases before the server starts so a prior restart cannot leave a
# device claim bound to an orphaned daemon.
acquire_launcher_lock
cleanup_agent_device_daemons

echo "[tunnel] Starting MCP server on port $PORT..." >&2
cd "$PROJECT_DIR"
node --import tsx src/index.ts "$PROJECTS_CONFIG" --http "$PORT" &
MCP_PID=$!

echo "[tunnel] Starting Cloudflare Tunnel (named: local-dev-mcp)..." >&2
cloudflared tunnel --config <(cat <<YAML
tunnel: $TUNNEL_ID
credentials-file: $TUNNEL_CREDENTIALS_FILE
url: http://localhost:$PORT
no-autoupdate: true
log-level: info
YAML
) run &
CLOUDFLARE_PID=$!

cleanup_children() {
  kill "$MCP_PID" "$CLOUDFLARE_PID" 2>/dev/null || true
  wait "$MCP_PID" 2>/dev/null || true
  wait "$CLOUDFLARE_PID" 2>/dev/null || true
  cleanup_agent_device_daemons
}

is_process_running() {
  local pid="$1"
  local stat
  stat="$(ps -p "$pid" -o stat= 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$stat" ] && [[ "$stat" != Z* ]]
}

trap "echo '[tunnel] Shutting down...' >&2; cleanup_children; exit 0" SIGINT SIGTERM

while true; do
  if ! is_process_running "$MCP_PID"; then
    wait "$MCP_PID" 2>/dev/null || true
    echo "[tunnel] MCP server exited unexpectedly." >&2
    cleanup_children
    exit 1
  fi

  if ! is_process_running "$CLOUDFLARE_PID"; then
    wait "$CLOUDFLARE_PID" 2>/dev/null || true
    echo "[tunnel] Cloudflare tunnel exited unexpectedly." >&2
    cleanup_children
    exit 1
  fi

  sleep 1
done
