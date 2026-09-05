#!/usr/bin/env python3
"""Split a beautified webpack chunk file into individual module files."""

import argparse
import json
import re
from pathlib import Path

# Detect module boundaries:
#   `  <digits>: (e, t, n) => {`   – standard webpack
#   `  <digits>: function(`         – standard webpack
#   `  <digits>(e, t, n) {`         – webpack 5 shorthand
MODULE_RE = re.compile(r'^(\s+)(\d+)(?:: (?:\(|function\s*\()|\()')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Split a beautified webpack chunk file into individual module files."
    )
    parser.add_argument("input", help="Path to a beautified webpack chunk file")
    parser.add_argument("outdir", help="Directory to write split module files")
    return parser.parse_args()


def find_modules(lines: list[str]) -> list[tuple[str, int]]:
    modules = []
    for i, line in enumerate(lines):
        m = MODULE_RE.match(line)
        if m and int(m.group(2)) > 0:
            modules.append((m.group(2), i))
    return modules


def extract_clues(body: list[str]) -> list[str]:
    size = len(body)
    header = "".join(body[: min(60, size)])
    clues = []

    exports = re.findall(r'(\w+): \(\) => \w+', header)
    if exports:
        clues.append(f"exports: {', '.join(exports[:8])}")

    dn = re.findall(r'displayName\s*[=:]\s*["\']([^"\']+)', header)
    if dn:
        clues.append(f"displayName: {dn[0]}")

    if "useContext" in header or "createContext" in header:
        clues.append("react-context")
    if "useState" in header or "useEffect" in header or "useRef" in header:
        clues.append("react-hooks")
    if "useInsertionEffect" in header:
        clues.append("dom-lock-related")
    if "contentEditable" in header.lower() or "ContentEditable" in header:
        clues.append("contentEditable")
    if "domLock" in header or "DomLock" in header or "DOMLock" in header:
        clues.append("domLock")
    if "MutationObserver" in header:
        clues.append("mutation-observer")
    if "selection" in header.lower() and ("range" in header.lower() or "anchor" in header.lower()):
        clues.append("selection")
    if "keyboard" in header.lower() or "shortcut" in header.lower() or "keydown" in header.lower():
        clues.append("keyboard")

    return clues


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    outdir = Path(args.outdir)

    if not input_path.exists() or not input_path.is_file():
        raise SystemExit(f"Input file not found: {input_path}")

    outdir.mkdir(parents=True, exist_ok=True)
    lines = input_path.read_text(encoding="utf-8", errors="replace").splitlines(keepends=True)
    modules = find_modules(lines)

    print(f"Found {len(modules)} modules in {input_path.name}")

    manifest = {}
    for idx, (mod_id, start) in enumerate(modules):
        end = modules[idx + 1][1] if idx + 1 < len(modules) else len(lines)
        body = lines[start:end]
        size = len(body)
        clues = extract_clues(body)

        tag = "_".join(clues[:3]).replace(" ", "").replace(",", "").replace(":", "-") if clues else ""
        tag = re.sub(r'[^a-zA-Z0-9_\-]', "", tag)

        filename = f"{mod_id}.js" if not tag else f"{mod_id}_{tag[:60]}.js"
        filepath = outdir / filename

        min_indent = min((len(l) - len(l.lstrip()) for l in body if l.strip()), default=0)
        cleaned = [l[min_indent:] if len(l) > min_indent else l for l in body]

        with filepath.open("w", encoding="utf-8") as out:
            summary = " | ".join(clues) if clues else "no clues"
            out.write(f"// Module {mod_id} | {size} lines | {summary}\n")
            out.writelines(cleaned)

        manifest[mod_id] = {
            "file": filename,
            "lines": size,
            "clues": clues,
        }

    manifest_path = outdir / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"Wrote {len(modules)} modules to {outdir}/")
    print(f"Manifest: {manifest_path}")

    sizes = sorted((v["lines"] for v in manifest.values()), reverse=True)
    print("\nSize distribution:")
    for t in [500, 200, 100, 50, 20, 10]:
        print(f"  >= {t:>3} lines: {sum(1 for s in sizes if s >= t):>3} modules")

    tagged = sum(1 for v in manifest.values() if v["clues"])
    print(f"\nModules with clues: {tagged}/{len(modules)}")


if __name__ == "__main__":
    main()
