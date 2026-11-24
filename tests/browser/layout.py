"""Phone and desktop layout (Playwright, Chromium): Tools panel, mode switch, one status
line, Add music sheet, first-run tips, bigger keys, one scan view at a time on phones.
Run: python3 tests/browser/layout.py [chromium_path]"""
import asyncio, http.server, os, socket, socketserver, sys, threading
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CHROME = sys.argv[1] if len(sys.argv) > 1 else None
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' | ' + str(detail)[:220] if detail != '' else ''))
class App(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=ROOT, **k)
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0))); d = b'{"ok": false}'
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(d))); self.end_headers(); self.wfile.write(d)
def start_app():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', port), App)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, 'http://127.0.0.1:%d' % port
def stub(path):
    async def h(route): await route.fulfill(path=os.path.join(HERE, path), content_type='text/javascript', headers={'Access-Control-Allow-Origin': '*'})
    return h

async def page(b, app, vp, mobile):
    ctx = await b.new_context(viewport=vp, is_mobile=mobile, has_touch=mobile, service_workers='block')
    pg = await ctx.new_page(); pg.set_default_timeout(15000); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(path=os.path.join(HERE, 'init.js'))
    await pg.route('**/tone/**', stub('tone-stub.js'))
    await pg.route('**/@tonejs/midi**', lambda r: r.abort())
    await pg.route('**/tesseract**', stub('tesseract-stub.js'))
    await pg.route('**/www.verovio.org/**', stub('verovio-stub.js'))
    await pg.goto(app + '/index.html')
    return ctx, pg, errs

async def open_piece(pg):
    await pg.click('#start'); await pg.wait_for_selector('#songs .card .play')
    await pg.locator('#songs .card .play').first.click()
    await pg.wait_for_selector('#practice.active')

