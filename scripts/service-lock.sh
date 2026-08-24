#!/bin/bash

# Shared best-effort single-instance lock for long-lived local-dev-mcp services.
# The lock contains the wrapper PID. A stale lock is reclaimed on the next start.

SERVICE_LOCK_DIR=""
SERVICE_LOCK_OWNED=0

release_service_lock() {
  if [ "$SERVICE_LOCK_OWNED" -ne 1 ] || [ -z "$SERVICE_LOCK_DIR" ]; then
    return
  fi

  local owner_pid
  owner_pid="$(cat "$SERVICE_LOCK_DIR/pid" 2>/dev/null || true)"
  if [ "$owner_pid" = "$$" ]; then
    rm -f "$SERVICE_LOCK_DIR/pid"
    rmdir "$SERVICE_LOCK_DIR" 2>/dev/null || true
  fi
  SERVICE_LOCK_OWNED=0
}

acquire_service_lock() {
  local lock_dir="$1"
  local service_name="$2"
  local attempt owner_pid stale_lock_dir

  SERVICE_LOCK_DIR="$lock_dir"
  mkdir -p "$(dirname "$SERVICE_LOCK_DIR")"

  for attempt in 1 2; do
    if mkdir "$SERVICE_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" > "$SERVICE_LOCK_DIR/pid"
      SERVICE_LOCK_OWNED=1
      return 0
    fi

    owner_pid="$(cat "$SERVICE_LOCK_DIR/pid" 2>/dev/null || true)"
    if [[ "$owner_pid" =~ ^[0-9]+$ ]] && kill -0 "$owner_pid" 2>/dev/null; then
      echo "[$service_name] Another instance is already running (pid: $owner_pid)." >&2
      return 75
    fi

    stale_lock_dir="${SERVICE_LOCK_DIR}.stale.$$"
    if mv "$SERVICE_LOCK_DIR" "$stale_lock_dir" 2>/dev/null; then
      rm -f "$stale_lock_dir/pid"
      rmdir "$stale_lock_dir" 2>/dev/null || {
        echo "[$service_name] Stale lock is not empty: $stale_lock_dir" >&2
        return 1
      }
    fi
  done

  echo "[$service_name] Could not acquire service lock: $SERVICE_LOCK_DIR" >&2
  return 75
}
