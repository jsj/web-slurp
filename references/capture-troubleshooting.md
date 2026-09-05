# Capture troubleshooting

## Portable agent-browser capture

Use `capture` first for public pages. It writes rendered HTML, metadata, and a newline-delimited script URL list under `<target>/input`.

Install Chromium with `"$SLURP/scripts/agent-browser.sh" install --with-deps`. The wrapper uses the pinned agent-browser package and an isolated daemon directory, so it cannot conflict with a different global agent-browser version. The package includes native executables for macOS, Linux, and Windows.

Chrome for Testing has no Linux ARM64 build. On Ubuntu or Debian ARM64, install `chromium` with the system package manager and set `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium`.

If the script list is unexpectedly empty, inspect the rendered HTML for iframes, CSP errors, delayed loading, or a consent gate. Capture waits for hydration, but it does not interact with consent dialogs or scroll-triggered loaders.

Captured HTML contains a `<base>` element pointing at the final page URL. It also removes `crossorigin` attributes from the cloned evidence document because those attributes can reject original-origin assets during localhost replay. The live page is not mutated.

## Authenticated Chrome CDP

Use CDP only with a browser profile the user has authorized. Prefer this route when Google rejects an automated browser as insecure, or when headless capture redirects to login.

Modern Chrome ignores remote debugging on its default profile. Launch a dedicated profile with the bundled helper:

```bash
SLURP="${SLURP:-$HOME/.agents/skills/web-slurp}"
"$SLURP/scripts/start-cdp-chrome.sh" "https://example.com/login"
```

The helper finds Canary, Chrome, or Chromium, uses a dedicated temporary profile, and verifies `http://127.0.0.1:9222/json/version`. Ask the user to authenticate in that window; never request credentials in chat or pass them on the command line.

After the user confirms authentication, attach without copying cookies or profile data:

```bash
"$SLURP/scripts/agent-browser.sh" --cdp 9222 tab
"$SLURP/scripts/agent-browser.sh" --cdp 9222 get url
"$SLURP/scripts/agent-browser.sh" --cdp 9222 snapshot -i -u
"$SLURP/scripts/agent-browser.sh" --cdp 9222 screenshot body "$TARGET/output/page.png" --full
bun run "$SLURP/src/cli.ts" capture-cdp "$TARGET" --page-url "https://example.com/dashboard"
```

The dedicated CDP Chrome stays open so several protected routes can share the authenticated session. Stop it explicitly when the capture is complete:

```bash
"$SLURP/scripts/stop-cdp-chrome.sh"
```

For multiple protected routes, navigate with visible links or buttons, wait for the expected URL, and capture each page separately. Do not click purchase, upgrade, delete, key-creation, or other mutating controls unless explicitly authorized. Treat screenshots and rendered text as private evidence and keep them out of version control.

Collect same-origin static assets only after inspecting the active page's script and stylesheet URLs. Exclude analytics, authentication, payment, and API-data origins. Feed the reviewed newline-delimited list to `download`; the CDP downloader is for static JavaScript/CSS assets, not authenticated API responses.

Review the URL list before downloading. Remove unrelated third-party analytics, advertising, and session endpoints. The downloader is intended for static script/CSS assets, not API data exfiltration.

The CDP downloader requires the Python package `websocket-client`. Install it in the active Python environment if the import is missing.

## Failure interpretation

- Connection refused: Chrome is not running with remote debugging on the selected port.
- CDP still unavailable after Chrome opens: confirm a non-default `--user-data-dir` is present and that another Chrome instance did not absorb the launch request.
- Google says the browser may not be secure: authenticate in the dedicated regular Chrome window launched by the helper, not an automation-managed Chrome for Testing session.
- HTTP 404 from `/json/version`: the endpoint is not a healthy Chrome CDP service.
- Fetch failures: confirm the referer, authenticated session, CSP/CORS behavior, and URL validity.
- Tiny or HTML `.js` files: inspect for a login page, bot challenge, or edge error; do not pass them to the splitter.
