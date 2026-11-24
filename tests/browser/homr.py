"""AI recognition end to end (Playwright, Chromium): the real app talking to the real
recognition server (server/app.py) with a stub homr that returns a known MusicXML.

Run:  python3 tests/browser/homr.py [chromium_path]
Starts its own static app server and recognition servers on free ports.
"""
import asyncio, http.server, json, os, socket, socketserver, subprocess, sys, threading, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CHROME = sys.argv[1] if len(sys.argv) > 1 else None
results = []

def check(name, ok, detail=''):
    results.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + (' | ' + str(detail)[:200] if detail != '' else ''))

def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p

class App(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):  # sheet-music rendering is not under test here
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        data = json.dumps({'ok': False}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)

def start_app():
    port = free_port()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', port), App)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://127.0.0.1:%d' % port

def start_recogniser(origin, **env):
    port = free_port()
    e = dict(os.environ, HOMR_CMD=sys.executable + ' ' + os.path.join(ROOT, 'tests', 'server', 'stub_homr.py'), ALLOWED_ORIGINS=origin)
    e.update(env)
    p = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app:app', '--port', str(port), '--log-level', 'warning'], cwd=os.path.join(ROOT, 'server'), env=e)
    base = 'http://127.0.0.1:%d' % port
    import urllib.request
    for _ in range(100):
        try: urllib.request.urlopen(base + '/health', timeout=0.5); return p, base
        except Exception: time.sleep(0.1)
    raise RuntimeError('recognition server did not start')

def stub(path):
    async def handler(route):
        await route.fulfill(path=os.path.join(HERE, path), content_type='text/javascript', headers={'Access-Control-Allow-Origin': '*'})
    return handler

async def new_page(b, app, default_server=None):
    ctx = await b.new_context(viewport={'width': 1366, 'height': 1024}, service_workers='block')
    pg = await ctx.new_page()
    pg.set_default_timeout(15000)
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(path=os.path.join(HERE, 'init.js'))
    if default_server: await pg.add_init_script('window.PC_DEFAULT_HOMR_URL = %r;' % default_server)
    await pg.route('**/tone/**', stub('tone-stub.js'))
    await pg.route('**/@tonejs/midi**', lambda r: r.abort())
    await pg.route('**/tesseract**', stub('tesseract-stub.js'))
    await pg.route('**/www.verovio.org/**', stub('verovio-stub.js'))
    await pg.goto(app + '/index.html')
    return ctx, pg, errs

async def go_library(pg):
    if await pg.is_visible('#start'): await pg.click('#start')

async def set_server(pg, url, test=True):
    await go_library(pg)
    await pg.click('#settings')
    await pg.fill('#homrUrl', url)
    await pg.locator('#homrUrl').dispatch_event('change')
    if test:
        await pg.click('#homrTest')
        await pg.wait_for_function("/✓|✖/.test(document.getElementById('homrStatus').textContent)", timeout=20000)
    status = await pg.text_content('#homrStatus')
    await pg.click('#settingsDone')
    return status

async def to_layout(pg, img):
    await go_library(pg)
    async with pg.expect_file_chooser() as fc:
        await pg.click('#photos')
    await (await fc.value).set_files(img)
    await pg.wait_for_selector('.opage')
    await pg.click('#omrNext1')
    await pg.wait_for_function("document.getElementById('omrLayoutInfo').textContent.indexOf('Analysing') < 0 && document.getElementById('omrLayoutInfo').textContent.length > 0", timeout=60000)

