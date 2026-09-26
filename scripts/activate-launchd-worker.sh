#!/bin/bash
set -euo pipefail

if [ "$#" -lt 8 ]; then
  echo "usage: activate-launchd-worker.sh DOMAIN LAUNCH_AGENTS_DIR ACTIVATION_PLIST SERVER_LABEL SERVICE_PORT LEGACY_TUNNEL_LABEL LEGACY_PERSONAL_MINI_TUNNEL_LABEL PERSONAL_TUNNEL_LABEL [TUNNEL_LABEL...]" >&2
  exit 64
fi

DOMAIN="$1"
LAUNCH_AGENTS_DIR="$2"
ACTIVATION_PLIST="$3"
SERVER_LABEL="$4"
SERVICE_PORT="$5"
LEGACY_TUNNEL_LABEL="$6"
LEGACY_PERSONAL_MINI_TUNNEL_LABEL="$7"
PERSONAL_TUNNEL_LABEL="$8"
shift 8
TUNNEL_LABELS=("$@")

wait_for_unload() {
  local label="$1"
  for _ in $(seq 1 240); do
    if ! launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for $label to unload from launchd." >&2
  return 1
}

bootstrap_with_retry() {
  local label="$1"
  local plist="$2"
  local last_error=""
  for _ in $(seq 1 240); do
    if last_error="$(launchctl bootstrap "$DOMAIN" "$plist" 2>&1)"; then
      return 0
    fi
    # wait_for_unload has already proven the old job disappeared. If the label
    # becomes visible after a failed bootstrap, it can only be the new job.
    if launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "Failed to bootstrap $label after launchd released the previous job." >&2
  if [ -n "$last_error" ]; then
    echo "$last_error" >&2
  fi
  return 1
}

# The installer can be invoked from local-dev-mcp itself. Give the caller time
# to return its MCP response, then perform the disruptive restart from this
# independent launchd-owned worker instead of a descendant of the server job.
sleep 1
# The activation plist lives outside ~/Library/LaunchAgents, but remove it as
# soon as launchd has loaded the job so no stale handoff file remains.
rm -f "$ACTIVATION_PLIST"

for label in "$SERVER_LABEL" "$LEGACY_TUNNEL_LABEL" "$LEGACY_PERSONAL_MINI_TUNNEL_LABEL" "$PERSONAL_TUNNEL_LABEL" "${TUNNEL_LABELS[@]}"; do
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
done

wait_for_unload "$SERVER_LABEL"
bootstrap_with_retry "$SERVER_LABEL" "$LAUNCH_AGENTS_DIR/$SERVER_LABEL.plist"

healthy=0
for _ in $(seq 1 240); do
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
  wait_for_unload "$label"
  bootstrap_with_retry "$label" "$LAUNCH_AGENTS_DIR/$label.plist"
done

rm -f "$LAUNCH_AGENTS_DIR/$LEGACY_TUNNEL_LABEL.plist" "$LAUNCH_AGENTS_DIR/$LEGACY_PERSONAL_MINI_TUNNEL_LABEL.plist"
personal_enabled=0
for label in "${TUNNEL_LABELS[@]}"; do
  if [ "$label" = "$PERSONAL_TUNNEL_LABEL" ]; then
    personal_enabled=1
  fi
done
if [ "$personal_enabled" -eq 0 ]; then
  rm -f "$LAUNCH_AGENTS_DIR/$PERSONAL_TUNNEL_LABEL.plist"
fi
echo "Activated $SERVER_LABEL and ${TUNNEL_LABELS[*]}"
