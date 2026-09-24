#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS_DIR="${LOCAL_DEV_MCP_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LABEL_PREFIX="${LOCAL_DEV_MCP_LAUNCHD_LABEL_PREFIX:-io.local-dev-mcp}"
SERVER_LABEL="$LABEL_PREFIX.server"
PERSONAL_TUNNEL_LABEL="$LABEL_PREFIX.openai-tunnel-personal"
BUSINESS_TUNNEL_LABEL="$LABEL_PREFIX.openai-tunnel-business"
BUSINESS_TUNNEL_ENABLE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_ENABLE:-0}"
LEGACY_TUNNEL_LABEL="$LABEL_PREFIX.openai-tunnel"
LEGACY_PERSONAL_MINI_TUNNEL_LABEL="$LABEL_PREFIX.openai-tunnel-personal-mini"
ACTIVATION_LABEL="$LABEL_PREFIX.activate"
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

env_entry() {
  local key="$1"
  local value="$2"
  printf '    <key>%s</key>\n    <string>%s</string>\n' "$(xml_escape "$key")" "$(xml_escape "$value")"
}

is_enabled() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node is required but was not found in PATH." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
SERVICE_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SERVICE_PORT="${PORT:-3456}"
SUBJECT_POLICY="${LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY:-}"
LOG_DIR="${LOCAL_DEV_MCP_LOG_DIR:-$PROJECT_DIR/logs}"
mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

PROJECT_XML="$(xml_escape "$PROJECT_DIR")"
PATH_XML="$(xml_escape "$SERVICE_PATH")"
NODE_XML="$(xml_escape "$NODE_BIN")"
PORT_XML="$(xml_escape "$SERVICE_PORT")"
SERVER_LABEL_XML="$(xml_escape "$SERVER_LABEL")"
PERSONAL_TUNNEL_LABEL_XML="$(xml_escape "$PERSONAL_TUNNEL_LABEL")"
BUSINESS_TUNNEL_LABEL_XML="$(xml_escape "$BUSINESS_TUNNEL_LABEL")"
ACTIVATION_LABEL_XML="$(xml_escape "$ACTIVATION_LABEL")"

write_agent() {
  local label="$1"
  local label_xml="$2"
  local service_script="$3"
  local log_name="$4"
  local extra_env_xml="${5:-}"
  local plist="$LAUNCH_AGENTS_DIR/$label.plist"
  local script_xml log_xml
  script_xml="$(xml_escape "$PROJECT_DIR/scripts/$service_script")"
  log_xml="$(xml_escape "$LOG_DIR/$log_name")"

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
$extra_env_xml
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ExitTimeOut</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST
  chmod 600 "$plist"
  plutil -lint "$plist" >/dev/null
  echo "Installed $plist"
}

TUNNEL_LABELS=("$PERSONAL_TUNNEL_LABEL")
SERVER_EXTRA_ENV=""
if [ -n "$SUBJECT_POLICY" ]; then
  SERVER_EXTRA_ENV="$(env_entry "LOCAL_DEV_MCP_OPENAI_SUBJECT_POLICY" "$SUBJECT_POLICY")"
fi
write_agent "$SERVER_LABEL" "$SERVER_LABEL_XML" "server.sh" "mcp-server.log" "$SERVER_EXTRA_ENV"

PERSONAL_TUNNEL_STATE_DIR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_STATE_DIR:-$HOME/.local-dev-mcp/openai-tunnel-personal}"
PERSONAL_TUNNEL_API_KEY_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_API_KEY_FILE:-$HOME/.openai-tunnels/personal/runtime-api-key}"
PERSONAL_TUNNEL_TOKEN_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_TOKEN_FILE:-$HOME/.local-dev-mcp/openai-tunnel/mcp-token}"
PERSONAL_TUNNEL_HEALTH_ADDR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_PERSONAL_HEALTH_ADDR:-127.0.0.1:3460}"
PERSONAL_TUNNEL_EXTRA_ENV="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR" "$PERSONAL_TUNNEL_STATE_DIR")"
PERSONAL_TUNNEL_EXTRA_ENV+="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE" "$PERSONAL_TUNNEL_API_KEY_FILE")"
PERSONAL_TUNNEL_EXTRA_ENV+="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE" "$PERSONAL_TUNNEL_TOKEN_FILE")"
PERSONAL_TUNNEL_EXTRA_ENV+="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_ADDR" "$PERSONAL_TUNNEL_HEALTH_ADDR")"
write_agent "$PERSONAL_TUNNEL_LABEL" "$PERSONAL_TUNNEL_LABEL_XML" "tunnel.sh" "openai-tunnel-personal.log" "$PERSONAL_TUNNEL_EXTRA_ENV"

