# web-slurp

Capture a rendered website, inspect its scripts and styles, and keep a local reference for frontend reconstruction.

## Install

Requires Bun and Python 3. From a persistent checkout or unpacked package directory:

```bash
./setup
```

Setup installs locked JavaScript dependencies and Chromium, checks the runtime, and creates:

- `~/.local/bin/web-slurp` → the package CLI
- `~/.agents/skills/web-slurp` → this package directory, including `SKILL.md` and its references

Keep the package directory in place. Add `~/.local/bin` to your shell's `PATH` if setup reports it missing. Installation creates no agent hooks and makes no changes to shell configuration.

If a skill or CLI already exists, setup stops. Use `./setup --backup-existing` to move conflicts to unique backups before creating links. Backups are stored in `web-slurp-backups/` beside the registration directory (for example, `~/.agents/web-slurp-backups/`), outside skill discovery. Repeating setup keeps existing links. Override registration locations with `--skills-dir <dir>` and `--bin-dir <dir>`.

For authenticated asset downloads, use `./setup --with-cdp`; this installs `websocket-client` in a package-local Python virtual environment. Other Python commands use the same environment when it exists. Use `--skip-browser` for machines that only analyze existing bundles; capture still needs Chromium. See [browser troubleshooting](references/capture-troubleshooting.md) for Linux ARM64 or missing system libraries.

## First capture

```bash
web-slurp capture https://example.com --out ./targets/example
web-slurp styles ./targets/example
web-slurp serve ./targets/example --live-assets
```

Style extraction reuses captured CSS, including authenticated stylesheets; `--download-css` fetches missing linked styles when needed.

Capture saves rendered HTML, a viewport screenshot, script/stylesheet URL lists, and observed static assets (scripts, CSS, images, and fonts). `input/assets/manifest.json` records saved files and failures. Chrome may revalidate an already-observed resource while retrieving its content; capture does not deliberately crawl additional URLs or save API responses.

Replay serves captured same-origin and CDN assets locally, including rewritten CSS URLs. Omit `--live-assets` for offline use; add it only to fetch missing same-origin static paths. Live APIs, unvisited states, and some script-driven behavior are not reproduced.

For an agent, ask: “Use web-slurp to capture this page and explain its layout and styles.” The installed skill guides the workflow.

Capture waits for network idle. To wait for an application-specific state:

```bash
web-slurp capture https://example.com/dashboard --out ./targets/dashboard \
  --wait-until domcontentloaded --wait-for '#dashboard-ready'
```

For a protected page, use a persistent Chrome profile and a selector that identifies the signed-in UI:

```bash
web-slurp capture https://example.com/dashboard --out ./targets/dashboard \
  --profile work --wait-for '#dashboard-ready'
web-slurp browser close --profile work
```

Sign in in the opened Chrome window; capture resumes automatically. Cookies survive browser restarts. If login redirects to another URL, specify it with `--ready-url`. A timeout or Ctrl-C preserves the browser session and allows retrying the same target when no evidence was saved. See [authentication and profiles](references/capture-troubleshooting.md).

Use a new output directory for each capture. Existing evidence is protected, including partially written evidence from a failed attempt. An interrupted process can leave `.capture-lock`; remove that empty lock directory only after confirming no capture is running.

```text
<target>/
  input/
    page-source/           rendered DOM, page.png, capture-metadata.json
    assets/                static bytes and manifest.json
    bundles/               script-urls.txt and stylesheet-urls.txt
      raw/
      js-assets/beautified/
  output/
    chunks/
    modules/
    style-inventory/
    replay-cache-v2/
```

## Responsive capture and visual comparison

```bash
web-slurp capture-responsive https://example.com --out ./targets/example-responsive
web-slurp compare ./targets/example-responsive/desktop http://localhost:3000 --out ./targets/comparison
```

Responsive capture writes desktop (1440×900) and mobile (390×844) references plus `responsive.json`. These are viewport layouts, not device emulators. For other sizes, use `capture --viewport 1280x800`; `--device-scale-factor 2` captures Retina density. Profile captures support the same viewports.

Comparison captures the local page at the reference viewport and pixel density. It writes `output/diff.png` and `output/comparison.json`, including changed-pixel percentage and the largest regions to inspect. It does not infer why pixels differ or verify application behavior. Use the same UI state; animations and changing content can contribute differences.

## Capture an interaction walkthrough

Create `steps.json`:

```json
[
  {"name":"initial", "waitFor":"#app-ready"},
  {"name":"menu-open", "click":"#menu-button", "waitFor":"#menu-panel"},
  {"name":"card-hover", "hover":".card"},
  {"name":"details", "scroll":"#details"}
]
```

```bash
web-slurp flow https://example.com --steps steps.json --out ./targets/example-flow
```

Each step saves its own DOM, screenshot, and static assets under `states/<name>`. `flow.json` records their order and completion; failed flows retain completed states. Only top-level CSS selectors are supported. Actions are explicit: review the steps before running them on a live site. Supply `waitFor` for a specific post-action state; two paint frames do not establish that a long animation has finished.

For authenticated flows, sign in with `browser open` first, then add `--profile <name>` and give the first step a selector unique to the signed-in page. `--timeout <seconds>` controls each readiness wait. Unnamed flow browsers are closed automatically; named profiles stay open for reuse.

## Bundle inspection

Select the relevant app bundle from the URL list before downloading. For public assets, use an ordinary HTTP downloader; for authenticated assets, follow the [CDP workflow](references/capture-troubleshooting.md).

```bash
web-slurp beautify ./targets/example/input/bundles/raw/app.js ./targets/example/output/app.js
web-slurp split ./targets/example/output/app.js ./targets/example/output/modules/app --format auto
web-slurp rename ./targets/example/output/modules/app --yes --heuristic-only
```

The bundled splitters handle webpack and Turbopack wrappers. They do not reconstruct original source files or support every bundler. See [advanced workflows](references/advanced-workflows.md).

## Update and uninstall

For a clean Git checkout with an upstream configured:

```bash
web-slurp update
web-slurp uninstall
```

Update uses `git pull --ff-only` and reruns setup with locked dependencies. It refuses dirty checkouts. Pass the same custom registration flags used during setup if applicable. For an unpacked package, replace it using your package manager and rerun setup.

Uninstall removes only links pointing to this package. It leaves source files, browser caches, Python dependencies, captures, and unique backups intact. Restore an earlier installation by moving its backup back after uninstalling.

## Develop

```bash
bun install --frozen-lockfile
bun run check
bun test
```

Tests include real Chromium captures of local fixtures and a regular Chrome profile login/restart test, so install the browser first and have regular Chrome available (or set `WEB_SLURP_CHROME`). They check sign-in resumption and profile reuse, dynamic imports and static bytes, evidence preservation, symlink registration, offline CDN replay, viewport fidelity, visual differences, and interaction states. `bun pm pack` produces a distributable archive; publishing and repository hosting are separate steps.
