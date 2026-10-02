#!/usr/bin/env python3
"""Render all Mermaid pages with Chromium; verify real SVGs and no browser errors."""
import argparse
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', nargs='?', default='site')
    args = parser.parse_args()
    root = Path(args.site).resolve()
    paths = [p for p in root.rglob('*.html') if 'class="mermaid"' in p.read_text(encoding='utf-8')]
    if not paths:
        raise SystemExit('No Mermaid diagrams found; check SuperFences configuration')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(root)))
    Thread(target=server.serve_forever, daemon=True).start()
    total = 0
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.environ.get('DOCS_CHROMIUM_EXECUTABLE') or None)
            page = browser.new_page()
            errors = []
            page.on('pageerror', lambda err: errors.append(str(err)))
            for path in paths:
                errors.clear()
                response = page.goto(f'http://127.0.0.1:{server.server_port}/' + path.relative_to(root).as_posix())
                if response.status != 200:
                    raise RuntimeError(f'{path}: HTTP {response.status}')
                expected = page.locator('.mermaid').count()
                page.wait_for_function('n => document.querySelectorAll(".mermaid svg").length === n', arg=expected, timeout=60000)
                if errors or page.locator('.mermaid .error-icon, .mermaid .error-text').count():
                    raise RuntimeError(f'{path}: Mermaid/browser error: {errors}')
                total += expected
                print(f'PASS: {path.relative_to(root)}: {expected} SVG diagrams')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f'PASS: rendered {total} Mermaid diagrams across {len(paths)} pages')

if __name__ == '__main__':
    main()
