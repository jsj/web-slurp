# Usage guide

Capture a rendered website, inspect its scripts and styles, and keep a local reference for frontend reconstruction.

## Install

Setup downloads a private Bun runtime and creates a local Python environment. From a persistent checkout or unpacked package directory:

```bash
./setup
```

Setup installs Bun under `.runtime/`, Python under `.venv/`, locked JavaScript dependencies, and Chromium, checks the runtime, and creates:

- `~/.local/bin/web-slurp` → the package CLI launcher
- `~/.agents/skills/web-slurp` → this package directory, including `SKILL.md` and its references

Setup copies the package to `~/.web-slurp`; the original checkout can move or be removed. Set `WEB_SLURP_INSTALL_DIR` to override the installation directory. Add `~/.local/bin` to your shell's `PATH` if setup reports it missing. Installation creates no agent hooks and makes no changes to shell configuration.

If a skill or CLI already exists, setup stops. Use `./setup --backup-existing` to move conflicts to unique backups before creating links. Backups are stored in `web-slurp-backups/` beside the registration directory (for example, `~/.agents/web-slurp-backups/`), outside skill discovery. Repeating setup keeps existing links. Override registration locations with `--skills-dir <dir>` and `--bin-dir <dir>`.

For authenticated asset downloads, use `./setup --with-cdp`; this installs `websocket-client` in a package-local Python virtual environment. Other Python commands use the same environment when it exists. Use `--skip-browser` for machines that only analyze existing bundles; capture still needs Chromium. See [browser troubleshooting](capture-troubleshooting.md) for Linux ARM64 or missing system libraries.

## First capture

```bash
web-slurp capture https://example.com --out ./targets/example
web-slurp styles ./targets/example
web-slurp serve ./targets/example
```

Style extraction reuses captured CSS, including authenticated stylesheets; `--download-css` fetches missing linked styles when needed.

Capture saves rendered HTML, a viewport screenshot, script/stylesheet URL lists, and observed static assets (scripts, CSS, images, and fonts). `input/assets/manifest.json` records saved files and failures. Chrome may revalidate an already-observed resource while retrieving its content; capture does not deliberately crawl additional URLs or save API responses.

### Motion evidence

```bash
web-slurp capture https://example.com --out ./targets/example-motion --motion
# Or inspect an already authorized browser page:
web-slurp capture-cdp ./targets/page-motion --cdp http://127.0.0.1:9222 --page-url https://example.com/ --motion
```

The opt-in motion probe runs after the initial screenshot and asset capture. It
scrolls down and back, then restores the original scroll position. Lazy loading
and one-shot reveals may change page state; the initial screenshot remains the
reference. It writes `input/motion/runtime.json` with source URL, viewport,
requested and observed scroll positions, warnings, and:

- Web Animations timing and keyframes, with `infiniteIterations` preserving infinite repeats.
- Hover and animation/transition rules from accessible CSSOM, including nested rules and keyframes.
- Exposed GSAP timeline timings and ScrollTrigger ranges. Function-valued easing remains unresolved.
- Inline-style samples classified per property as `scroll-candidate`, `latched-candidate`, or `unverified`.

Candidates require stable stationary samples and matching return values; one-shot
reveals may remain latched. Properties that keep changing or fail to repeat stay
unverified. These controls reduce timer confusion but do not prove causation.
Sampling is bounded to 500 inline-style nodes and 200 GSAP timeline entries;
warnings record inaccessible stylesheets, truncation, or an ineffective scroll
sweep. Nested scroll containers, hidden library registries, transient motion,
and hover/click behavior need further interaction evidence. The probe does not
record video or generate frontend code. A failed probe retains an error report
and the initial page capture; retry with a fresh target.

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

Sign in in the opened Chrome window; capture resumes automatically. Cookies survive browser restarts. If login redirects to another URL, specify it with `--ready-url`. A timeout or Ctrl-C preserves the browser session and allows retrying the same target when no evidence was saved. See [authentication and profiles](capture-troubleshooting.md).

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

Each step saves its own DOM, screenshot, and static assets under `states/<name>`. `flow.json` records their order and completion; failed flows retain completed states. Actions are explicit: review the steps before running them on a live site. Supply `waitFor` for a specific post-action state; two paint frames do not establish that a long animation has finished.

Selectors must identify a single element in the main document. You can instead use an exact accessible role/name locator for `click`, `hover`, `scroll`, or `waitFor`:

