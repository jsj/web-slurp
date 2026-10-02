# Advanced workflows

## Lazy webpack chunks

After identifying and beautifying the webpack runtime, list resolved chunks through the stable CLI before downloading:

```bash
web-slurp chunks \
  --app-js "/absolute/path/runtime.beautified.js" \
  --outdir "/absolute/path/output/chunks" \
  --base-url "https://example.com/_next/static/chunks" \
  --list
```

Inspect the list before removing `--list`. If filenames follow a different convention, provide `--url-template` with only `{base_url}`, `{id}`, `{name}`, and `{hash}` placeholders.

## Splitter selection

Auto detection checks known webpack and Turbopack markers and rejects unrecognized files before writing output. Markers are hints, not structural validation. Override detection only when inspection establishes a supported wrapper:

```bash
web-slurp split "/absolute/input.js" "/absolute/output/modules" --format turbopack
```

Beautification is a prerequisite because both splitters use lexical structure and readable wrapper boundaries. If splitting fails, retain the untouched input, inspect the bundle wrapper, and report the failure rather than inventing module boundaries.

For Vite/Rollup/Rolldown, esbuild/Bun, or AST-based webpack recovery, use `web-slurp recover <raw-files-or-directory> --out <fresh-directory>`. It handles source maps, JSX restoration, provenance, and a searchable module/import index locally. Read [Bundle inspection](usage.md#bundle-inspection) for modes, output artifacts, platform support, and limitations. Do not run the legacy `rename` command on Wakaru output: its manifest contract belongs to the bundled splitters.

## Naming

Run heuristic-only naming first. It is deterministic and keeps code local. The harness can optionally call a local OpenAI-compatible endpoint; inspect its `rename_modules.py --help` and environment configuration before allowing that path. Never send proprietary or authenticated bundle contents to an external endpoint without explicit authorization.
