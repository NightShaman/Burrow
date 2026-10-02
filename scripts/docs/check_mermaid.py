#!/usr/bin/env python3
"""Render all Mermaid pages with Chromium; verify real SVGs and no browser errors."""
import argparse
import json
import os
from functools import partial
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright


# Material renders each diagram in a CLOSED shadow root. Retain the returned root
# for inspection without changing attachShadow's options or the site's behavior.
# Install before navigation, so even roots created during page startup are seen.
CAPTURE_SHADOW_ROOTS = """(() => {
    const roots = new WeakMap();
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (...args) {
        const root = Reflect.apply(attachShadow, this, args);
        roots.set(this, root);
        return root;
    };
    Object.defineProperty(window, '__docsMermaidRoots', { value: roots });
})()"""

DIAGRAM_STATE = """() => {
    const errorSelector = '.error-icon, .error-text, svg[aria-roledescription="error"]';
    const errors = [...document.querySelectorAll(errorSelector)]
        .map(el => el.textContent.trim() || el.getAttribute('class'));
    const diagrams = [...document.querySelectorAll('.mermaid')].map((host, index) => {
        const root = window.__docsMermaidRoots.get(host) || host.shadowRoot || host;
        const svgs = [...root.querySelectorAll('svg')];
        const svg = svgs[0];
        const box = svg ? svg.getBoundingClientRect() : { width: 0, height: 0 };
        const graphics = svg ? svg.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line, text, foreignObject').length : 0;
        const diagramErrors = [...root.querySelectorAll(errorSelector)]
            .map(el => el.textContent.trim() || el.getAttribute('class'));
        errors.push(...diagramErrors);
        return {
            index: index + 1,
            host: host.tagName.toLowerCase(),
            shadow: root !== host,
            svgCount: svgs.length,
            width: box.width,
            height: box.height,
            graphics,
            rendered: svgs.length === 1 &&
                svg.namespaceURI === 'http://www.w3.org/2000/svg' &&
                box.width > 0 && box.height > 0 && graphics > 0 &&
                diagramErrors.length === 0,
        };
    });
    return { diagrams, errors };
}"""

WAIT_FOR_DIAGRAMS = """expected => {
    const state = (""" + DIAGRAM_STATE + """)();
    // Return Mermaid error SVGs immediately rather than waiting for a timeout.
    return state.errors.length ||
        (state.diagrams.length === expected && state.diagrams.every(d => d.rendered))
        ? state : false;
}"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class DiagramCounter(HTMLParser):
    """Count built source blocks before Material temporarily removes their class."""

    def __init__(self):
        super().__init__()
        self.count = 0

    def handle_starttag(self, tag, attrs):
        if 'mermaid' in (dict(attrs).get('class') or '').split():
            self.count += 1


def diagram_count(path):
    parser = DiagramCounter()
    parser.feed(path.read_text(encoding='utf-8'))
    return parser.count


def save_artifacts(page, directory, relative_path, report):
    if directory is None:
        return
    # Preserve the page hierarchy to avoid collisions between index.html files.
    destination = directory / relative_path.with_suffix('')
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        page.screenshot(path=str(destination.with_suffix('.png')), full_page=True, timeout=15000)
    except Exception as exc:
        # A crashed browser must not hide the original failure or its diagnostics.
        report['screenshot_error'] = str(exc)
    destination.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('site', nargs='?', default='site')
    parser.add_argument('--artifacts', type=Path, help='Save homepage and diagram-page screenshots and JSON diagnostics')
    args = parser.parse_args()
    root = Path(args.site).resolve()
    paths = [(path, count) for path in sorted(root.rglob('*.html')) if (count := diagram_count(path))]
    if not paths:
        raise SystemExit('No Mermaid diagrams found; check SuperFences configuration')
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(root)))
    Thread(target=server.serve_forever, daemon=True).start()
    total = 0
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=os.environ.get('DOCS_CHROMIUM_EXECUTABLE') or None)
            page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
            page.add_init_script(CAPTURE_SHADOW_ROOTS)
            errors, console_errors, failed_requests, failed_responses = [], [], [], []
            page.on('pageerror', lambda err: errors.append(str(err)))
            page.on('console', lambda msg: console_errors.append(msg.text) if msg.type == 'error' else None)
            page.on('requestfailed', lambda request: failed_requests.append({'url': request.url, 'failure': request.failure}))
            page.on('response', lambda response: failed_responses.append({'url': response.url, 'status': response.status}) if response.status >= 400 else None)
            # The homepage is useful visual context, even when it has no diagram.
            homepage = root / 'index.html'
            if args.artifacts and homepage.is_file() and all(path != homepage for path, _ in paths):
                paths_to_check = [(homepage, 0), *paths]
            else:
                paths_to_check = paths
            for path, expected in paths_to_check:
                for events in (errors, console_errors, failed_requests, failed_responses):
                    events.clear()
                relative_path = path.relative_to(root)
                report = {'page': relative_path.as_posix(), 'expected': expected}
                try:
                    response = page.goto(f'http://127.0.0.1:{server.server_port}/' + relative_path.as_posix())
                    if response is None or response.status != 200:
                        raise RuntimeError(f'HTTP {response.status if response else "no response"}')
                    if expected:
                        state = page.wait_for_function(WAIT_FOR_DIAGRAMS, arg=expected, timeout=60000).json_value()
                    else:
                        state = page.evaluate(DIAGRAM_STATE)
                    report.update(state)
                    if state['errors'] or errors:
                        raise RuntimeError(f'Mermaid/browser errors: {state["errors"] + errors}')
                    report['result'] = 'pass'
                except Exception as exc:
                    report.update(result='fail', failure=str(exc))
                    try:
                        report.update(page.evaluate(DIAGRAM_STATE))
                    except Exception as diagnostic_error:
                        report['diagnostic_error'] = str(diagnostic_error)
                    raise RuntimeError(f'{relative_path}: {exc}') from exc
                finally:
                    report.update(browser_errors=list(errors), console_errors=list(console_errors),
                                  failed_requests=list(failed_requests), failed_responses=list(failed_responses))
                    save_artifacts(page, args.artifacts, relative_path, report)
                    if report.get('result') == 'fail':
                        print(json.dumps(report, indent=2), flush=True)
                total += expected
                print(f'PASS: {relative_path}: {expected} SVG diagrams', flush=True)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print(f'PASS: rendered {total} Mermaid diagrams across {len(paths)} pages')


if __name__ == '__main__':
    main()
