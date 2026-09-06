#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${WEB_SLURP_CDP_PORT:-}${WEB_SLURP_CDP_PROFILE:-}" ]; then
  echo 'Use WEB_SLURP_PROFILE=<name> and WEB_SLURP_PROFILE_ROOT=<directory>; CDP ports are now selected and verified automatically.' >&2
  exit 1
fi
exec "$SCRIPT_DIR/web-slurp" browser open "${1:-about:blank}" --profile "${WEB_SLURP_PROFILE:-default}"
