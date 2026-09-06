<p align="center">
  <img src=".README/icon.png" alt="A mint drinking straw on navy" width="160" height="160" />
</p>

<h1 align="center">web-slurp</h1>

<p align="center">Capture websites for your coding agent.</p>

<p align="center">
  <a href="https://github.com/jsj/web-slurp/actions/workflows/ci.yml"><img src="https://github.com/jsj/web-slurp/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-9be8ce?labelColor=091136" alt="Apache 2.0 license" /></a>
</p>

<details open>
<summary align="center"><img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/claude.svg" width="18" height="18" alt="Claude">&nbsp;<img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/cursor.svg" width="18" height="18" alt="Cursor">&nbsp;<img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/github-copilot.svg" width="18" height="18" alt="GitHub Copilot">&nbsp;<img src="https://cdn.jsdelivr.net/gh/jsj/agent-icons@ec84fc0fc6f70311a33800a53121c8cac0e5b48b/openai.svg" width="18" height="18" alt="OpenAI">&nbsp;&nbsp;<strong>Copy this prompt to your coding agent</strong></summary>

```text
Install web-slurp from https://github.com/jsj/web-slurp.
Read README.md and SKILL.md.
Run ./setup.
Ask me which page to capture.
Use the captured page, styles, and assets to build my frontend.
Compare the result with the reference.
```

</details>

## Install

Requires [Bun](https://bun.sh) and Python 3. Pages that need a login also require Google Chrome.

```sh
gh repo clone jsj/web-slurp
cd web-slurp
./setup
```

Setup installs the CLI and agent skill as links to this checkout. Keep the checkout in place.
If prompted, add `~/.local/bin` to your `PATH`.

## Use

```sh
web-slurp capture https://example.com --out ./targets/example
web-slurp styles ./targets/example
web-slurp serve ./targets/example
```

Each capture saves the page HTML, a screenshot, and the loaded scripts, styles, images, and fonts.
Local replay does not reproduce live APIs.

Profiles keep your login. You can also capture mobile layouts and interactions, then compare your frontend with a screenshot reference.

[Full guide](references/usage.md) · [Login and troubleshooting](references/capture-troubleshooting.md) · [Agent skill](SKILL.md)

## Update

```sh
web-slurp update
```

Update requires a clean checkout. Run `web-slurp uninstall` to remove the installed links.
Your files and browser profiles remain.

[Development and tests](references/usage.md#develop)

[Apache 2.0](LICENSE) · Copyright 2026 James Jackson.
