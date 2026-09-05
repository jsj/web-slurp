#!/usr/bin/env python3
"""Extract a reusable style inventory from a captured target directory."""

from __future__ import annotations

import argparse
import json
import re
import urllib.request
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

STYLESHEET_REL = "stylesheet"
TAILWIND_DIRECTIVE_RE = re.compile(r"@tailwind\b")
TAILWIND_VAR_RE = re.compile(r"--tw-[A-Za-z0-9_-]+")
CSS_MODULE_EXPORT_RE = re.compile(
    r"(?P<module_id>\d+)\s*:\s*(?:\([^)]*\)\s*=>\s*|\w+\s*=>\s*|function\s*\([^)]*\)\s*)"
    r"\{\s*(?:\w+\.)?exports\s*=\s*\{(?P<body>[^{}]{1,50000})\}\s*\}",
    re.S,
)
EXPORT_PAIR_RE = re.compile(
    r"(?P<key>\"[^\"]+\"|'[^']+'|[A-Za-z0-9_-]+)\s*:\s*\"(?P<value>[^\"]+)\""
)
STRING_RE = re.compile(r"\"([^\"]+)\"|'([^']+)'")
CUSTOM_PROPERTY_DEF_RE = re.compile(r"(--[A-Za-z0-9_-]+)\s*:")
CUSTOM_PROPERTY_USE_RE = re.compile(r"var\(\s*(--[A-Za-z0-9_-]+)")
CLASS_SELECTOR_RE = re.compile(r"(?<![A-Za-z0-9_-])\.([A-Za-z_-][A-Za-z0-9_-]*)")
MODULE_HEADER_RE = re.compile(r"^// Module (\d+)")
STYLE_OBJECT_START_RE = re.compile(r"\bstyle\s*:\s*\{")
STYLE_PROPERTY_RE = re.compile(r"([A-Za-z_$-][A-Za-z0-9_$-]*)\s*:")


class CapturedHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stylesheets: list[str] = []
        self.canonical_url: str | None = None
        self.inline_style_blocks: list[str] = []
        self._in_style = False
        self._style_chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_map = {key.lower(): (value or "") for key, value in attrs}
        if tag.lower() == "link":
            rel_values = {part.lower() for part in attr_map.get("rel", "").split()}
            href = attr_map.get("href", "")
            if STYLESHEET_REL in rel_values and href:
                self.stylesheets.append(href)
            if "canonical" in rel_values and href and not self.canonical_url:
                self.canonical_url = href
        elif tag.lower() == "style":
            self._in_style = True
            self._style_chunks = []

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "style" and self._in_style:
            content = "".join(self._style_chunks).strip()
            if content:
                self.inline_style_blocks.append(content)
            self._style_chunks = []
            self._in_style = False

    def handle_data(self, data: str) -> None:
        if self._in_style:
            self._style_chunks.append(data)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract stylesheet URLs, CSS-module exports, and style tokens from a target."
    )
    parser.add_argument(
        "target",
        help="Path to a target directory containing input/ and output/ (for example targets/linear)",
    )
    parser.add_argument("--html", help="Override the captured HTML file to inspect")
    parser.add_argument("--base-url", help="Override the page URL used to resolve relative CSS links")
    parser.add_argument(
        "--outdir",
        help="Directory to write reports (default: <target>/output/style-inventory)",
    )
    parser.add_argument(
        "--download-css",
        action="store_true",
        help="Download linked CSS assets into <outdir>/css before scanning them",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Redownload CSS assets even if they already exist locally",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Network timeout in seconds for stylesheet downloads",
    )
    parser.add_argument(
        "--sample-limit",
        type=int,
        default=40,
        help="Maximum number of samples to keep in the JSON reports",
    )
    return parser.parse_args()


def find_html_file(target_dir: Path, override: str | None) -> Path:
    if override:
        path = Path(override)
        if not path.is_absolute():
            path = target_dir / path
        if path.exists():
            return path
        raise SystemExit(f"HTML file not found: {path}")

    page_source_dir = target_dir / "input" / "page-source"
    html_files = sorted(page_source_dir.glob("*.html"))
    if not html_files:
        raise SystemExit(f"No HTML files found in {page_source_dir}")
    return html_files[0]


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError:
        return {}


