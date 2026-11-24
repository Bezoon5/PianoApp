"""Installable/offline check with the real service worker (Chromium).
Run: python3 tests/browser/server.py 8080 &  then  python3 tests/browser/offline.py [base_url] [chromium_path]"""
import asyncio, sys
from playwright.async_api import async_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8080/index.html'
CHROME = sys.argv[2] if len(sys.argv) > 2 else None
res = []
def check(n, ok, d=''): res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + (' | ' + str(d)[:150] if d != '' else ''))
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1180, 'height': 820})
        pg = await ctx.new_page()
        await pg.goto(BASE)
        man = await pg.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
        check('Manifest: standalone app with 192/512/maskable icons', man['display'] == 'standalone' and {'192x192', '512x512'} <= {i['sizes'] for i in man['icons']} and any(i.get('purpose') == 'maskable' for i in man['icons']), man['name'])
        await pg.evaluate("navigator.serviceWorker.ready")
        if not await pg.evaluate("!!navigator.serviceWorker.controller"):
            await pg.reload(); await pg.evaluate("navigator.serviceWorker.ready")
        check('Service worker installed and controlling the page', await pg.evaluate("!!navigator.serviceWorker.controller"))
        n = await pg.evaluate("caches.open('pc-shell-6.1.1').then(c => c.keys()).then(k => k.map(r => new URL(r.url).pathname))")
        check('App shell cached, including music/practice.js and omr/homr.js', len(n) >= 20 and any(x.endswith('music/practice.js') for x in n) and any(x.endswith('omr/homr.js') for x in n), len(n))
        await ctx.set_offline(True)
        await pg.reload(); await pg.wait_for_selector('#title.active')
        hero = await pg.evaluate("document.querySelector('.hero').complete && document.querySelector('.hero').naturalWidth")
        check('Offline: title page and hero image load', hero and hero > 1000, hero)
        await pg.click('#start'); await pg.wait_for_timeout(500)
        check('Offline: library works (25 carols listed)', await pg.locator('#songs .card').count() >= 25)
        await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click()
        await pg.wait_for_function("/unavailable/.test(document.getElementById('notationNote').textContent)", timeout=70000)
        check('Offline without cached engine: practice opens in simple view with explanation', not await pg.evaluate("document.getElementById('score').hidden"))
        check('Offline: practice tools, scanning and MusicXML modules available', await pg.evaluate("['OMREngine','OMRModel','PCMusicXML','PCNotation','PCPractice','PCOMR'].every(k => !!window[k])"))
        await b.close()
    print('\nSUMMARY', sum(res), '/', len(res), 'passed'); sys.exit(0 if all(res) else 1)
asyncio.run(main())
