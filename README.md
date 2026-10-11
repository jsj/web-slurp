<p align="center">
  <img src=".README/icon.png" alt="A mint drinking straw on navy" width="160" height="160" />
</p>

<h1 align="center">web-slurp</h1>

<p align="center">See a website you like? Ask your agent to rebuild it.</p>

<p align="center">
  <a href="https://github.com/jsj/web-slurp/actions/workflows/ci.yml"><img src="https://github.com/jsj/web-slurp/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-9be8ce?labelColor=091136" alt="Apache 2.0 license" /></a>
</p>

<details open>
<summary align="center"><strong>Copy this prompt to your coding agent</strong>&nbsp;&nbsp;<img src=".README/agents.svg" align="absmiddle" width="140" height="36" alt="Claude, Cursor, GitHub Copilot, and OpenAI"></summary>

```text
Install web-slurp from https://github.com/jsj/web-slurp.
Read README.md and SKILL.md.
Follow its setup instructions.
Ask me which website I want to recreate.
Inspect its layout, fonts, images, styles, and interactions.
Rebuild it in my project, then compare screenshots and fix the differences.
```

</details>

## Give your agent a website

In Codex, Claude Code, or Cursor, paste the setup prompt above. Then ask:

```text
Recreate https://example.com in my project with web-slurp.
Match the layout, typography, images, and interactions.
Compare desktop and mobile screenshots, then fix the differences.
```

Your agent inspects the rendered page and its actual styles and assets, builds your version, and checks it against the reference. Live APIs and backend behavior need separate implementation.

[Setup and usage](references/usage.md) · [Troubleshooting](references/capture-troubleshooting.md) · [Development](references/usage.md#develop) · [License](LICENSE)
