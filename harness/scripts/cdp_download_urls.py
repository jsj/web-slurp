#!/usr/bin/env python3
"""Download URLs via Chrome CDP, using the browser's session context."""

import argparse
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path
import re
import websocket  # pip install websocket-client


def get_ws_url(cdp_host: str = "http://127.0.0.1:9222") -> str:
    targets = json.loads(urllib.request.urlopen(f"{cdp_host}/json").read())
    for t in targets:
        if t.get("type") == "page":
            return t["webSocketDebuggerUrl"]
    # Create a new tab
    new = json.loads(urllib.request.urlopen(f"{cdp_host}/json/new").read())
    return new["webSocketDebuggerUrl"]


def cdp_send(ws, method: str, params: dict | None = None, timeout: float = 30) -> dict:
    msg_id = int(time.time() * 1000) % 1_000_000
    ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = json.loads(ws.recv())
        except Exception:
            continue
        if resp.get("id") == msg_id:
            return resp
    raise TimeoutError(f"CDP timeout: {method}")


def navigate_and_wait(ws, url: str, wait: float = 5):
    cdp_send(ws, "Page.enable")
    cdp_send(ws, "Page.navigate", {"url": url})
    time.sleep(wait)


def fetch_url(ws, url: str) -> bytes | None:
    resp = cdp_send(ws, "Runtime.evaluate", {
        "expression": f"""
            fetch("{url}").then(r => r.arrayBuffer()).then(buf => {{
                const bytes = new Uint8Array(buf);
                let binary = '';
                for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                return btoa(binary);
            }})
        """,
        "awaitPromise": True,
        "returnByValue": True,
    }, timeout=30)
    try:
        b64 = resp["result"]["result"]["value"]
        return base64.b64decode(b64)
    except (KeyError, TypeError):
        return None


def sanitize(url: str) -> str:
    name = url.split("/")[-1].split("?")[0]
    return re.sub(r"[^a-zA-Z0-9._-]", "_", name) or "chunk.js"


def main():
    parser = argparse.ArgumentParser(description="Download URLs via Chrome CDP")
    parser.add_argument("url_list", help="File with one URL per line")
    parser.add_argument("outdir", help="Output directory")
    parser.add_argument("--referer", default="https://www.tmz.com/", help="Navigate to this page first")
    parser.add_argument("--cdp", default="http://127.0.0.1:9222", help="CDP endpoint")
    args = parser.parse_args()

    urls = [l.strip() for l in Path(args.url_list).read_text().splitlines() if l.strip()]
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    ws_url = get_ws_url(args.cdp)
    ws = websocket.create_connection(ws_url, timeout=30)

    print(f"Navigating to {args.referer} to establish context...")
    navigate_and_wait(ws, args.referer, wait=6)
    print(f"Context ready. Downloading {len(urls)} files...")

    ok, fail = 0, 0
    for i, url in enumerate(urls, 1):
        fname = sanitize(url)
        outpath = outdir / fname
        if outpath.exists() and outpath.stat().st_size > 200:
            ok += 1
            continue

        data = fetch_url(ws, url)
        if data and len(data) > 100:
            outpath.write_bytes(data)
            ok += 1
            if i % 20 == 0 or i == len(urls):
                print(f"  [{i}/{len(urls)}] {fname} ({len(data)} bytes)")
        else:
            fail += 1
            print(f"  [{i}/{len(urls)}] FAIL {fname}", file=sys.stderr)

    ws.close()
    print(f"\nDone: {ok} ok, {fail} failed -> {outdir}/")


if __name__ == "__main__":
    main()