def resolve_base_url(
    html_parser: CapturedHTMLParser,
    metadata: dict[str, Any],
    override: str | None,
) -> str:
    if override:
        return override
    capture_url = metadata.get("url")
    if isinstance(capture_url, str) and capture_url:
        return capture_url
    if html_parser.canonical_url:
        return html_parser.canonical_url
    return ""


def top_items(counter: Counter[str], limit: int) -> list[dict[str, Any]]:
    return [{"name": name, "count": count} for name, count in counter.most_common(limit)]


def relative_to(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def download_stylesheets(
    stylesheets: list[str],
    base_url: str,
    css_dir: Path,
    force: bool,
    timeout: float,
) -> list[dict[str, Any]]:
    css_dir.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, Any]] = []

    for index, href in enumerate(stylesheets, start=1):
        absolute_url = urljoin(base_url, href) if base_url else href
        parsed = urlparse(absolute_url)
        filename = Path(parsed.path).name or f"stylesheet-{index}.css"
        destination = css_dir / filename

        record: dict[str, Any] = {
            "href": href,
            "absolute_url": absolute_url,
            "local_file": str(destination),
        }

        if destination.exists() and not force:
            record["downloaded"] = False
            record["status"] = "reused"
            record["bytes"] = destination.stat().st_size
            results.append(record)
            continue

        try:
            request = urllib.request.Request(
                absolute_url,
                headers={"User-Agent": "webpack-decomp-harness/style-inventory"},
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
            destination.write_bytes(payload)
            record["downloaded"] = True
            record["status"] = "downloaded"
            record["bytes"] = len(payload)
        except Exception as exc:  # pragma: no cover - network failures are environment-specific
            record["downloaded"] = False
            record["status"] = "error"
            record["error"] = str(exc)

        results.append(record)

    return results


def scan_css_text(content: str) -> dict[str, Counter[str]]:
    return {
        "class_selectors": Counter(CLASS_SELECTOR_RE.findall(content)),
        "defined_custom_properties": Counter(CUSTOM_PROPERTY_DEF_RE.findall(content)),
        "used_custom_properties": Counter(CUSTOM_PROPERTY_USE_RE.findall(content)),
    }


def parse_export_body(body: str) -> dict[str, str]:
    pairs: dict[str, str] = {}
    for match in EXPORT_PAIR_RE.finditer(body):
        raw_key = match.group("key")
        key = raw_key.strip("\"'")
        pairs[key] = match.group("value")
    return pairs


def extract_css_module_exports(source_files: list[Path], repo_root: Path) -> list[dict[str, Any]]:
    exports: list[dict[str, Any]] = []
    for file_path in source_files:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        for match in CSS_MODULE_EXPORT_RE.finditer(text):
            pairs = parse_export_body(match.group("body"))
            if not pairs:
                continue
            if not any("__" in value for value in pairs.values()):
                continue
            exports.append(
                {
                    "file": relative_to(file_path, repo_root),
                    "module_id": match.group("module_id"),
                    "entries": pairs,
                }
            )
    return exports


def is_probable_class_literal(value: str) -> bool:
    if not value:
        return False
    if "://" in value or value.startswith("var(") or value.startswith("#"):
        return False
    if len(value) > 80:
        return False
    if any(token in value for token in (" ", "\n")):
        return "-" in value
    return "-" in value


def truncate(text: str, limit: int = 160) -> str:
    compact = " ".join(text.split())
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def find_matching_brace(text: str, start: int) -> int | None:
    depth = 0
    quote: str | None = None
    escaped = False

    for index in range(start, len(text)):
        char = text[index]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue

        if char in {"'", '"', "`"}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return None


def iter_style_objects(text: str) -> list[str]:
    objects: list[str] = []
    for match in STYLE_OBJECT_START_RE.finditer(text):
        start = text.find("{", match.start())
        if start == -1:
            continue
        end = find_matching_brace(text, start)
        if end is None:
            continue
        objects.append(text[start : end + 1])
    return objects


def module_id_for_file(file_path: Path) -> str | None:
    header = file_path.read_text(encoding="utf-8", errors="replace").splitlines()[:1]
    if not header:
        return None
    match = MODULE_HEADER_RE.match(header[0])
    return match.group(1) if match else None


def scan_js_style_usage(
    source_files: list[Path],
    repo_root: Path,
    sample_limit: int,
) -> dict[str, Any]:
    css_vars = Counter()
    literal_classes = Counter()
    inline_style_properties = Counter()
    inline_style_object_count = 0
    inline_style_samples: list[dict[str, Any]] = []

    for file_path in source_files:
        text = file_path.read_text(encoding="utf-8", errors="replace")
        css_vars.update(CUSTOM_PROPERTY_USE_RE.findall(text))

        for line in text.splitlines():
            if "className" not in line:
                continue
            for match in STRING_RE.finditer(line):
                literal = match.group(1) or match.group(2) or ""
                if is_probable_class_literal(literal):
                    literal_classes[literal] += 1

        file_module_id = module_id_for_file(file_path)
        for style_object in iter_style_objects(text):
            properties = STYLE_PROPERTY_RE.findall(style_object)
            if not properties:
                continue
            inline_style_object_count += 1
            inline_style_properties.update(properties)
            if len(inline_style_samples) < sample_limit:
                inline_style_samples.append(
                    {
                        "file": relative_to(file_path, repo_root),
                        "module_id": file_module_id,
                        "properties": properties[:12],
                        "snippet": truncate(style_object),
                    }
                )

    return {
        "files_scanned": len(source_files),
        "custom_property_usage": css_vars,
        "literal_class_names": literal_classes,
        "inline_style_objects": inline_style_object_count,
        "inline_style_property_usage": inline_style_properties,
        "inline_style_samples": inline_style_samples,
    }


def guess_styling_system(
    tailwind_signal_count: int,
    css_module_exports: list[dict[str, Any]],
    html_text: str,
) -> str:
    if tailwind_signal_count > 0:
        return "Tailwind or a mixed pipeline is present."
    if css_module_exports and ("data-styled" in html_text or "styled-components" in html_text):
        return "CSS modules + styled-components + compiled Next.js CSS assets."
    if css_module_exports:
        return "CSS modules + compiled Next.js CSS assets."
    return "Compiled CSS assets without obvious Tailwind source markers."


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def main() -> None:
    args = parse_args()
    target_dir = Path(args.target).resolve()
    if not target_dir.exists():
        raise SystemExit(f"Target directory not found: {target_dir}")

    repo_root = target_dir.parent.parent.resolve()
    html_file = find_html_file(target_dir, args.html)
    outdir = Path(args.outdir).resolve() if args.outdir else target_dir / "output" / "style-inventory"
    outdir.mkdir(parents=True, exist_ok=True)

    html_text = html_file.read_text(encoding="utf-8", errors="replace")
    html_parser = CapturedHTMLParser()
    html_parser.feed(html_text)

    metadata = read_json(html_file.parent / "capture-metadata.json")
    base_url = resolve_base_url(html_parser, metadata, args.base_url)

    stylesheet_urls = sorted(dict.fromkeys(html_parser.stylesheets))
    write_text(outdir / "stylesheet-urls.txt", "\n".join(stylesheet_urls) + ("\n" if stylesheet_urls else ""))

    css_downloads: list[dict[str, Any]] = []
    if args.download_css and stylesheet_urls:
        css_downloads = download_stylesheets(
            stylesheet_urls,
            base_url,
            outdir / "css",
            args.force,
            args.timeout,
        )
    else:
        existing_css_dir = outdir / "css"
        if existing_css_dir.exists():
            for css_file in sorted(existing_css_dir.glob("*.css")):
                css_downloads.append(
                    {
                        "href": css_file.name,
                        "absolute_url": "",
                        "local_file": str(css_file),
                        "downloaded": False,
                        "status": "existing",
                        "bytes": css_file.stat().st_size,
                    }
                )

    css_reports: list[dict[str, Any]] = []
    css_class_selectors = Counter()
    css_defined_vars = Counter()
    css_used_vars = Counter()

    for index, block in enumerate(html_parser.inline_style_blocks, start=1):
        stats = scan_css_text(block)
        css_class_selectors.update(stats["class_selectors"])
        css_defined_vars.update(stats["defined_custom_properties"])
        css_used_vars.update(stats["used_custom_properties"])
        css_reports.append(
            {
                "source": f"inline-style-{index}",
                "kind": "inline-style",
                "bytes": len(block.encode("utf-8")),
                "top_class_selectors": top_items(stats["class_selectors"], 20),
                "top_defined_custom_properties": top_items(stats["defined_custom_properties"], 20),
                "top_used_custom_properties": top_items(stats["used_custom_properties"], 20),
            }
        )

    for css_record in css_downloads:
        local_file = css_record.get("local_file")
        if not local_file or css_record.get("status") == "error":
            continue
        css_path = Path(local_file)
        if not css_path.exists():
            continue
        css_text = css_path.read_text(encoding="utf-8", errors="replace")
        stats = scan_css_text(css_text)
        css_class_selectors.update(stats["class_selectors"])
        css_defined_vars.update(stats["defined_custom_properties"])
        css_used_vars.update(stats["used_custom_properties"])
        css_reports.append(
            {
                "source": relative_to(css_path, repo_root),
                "kind": "downloaded-stylesheet",
                "href": css_record.get("href"),
                "absolute_url": css_record.get("absolute_url"),
                "bytes": css_record.get("bytes", len(css_text.encode("utf-8"))),
                "top_class_selectors": top_items(stats["class_selectors"], 20),
                "top_defined_custom_properties": top_items(stats["defined_custom_properties"], 20),
                "top_used_custom_properties": top_items(stats["used_custom_properties"], 20),
            }
        )

    raw_bundle_files = sorted((target_dir / "input" / "bundles" / "raw").glob("*.js"))
    module_files = sorted((target_dir / "output" / "modules").glob("**/*.js"))
    js_source_files = module_files if module_files else raw_bundle_files

    css_module_exports = extract_css_module_exports(raw_bundle_files or module_files, repo_root)
    semantic_keys = Counter()
    namespace_names = Counter()
    for record in css_module_exports:
        for key, value in record["entries"].items():
            semantic_keys[key] += 1
            namespace_names[value.split("__", 1)[0]] += 1

    js_style_usage = scan_js_style_usage(js_source_files, repo_root, args.sample_limit)

    tailwind_signal_count = 0
    for path in [html_file, *raw_bundle_files, *module_files]:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        tailwind_signal_count += len(TAILWIND_DIRECTIVE_RE.findall(text))
        tailwind_signal_count += len(TAILWIND_VAR_RE.findall(text))

    styling_system_guess = guess_styling_system(tailwind_signal_count, css_module_exports, html_text)

    stylesheets_json_path = outdir / "stylesheets.json"
    css_modules_json_path = outdir / "css-modules.json"
    inventory_json_path = outdir / "inventory.json"
    summary_md_path = outdir / "summary.md"

    stylesheet_download_records = []
    for record in css_downloads:
        normalized = dict(record)
        if normalized.get("local_file"):
            normalized["local_file"] = relative_to(Path(normalized["local_file"]), repo_root)
        stylesheet_download_records.append(normalized)

    write_text(
        stylesheets_json_path,
        json.dumps(
            {
                "downloads": stylesheet_download_records,
                "sources": css_reports,
            },
            indent=2,
        ),
    )
    write_text(css_modules_json_path, json.dumps(css_module_exports, indent=2))

    inventory = {
        "target_dir": str(target_dir),
        "html_file": str(html_file),
        "base_url": base_url,
        "styling_system_guess": styling_system_guess,
        "tailwind_signals": {
            "strong_signal_count": tailwind_signal_count,
            "tailwind_like": tailwind_signal_count > 0,
        },
        "stylesheets": {
            "linked": len(stylesheet_urls),
            "download_attempts": len(css_downloads),
            "downloaded": sum(1 for item in css_downloads if item.get("status") == "downloaded"),
            "failed": sum(1 for item in css_downloads if item.get("status") == "error"),
            "available_locally": sum(
                1 for item in css_downloads if item.get("status") in {"downloaded", "reused", "existing"}
            ),
            "inline_style_blocks": len(html_parser.inline_style_blocks),
            "stylesheet_urls_file": relative_to(outdir / "stylesheet-urls.txt", repo_root),
            "report_file": relative_to(stylesheets_json_path, repo_root),
            "download_records": stylesheet_download_records,
            "top_css_class_selectors": top_items(css_class_selectors, args.sample_limit),
            "top_css_defined_custom_properties": top_items(css_defined_vars, args.sample_limit),
            "top_css_used_custom_properties": top_items(css_used_vars, args.sample_limit),
        },
        "css_modules": {
            "export_blocks": len(css_module_exports),
            "top_semantic_keys": top_items(semantic_keys, args.sample_limit),
            "top_namespaces": top_items(namespace_names, args.sample_limit),
            "report_file": relative_to(css_modules_json_path, repo_root),
        },
        "js_style_usage": {
            "source_files_scanned": js_style_usage["files_scanned"],
            "top_custom_property_usage": top_items(js_style_usage["custom_property_usage"], args.sample_limit),
            "top_literal_class_names": top_items(js_style_usage["literal_class_names"], args.sample_limit),
            "top_inline_style_properties": top_items(
                js_style_usage["inline_style_property_usage"], args.sample_limit
            ),
            "inline_style_object_count": js_style_usage["inline_style_objects"],
            "inline_style_sample_count": len(js_style_usage["inline_style_samples"]),
            "inline_style_samples": js_style_usage["inline_style_samples"],
        },
    }
    write_text(inventory_json_path, json.dumps(inventory, indent=2))

    summary_lines = [
        "# Style Inventory",
        "",
        f"- Target: `{relative_to(target_dir, repo_root)}`",
        f"- HTML: `{relative_to(html_file, repo_root)}`",
        f"- Styling system guess: {styling_system_guess}",
        f"- Strong Tailwind signals found: {tailwind_signal_count}",
        (
            f"- Linked stylesheets: {len(stylesheet_urls)} "
            f"({sum(1 for item in css_downloads if item.get('status') in {'downloaded', 'reused', 'existing'})}"
            " available locally)"
        ),
        f"- CSS module export blocks: {len(css_module_exports)}",
        f"- JS style source files scanned: {js_style_usage['files_scanned']}",
        "",
        "## Top JS custom properties",
    ]
    summary_lines.extend(
        f"- `{item['name']}`: {item['count']}" for item in top_items(js_style_usage["custom_property_usage"], 15)
    )
    summary_lines.extend(["", "## Top literal class names"])
    summary_lines.extend(
        f"- `{item['name']}`: {item['count']}" for item in top_items(js_style_usage["literal_class_names"], 15)
    )
    summary_lines.extend(["", "## Top CSS module namespaces"])
    summary_lines.extend(f"- `{item['name']}`: {item['count']}" for item in top_items(namespace_names, 15))
    summary_lines.extend(["", "## Artifacts"])
    summary_lines.extend(
        [
            f"- Inventory JSON: `{relative_to(inventory_json_path, repo_root)}`",
            f"- CSS module exports: `{relative_to(css_modules_json_path, repo_root)}`",
            f"- Stylesheet report: `{relative_to(stylesheets_json_path, repo_root)}`",
            f"- Stylesheet URLs: `{relative_to(outdir / 'stylesheet-urls.txt', repo_root)}`",
        ]
    )
    write_text(summary_md_path, "\n".join(summary_lines) + "\n")

    print(f"Wrote {inventory_json_path}")
    print(f"Wrote {css_modules_json_path}")
    print(f"Wrote {stylesheets_json_path}")
    print(f"Wrote {summary_md_path}")


if __name__ == "__main__":
    main()