async def main():
    srv, app = start_app()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()

        # Phone (iPhone-sized)
        ctx, pg, errs = await page(b, app, {'width': 390, 'height': 844}, True)
        await pg.click('#start')
        check('phone library: import tiles folded behind Add music', await pg.is_visible('#addMusic') and not await pg.is_visible('#photos'))
        await pg.click('#addMusic')
        check('phone library: Add music shows the five choices', all([await pg.is_visible(s) for s in ['#xml', '#cam', '#photos', '#pdf', '#midi']]))
        await pg.click('#addMusic')
        await pg.locator('#songs .card .play').first.click(); await pg.wait_for_selector('#practice.active')
        check('phone practice: Tools folded away by default', not await pg.is_visible('#handSel') and await pg.get_attribute('#toolsBtn', 'aria-expanded') == 'false')
        row = await pg.evaluate("(() => { const t = document.querySelector('.transport'); const ids = ['listen','wait','along','play','stop','micBtn','fallToggle']; const rs = ids.map(i => document.getElementById(i).getBoundingClientRect()); return { fits: t.scrollWidth <= t.clientWidth + 1, oneRow: Math.max(...rs.map(r => r.top)) - Math.min(...rs.map(r => r.top)) < 4, inside: rs.every(r => r.right <= innerWidth + 1 && r.width > 0) }; })()")
        check('phone practice: modes, Play, Stop, Mic and Falling fit on one row', row['fits'] and row['oneRow'] and row['inside'], row)
        labels = await pg.evaluate("['wait','along','play'].map(i => document.getElementById(i).innerText.trim())")
        check('phone practice: short labels (Wait, Play, ▶)', labels == ['Wait', 'Play', '▶'], labels)
        check('phone: nothing wider than the screen', await pg.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        ww = await pg.evaluate("document.querySelector('#piano .key.white').getBoundingClientRect().width")
        check('phone: bigger keys (about 44 px wide)', 42 <= ww <= 46, ww)
        bw = await pg.evaluate("(() => { const k = document.querySelector('#piano .key.black'), r = k.getBoundingClientRect(), prev = document.querySelector('#piano [data-m=\"' + (+k.dataset.m - 1) + '\"]').getBoundingClientRect(); return [r.width, Math.round(r.left + r.width / 2 - prev.right)]; })()")
        check('phone: black keys scaled and centred on the gap', 24 <= bw[0] <= 28 and abs(bw[1]) <= 1, bw)
        check('first visit: quick tips shown', await pg.is_visible('#guide'))
        await pg.click('#guideDone')
        check('tips: Got it hides them', not await pg.is_visible('#guide'))
        await pg.click('#toolsBtn')
        check('phone: Tools opens the panel', await pg.is_visible('#handSel') and await pg.is_visible('#recBtn') and await pg.is_visible('#viewToggle') and await pg.is_visible('#tempo'))
        await pg.fill('#loopFrom', '4'); await pg.fill('#loopTo', '2'); await pg.click('#loopBtn')   # a backwards loop gives a message
        await pg.click('#toolsBtn')
        st = await pg.evaluate("(() => { const s = document.querySelector('.statusline'); return { visible: s.offsetHeight > 0, text: s.innerText, spans: [...s.children].filter(x => x.textContent).length, sep: getComputedStyle(document.getElementById('toolStatus'), '::before').content }; })()")
        check('status line stays visible with Tools closed and joins messages', st['visible'] and 'Measure' in st['text'] and 'at or after' in st['text'] and st['sep'] == '"·"', st)
        await pg.reload(); await open_piece(pg)
        check('Tools choice and tips remembered after reload', not await pg.is_visible('#guide') and not await pg.is_visible('#handSel'))
        await pg.click('#toolsBtn')
        await pg.reload(); await open_piece(pg)
        check('Tools open is remembered too', await pg.is_visible('#handSel'))
        check('no page errors (phone)', not errs, errs)
        await ctx.close()

        # Phone scan review: one view at a time
        ctx, pg, errs = await page(b, app, {'width': 390, 'height': 844}, True)
        await pg.evaluate("localStorage.setItem('pc-omr-engine', 'device')")
        await pg.click('#start'); await pg.click('#addMusic')
        async with pg.expect_file_chooser() as fc: await pg.click('#photos')
        await (await fc.value).set_files(os.path.join(HERE, 'happy.png'))
        await pg.wait_for_selector('.opage'); await pg.click('#omrNext1')
        await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=60000)
        await pg.click('#omrNext2')
        await pg.wait_for_function("PCOMR.state.score", timeout=60000)
        await pg.wait_for_timeout(300)
        v = await pg.evaluate("({ view: document.getElementById('omrPanes').dataset.view, split: getComputedStyle(document.querySelector('[data-view=split]')).display, orig: document.getElementById('omrOrigWrap').offsetHeight, rec: document.getElementById('omrRecWrap').offsetHeight })")
        check('phone review: Recognised shown alone, no side-by-side option', v['view'] == 'rec' and v['split'] == 'none' and v['orig'] == 0 and v['rec'] > 0, v)
        await pg.click('[data-view=orig]')
        v = await pg.evaluate("({ orig: document.getElementById('omrOrigWrap').offsetHeight, rec: document.getElementById('omrRecWrap').offsetHeight })")
        check('phone review: switch to the photo', v['orig'] > 0 and v['rec'] == 0, v)
        check('no page errors (phone review)', not errs, errs)
        await ctx.close()

        # Desktop: everything visible as before, just tidier
        ctx, pg, errs = await page(b, app, {'width': 1366, 'height': 900}, False)
        await pg.click('#start')
        check('desktop library: import tiles shown directly, no Add music button', await pg.is_visible('#photos') and not await pg.is_visible('#addMusic'))
        await pg.locator('#songs .card .play').first.click(); await pg.wait_for_selector('#practice.active')
        check('desktop practice: Tools open by default', await pg.is_visible('#handSel') and await pg.get_attribute('#toolsBtn', 'aria-expanded') == 'true')
        labels = await pg.evaluate("['wait','along','play'].map(i => document.getElementById(i).innerText.trim())")
        check('desktop practice: full labels', labels == ['Wait mode', 'Play along', '▶ Play'], labels)
        await pg.click('#toolsBtn')
        check('desktop: Tools can be folded away', not await pg.is_visible('#handSel'))
        check('no page errors (desktop)', not errs, errs)
        await ctx.close()
        await b.close()
    srv.shutdown()
    print('%d/%d passed' % (sum(results), len(results)))
    sys.exit(0 if all(results) else 1)

asyncio.run(main())
