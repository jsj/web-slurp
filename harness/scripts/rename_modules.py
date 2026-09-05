#!/usr/bin/env python3
"""
Rename split webpack modules with descriptive names.
Two-pass approach:
  1. Heuristic: extract meaningful names from code identifiers & manifest clues
  2. LLM (Haiku): batch-name the ambiguous remainder

Usage:
  python rename_modules.py <modules_dir> [--yes] [--api-url URL] [--model MODEL]

Designed to run after split_modules.py.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

DEFAULT_API_URL = "http://localhost:8317/v1/chat/completions"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

MEANINGFUL_PATTERNS = [
    r'\bclass\s+([A-Z][a-zA-Z0-9]{2,})\b',
    r'\bfunction\s+([a-zA-Z][a-zA-Z0-9]{4,})\b',
    r'\b([A-Z][A-Z_]{3,}[A-Z])\b',
    r'\b([a-z][a-zA-Z]{4,}(?:[A-Z][a-zA-Z]+)+)\b',
    r'(?<=["\'])\s*([A-Z][a-z]+(?:[A-Z][a-z]+){1,})\b',
    r'displayName["\s:]+["\']([^"\']+)["\']',
    r'(\w{3,}):\s*\(\)\s*=>\s*\w',
]

STOPWORDS = {
    'undefined', 'function', 'object', 'string', 'number', 'boolean',
    'default', 'module', 'exports', 'require', 'return', 'prototype',
    'constructor', 'length', 'value', 'index', 'error', 'result',
    'callback', 'promise', 'resolve', 'reject', 'window', 'document',
    'element', 'event', 'target', 'source', 'state', 'props', 'children',
    'Component', 'render', 'componentDidMount', 'componentWillUnmount',
    'setState', 'forceUpdate', 'apply', 'call', 'bind', 'null', 'void',
    'true', 'false', 'const', 'class', 'super', 'this', 'arguments',
    'hasOwnProperty', 'toString', 'valueOf', 'Array', 'Object', 'String',
    'Number', 'Boolean', 'Symbol', 'BigInt', 'Error', 'TypeError',
    'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError',
    'console', 'clearTimeout', 'setTimeout', 'clearInterval', 'setInterval',
    'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener',
    'removeEventListener', 'createElement', 'createContext',
    'useRef', 'useState', 'useEffect', 'useMemo', 'useCallback',
    'useContext', 'useReducer', 'useLayoutEffect', 'useImperativeHandle',
    'Fragment', 'Suspense', 'StrictMode', 'Profiler', 'Portal',
    'HTMLElement', 'SVGElement', 'includes', 'filter', 'forEach',
    'reduce', 'concat', 'splice', 'slice', 'shift', 'unshift', 'push',
    'entries', 'values', 'keys', 'from', 'isArray', 'assign', 'freeze',
    'defineProperty', 'getOwnPropertyDescriptor', 'getPrototypeOf',
    'create', 'parse', 'stringify', 'replace', 'match', 'split', 'trim',
    'toLowerCase', 'toUpperCase', 'charAt', 'charCodeAt', 'startsWith',
    'endsWith', 'padStart', 'padEnd', 'repeat', 'search', 'substring',
}

DOMAIN_WORDS = [
    'Store', 'Query', 'Client', 'Config', 'Context', 'Provider',
    'Editor', 'Block', 'Page', 'User', 'Auth', 'Route', 'Nav',
    'Menu', 'Modal', 'Popup', 'Drag', 'Drop', 'Scroll', 'Theme',
    'Layout', 'Keyboard', 'Shortcut', 'Selection', 'Cursor',
    'Command', 'Action', 'Handler', 'Manager', 'Service',
    'Controller', 'Renderer', 'Parser', 'Serializer', 'Cache',
    'Queue', 'Worker', 'Socket', 'Stream', 'Buffer', 'Device',
    'Environment', 'Debug', 'Logger', 'Monitor', 'Metrics',
    'Animation', 'Transition', 'Transform', 'Style', 'Color',
    'Palette', 'Icon', 'Image', 'Media', 'Audio', 'Video',
    'Database', 'IndexedDB', 'Storage', 'Session', 'Cookie',
    'Token', 'Permission', 'Notification', 'Message', 'Chat',
    'TimeSeries', 'Graph', 'Chart', 'Table', 'List', 'Tree',
    'DOMlock', 'domLock', 'ContentEditable', 'Reactivity',
    'HTTP', 'Request', 'Response', 'Fetch', 'API', 'REST',
    'Webhook', 'Subscription', 'Observer', 'Emitter', 'Listener',
    'Hook', 'Plugin', 'Extension', 'Middleware', 'Decorator',
    'Undo', 'Redo', 'Clipboard', 'Paste', 'Copy', 'Cut',
    'Focus', 'Blur', 'Hover', 'Click', 'Touch', 'Gesture',
]


def score_identifier(ident: str) -> int:
    if len(ident) <= 2 or ident in STOPWORDS:
        return 0
    score = 0
    if ident[0].isupper() and any(c.islower() for c in ident):
        score += 3
    if len(ident) >= 8:
        score += 2
    if len(ident) >= 5:
        score += 1
    for w in DOMAIN_WORDS:
        if w.lower() in ident.lower():
            score += 5
            break
    return score


def extract_heuristic_name(file_path: Path, manifest_entry: dict) -> tuple[str | None, int]:
    clues = manifest_entry.get("clues", [])

    for clue in clues:
        if "displayName:" in clue:
            return clue.split("displayName:")[1].strip(), 10

    for clue in clues:
        if clue.startswith("exports:"):
            exports = clue.replace("exports:", "").strip()
            named = [e.strip() for e in exports.split(",") if len(e.strip()) > 2]
            real_names = [n for n in named if len(n) >= 3 and n not in STOPWORDS
                          and not re.match(r'^[A-Z][a-z]$', n)]
            if real_names:
                best = max(real_names, key=score_identifier)
                if score_identifier(best) >= 3:
                    return best, 8

    try:
        content = file_path.read_text(errors='replace')
    except Exception:
        return None, 0

    snippet = content[:3000]
    candidates = {}
    for pattern in MEANINGFUL_PATTERNS:
        for match in re.finditer(pattern, snippet):
            ident = match.group(1) if match.lastindex else match.group(0)
            s = score_identifier(ident)
            if s > 0 and ident not in candidates:
                candidates[ident] = s

    if not candidates:
        return None, 0

    best = max(candidates, key=lambda k: candidates[k])
    return best, min(candidates[best], 9)


def to_kebab(name: str) -> str:
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', name)
    s = re.sub(r'([A-Z]+)([A-Z][a-z])', r'\1-\2', s)
    s = re.sub(r'[^a-zA-Z0-9]', '-', s)
    s = re.sub(r'-+', '-', s).strip('-')
    return s.lower()


def batch_llm(ambiguous: list[tuple[str, str, dict]], api_url: str, model: str) -> dict[str, str]:
    if not ambiguous:
        return {}

    results = {}
    batch_size = 30

    for i in range(0, len(ambiguous), batch_size):
        batch = ambiguous[i:i + batch_size]
        modules_text = ""
        for mod_id, snippet, entry in batch:
            clues = ", ".join(entry.get("clues", []))
            lines = snippet.split("\n")[:40]
            short = "\n".join(lines)
            modules_text += f"\n--- MODULE {mod_id} (clues: {clues}) ---\n{short}\n"

        prompt = f"""You are naming decompiled webpack modules.
