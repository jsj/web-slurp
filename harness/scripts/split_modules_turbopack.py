#!/usr/bin/env python3
"""Split a beautified Turbopack chunk file into individual module files."""

import argparse
import json
import re
from pathlib import Path

CALLABLE_RE = re.compile(
    r"^(?:"
    r"\([^)]*\)\s*=>|"  # (a, b) => ...
    r"[A-Za-z_$][\w$]*\s*=>|"  # x => ...
    r"async\s+\([^)]*\)\s*=>|"  # async (a) => ...
    r"async\s+[A-Za-z_$][\w$]*\s*=>|"  # async x => ...
    r"function\b|"
    r"async\s+function\b"
    r")"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Split a beautified Turbopack chunk file into individual module files."
    )
    parser.add_argument("input", help="Path to a beautified Turbopack chunk file")
    parser.add_argument("outdir", help="Directory to write split module files")
    return parser.parse_args()


def previous_significant_char(source: str, index: int) -> str:
    j = index - 1
    while j >= 0 and source[j].isspace():
        j -= 1
    return source[j] if j >= 0 else ""


def is_regex_start(source: str, index: int) -> bool:
    prev = previous_significant_char(source, index)
    if not prev:
        return True
    return prev in "([{:;,=!?&|+-*%^~<>"


def extract_clues(body_text: str) -> list[str]:
    lines = body_text.splitlines(keepends=True)
    header = "".join(lines[: min(60, len(lines))])
    clues = []

    exports = re.findall(r"(\w+): \(\) => \w+", header)
    if exports:
        clues.append(f"exports: {', '.join(exports[:8])}")

    display_names = re.findall(r'displayName\s*[=:]\s*["\']([^"\']+)', header)
    if display_names:
        clues.append(f"displayName: {display_names[0]}")

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


def find_turbopack_push_payload(source: str) -> tuple[int, int]:
    marker = ".push(["
    push_start = source.find(marker)
    if push_start < 0:
        raise ValueError("Could not find Turbopack push payload (.push([)")

    open_bracket = push_start + len(".push(")
    try:
        close_bracket = find_matching_bracket(source, open_bracket)
    except ValueError:
        # Fallback for edge-case chunks where lightweight lexical scanning
        # cannot prove bracket balance (for example, unusual comment/regex mix).
        close_bracket = source.rfind("]);")
        if close_bracket <= open_bracket:
            raise
    return open_bracket + 1, close_bracket