```json
{"name":"menu-open", "click":{"css":"#old-menu-id", "role":"button", "name":"Open menu"}, "waitFor":"#menu-panel"}
```

If the optional CSS selector is missing, the current Chrome accessibility tree supplies the role/name fallback. Names use normalized whitespace and remain case-sensitive. Every action resolves the current DOM again; ambiguous matches fail before the action. `flow.json` records how each action target was resolved. Frame and shadow-root traversal are not supported by these locators. This adopts the semantic targeting idea from [Stagehand](https://github.com/browserbase/stagehand) without requiring its AI service.

Add `--record` to retain an [rrweb](https://github.com/rrweb-io/rrweb) event stream under `input/recording/events.json`. It contains full DOM snapshots, incremental mutations and interactions, document boundaries, and its own completion status. Navigation preserves the earlier document's events; a failed flow preserves its buffered events. Input values are masked in the recording, but ordinary HTML captures are separate and retain their existing behavior. Recordings stop at 10,000 events or 8 MiB with a warning; canvas recording is disabled. The raw `events` array can be supplied to an rrweb replayer; slurp's static `serve` command does not play it.

Add `--layout [selector]` to `capture`, `capture-cdp`, or `flow` for `input/layout/layout.json` (inside each state for a flow). The default root is `body`. It measures up to 200 visible elements and samples matched/inherited CSS rules for the first 20, retaining computed properties, viewport/document rectangles, stylesheet URLs and source ranges where Chrome exposes them. This uses the same CDP CSS evidence as [Chrome DevTools](https://github.com/ChromeDevTools/devtools-frontend). Matched rules are cascade candidates, not an explanation of which declaration wins. Measurement covers the main document; iframe and shadow-root traversal are omitted. Inspect status and warnings before using the evidence.

For authenticated flows, sign in with `browser open` first, then add `--profile <name>` and give the first step a selector unique to the signed-in page. `--timeout <seconds>` controls each readiness wait. Unnamed flow browsers are closed automatically; named profiles stay open for reuse.

## Bundle inspection

Select the relevant app bundle from the URL list before downloading. For public assets, use an ordinary HTTP downloader; for authenticated assets, follow the [CDP workflow](capture-troubleshooting.md).

For broader recovery, pass captured raw files or a directory of chunks to Wakaru through slurp:

```bash
web-slurp recover ./targets/example --out ./targets/example/output/recovery
```

For a capture target, recovery selects saved scripts from `input/assets/manifest.json`, including extensionless scripts, and restores their URL paths under an origin namespace. Query variants stay separate; unavailable scripts are reported. The import index can link captured URL references when they have a unique recovered target. You can also pass a directory of raw downloads or explicit files. This runs locally using pinned Wakaru 1.13.0. It supports webpack, esbuild/Bun, Browserify, Metro JavaScript, SystemJS and AMD/UMD; Rollup/Vite/Rolldown output may retain its existing chunk boundaries or use heuristic splitting. React calls can be restored to JSX. Rspack output is covered by a compiled fixture, but arbitrary webpack-compatible output is not guaranteed. Turbopack still uses the bundled `split` command below.

Recovery requires a fresh directory. It snapshots the input files under `inputs/` and hashes them in `recovery.json`. Before rewriting, it checks sibling or inline source maps and extracts available `sourcesContent` under `sources/`. Those files are original source, and should be preferred over reconstructed modules. Remote maps and maps outside an input's directory are not fetched or followed automatically. Source maps without embedded files cannot restore original source files.

Readable modules are under `modules/`, with `provenance.json` linking modules to input byte ranges (input paths resolve from `modules/`) and `.map` files linking rewritten positions to their inputs. `module-index.json` lists sizes, hashes, exports, static/reexport/literal dynamic imports, missing relative imports, and parsing errors. `source-index.json` indexes extracted originals; Svelte/Vue source files are listed but their internal imports are not parsed. The index describes syntax, not runtime reachability, and does not resolve CommonJS calls, package aliases, or computed dynamic imports. Inspect the report's warnings and `result.safety` before using recovered code. Completion means artifact generation succeeded, not application equivalence.

```bash
# Finer module boundaries for reading; may not preserve initialization order.
web-slurp recover ./raw --out ./output/inspect --mode inspect
# Structural detection without heuristic splitting; plain JS stays one file.
web-slurp recover ./raw --out ./output/strict --mode strict --level minimal
# Raw extraction, without readability rewrites or output source maps.
web-slurp recover ./raw --out ./output/raw --raw
# Rewrite a single file, with identifier recovery from an explicit input map.
web-slurp recover ./app.js --out ./output/file --mode file --source-map ./app.js.map
```

Malformed input or error-class diagnostics fail the command and preserve partial artifacts and `recovery.json`. A malformed automatically discovered map is recorded as a warning and does not prevent JavaScript recovery. Missing captured dependencies remain visible in the index. Wakaru recovery does not execute inputs. JSX reconstruction does not imply original component names or a recovered project; compiled Svelte is readable JavaScript unless a source map embeds the original `.svelte` files.

For an alternative deobfuscation and unpacking engine, install [webcrack](https://github.com/j4k0xb/webcrack) with its supported Node 22/24 runtime, then run:

```bash
web-slurp recover ./raw --engine webcrack --out ./output/webcrack
# If its executable is outside PATH:
WEB_SLURP_WEBCRACK=/absolute/path/to/webcrack web-slurp recover ./app.js --engine webcrack --mode file --out ./output/webcrack-file
```

The adapter was verified against webcrack 2.16.0. It preserves hashed inputs, groups output under `modules/<input-number>/`, and writes `module-index.json` plus per-input logs and provenance in `recovery.json`. It supports modes `auto` and `file`, the standard rewrite level, and `--raw`; source-map extraction, other modes/levels and cross-chunk URL linking remain Wakaru features. `file` disables unpacking. webcrack's own deobfuscator can evaluate isolated decoder expressions; use Wakaru for static recovery without that evaluation. webcrack is an optional external executable, not required for ordinary captures or the default engine.

Wakaru's npm binary supports macOS ARM64 and Linux ARM64/x64. On other platforms, set `WEB_SLURP_WAKARU` to a compatible installed executable. `doctor` reports its availability; capture and the bundled splitters work without it.

For the existing lexical splitters:

```bash
web-slurp beautify ./targets/example/input/bundles/raw/app.js ./targets/example/output/app.js
web-slurp split ./targets/example/output/app.js ./targets/example/output/modules/app --format auto
web-slurp rename ./targets/example/output/modules/app --yes --heuristic-only
```

The bundled splitters handle webpack and Turbopack wrappers. Auto-detection checks known wrapper markers and rejects unrecognized inputs before writing output. For a known wrapper with renamed markers, choose `--format webpack` or `--format turbopack` explicitly. Marker detection is a hint, not structural validation. These splitters do not reconstruct original source files or support every bundler. See [advanced workflows](advanced-workflows.md).

## Update and uninstall

For a clean Git checkout with an upstream configured:

```bash
web-slurp update
web-slurp uninstall
```

Update uses `git pull --ff-only` and reruns setup, refreshing agent-browser to the latest release. It refuses dirty checkouts. Pass the same custom registration flags used during setup if applicable. For an unpacked package, replace it using your package manager and rerun setup.

Uninstall removes only links pointing to this package. It leaves source files, browser caches, Python dependencies, captures, and unique backups intact. Restore an earlier installation by moving its backup back after uninstalling.

## Develop

```bash
bun install --frozen-lockfile
bun run check
bun test
```

Tests include real Chromium captures of local fixtures and a regular Chrome profile login/restart test, so install the browser first and have regular Chrome available (or set `WEB_SLURP_CHROME`). They check sign-in resumption and profile reuse, dynamic imports and static bytes, evidence preservation, symlink registration, offline CDN replay, viewport fidelity, visual differences, and interaction states. Recovery tests build React fixtures with webpack, Rspack, Rollup, Vite/Rolldown, esbuild, and Bun, plus a Svelte/Vite fixture, then check original-source extraction, JSX, provenance, parsing, and preservation. They require Wakaru and the development dependencies.

From a source checkout, retain the fixture builds and recovery reports for inspection:

```bash
bun run benchmark:recovery --out ./targets/recovery-benchmark
```

The benchmark writes `results.json` and exits nonzero for failed recovery, missing fixture markers, absent original sources, parsing errors, missing relative imports, or missing React JSX. It measures small compiler fixtures, not arbitrary-site reconstruction. Use a fresh directory for each run. `bun pm pack` produces a distributable archive; publishing and repository hosting are separate steps.
