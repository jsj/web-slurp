#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -n "${WEB_SLURP_CDP_PORT:-}${WEB_SLURP_CDP_PROFILE:-}" ]; then
  echo 'Use WEB_SLURP_PROFILE=<name>; only the verified browser belonging to that profile will be closed.' >&2
  exit 1
fi
exec "$SCRIPT_DIR/web-slurp" browser close --profile "${WEB_SLURP_PROFILE:-default}"
