"""Backups (Playwright, Chromium): reminder on the library screen, send via the share
sheet, download, and restore that merges instead of overwriting.
Run: python3 tests/browser/backup.py [chromium_path]"""
import asyncio, http.server, json, os, socket, socketserver, sys, threading
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
CHROME = sys.argv[1] if len(sys.argv) > 1 else None
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (' | ' + str(detail)[:200] if detail != '' else ''))
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
    return srv, 'http://127.0.0.1:%d/index.html' % port
SHARE_STUB = """
window.__shared = [];
navigator.canShare = d => !!(d && d.files && d.files.length);
navigator.share = async d => { if (window.__cancelShare) { const e = new Error('cancel'); e.name = 'AbortError'; throw e; } window.__shared.push({ name: d.files[0].name, text: await d.files[0].text() }); };
"""
async def stub(route, f): await route.fulfill(path=os.path.join(HERE, f), content_type='text/javascript')
async def main():
    srv, url = start_app()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1300, 'height': 950}, service_workers='block', accept_downloads=True)
        pg = await ctx.new_page(); pg.set_default_timeout(15000)
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(path=os.path.join(HERE, 'init.js')); await pg.add_init_script(SHARE_STUB)
        await pg.route('**/tone/**', lambda r: stub(r, 'tone-stub.js')); await pg.route('**/tesseract**', lambda r: stub(r, 'tesseract-stub.js')); await pg.route('**/www.verovio.org/**', lambda r: stub(r, 'verovio-stub.js'))
        await pg.goto(url); await pg.click('#start')
        check('no reminder while the library has only built-in pieces', await pg.is_hidden('#backupNudge'))
        async with pg.expect_file_chooser() as fc: await pg.click('#xml')
        await (await fc.value).set_files(os.path.join(ROOT, 'tests', 'fixtures', 'homr-happy-birthday.musicxml'))
        await pg.wait_for_selector('#practice.active')
        await pg.click('#practice [data-nav=library]')
        await pg.wait_for_selector('#backupNudge:not([hidden])')
        check('reminder appears after importing a piece', '1 piece is saved only on this device. Back it up' in await pg.inner_text('#nudgeText'), await pg.inner_text('#nudgeText'))
        await pg.click('#nudgeLater')
        check('Not now hides the reminder', await pg.is_hidden('#backupNudge'))
        await pg.reload(); await pg.click('#start'); await pg.wait_for_timeout(500)
        check('reminder stays snoozed after reloading', await pg.is_hidden('#backupNudge'))
        await pg.evaluate("localStorage.removeItem('pc-backup-snooze')"); await pg.reload(); await pg.click('#start')
        await pg.wait_for_selector('#backupNudge:not([hidden])')
        await pg.evaluate("window.__cancelShare = true"); await pg.click('#nudgeSend'); await pg.wait_for_timeout(300)
        check('cancelling the share sheet keeps the reminder', await pg.is_visible('#backupNudge') and 'Not sent' in await pg.inner_text('#nudgeText'))
        await pg.evaluate("window.__cancelShare = false"); await pg.click('#nudgeSend')
        await pg.wait_for_function("window.__shared.length === 1")
        shared = await pg.evaluate("window.__shared[0]"); data = json.loads(shared['text'])
        check('Back up or send opens the share sheet with the whole library', shared['name'].startswith('piano-companion-backup-') and data['format'] == 'piano-companion-backup' and len(data['songs']) == 1, shared['name'])
        check('reminder disappears once the library is sent', await pg.is_hidden('#backupNudge'))
        piece = data['songs'][0]
        check('saved pieces carry a change time', isinstance(piece.get('updatedAt'), (int, float)) and piece['updatedAt'] > 0)
        # Settings: share button and plain download
        await pg.click('#settings'); await pg.click('#shareBtn'); await pg.wait_for_function("window.__shared.length === 2")
        check('Send to another device explains the next step', 'Restore backup' in await pg.inner_text('#backupStatus'), await pg.inner_text('#backupStatus'))
        async with pg.expect_download() as dl: await pg.click('#backupBtn')
        check('Back up library still downloads a file', (await dl.value).suggested_filename.endswith('.json'))
        # Restore merge: an older copy must not overwrite a newer local edit; new pieces are added
        older = dict(piece, title='Old title', updatedAt=piece['updatedAt'] - 10000)
        extra = dict(piece, id='from-other-device', title='From the iPad', updatedAt=piece['updatedAt'])
        backup = dict(data, songs=[older, extra])
        path = os.path.join('/tmp', 'pc-merge-backup.json'); open(path, 'w').write(json.dumps(backup))
        async with pg.expect_file_chooser() as fc: await pg.click('#restoreBtn')
        await (await fc.value).set_files(path)
        await pg.wait_for_function("/Restored:/.test(document.getElementById('backupStatus').textContent)")
        st = await pg.inner_text('#backupStatus')
        check('restore reports added and kept pieces', '1 new piece' in st and '1 piece kept as on this device' in st, st)
        await pg.click('#settingsDone'); await pg.wait_for_timeout(400)
        titles = await pg.evaluate("[...document.querySelectorAll('#songs .card h3')].map(h => h.textContent)")
        check('newer local copy kept, piece from the other device added', piece['title'] in titles and 'From the iPad' in titles and 'Old title' not in titles, [t for t in titles if 'Birthday' in t or 'iPad' in t or 'Old' in t])
        before = titles.count(piece['title'])  # the library also has a built-in piece with this title
        newer = dict(piece, title='Renamed on iPad', updatedAt=piece['updatedAt'] + 10000)
        open(path, 'w').write(json.dumps(dict(data, songs=[newer])))
        await pg.click('#settings')
        async with pg.expect_file_chooser() as fc: await pg.click('#restoreBtn')
        await (await fc.value).set_files(path)
        await pg.wait_for_function("/newer version/.test(document.getElementById('backupStatus').textContent)")
        await pg.click('#settingsDone'); await pg.wait_for_timeout(400)
        titles = await pg.evaluate("[...document.querySelectorAll('#songs .card h3')].map(h => h.textContent)")
        check('a newer copy from the backup replaces the local one', 'Renamed on iPad' in titles and titles.count(piece['title']) == before - 1, (before, titles.count(piece['title'])))
        check('no page errors', not errs, errs)
        await b.close()
    srv.shutdown()
    print('%d/%d passed' % (sum(results), len(results))); sys.exit(0 if all(results) else 1)
asyncio.run(main())
