#!/bin/sh
# Integration check: no Bun or uv from the developer/CI environment.
set -eu
slurp_test=$(mktemp -d)
trap 'rm -rf "$slurp_test"' EXIT HUP INT TERM
bun pm pack --destination "$slurp_test" >/dev/null
tar -xzf "$slurp_test"/web-slurp-*.tgz -C "$slurp_test"
cd "$slurp_test/package"
for attempt in 1 2; do
  env PATH=/usr/bin:/bin:/usr/sbin:/sbin sh ./setup --skip-browser --with-cdp \
    --skills-dir "$slurp_test/skills" --bin-dir "$slurp_test/bin"
done
env PATH=/usr/bin:/bin "$slurp_test/bin/web-slurp" --version
.venv/bin/python3 -c 'import websocket, sys; assert sys.prefix != sys.base_prefix'
env PATH=/usr/bin:/bin "$slurp_test/bin/web-slurp" init "$slurp_test/capture"
printf '%s\n' '<!doctype html><html><head><style>body { color: red; }</style></head><body>Fixture</body></html>' > "$slurp_test/capture/input/page-source/fixture.html"
env PATH=/usr/bin:/bin "$slurp_test/bin/web-slurp" styles "$slurp_test/capture"
env PATH=/usr/bin:/bin "$slurp_test/bin/web-slurp" uninstall \
  --skills-dir "$slurp_test/skills" --bin-dir "$slurp_test/bin"
[ ! -L "$slurp_test/bin/web-slurp" ]
echo 'Clean bootstrap, repeat setup, Python command, and uninstall passed.'
