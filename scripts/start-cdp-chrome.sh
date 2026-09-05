#!/bin/sh
set -eu

PORT="${WEB_SLURP_CDP_PORT:-9222}"
PROFILE="${WEB_SLURP_CDP_PROFILE:-/tmp/web-slurp-cdp-profile}"
URL="${1:-about:blank}"

if curl --silent --fail "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  printf 'CDP is already available at http://127.0.0.1:%s\n' "$PORT"
  exit 0
fi

CHROME=""
for candidate in \
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
do
  if [ -x "$candidate" ]; then
    CHROME="$candidate"
    break
  fi
done

if [ -z "$CHROME" ]; then
  printf 'No supported Chrome executable was found in /Applications.\n' >&2
  exit 1
fi

open -na "$CHROME" --args \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$PROFILE" \
  "$URL"

attempt=0
while [ "$attempt" -lt 10 ]; do
  if curl --silent --fail "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    printf 'Chrome CDP ready at http://127.0.0.1:%s\n' "$PORT"
    printf 'Authenticate in the opened Chrome window, then attach with: agent-browser --cdp %s tab\n' "$PORT"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done

printf 'Chrome opened, but CDP did not become available on port %s.\n' "$PORT" >&2
exit 1
