# Advanced workflows

## Lazy webpack chunks

After identifying and beautifying the webpack runtime, list resolved chunks through the stable CLI before downloading:

```bash
SLURP="$HOME/.codex/skills/web-slurp"
bun run "$SLURP/src/cli.ts" chunks \
  --app-js "/absolute/path/runtime.beautified.js" \
  --outdir "/absolute/path/output/chunks" \
  --base-url "https://example.com/_next/static/chunks" \
  --list
```

Inspect the list before removing `--list`. If filenames follow a different convention, provide `--url-template` with only `{base_url}`, `{id}`, `{name}`, and `{hash}` placeholders.

## Splitter selection

Auto detection uses common Turbopack markers and otherwise selects webpack. Override it when inspection shows a false classification:

```bash
bun run "$SLURP/src/cli.ts" split "/absolute/input.js" "/absolute/output/modules" --format turbopack
```

Beautification is a prerequisite because both splitters use lexical structure and readable wrapper boundaries. If splitting fails, retain the untouched input, inspect the bundle wrapper, and report the failure rather than inventing module boundaries.

## Naming

Run heuristic-only naming first. It is deterministic and keeps code local. The harness can optionally call a local OpenAI-compatible endpoint; inspect its `rename_modules.py --help` and environment configuration before allowing that path. Never send proprietary or authenticated bundle contents to an external endpoint without explicit authorization.
