<p align="center">
  <img src=".README/cover.png" alt="web-slurp: Website references for coding agents" width="1024" />
</p>

<h1 align="center">web-slurp</h1>

<p align="center">
  Capture a website. Give your coding agent the details to rebuild it.
</p>

<details open>
<summary align="center"><img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/claude.svg" width="18" height="18" alt="Claude">&nbsp;<img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/cursor.svg" width="18" height="18" alt="Cursor">&nbsp;<img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/github-copilot.svg" width="18" height="18" alt="GitHub Copilot">&nbsp;<img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/openai.svg" width="18" height="18" alt="OpenAI">&nbsp;&nbsp;<strong>Copy this prompt to your coding agent</strong></summary>

```text
Set up web-slurp from https://github.com/jsj/web-slurp.
Read the README and SKILL.md, then run ./setup.
Ask me which page to capture and where to build the frontend.
Use web-slurp to save the rendered page, screenshots, and static assets.
For a protected page, open a named Chrome profile and let me sign in.
Inspect the captured styles and assets, then build the frontend.
Compare it against the reference and fix the visible differences.
```

</details>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="SKILL.md">Agent skill</a> · <a href="references/usage.md">Usage guide</a>
</p>

## What it captures

Screenshots are the starting point. Web-slurp also saves the rendered DOM, CSS, images, fonts, and JavaScript your browser loaded.

| Task | What you get |
| --- | --- |
| Capture a page | Rendered HTML, screenshot, static assets, and a manifest of missing files |
| Sign in | A named Chrome profile that keeps your login between sessions |
| Check responsive layouts | Desktop and mobile references |
| Capture interactions | Separate references for click, hover, and scroll states |
| Compare your build | A pixel diff and the largest changed regions |
| Inspect the implementation | Style inventories and webpack/Turbopack bundle tools |

Captured pages replay locally. Live APIs and unvisited states are not reproduced.

## Get started

Requires [Bun](https://bun.sh) and Python 3. Authenticated capture also needs Google Chrome.

```sh
gh repo clone jsj/web-slurp
cd web-slurp
./setup
```

Setup installs dependencies and Chromium. It links the CLI into `~/.local/bin` and the skill into `~/.agents/skills`.
Keep the checkout in place. If prompted, add `~/.local/bin` to your `PATH`.

If an older installation exists, run `./setup --backup-existing` to preserve it before creating the links.

## Capture your first page

```sh
web-slurp capture https://example.com --out ./targets/example
web-slurp styles ./targets/example
web-slurp serve ./targets/example
```

Open the local URL printed by `serve`. Each capture keeps its evidence in its own output directory.

For a page that needs a login:

```sh
web-slurp capture https://example.com/dashboard --out ./targets/dashboard \
  --profile work --wait-for '#dashboard-ready'
```

Replace the URL and selector with your page and an element visible after login.
Sign in in Chrome. Capture continues when the page is ready, and the profile keeps your session for next time.

## Compare your frontend

```sh
web-slurp capture-responsive https://example.com --out ./targets/reference
web-slurp compare ./targets/reference/desktop http://localhost:3000 \
  --out ./targets/comparison
```

Open `targets/comparison/output/diff.png` to inspect the differences. The JSON report includes the changed-pixel percentage and largest changed regions.

Comparison uses the reference viewport and pixel density. Match the page state first. Animations and changing content can affect the result.

## Go deeper

- [Interaction captures, bundle inspection, and command examples](references/usage.md)
- [Authentication, retries, and browser troubleshooting](references/capture-troubleshooting.md)
- [Advanced bundle workflows](references/advanced-workflows.md)

## Update or uninstall

```sh
web-slurp update
web-slurp uninstall
```

Update pulls the latest commit and reruns setup. It requires a clean checkout.
Uninstall removes the installed links and preserves your checkout, captures, and browser profiles.

## Develop

```sh
bun install --frozen-lockfile
bun run check
bun test
```

The tests use local browser fixtures. Install Chromium with `./setup` and have Google Chrome available for profile tests.
See the [usage guide](references/usage.md#develop) for coverage and packaging details.