def find_matching_bracket(source: str, open_index: int) -> int:
    if open_index >= len(source) or source[open_index] != "[":
        raise ValueError("Expected '[' at open_index")

    depth = 1
    i = open_index + 1
    in_single = False
    in_double = False
    in_backtick = False
    in_regex = False
    in_regex_class = False
    in_line_comment = False
    in_block_comment = False
    escape = False

    while i < len(source):
        ch = source[i]

        if in_line_comment:
            if ch == "\n" or ch == "\r":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and i + 1 < len(source) and source[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_regex:
            if escape:
                escape = False
                i += 1
                continue
            if ch == "\\":
                escape = True
                i += 1
                continue
            if ch == "[":
                in_regex_class = True
                i += 1
                continue
            if ch == "]" and in_regex_class:
                in_regex_class = False
                i += 1
                continue
            if ch == "/" and not in_regex_class:
                in_regex = False
            i += 1
            continue

        if in_single or in_double or in_backtick:
            if escape:
                escape = False
                i += 1
                continue
            if ch == "\\":
                escape = True
                i += 1
                continue
            if in_single and ch == "'":
                in_single = False
            elif in_double and ch == '"':
                in_double = False
            elif in_backtick and ch == "`":
                in_backtick = False
            i += 1
            continue

        if ch == "'":
            in_single = True
            i += 1
            continue
        if ch == '"':
            in_double = True
            i += 1
            continue
        if ch == "`":
            in_backtick = True
            i += 1
            continue
        if ch == "/" and i + 1 < len(source):
            nxt = source[i + 1]
            if nxt == "/":
                in_line_comment = True
                i += 2
                continue
            if nxt == "*":
                in_block_comment = True
                i += 2
                continue
        if ch == "/" and is_regex_start(source, i):
            in_regex = True
            in_regex_class = False
            i += 1
            continue

        if ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i
        i += 1

    raise ValueError("Could not find matching closing ']' for Turbopack payload")


def split_top_level_tokens(text: str) -> list[tuple[int, int, str]]:
    tokens = []
    token_start = 0

    depth_paren = 0
    depth_brace = 0
    depth_bracket = 0
    in_single = False
    in_double = False
    in_backtick = False
    in_regex = False
    in_regex_class = False
    in_line_comment = False
    in_block_comment = False
    escape = False

    i = 0
    while i < len(text):
        ch = text[i]

        if in_line_comment:
            if ch == "\n" or ch == "\r":
                in_line_comment = False
            i += 1
            continue

        if in_block_comment:
            if ch == "*" and i + 1 < len(text) and text[i + 1] == "/":
                in_block_comment = False
                i += 2
                continue
            i += 1
            continue

        if in_regex:
            if escape:
                escape = False
                i += 1
                continue
            if ch == "\\":
                escape = True
                i += 1
                continue
            if ch == "[":
                in_regex_class = True
                i += 1
                continue
            if ch == "]" and in_regex_class:
                in_regex_class = False
                i += 1
                continue
            if ch == "/" and not in_regex_class:
                in_regex = False
            i += 1
            continue

        if in_single or in_double or in_backtick:
            if escape:
                escape = False
                i += 1
                continue
            if ch == "\\":
                escape = True
                i += 1
                continue
            if in_single and ch == "'":
                in_single = False
            elif in_double and ch == '"':
                in_double = False
            elif in_backtick and ch == "`":
                in_backtick = False
            i += 1
            continue

        if ch == "'":
            in_single = True
            i += 1
            continue
        if ch == '"':
            in_double = True
            i += 1
            continue
        if ch == "`":
            in_backtick = True
            i += 1
            continue
        if ch == "/" and i + 1 < len(text):
            nxt = text[i + 1]
            if nxt == "/":
                in_line_comment = True
                i += 2
                continue
            if nxt == "*":
                in_block_comment = True
                i += 2
                continue
        if ch == "/" and is_regex_start(text, i):
            in_regex = True
            in_regex_class = False
            i += 1
            continue

        if ch == "(":
            depth_paren += 1
        elif ch == ")":
            depth_paren -= 1
        elif ch == "{":
            depth_brace += 1
        elif ch == "}":
            depth_brace -= 1
        elif ch == "[":
            depth_bracket += 1
        elif ch == "]":
            depth_bracket -= 1
        elif ch == "," and depth_paren == 0 and depth_brace == 0 and depth_bracket == 0:
            token = text[token_start:i]
            tokens.append((token_start, i, token))
            token_start = i + 1
        i += 1

    final = text[token_start:]
    if final.strip():
        tokens.append((token_start, len(text), final))
    return tokens


def parse_runtime_metadata(token_text: str) -> dict:
    metadata: dict[str, object] = {}

    other_chunks_match = re.search(r"otherChunks\s*:\s*\[(.*?)\]", token_text, re.DOTALL)
    if other_chunks_match:
        chunk_values = re.findall(r'["\']([^"\']+)["\']', other_chunks_match.group(1))
        metadata["otherChunks"] = chunk_values
    else:
        metadata["otherChunks"] = []

    runtime_ids_match = re.search(r"runtimeModuleIds\s*:\s*\[(.*?)\]", token_text, re.DOTALL)
    if runtime_ids_match:
        runtime_ids = [int(x) for x in re.findall(r"\d+", runtime_ids_match.group(1))]
        metadata["runtimeModuleIds"] = runtime_ids
    else:
        metadata["runtimeModuleIds"] = []

    return metadata


def is_module_id(token: str) -> bool:
    return bool(re.fullmatch(r"\d+", token.strip()))


def is_module_factory(token: str) -> bool:
    return bool(CALLABLE_RE.match(token.strip()))


def collect_modules(payload_text: str, payload_offset: int) -> tuple[list[tuple[str, int, int]], dict]:
    tokens = split_top_level_tokens(payload_text)
    if not tokens:
        return [], {}

    runtime_metadata = {}
    cursor = 1
    if len(tokens) > 1:
        maybe_metadata = tokens[1][2].strip()
        if maybe_metadata.startswith("{") and "runtimeModuleIds" in maybe_metadata:
            runtime_metadata = parse_runtime_metadata(maybe_metadata)
            cursor = 2

    candidates: list[tuple[str, int, int]] = []
    i = cursor
    while i + 1 < len(tokens):
        id_token = tokens[i]
        factory_token = tokens[i + 1]
        if is_module_id(id_token[2]) and is_module_factory(factory_token[2]):
            module_id = id_token[2].strip()
            module_start = payload_offset + id_token[0]
            candidates.append((module_id, module_start, 0))
            i += 2
            continue
        i += 1

    modules: list[tuple[str, int, int]] = []
    for idx, (module_id, module_start, _) in enumerate(candidates):
        if idx + 1 < len(candidates):
            module_end = candidates[idx + 1][1]
        else:
            module_end = payload_offset + tokens[-1][1]
        modules.append((module_id, module_start, module_end))

    return modules, runtime_metadata


def write_modules(source: str, modules: list[tuple[str, int, int]], outdir: Path) -> dict:
    manifest = {}

    for module_id, start, end in modules:
        body_text = source[start:end].strip()
        if body_text and not body_text.endswith("\n"):
            body_text += "\n"
        clues = extract_clues(body_text)
        lines = body_text.splitlines(keepends=True)
        line_count = len(lines)

        tag = "_".join(clues[:3]).replace(" ", "").replace(",", "").replace(":", "-") if clues else ""
        tag = re.sub(r"[^a-zA-Z0-9_\-]", "", tag)

        filename = f"{module_id}.js" if not tag else f"{module_id}_{tag[:60]}.js"
        filepath = outdir / filename

        with filepath.open("w", encoding="utf-8") as out:
            summary = " | ".join(clues) if clues else "no clues"
            out.write(f"// Module {module_id} | {line_count} lines | {summary}\n")
            out.write(body_text)

        manifest[module_id] = {
            "file": filename,
            "lines": line_count,
            "clues": clues,
        }

    return manifest


def print_size_distribution(manifest: dict) -> None:
    sizes = sorted((v["lines"] for v in manifest.values()), reverse=True)
    print("\nSize distribution:")
    for threshold in [500, 200, 100, 50, 20, 10]:
        count = sum(1 for size in sizes if size >= threshold)
        print(f"  >= {threshold:>3} lines: {count:>3} modules")

    tagged = sum(1 for v in manifest.values() if v["clues"])
    print(f"\nModules with clues: {tagged}/{len(manifest)}")


def main() -> None:
    args = parse_args()
    input_path = Path(args.input)
    outdir = Path(args.outdir)

    if not input_path.exists() or not input_path.is_file():
        raise SystemExit(f"Input file not found: {input_path}")

    outdir.mkdir(parents=True, exist_ok=True)
    source = input_path.read_text(encoding="utf-8", errors="replace")

    payload_start, payload_end = find_turbopack_push_payload(source)
    payload_text = source[payload_start:payload_end]
    modules, runtime_metadata = collect_modules(payload_text, payload_start)

    print(f"Found {len(modules)} modules in {input_path.name}")
    manifest = write_modules(source, modules, outdir)

    manifest_path = outdir / "_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    bundle_info = {
        "bundler": "turbopack",
        "moduleCount": len(modules),
        "runtimeModuleIds": runtime_metadata.get("runtimeModuleIds", []),
        "otherChunks": runtime_metadata.get("otherChunks", []),
    }
    bundle_info_path = outdir / "_bundle-info.json"
    bundle_info_path.write_text(json.dumps(bundle_info, indent=2), encoding="utf-8")

    print(f"Wrote {len(modules)} modules to {outdir}/")
    print(f"Manifest: {manifest_path}")
    print(f"Bundle info: {bundle_info_path}")
    print_size_distribution(manifest)


if __name__ == "__main__":
    main()
