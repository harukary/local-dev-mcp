#!/bin/bash
set -euo pipefail

if [ "$#" -lt 8 ]; then
  echo "usage: activate-launchd-worker.sh DOMAIN LAUNCH_AGENTS_DIR ACTIVATION_PLIST SERVER_LABEL SERVICE_PORT LEGACY_TUNNEL_LABEL LEGACY_PERSONAL_MINI_TUNNEL_LABEL TUNNEL_LABEL..." >&2
  exit 64
fi

DOMAIN="$1"
LAUNCH_AGENTS_DIR="$2"
ACTIVATION_PLIST="$3"
SERVER_LABEL="$4"
SERVICE_PORT="$5"
LEGACY_TUNNEL_LABEL="$6"
LEGACY_PERSONAL_MINI_TUNNEL_LABEL="$7"
shift 7
TUNNEL_LABELS=("$@")

# The installer can be invoked from local-dev-mcp itself. Give the caller time
# to return its MCP response, then perform the disruptive restart from this
# independent launchd-owned worker instead of a descendant of the server job.
sleep 1
# The activation plist lives outside ~/Library/LaunchAgents, but remove it as
# soon as launchd has loaded the job so no stale handoff file remains.
rm -f "$ACTIVATION_PLIST"

for label in "$SERVER_LABEL" "$LEGACY_TUNNEL_LABEL" "$LEGACY_PERSONAL_MINI_TUNNEL_LABEL" "${TUNNEL_LABELS[@]}"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done

launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist"

healthy=0
for _ in $(seq 1 60); do
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

for label in "${TUNNEL_LABELS[@]}"; do
  launchctl bootstrap "$DOMAIN" "$LAUNCH_AGENTS_DIR/$label.plist"
done

rm -f "$LAUNCH_AGENTS_DIR/$LEGACY_TUNNEL_LABEL.plist" "$LAUNCH_AGENTS_DIR/$LEGACY_PERSONAL_MINI_TUNNEL_LABEL.plist"
echo "Activated $SERVER_LABEL and ${TUNNEL_LABELS[*]}"
