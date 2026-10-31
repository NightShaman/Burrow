#!/usr/bin/env python3
"""Serve only the built fixture; no API proxy and no backend access."""
import argparse
import http.server
import os
import pathlib
import urllib.parse

ROOT = (pathlib.Path(__file__).resolve().parent / 'bundle').resolve()
CSP = ("default-src 'self'; connect-src 'none'; img-src 'self' data: blob:; "
       "script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; "
       "frame-ancestors 'none'; worker-src 'none'")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def allowed_path(self):
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path == '/api' or path.startswith('/api/'):
            return False
        return (ROOT / path.lstrip('/')).resolve().is_relative_to(ROOT)

    def do_GET(self):
        if not self.allowed_path():
            self.send_error(403)
            return
        super().do_GET()

    def do_HEAD(self):
        if not self.allowed_path():
            self.send_error(403)
            return
        super().do_HEAD()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='127.0.0.1', help='bind address (use 10.10.20.105 only on a trusted private interface)')
    parser.add_argument('--port', type=int, default=0, help='bind port; 0 selects a free high port (default)')
    args = parser.parse_args()
    if not (ROOT / 'index.html').is_file():
        parser.error('fixture bundle not found; run node scripts/schedules-fixture/build.mjs first')
    with http.server.ThreadingHTTPServer((args.host, args.port), Handler) as server:
        print(f'PID={os.getpid()} HOST={args.host} PORT={server.server_port} ROOT={ROOT}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