if is_enabled "$BUSINESS_TUNNEL_ENABLE"; then
  BUSINESS_TUNNEL_STATE_DIR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_STATE_DIR:-$HOME/.local-dev-mcp/openai-tunnel-business}"
  BUSINESS_TUNNEL_API_KEY_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_API_KEY_FILE:-$HOME/.openai-tunnels/business/runtime-api-key}"
  BUSINESS_TUNNEL_TOKEN_FILE="${LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_TOKEN_FILE:-$HOME/.local-dev-mcp/openai-tunnel/mcp-token}"
  BUSINESS_TUNNEL_HEALTH_ADDR="${LOCAL_DEV_MCP_OPENAI_TUNNEL_BUSINESS_HEALTH_ADDR:-127.0.0.1:3462}"
  BUSINESS_TUNNEL_EXTRA_ENV="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_STATE_DIR" "$BUSINESS_TUNNEL_STATE_DIR")"
  BUSINESS_TUNNEL_EXTRA_ENV+="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_API_KEY_FILE" "$BUSINESS_TUNNEL_API_KEY_FILE")"
  BUSINESS_TUNNEL_EXTRA_ENV+="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_TOKEN_FILE" "$BUSINESS_TUNNEL_TOKEN_FILE")"
  BUSINESS_TUNNEL_EXTRA_ENV+="$(env_entry "LOCAL_DEV_MCP_OPENAI_TUNNEL_HEALTH_ADDR" "$BUSINESS_TUNNEL_HEALTH_ADDR")"
  write_agent "$BUSINESS_TUNNEL_LABEL" "$BUSINESS_TUNNEL_LABEL_XML" "tunnel.sh" "openai-tunnel-business.log" "$BUSINESS_TUNNEL_EXTRA_ENV"
  TUNNEL_LABELS+=("$BUSINESS_TUNNEL_LABEL")
fi

if [ "$MODE" != "activate" ]; then
  echo "LaunchAgents written but not activated."
  exit 0
fi

ACTIVATION_LOG="$LOG_DIR/launchd-activate.log"
ACTIVATION_ERROR_LOG="$LOG_DIR/launchd-activate-error.log"
ACTIVATION_PLIST="$LOG_DIR/.launchd-activate.plist"
: > "$ACTIVATION_LOG"
: > "$ACTIVATION_ERROR_LOG"

# Remove a previously loaded one-shot helper before replacing it. The helper is
# an explicit RunAtLoad LaunchAgent without KeepAlive; launchctl submit is not
# used because submitted jobs get implicit keepalive semantics on macOS.
launchctl bootout "$DOMAIN/$ACTIVATION_LABEL" 2>/dev/null || launchctl remove "$ACTIVATION_LABEL" 2>/dev/null || true

ACTIVATION_WORKER_XML="$(xml_escape "$PROJECT_DIR/scripts/activate-launchd-worker.sh")"
ACTIVATION_PLIST_XML="$(xml_escape "$ACTIVATION_PLIST")"
DOMAIN_XML="$(xml_escape "$DOMAIN")"
LAUNCH_AGENTS_DIR_XML="$(xml_escape "$LAUNCH_AGENTS_DIR")"
LEGACY_TUNNEL_LABEL_XML="$(xml_escape "$LEGACY_TUNNEL_LABEL")"
LEGACY_PERSONAL_MINI_TUNNEL_LABEL_XML="$(xml_escape "$LEGACY_PERSONAL_MINI_TUNNEL_LABEL")"
ACTIVATION_LOG_XML="$(xml_escape "$ACTIVATION_LOG")"
ACTIVATION_ERROR_LOG_XML="$(xml_escape "$ACTIVATION_ERROR_LOG")"
TUNNEL_ARGUMENTS_XML=""
for label in "${TUNNEL_LABELS[@]}"; do
  TUNNEL_ARGUMENTS_XML+="    <string>$(xml_escape "$label")</string>"$'\n'
done

cat > "$ACTIVATION_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$ACTIVATION_LABEL_XML</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ACTIVATION_WORKER_XML</string>
    <string>$DOMAIN_XML</string>
    <string>$LAUNCH_AGENTS_DIR_XML</string>
    <string>$ACTIVATION_PLIST_XML</string>
    <string>$SERVER_LABEL_XML</string>
    <string>$PORT_XML</string>
    <string>$LEGACY_TUNNEL_LABEL_XML</string>
    <string>$LEGACY_PERSONAL_MINI_TUNNEL_LABEL_XML</string>
$TUNNEL_ARGUMENTS_XML  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_XML</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$ACTIVATION_LOG_XML</string>
  <key>StandardErrorPath</key>
  <string>$ACTIVATION_ERROR_LOG_XML</string>
</dict>
</plist>
PLIST
chmod 600 "$ACTIVATION_PLIST"
plutil -lint "$ACTIVATION_PLIST" >/dev/null
launchctl bootstrap "$DOMAIN" "$ACTIVATION_PLIST"

echo "Activation handed off to one-shot launchd job $ACTIVATION_LABEL."
echo "Logs: $ACTIVATION_LOG and $ACTIVATION_ERROR_LOG"