For each module below, provide a short descriptive kebab-case name (2-4 words, no module ID).
The name should describe what the module DOES, not list identifiers.

Good names: keyboard-shortcut-handler, config-override, dom-lock-mutation,
focus-manager, indexed-db-wrapper, theme-context-provider

Reply ONLY as JSON: {{"module_id": "suggested-name", ...}}

{modules_text}"""

        payload = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 2048,
            "temperature": 0.0,
        })

        req = urllib.request.Request(
            api_url,
            data=payload.encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read())
                text = data["choices"][0]["message"]["content"]
                json_match = re.search(r'\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}', text, re.DOTALL)
                if json_match:
                    batch_results = json.loads(json_match.group())
                    results.update(batch_results)
                    print(f"  LLM batch {i // batch_size + 1}: named {len(batch_results)} modules")
        except Exception as e:
            print(f"  LLM batch {i // batch_size + 1} failed: {e}", file=sys.stderr)

    return results


def main():
    parser = argparse.ArgumentParser(description="Rename webpack modules with descriptive names")
    parser.add_argument("modules_dir", help="Path to modules directory (output of split_modules.py)")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="LLM API endpoint")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="LLM model name")
    parser.add_argument("--heuristic-only", action="store_true", help="Skip LLM pass")
    parser.add_argument("--dry-run", action="store_true", help="Show renames without executing")
    args = parser.parse_args()

    modules_dir = Path(args.modules_dir)
    manifest_path = modules_dir / "_manifest.json"

    if not manifest_path.exists():
        print(f"Error: {manifest_path} not found. Run split_modules.py first.", file=sys.stderr)
        sys.exit(1)

    manifest = json.loads(manifest_path.read_text())
    print(f"Processing {len(manifest)} modules in {modules_dir}...")

    heuristic_named = {}
    ambiguous = []

    for mod_id, entry in manifest.items():
        file_path = modules_dir / entry["file"]
        if not file_path.exists():
            continue

        name, confidence = extract_heuristic_name(file_path, entry)
        if confidence >= 7:
            heuristic_named[mod_id] = name
        else:
            try:
                content = file_path.read_text(errors='replace')
                ambiguous.append((mod_id, content[:2000], entry))
            except Exception:
                pass

    print(f"  Heuristic: {len(heuristic_named)} named")
    print(f"  Ambiguous: {len(ambiguous)} remaining")

    llm_named = {}
    if not args.heuristic_only and ambiguous:
        llm_named = batch_llm(ambiguous, args.api_url, args.model)
        print(f"  LLM total: {len(llm_named)} named")

    # Collect existing tags from filenames
    known_tags = ['react-hooks', 'react-context', 'keyboard', 'contentEditable',
                  'dom-lock-related', 'domLock', 'mutation-observer', 'selection']

    rename_map = {}
    new_manifest = {}

    for mod_id, entry in manifest.items():
        old_file = entry["file"]
        name = heuristic_named.get(mod_id) or llm_named.get(mod_id)

        if name:
            kebab = to_kebab(name) if not re.match(r'^[a-z0-9-]+$', name) else name
            tags = [t for t in known_tags if t in old_file]
            tag_suffix = "_" + "_".join(tags) if tags else ""
            new_file = f"{mod_id}_{kebab}{tag_suffix}.js"
        else:
            new_file = old_file

        rename_map[old_file] = new_file
        new_manifest[mod_id] = {**entry, "file": new_file, "old_file": old_file}

    changes = [(old, new) for old, new in rename_map.items() if old != new]
    print(f"\n{len(changes)} files to rename:")
    for old, new in sorted(changes)[:25]:
        print(f"  {old}")
        print(f"    -> {new}")
    if len(changes) > 25:
        print(f"  ... and {len(changes) - 25} more")

    if args.dry_run:
        mapping_path = modules_dir / "_rename_map.json"
        mapping_path.write_text(json.dumps(rename_map, indent=2))
        print(f"\nDry run. Saved rename map to {mapping_path}")
        return

    if not args.yes:
        resp = input("\nProceed with rename? [y/N] ")
        if resp.lower() != "y":
            mapping_path = modules_dir / "_rename_map.json"
            mapping_path.write_text(json.dumps(rename_map, indent=2))
            print(f"Saved rename map to {mapping_path}")
            return

    renamed = 0
    for old, new in rename_map.items():
        if old != new:
            old_path = modules_dir / old
            new_path = modules_dir / new
            if old_path.exists() and not new_path.exists():
                old_path.rename(new_path)
                renamed += 1
            elif old_path.exists():
                print(f"  SKIP (conflict): {old} -> {new}")

    manifest_path.write_text(json.dumps(new_manifest, indent=2))
    print(f"\nDone! Renamed {renamed} files, updated manifest.")


if __name__ == "__main__":
    main()
