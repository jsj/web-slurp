# Capture troubleshooting

## Public pages

`web-slurp capture <url> --out <target>` launches the pinned agent-browser runtime and captures rendered HTML and script/stylesheet URLs. Use `--wait-for <selector>` for application readiness. For continuously active pages, use `--wait-until domcontentloaded` with a selector.

Install Chromium with `web-slurp setup`, or use `scripts/agent-browser.sh install --with-deps` when Linux system libraries are missing. On Linux ARM64, install distro Chromium and set `AGENT_BROWSER_EXECUTABLE_PATH` to its executable.

Capture does not scroll, dismiss consent dialogs, or discover interactions automatically. Resource Timing includes already-fetched dynamic imports; it cannot enumerate every lazy route. Stored HTML preserves the rendered DOM; replay adjustments do not mutate that evidence.

## Sign in and resume

Use a named, persistent regular Chrome profile when the target needs authentication or rejects automated Chromium:

```bash
web-slurp capture https://example.com/dashboard --out ./targets/dashboard \
  --profile work --wait-for '#dashboard-ready'
```

Chrome opens a new capture tab. The user signs in themselves, including MFA. The command waits up to five minutes for the expected URL and visible selector, then captures that tab automatically. It never enters credentials. Pick a selector unique to the signed-in state. If login lands on a different URL, add `--ready-url https://example.com/home`; matching checks the full URL, including query and hash. Increase `--auth-timeout <seconds>` when needed.

A timeout saves no page evidence and releases the capture lock. Chrome remains open, so the user can finish login and rerun the same command and output directory. Ctrl-C also releases the lock and preserves the profile. A forced kill can leave `.capture-lock`; check for a running capture before removing it.

Profiles live under `~/.local/share/web-slurp/profiles/<name>` and retain cookies and other browser state across restarts. Keep this directory private and out of capture archives or Git. Override its root with `WEB_SLURP_PROFILE_ROOT`; set `WEB_SLURP_CHROME` to a regular Chrome executable if auto-detection fails. A profile must not be used by another Chrome process outside this launcher.

Manage the browser separately when collecting several pages:

```bash
web-slurp browser open https://example.com/login --profile work
web-slurp browser status --profile work
web-slurp browser close --profile work
```

Closing preserves the profile's login state. Close a dedicated browser when finished. The launcher selects a free CDP port and verifies the browser ID against that profile's `DevToolsActivePort` file before attaching or closing. It does not adopt a browser simply because port 9222 responds.

The legacy start/stop helper scripts now delegate to these commands, using `WEB_SLURP_PROFILE` (default `default`). Old `WEB_SLURP_CDP_PORT` and `WEB_SLURP_CDP_PROFILE` overrides are rejected with migration instructions. Existing `/tmp/web-slurp-cdp-profile` data is left untouched.

## Explicit CDP sessions and assets

For a Chrome session the user already authorized, `capture-cdp` remains available. Get the endpoint from `browser status` for a managed profile; do not assume a fixed port.

```bash
web-slurp capture-cdp ./targets/dashboard --page-url https://example.com/dashboard \
  --cdp http://127.0.0.1:PORT
```

This captures the selected page immediately; it does not wait for login. An exact URL match takes precedence over a prefix, and ambiguous matches fail. For direct browser inspection, use `scripts/agent-browser.sh --session <unique-name> --cdp <port>` and select the correct tab before interacting.

Authenticated asset downloads require the optional Python package installed by `web-slurp setup --with-cdp`. Review the URL list and retain only the necessary static JS/CSS assets before downloading:

```bash
web-slurp download ./targets/dashboard/input/bundles/script-urls.txt \
  ./targets/dashboard/input/bundles/raw --referer https://example.com/dashboard \
  --cdp http://127.0.0.1:PORT
```

The legacy downloader navigates the first page tab to the referer. Use a dedicated browser session for it; it is not a general authenticated API client. Exclude unrelated analytics, payments, authentication endpoints, and API data. Keep private captures out of version control.

## Failures

- **Chrome not found:** set `WEB_SLURP_CHROME` to its executable, not the app directory.
- **Profile launch or shutdown already in progress:** another command holds `.launch-lock`; after an interrupted launch, verify Chrome's state before removing the lock.
- **Chrome exits before becoming ready:** the profile may already be open elsewhere. Close that instance or choose another profile name.
- **Sign-in/readiness timeout:** finish login in Chrome, check the final URL and selector, then retry. A page redirect may need `--ready-url`.
- **Capture tab closed:** rerun the command; the persistent profile retains its login state.
- **Google rejects automated Chromium:** use `--profile` with regular Chrome and let the user complete sign-in there.
- **Tiny or HTML `.js` files:** inspect for login pages or server errors before splitting them.