async def main():
    app_srv, app = start_app()
    rec, rec_url = start_recogniser(app)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()

        # 1. Happy path: photo -> AI recognition -> review -> save
        ctx, pg, errs = await new_page(b, app)
        st = await set_server(pg, rec_url.replace('http://', ''))
        check('settings: test connection succeeds (address without http:// accepted)', '✓ Connected' in st, st)
        check('settings: address normalised and saved', await pg.evaluate("localStorage.getItem('pc-homr-url')") == rec_url)
        await to_layout(pg, os.path.join(HERE, 'happy.png'))
        eng = await pg.evaluate("[...document.querySelectorAll('input[name=omrEngine]')].map(r => r.value + ':' + r.checked + ':' + r.disabled).join(',')")
        check('layout: AI recognition selected by default once a server is set', eng == 'homr:true:false,device:false:false', eng)
        check('layout: button says Recognise with AI', 'AI' in await pg.text_content('#omrNext2'))
        await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=20000)
        await pg.click('#omrNext2')
        await pg.wait_for_function("/AI recognition: /.test(document.getElementById('omrReviewStatus').textContent)", timeout=60000)
        status = await pg.text_content('#omrReviewStatus')
        check('review: 9 measures recognised by AI', 'AI recognition: 9 measures recognised' in status, status)
        chips = await pg.evaluate("[...document.querySelectorAll('#omrIssues .ochip')].map(c => c.textContent)")
        check('review: every measure adds up', chips and chips[0].startswith('✖ 0'), chips)
        check('review: key F major and 3/4 filled in', await pg.input_value('#omrKey') == '-1' and await pg.input_value('#omrTime') == '3/4')
        check('review: title from homr', await pg.input_value('#omrReviewTitle') == 'Happy Birthday', await pg.input_value('#omrReviewTitle'))
        drawn = await pg.evaluate("""(() => { const c = document.getElementById('omrRec'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 0; i < d.length; i += 16) if (d[i] < 100) ink++; return ink; })()""")
        check('review: recognised score is drawn', drawn > 500, drawn)
        orig = await pg.evaluate("(() => { const c = document.getElementById('omrOrig'); return [c.width, c.height]; })()")
        check('review: original pane shows the photo', orig[0] > 100 and orig[1] > 100, orig)
        # tap the first treble note on the recognised view and move it up
        pos = await pg.evaluate("""(() => { const s = PCOMR.state.score, m = s.measures[1], st = m.staves[0], e = st.events[0], n = e.notes[0];
            const c = document.getElementById('omrRec'), r = c.getBoundingClientRect(), k = r.width / s.pages[0].width;
            const y = st.staff.bottom - (n.diatonic - OMRModel.clefBase(st.clef)) * st.staff.interline / 2;
            return [r.left + e.x * k, r.top + y * k, n.diatonic]; })()""")
        await pg.mouse.click(pos[0], pos[1])
        info = await pg.text_content('#omrSelInfo')
        check('review: tapping a note selects it', 'Measure 1 ' in info and 'treble' in info and 'D4' in info, info)
        await pg.click('#omrUp')
        moved = await pg.evaluate("PCOMR.state.score.measures[1].staves[0].events[0].notes[0].diatonic")
        check('review: pitch edit works', moved == pos[2] + 1, moved)
        await pg.click('#omrUndo')
        check('review: undo works', await pg.evaluate("PCOMR.state.score.measures[1].staves[0].events[0].notes[0].diatonic") == pos[2])
        await pg.click('#omrSave')
        await pg.wait_for_function("document.getElementById('practice') && document.getElementById('practice').classList.contains('active')", timeout=20000)
        saved = await pg.evaluate("""new Promise(res => { const rq = indexedDB.open('PC44'); rq.onsuccess = () => { const db = rq.result; const names = [...db.objectStoreNames]; const t = db.transaction('songs').objectStore('songs').getAll(); t.onsuccess = () => res(t.result.filter(s => s.source === 'OMR').map(s => [s.title, s.notes.length, s.omr.engine])); }; rq.onerror = () => res('db error'); })""")
        check('save: piece stored with all 52 notes, marked as AI-recognised', saved == [['Happy Birthday', 52, 'homr']], saved)
        check('no page errors', not errs, errs)
        await ctx.close()

        # 2. Badly lit photo: the on-device check fails, AI recognition still goes ahead
        ctx, pg, errs = await new_page(b, app)
        await set_server(pg, rec_url, test=False)
        await to_layout(pg, os.path.join(HERE, 'shadow.png'))
        await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=20000)
        info = await pg.text_content('#omrLayoutInfo')
        check('shadowed photo: can still send to AI', await pg.is_enabled('#omrNext2'), info)
        await pg.click('#omrNext2')
        await pg.wait_for_function("/AI recognition: /.test(document.getElementById('omrReviewStatus').textContent)", timeout=60000)
        check('shadowed photo: recognised', '9 measures' in await pg.text_content('#omrReviewStatus'))
        check('no page errors (shadowed)', not errs, errs)
        await ctx.close()

        # 3. Server down: clear message and fall back to the on-device recogniser
        ctx, pg, errs = await new_page(b, app)
        dead = 'http://127.0.0.1:%d' % free_port()
        st = await set_server(pg, dead)
        check('settings: unreachable server reported', '✖' in st and 'could not reach' in st.lower(), st)
        await to_layout(pg, os.path.join(HERE, 'happy.png'))
        await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=20000)
        await pg.click('#omrNext2')
        await pg.wait_for_function("/on-device recogniser instead/.test(document.getElementById('omrReviewStatus').textContent)", timeout=60000)
        status = await pg.text_content('#omrReviewStatus')
        check('server down: falls back with an explanation', 'AI recognition is unavailable' in status and 'measures recognised' in status, status)
        await ctx.close()

        # 4. Choosing the on-device engine explicitly, and no server configured
        ctx, pg, errs = await new_page(b, app)
        await set_server(pg, rec_url, test=False)
        await to_layout(pg, os.path.join(HERE, 'happy.png'))
        await pg.check('input[name=omrEngine][value=device]')
        check('engine switch: button text follows the choice', 'AI' not in await pg.text_content('#omrNext2'))
        check('engine switch: choice remembered', await pg.evaluate("localStorage.getItem('pc-omr-engine')") == 'device')
        await pg.click('#omrNext2')
        await pg.wait_for_function("/measures recognised/.test(document.getElementById('omrReviewStatus').textContent)", timeout=60000)
        check('on-device engine used when chosen', 'AI recognition' not in await pg.text_content('#omrReviewStatus') and await pg.evaluate("PCOMR.state.score.engine") == 'device')
        await ctx.close()

        ctx, pg, errs = await new_page(b, app)
        await to_layout(pg, os.path.join(HERE, 'happy.png'))
        eng = await pg.evaluate("[...document.querySelectorAll('input[name=omrEngine]')].map(r => r.value + ':' + r.checked + ':' + r.disabled).join(',')")
        check('no server set: AI option disabled with a hint, device selected', eng == 'homr:false:true,device:true:false' and 'Settings' in await pg.text_content('#omrEngineHint'), eng)
        await ctx.close()

        # 5. Built-in server: works with nothing set in Settings
        ctx, pg, errs = await new_page(b, app, default_server=rec_url)
        await go_library(pg)
        await pg.click('#settings')
        shown = await pg.input_value('#homrUrl'); st = await pg.text_content('#homrStatus')
        check('built-in server: shown in Settings', shown == rec_url and 'built-in' in st, (shown, st))
        await pg.click('#settingsDone')
        await to_layout(pg, os.path.join(HERE, 'happy.png'))
        eng = await pg.evaluate("[...document.querySelectorAll('input[name=omrEngine]')].map(r => r.value + ':' + r.checked).join(',')")
        check('built-in server: AI recognition selected without any setup', eng == 'homr:true,device:false', eng)
        await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=20000)
        await pg.click('#omrNext2')
        await pg.wait_for_function("/AI recognition: /.test(document.getElementById('omrReviewStatus').textContent)", timeout=60000)
        check('built-in server: page recognised', '9 measures' in await pg.text_content('#omrReviewStatus'))
        await pg.click('#omrClose')
        await pg.click('#settings'); await pg.fill('#homrUrl', 'other.example'); await pg.locator('#homrUrl').dispatch_event('change')
        check('built-in server: own address overrides it', await pg.evaluate("localStorage.getItem('pc-homr-url')") == 'https://other.example')
        await pg.fill('#homrUrl', ''); await pg.locator('#homrUrl').dispatch_event('change')
        check('built-in server: clearing the box goes back to it', await pg.evaluate("localStorage.getItem('pc-homr-url')") is None and await pg.input_value('#homrUrl') == rec_url)
        await ctx.close()

        # 6. Recognition failure on the server (422) also falls back
        rec.terminate(); rec.wait()
        rec, rec_url = start_recogniser(app, STUB_MODE='fail')
        ctx, pg, errs = await new_page(b, app)
        await set_server(pg, rec_url, test=False)
        await to_layout(pg, os.path.join(HERE, 'happy.png'))
        await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=20000)
        await pg.click('#omrNext2')
        await pg.wait_for_function("/instead/.test(document.getElementById('omrReviewStatus').textContent)", timeout=60000)
        status = await pg.text_content('#omrReviewStatus')
        check('server could not read page: reason shown, device fallback', 'could not read this page' in status and 'no staffs found' in status, status)
        await ctx.close()
        await b.close()
    rec.terminate(); rec.wait(); app_srv.shutdown()
    print('%d/%d passed' % (sum(results), len(results)))
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
