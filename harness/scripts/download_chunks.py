#!/usr/bin/env python3
"""
Download lazy-loaded webpack chunks from a webpack runtime chunk map.

Extracts name/hash maps from a beautified runtime chunk, constructs asset URLs
from a template, and downloads selected chunks.

Usage:
  python download_chunks.py --app-js <path> --outdir <dir> --base-url <url>
  python download_chunks.py --app-js <path> --outdir <dir> --url-template <tmpl>
"""

import argparse
import re
import sys
import urllib.request
from pathlib import Path

DEFAULT_URL_TEMPLATE = "{base_url}/{name}-{hash}.js"


def extract_chunk_maps(app_js_path: Path) -> tuple[dict, dict]:
    content = app_js_path.read_text(encoding="utf-8", errors="replace")

    name_map = {}
    for m in re.finditer(r'(\d+):\s*"([a-zA-Z][a-zA-Z0-9_-]+)"', content):
        cid, name = m.group(1), m.group(2)
        if len(name) > 2 and not re.match(r'^[0-9a-f]+$', name):
            name_map[cid] = name

    hash_map = {}
    for m in re.finditer(r'(\d+):\s*"([0-9a-f]{8,})"', content):
        cid, h = m.group(1), m.group(2)
        hash_map[cid] = h

    return name_map, hash_map


def build_url(
    chunk_id: str,
    name_map: dict,
    hash_map: dict,
    url_template: str,
    base_url: str | None,
) -> str | None:
    h = hash_map.get(chunk_id)
    if not h:
        return None
    name = name_map.get(chunk_id, chunk_id)
    values = {
        "id": chunk_id,
        "name": name,
        "hash": h,
        "base_url": (base_url or "").rstrip("/"),
    }
    try:
        return url_template.format(**values)
    except KeyError as e:
        raise SystemExit(f"Invalid --url-template placeholder: {e}") from e


def download_chunk(url: str, outpath: Path) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            outpath.write_bytes(data)
            return True
    except Exception as e:
        print(f"  FAIL {url}: {e}", file=sys.stderr)
        return False


def sanitize_filename(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-") or "unnamed"


def main():
    parser = argparse.ArgumentParser(description="Download webpack lazy chunks from extracted chunk maps")
    parser.add_argument("--app-js", required=True, help="Path to beautified runtime/app chunk")
    parser.add_argument("--outdir", required=True, help="Output directory for downloaded chunks")
    parser.add_argument("--base-url", help="Base URL prefix for chunk assets")
    parser.add_argument(
        "--url-template",
        default=DEFAULT_URL_TEMPLATE,
        help=(
            "URL template with placeholders: {base_url}, {id}, {name}, {hash}. "
            f"Default: {DEFAULT_URL_TEMPLATE}"
        ),
    )
    parser.add_argument("--all", action="store_true", help="Download ALL chunks (named + unnamed)")
    parser.add_argument("--filter", type=str, help="Regex filter on chunk names")
    parser.add_argument("--list", action="store_true", help="Just list chunks, don't download")
    parser.add_argument("--unnamed", action="store_true", help="Include unnamed chunks")
    args = parser.parse_args()

    if "{base_url}" in args.url_template and not args.base_url:
        raise SystemExit("--base-url is required when --url-template uses {base_url}")

    app_js_path = Path(args.app_js)
    if not app_js_path.exists() or not app_js_path.is_file():
        raise SystemExit(f"Input file not found: {app_js_path}")

    name_map, hash_map = extract_chunk_maps(app_js_path)
    print(f"Found {len(name_map)} named chunks, {len(hash_map)} total hashed chunks")

    # Determine which chunks to process
    if args.all:
        chunk_ids = list(hash_map.keys())
    elif args.filter:
        pat = re.compile(args.filter, re.IGNORECASE)
        chunk_ids = [cid for cid, name in name_map.items() if pat.search(name)]
    else:
        chunk_ids = list(name_map.keys()) if name_map else list(hash_map.keys())

    if args.unnamed or args.all:
        unnamed = [cid for cid in hash_map if cid not in name_map]
        chunk_ids.extend(unnamed)

    chunk_ids = sorted(set(chunk_ids), key=lambda x: name_map.get(x, x))

    if args.list:
        for cid in chunk_ids:
            name = name_map.get(cid, f"(unnamed-{cid})")
            url = build_url(cid, name_map, hash_map, args.url_template, args.base_url)
            print(f"  {cid:>6}  {name:<50}  {url}")
        print(f"\nTotal: {len(chunk_ids)} chunks")
        return

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    skipped = 0
    for cid in chunk_ids:
        name = name_map.get(cid, cid)
        url = build_url(cid, name_map, hash_map, args.url_template, args.base_url)
        if not url:
            continue

        outpath = outdir / f"{cid}_{sanitize_filename(name)}.js"
        if outpath.exists():
            skipped += 1
            continue

        print(f"  Downloading {name} ({cid})...")
        if download_chunk(url, outpath):
            downloaded += 1

    print(f"\nDone: {downloaded} downloaded, {skipped} skipped (already exist)")
    print(f"Chunks saved to {outdir}/")


if __name__ == "__main__":
    main()
