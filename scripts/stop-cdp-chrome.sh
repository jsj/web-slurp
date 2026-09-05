#!/bin/sh
set -eu

PORT="${WEB_SLURP_CDP_PORT:-9222}"
PROFILE="${WEB_SLURP_CDP_PROFILE:-/tmp/web-slurp-cdp-profile}"

CANDIDATES=$(pgrep -f "remote-debugging-port=$PORT" || true)
PIDS=""
for pid in $CANDIDATES; do
  command=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$command" in
    *"--remote-debugging-port=$PORT"*"--user-data-dir=$PROFILE"*)
      PIDS="$PIDS $pid"
      ;;
  esac
done

if [ -z "$PIDS" ]; then
  printf 'No web-slurp Chrome process found on port %s with profile %s\n' "$PORT" "$PROFILE"
  exit 0
fi

for pid in $PIDS; do
  kill -TERM "$pid"
done

attempt=0
while [ "$attempt" -lt 10 ]; do
  remaining=""
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      remaining="$remaining $pid"
    fi
  done
  if [ -z "$remaining" ]; then
    printf 'Stopped web-slurp Chrome on port %s\n' "$PORT"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

printf 'Chrome did not stop after 10 seconds; still running:%s\n' "$remaining" >&2
exit 1
