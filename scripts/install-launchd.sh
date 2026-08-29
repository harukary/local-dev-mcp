#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS_DIR="${LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LABEL_PREFIX="${LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX:-io.local-dev-mcp}"
SERVER_LABEL="$LABEL_PREFIX.server"
TUNNEL_LABEL="$LABEL_PREFIX.openai-tunnel"
DOMAIN="gui/$(id -u)"
MODE="install-only"

usage() {
  cat <<'USAGE'
usage: install-launchd.sh [--install-only|--activate]

Installs separate LaunchAgents for the local-dev-mcp HTTP server and the
OpenAI Secure MCP Tunnel client. Credential values remain in private state
files read by wrapper scripts and are never embedded in plist files.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-only) MODE="install-only" ;;
    --activate) MODE="activate" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node is required but was not found in PATH." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
SERVICE_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SERVICE_PORT="${PORT:-3456}"
mkdir -p "$LAUNCH_AGENTS_DIR" "$PROJECT_DIR/logs"

PROJECT_XML="$(xml_escape "$PROJECT_DIR")"
PATH_XML="$(xml_escape "$SERVICE_PATH")"
NODE_XML="$(xml_escape "$NODE_BIN")"
PORT_XML="$(xml_escape "$SERVICE_PORT")"
SERVER_LABEL_XML="$(xml_escape "$SERVER_LABEL")"
TUNNEL_LABEL_XML="$(xml_escape "$TUNNEL_LABEL")"

write_agent() {
  local label="$1"
  local label_xml="$2"
  local service_script="$3"
  local log_name="$4"
  local plist="$LAUNCH_AGENTS_DIR/$label.plist"
  local script_xml log_xml
  script_xml="$(xml_escape "$PROJECT_DIR/scripts/$service_script")"
  log_xml="$(xml_escape "$PROJECT_DIR/logs/$log_name")"

  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$PROJECT_XML/scripts/run-with-rotating-log.mjs</string>
    <string>$log_xml</string>
    <string>--</string>
    <string>/bin/bash</string>
    <string>$script_xml</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_XML</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$PATH_XML</string>
    <key>PORT</key>
    <string>$PORT_XML</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST
  chmod 600 "$plist"
  plutil -lint "$plist" >/dev/null
  echo "Installed $plist"
}

write_agent "$SERVER_LABEL" "$SERVER_LABEL_XML" "server.sh" "mcp-server.log"
write_agent "$TUNNEL_LABEL" "$TUNNEL_LABEL_XML" "tunnel.sh" "openai-tunnel.log"

if [ "$MODE" != "activate" ]; then
  echo "LaunchAgents written but not activated."
  exit 0
fi

for label in "$SERVER_LABEL" "$TUNNEL_LABEL"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done

launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist"

healthy=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$SERVICE_PORT/healthz" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 0.25
done
if [ "$healthy" -ne 1 ]; then
  echo "MCP server did not become healthy; OpenAI Tunnel was not started." >&2
  exit 1
fi

launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$TUNNEL_LABEL.plist"
echo "Activated $SERVER_LABEL and $TUNNEL_LABEL"
