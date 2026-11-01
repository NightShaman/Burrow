import http.server, os, pathlib
ROOT = pathlib.Path(__file__).resolve().parent / 'bundle'
class Handler(http.server.SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT),**kwargs)
 def end_headers(self):
  self.send_header('Content-Security-Policy', "default-src 'self'; connect-src 'none'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'")
  self.send_header('Cache-Control','no-store');super().end_headers()
 def do_GET(self):
  target=(ROOT/self.path.split('?')[0].lstrip('/')).resolve()
  if not target.is_relative_to(ROOT): self.send_error(403);return
  super().do_GET()
server=http.server.ThreadingHTTPServer(('0.0.0.0',0),Handler)
print(f'PID={os.getpid()} PORT={server.server_port} ROOT={ROOT}',flush=True)
server.serve_forever()
