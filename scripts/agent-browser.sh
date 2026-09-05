#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SLURP_DIR=$(dirname -- "$SCRIPT_DIR")
WEB_SLURP_SOCKET_DIR="${WEB_SLURP_AGENT_BROWSER_SOCKET_DIR:-/tmp/ws-ab-$(id -u)}"

mkdir -p "$WEB_SLURP_SOCKET_DIR"
export AGENT_BROWSER_SOCKET_DIR="$WEB_SLURP_SOCKET_DIR"

exec bun run "$SLURP_DIR/node_modules/agent-browser/bin/agent-browser.js" "$@"
