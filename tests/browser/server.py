"""Test server: serves the app and renders MusicXML with the real Verovio engine
(pip install verovio) at POST /__verovio, so browser tests see genuine Verovio output."""
import json, sys, os, http.server, socketserver
import verovio
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
tk = verovio.toolkit()
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        if self.path != '/__verovio': return self.send_error(404)
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tk.setOptions(dict(body.get('opts') or {}))
        ok = tk.loadData(body['xml'])
        out = {'ok': bool(ok)}
        if ok:
            out['pages'] = [tk.renderToSVG(p) for p in range(1, tk.getPageCount() + 1)]
            out['timemap'] = tk.renderToTimemap({'includeMeasures': True})
        data = json.dumps(out).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8080), H) as s: s.serve_forever()
