---
name: web-slurp
description: Capture rendered web pages and script URLs, download browser-authenticated JavaScript assets, beautify webpack or Turbopack bundles, split bundles into modules, rename modules, and inventory reusable CSS/style tokens. Use for website reverse engineering, frontend reconstruction, bundle archaeology, design-system extraction, or requests to inspect how a live web UI is implemented.
---

# Web Slurp

Use the bundled Bun + Commander CLI and its self-contained webpack decomp harness through one stable interface. Keep all generated artifacts in the user's project, never in the skill or harness directory.

## Start safely

1. Confirm the user is authorized to inspect the target and respect authentication, rate limits, terms, and robots guidance.
2. Set an explicit target directory. Never overwrite a prior capture unless the user asks.
3. Install the bundled agent-browser Chromium runtime once, then run the doctor before a first capture:

```bash
SLURP="${SLURP:-$HOME/.agents/skills/web-slurp}"
"$SLURP/scripts/agent-browser.sh" install --with-deps
bun run "$SLURP/src/cli.ts" doctor
```

On Linux ARM64, Chrome for Testing is unavailable. Install distro Chromium and export its path instead:

```bash
apt-get update && apt-get install -y chromium
export AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
```

4. Initialize the artifact contract:

```bash
TARGET="$PWD/targets/example-com"
bun run "$SLURP/src/cli.ts" init "$TARGET"
```

Use absolute paths in every subsequent command.

## Workflow

Capture rendered HTML and browser-discovered script URLs with the bundled agent-browser CLI:

```bash
bun run "$SLURP/src/cli.ts" capture "https://example.com/" "$TARGET"
```

If headless Chromium cannot pass authentication or bot checks, use an authorized Chrome CDP session. Read [capture-troubleshooting.md](references/capture-troubleshooting.md) before switching methods. Use the bundled launcher for Google login or modern Chrome, authenticate manually, then inspect and capture the rendered pages with `"$SLURP/scripts/agent-browser.sh" --cdp 9222`. Download only the reviewed static asset URLs through that session. Stop the dedicated Chrome process when the capture is complete:

```bash
bun run "$SLURP/src/cli.ts" capture-cdp "$TARGET" \
  --page-url "https://example.com/dashboard"

bun run "$SLURP/src/cli.ts" download "$TARGET/input/bundles/script-urls.txt" \
  "$TARGET/input/bundles/raw" \
  --referer "https://example.com/"

"$SLURP/scripts/stop-cdp-chrome.sh"
```

Beautify a selected bundle, then split it. Do not blindly process every bundle: identify runtimes, app chunks, and feature chunks by filename, size, and a quick text search first.

```bash
bun run "$SLURP/src/cli.ts" beautify \
  "$TARGET/input/bundles/raw/app.js" \
  "$TARGET/input/bundles/js-assets/beautified/app.js"

bun run "$SLURP/src/cli.ts" split \
  "$TARGET/input/bundles/js-assets/beautified/app.js" \
  "$TARGET/output/modules/app" \
  --format auto
```

Rename split modules heuristically first. Only enable LLM naming after reviewing the privacy and endpoint implications:

```bash
bun run "$SLURP/src/cli.ts" rename "$TARGET/output/modules/app" --yes --heuristic-only
```

Extract a style inventory after HTML and bundles exist:

```bash
bun run "$SLURP/src/cli.ts" styles "$TARGET" --download-css
```

Serve a live local reference from the captured DOM and same-origin static assets:

```bash
bun run "$SLURP/src/cli.ts" serve "$TARGET" --port 4174
```

The replay server uses the captured HTML and caches same-origin GET and HEAD
requests. It blocks all writes. Do not replace an interactive reference with a
screenshot when the captured DOM and assets are available.

## Operating rules

- Treat `input/` as immutable evidence and write derived artifacts under `output/`.
- Preserve the exact target URL and report the concrete artifact paths in the handoff.
- Captured HTML includes an original-page `<base>` URL and removes replay-invalid `crossorigin` attributes so relative CSS, scripts, images, and links keep working from another origin.
- Prefer `--format auto`; override with `webpack` or `turbopack` only after inspecting the chunk wrapper.
- Download only required origins. Review `script-urls.txt` before authenticated downloads.
- Never commit cookies, browser profiles, `.env` files, tokens, or captured private data.
- Stop on command failure. Do not interpret partial output as a successful capture.
- Use `scripts/agent-browser.sh` for browser commands. Its isolated daemon directory prevents the bundled CLI from conflicting with a global agent-browser installation.
- Stop authenticated CDP Chrome with `scripts/stop-cdp-chrome.sh` when the capture is complete.
- The skill always uses the harness bundled in its `harness/` directory.

## Artifact contract

```text
<target>/
  input/
    page-source/
    bundles/
      raw/
      js-assets/beautified/
  output/
    chunks/
    modules/
    style-inventory/
```

For lazy webpack chunk-map extraction and unusual failures, read [advanced-workflows.md](references/advanced-workflows.md).
