"""Recognition server tests with a stub homr. Run: python3 tests/server/test_server.py"""
import os, subprocess, sys, time, socket, io
import requests
HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, '..', '..', 'server')
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' | ' + str(detail)[:200] if detail != '' else ''))
def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p
def start(**env):
    port = free_port()
    e = dict(os.environ, HOMR_CMD=sys.executable + ' ' + os.path.join(HERE, 'stub_homr.py'), PORT=str(port)); e.update(env)
    p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app:app', '--port', str(port), '--log-level', 'warning'], cwd=SERVER, env=e)
    base = 'http://127.0.0.1:%d' % port
    for _ in range(100):
        try: requests.get(base + '/health', timeout=0.5); return p, base
        except Exception: time.sleep(0.1)
    raise RuntimeError('server did not start')
PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 100
JPG = b'\xff\xd8\xff\xe0' + b'\0' * 100

p, base = start()
try:
    h = requests.get(base + '/health').json()
    check('health reports homr engine', h['ok'] and h['engine'] == 'homr' and h['needsKey'] is False, h)
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG, 'image/jpeg')}, data={'tempo': '100'})
    check('recognise returns MusicXML', r.status_code == 200 and '<score-partwise' in r.text and 'musicxml' in r.headers['content-type'], r.status_code)
    check('recognition time header', 'X-Recognition-Seconds' in r.headers)
    r = requests.post(base + '/recognise', files={'image': ('page.png', PNG, 'image/png')})
    check('PNG accepted', r.status_code == 200)
    r = requests.post(base + '/recognise', files={'image': ('x.gif', b'GIF89a' + b'\0' * 50, 'image/gif')})
    check('non-image rejected with 415', r.status_code == 415 and 'JPEG' in r.json()['error'], r.text)
    r = requests.post(base + '/recognise', data={'tempo': '90'})
    check('missing image -> 400', r.status_code == 400, r.text)
    r = requests.options(base + '/recognise', headers={'Origin': 'https://bezoon5.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-api-key'})
    check('CORS preflight allowed for GitHub Pages', r.status_code == 200 and r.headers.get('access-control-allow-origin') == 'https://bezoon5.github.io', dict(r.headers))
    r = requests.options(base + '/recognise', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST'})
    check('CORS refused for other sites', r.headers.get('access-control-allow-origin') is None)
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG + b'\0' * (21 * 1024 * 1024), 'image/jpeg')})
    check('oversized upload -> 413', r.status_code == 413, r.status_code)
finally:
    p.terminate(); p.wait()

p, base = start(STUB_MODE='fail')
try:
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG, 'image/jpeg')})
    check('homr failure -> 422 with reason', r.status_code == 422 and 'no staffs found' in r.json()['error'], r.text)
finally:
    p.terminate(); p.wait()

p, base = start(STUB_MODE='slow', HOMR_TIMEOUT='1')
try:
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG, 'image/jpeg')})
    check('timeout -> 504', r.status_code == 504 and 'longer than' in r.json()['error'], r.text)
    h = requests.get(base + '/health').json()
    check('counters recover after timeout', h['busy'] == 0 and h['queued'] == 0 and h['failed'] == 1, h)
finally:
    p.terminate(); p.wait()

p, base = start(API_KEY='s3cret')
try:
    check('health says key needed', requests.get(base + '/health').json()['needsKey'] is True)
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG, 'image/jpeg')})
    check('no key -> 401', r.status_code == 401)
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG, 'image/jpeg')}, headers={'X-API-Key': 's3cret'})
    check('right key -> 200', r.status_code == 200)
finally:
    p.terminate(); p.wait()

p, base = start(HOMR_CMD='/nonexistent/homr')
try:
    r = requests.post(base + '/recognise', files={'image': ('page.jpg', JPG, 'image/jpeg')})
    check('homr missing -> clear 500', r.status_code == 500 and 'not installed' in r.json()['error'], r.text)
finally:
    p.terminate(); p.wait()

print('%d/%d passed' % (sum(results), len(results)))
sys.exit(0 if all(results) else 1)
