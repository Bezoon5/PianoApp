"""Piano Companion regression tests (Playwright, Chromium): MusicXML import,
sheet music, sound, scanning workflow, storage and input.

Run:  python3 tests/browser/server.py 8080 &   (needs: pip install verovio playwright)
      python3 tests/browser/stress.py [base_url] [chromium_path]
CDN libraries are replaced by stubs; Verovio rendering is real (via server.py).
"""
import asyncio, sys, os
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, '..', 'fixtures')
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8080/index.html'
CHROME = sys.argv[2] if len(sys.argv) > 2 else None
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (' | ' + str(detail)[:160] if detail != '' else ''))

def stub(path):
    async def handler(route):
        await route.fulfill(path=os.path.join(HERE, path), content_type='text/javascript', headers={'Access-Control-Allow-Origin': '*'})
    return handler

async def new_page(b, worker_404=False, ocr=True, verovio=True, sampler='load'):
    ctx = await b.new_context(viewport={'width': 1366, 'height': 1024}, service_workers='block', accept_downloads=True)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(path=os.path.join(HERE, 'init.js'))
    await pg.add_init_script('window.__samplerMode = %r' % sampler)
    await pg.route('**/tone/**', stub('tone-stub.js'))
    await pg.route('**/@tonejs/midi**', lambda r: r.abort())
    await pg.route('**/tesseract**', stub('tesseract-stub.js') if ocr else (lambda r: r.abort()))
    await pg.route('**/www.verovio.org/**', stub('verovio-stub.js') if verovio else (lambda r: r.abort()))
    if worker_404:
        await pg.route('**/omr/worker.js', lambda r: r.fulfill(status=404, body='missing'))
    return ctx, pg, errs

async def to_review(pg, img, choose_other_part=False):
    await pg.click('#start')
    async with pg.expect_file_chooser() as fc:
        await pg.click('#photos')
    await (await fc.value).set_files(img)
    await pg.wait_for_selector('.opage')
    await pg.click('#omrNext1')
    await pg.wait_for_function("!document.getElementById('omrNext2').disabled", timeout=30000)
    if choose_other_part:
        radios = pg.locator('#omrParts input')
        if await radios.count() > 1: await radios.nth(0).check()
        await pg.wait_for_function("/OCR complete/.test(document.getElementById('omrOcrStatus').textContent)", timeout=15000)
        return
    await pg.click('#omrNext2')
    await pg.wait_for_function("document.getElementById('omrIssues').children.length>0", timeout=60000)

async def import_xml(pg, path):
    async with pg.expect_file_chooser() as fc:
        await pg.click('#xml')
    await (await fc.value).set_files(path)

async def wait_sheet(pg):
    await pg.wait_for_function("PCApp._state().sheetReady || /unavailable|Could not/.test(document.getElementById('notationNote').textContent)", timeout=60000)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()

        ctx, pg, errs = await new_page(b)
        await pg.goto(BASE); await pg.click('#start')
        await import_xml(pg, os.path.join(FIX, 'maple-leaf-rag.mxl'))
        await pg.wait_for_selector('#practice.active', timeout=15000)
        await wait_sheet(pg)
        title = await pg.inner_text('#songTitle'); meta = await pg.inner_text('#songMeta')
        check('MusicXML .mxl import opens practice', title.lower() == 'maple leaf rag' and '2568 notes' in meta, (title, meta))
        nm = await pg.evaluate("document.querySelectorAll('#engraved g.measure').length")
        check('Sheet music engraved by Verovio (85 measures)', await pg.evaluate("PCApp._state().sheetReady") and nm == 85, nm)
        hl = await pg.evaluate("""() => {
            const all = [...document.querySelectorAll('#engraved g.measure')];
            const out = [];
            // 2/4 with a half-beat pickup (measure 0). Strain A (0-16) then its repeat (1-15) then 17.
            for (const [beat, expect] of [[0.01, 0], [32.51, 1], [62.51, 17]]) {
              PCApp._position(beat);
              const bar = document.querySelector('#engraved g.measure.pc-bar');
              out.push([all.indexOf(bar), expect, document.querySelectorAll('#engraved .pc-on').length, document.getElementById('measure').textContent]);
            }
            return out; }""")
        check('Bar highlight maps playback through repeats to the right measure', all(a == e for a, e, _, _ in hl), hl)
        check('Sounding notes highlighted in the sheet music', all(n > 0 for _, _, n, _ in hl), [h[2] for h in hl])
        check('Measure counter shows score measure numbers (incl. pickup 0 and repeat)', [h[3] for h in hl] == ['Measure 0', 'Measure 1', 'Measure 17'], [h[3] for h in hl])
        await pg.fill('#loopFrom', '5'); await pg.fill('#loopTo', '8'); await pg.click('#loopBtn')
        marked = await pg.evaluate("[...document.querySelectorAll('#engraved g.measure')].map((g, i) => g.classList.contains('pc-loop') ? i : -1).filter(i => i >= 0)")
        check('v6 loop through repeats marks bars 5–8 of the score', marked == [5, 6, 7, 8], marked)
        await pg.click('#loopBtn')

        await pg.click('[data-nav="library"]')
        await import_xml(pg, os.path.join(FIX, 'lindenbaum.xml'))
        await pg.wait_for_selector('#partDlg[open]')
        opts = await pg.inner_text('#partList')
        checked = await pg.evaluate("document.querySelector('#partList input:checked').value")
        check('Part chooser lists parts and suggests piano', 'Voice' in opts and 'Piano' in opts and checked == 'P2', opts.replace('\n', ' / '))
        await pg.click('#partOk')
        await pg.wait_for_selector('#practice.active'); await wait_sheet(pg)
        nm = await pg.evaluate("document.querySelectorAll('#engraved g.measure').length")
        staves = await pg.evaluate("document.querySelectorAll('#engraved g.measure')[0].querySelectorAll('g.staff').length")
        check('Only the piano part is engraved (82 measures, 2 staves)', nm == 82 and staves == 2, (nm, staves))
        await pg.click('[data-nav="library"]'); await pg.click('[data-filter="imported"]'); await pg.wait_for_timeout(300)
        lib = await pg.inner_text('#songs')
        check('Imported MusicXML saved in the library with its part', 'Der Lindenbaum' in lib and 'Piano' in lib, lib[:120].replace('\n', ' | '))
        await pg.locator('#songs .card', has_text='Der Lindenbaum').locator('.play').click()
        await pg.wait_for_selector('#practice.active'); await wait_sheet(pg)
        check('Reopened MusicXML piece renders from storage', await pg.evaluate("PCApp._state().sheetReady"))

        await pg.click('[data-nav="library"]')
        await import_xml(pg, os.path.join(FIX, 'dichterliebe-2.xml'))
        await pg.wait_for_selector('#partDlg[open]'); await pg.click('#partCancel'); await pg.wait_for_timeout(200)
        check('Cancelling the part chooser imports nothing', 'cancelled' in (await pg.inner_text('#libStatus')).lower())
        bad = os.path.join(HERE, 'not-music.xml')
        open(bad, 'w').write('<html><body>hello</body></html>')
        await import_xml(pg, bad); await pg.wait_for_timeout(300)
        os.remove(bad)
        st = await pg.inner_text('#libStatus')
        check('Non-MusicXML file gives a clear error', 'not a MusicXML score' in st, st)

        await pg.click('[data-filter="all"]'); await pg.wait_for_timeout(200)
        await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click()
        await wait_sheet(pg)
        nm = await pg.evaluate("document.querySelectorAll('#engraved g.measure').length")
        await pg.evaluate("PCApp._position(3.2)")
        idx = await pg.evaluate("[...document.querySelectorAll('#engraved g.measure')].indexOf(document.querySelector('#engraved g.measure.pc-bar'))")
        check('Carol without MusicXML is engraved (generated) and highlighted', nm == 8 and idx == 1, (nm, idx))

        await pg.click('#viewToggle'); await pg.wait_for_timeout(200)
        simple = await pg.evaluate("document.getElementById('engraved').hidden && !document.getElementById('score').hidden")
        await pg.reload(); await pg.click('#start'); await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click(); await pg.wait_for_timeout(400)
        still = await pg.evaluate("document.getElementById('engraved').hidden")
        check('Simple view toggle works and is remembered', simple and still)
        await pg.click('#viewToggle'); await wait_sheet(pg)

        await pg.evaluate("__synthLog.length = 0"); await pg.evaluate("__midiSend(0x90, 64, 100)"); await pg.wait_for_timeout(50); await pg.evaluate("__midiSend(0x80, 64, 0)")
        await pg.wait_for_timeout(300)
        log = await pg.evaluate("__synthLog.slice()")
        check('MIDI: note released while audio starts is cancelled (no stuck note)', sum('attack M64' in l for l in log) == sum('release M64' in l for l in log), log)
        await pg.click('[data-nav="library"]'); await pg.click('#settings')
        await pg.wait_for_function("/ready/.test(document.getElementById('soundStatus').textContent)", timeout=5000)
        await pg.select_option('#soundSel', 'synth'); await pg.click('#settingsDone')
        await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click(); await pg.wait_for_timeout(300)
        await pg.evaluate("__synthLog.length = 0"); await pg.evaluate("__midiSend(0x90, 64, 100)"); await pg.wait_for_timeout(50); await pg.evaluate("__midiSend(0x80, 64, 0)")
        log = await pg.evaluate("__synthLog.slice()")
        check('Sound setting “Simple synth” is honoured', 'synth attack M64' in log, log)
        await pg.evaluate("localStorage.setItem('pc-sound','piano')")
        print('page errors:', errs); await ctx.close()

        ctx, pg, errs = await new_page(b, sampler='slow')
        await pg.goto(BASE); await pg.click('#start')
        await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click()
        await pg.evaluate("__synthLog.length = 0")
        await pg.evaluate("__midiSend(0x90, 60, 100)"); await pg.wait_for_timeout(250)
        before = await pg.evaluate("PCApp._state().samplerState")
        await pg.wait_for_function("PCApp._state().samplerState === 'ready'", timeout=8000)
        await pg.evaluate("__midiSend(0x80, 60, 0)"); await pg.evaluate("__midiSend(0x90, 62, 90)"); await pg.evaluate("__midiSend(0x80, 62, 0)"); await pg.wait_for_timeout(100)
        log = await pg.evaluate("__synthLog.slice()")
        check('Note played while samples load uses the synth and is released on the synth', before == 'loading' and 'synth attack M60' in log and 'synth release M60' in log and 'piano release M60' not in log, (before, log))
        check('Grand piano samples used once loaded (30 Salamander samples)', 'piano attack M62' in log and 'piano release M62' in log and await pg.evaluate("window.__samplerOpts.urls") == 30, log)
        await ctx.close()

        ctx, pg, errs = await new_page(b, verovio=False, sampler='error')
        await pg.goto(BASE); await pg.click('#start')
        await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click()
        await wait_sheet(pg)
        note = await pg.inner_text('#notationNote')
        check('Notation engine unavailable: falls back to the simple view with a message', 'unavailable' in note and not await pg.evaluate("document.getElementById('score').hidden"), note)
        await pg.evaluate("__midiSend(0x90, 60, 100)"); await pg.wait_for_timeout(400); await pg.evaluate("__midiSend(0x80, 60, 0)")
        await pg.click('[data-nav="library"]'); await pg.click('#settings')
        ss = await pg.inner_text('#soundStatus'); log = await pg.evaluate("__synthLog.slice()")
        check('Piano samples fail: synth keeps playing and the reason is shown', 'could not load' in ss and 'synth attack M60' in log, (ss, log))
        await ctx.close()

        ctx, pg, errs = await new_page(b)
        await pg.goto(BASE)
        await pg.evaluate("""() => new Promise(ok => { const r = indexedDB.open('PianoCompanion42', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('songs', { keyPath: 'id' });
          r.onsuccess = () => { const tx = r.result.transaction('songs', 'readwrite');
            tx.objectStore('songs').put({ id: 'x1', title: 'My Old Import', bpm: 96, notes: [{ midi: 60, startBeat: 0, durationBeats: 1 }] });
            tx.oncomplete = () => { r.result.close(); localStorage.removeItem('pc-migrated-v51'); ok(); }; }; })""")
        await pg.reload(); await pg.click('#start'); await pg.wait_for_timeout(800)
        check('Migration: older library appears', 'My Old Import' in await pg.inner_text('#songs'), await pg.inner_text('#libStatus'))
        n1 = await pg.locator('#songs .card').count()
        await pg.evaluate("Promise.all([PCApp._render(), PCApp._render(), PCApp._render()])"); await pg.wait_for_timeout(300)
        n2 = await pg.locator('#songs .card').count()
        check('Library: overlapping renders do not duplicate cards', n1 == n2 == 26, (n1, n2))
        await pg.locator('#songs .card').first.locator('.play').click(); await pg.wait_for_timeout(300)
        await pg.evaluate("__synthLog.length = 0")
        key = pg.locator('#piano [data-m="60"]'); box = await key.bounding_box()
        await pg.mouse.move(box['x'] + 10, box['y'] + box['height'] - 20)
        await pg.mouse.down(); await pg.wait_for_timeout(20); await pg.mouse.up(); await pg.wait_for_timeout(400)
        log = await pg.evaluate("__synthLog.slice()")
        check('Keyboard: quick first tap leaves no note sounding', sum('attack M60' in l for l in log) == sum('release M60' in l for l in log), log)
        await pg.click('#wait'); await pg.wait_for_timeout(100)
        await pg.evaluate("__midiSend(0x90, 67, 100)"); await pg.evaluate("__midiSend(0x80, 67, 0)")
        await pg.evaluate("__midiSend(0x90, 61, 100)"); await pg.evaluate("__midiSend(0x80, 61, 0)"); await pg.wait_for_timeout(200)
        sc = await pg.inner_text('#scoreOut')
        check('MIDI input drives Wait mode and scoring', 'Accuracy 50%' in sc and 'Progress 4%' in sc, sc)
        await pg.click('[data-nav="library"]'); await pg.click('[data-nav="title"]')
        await to_review(pg, os.path.join(HERE, 'happy.png'))
        await pg.evaluate("window.__failPut = true"); await pg.click('#omrSave'); await pg.wait_for_timeout(500)
        hint = await pg.inner_text('#omrSaveHint')
        check('Save failure is reported and the review stays open', 'Could not save' in hint and await pg.evaluate("document.getElementById('omr').classList.contains('active')"), hint[:80])
        before = await pg.inner_text('#omrIssues'); bad = lambda t: int(t.split('✖ ')[1].split(' ')[0])
        await pg.click('#omrIssues .ochip.bad'); await pg.click('#omrAccept'); await pg.wait_for_timeout(150)
        check('“Measure correct” clears a red measure', bad(await pg.inner_text('#omrIssues')) == bad(before) - 1)
        await pg.click('#omrAdd'); await pg.evaluate("document.getElementById('omrRecWrap').scrollTop = 0")
        rb = await pg.locator('#omrRec').bounding_box(); await pg.mouse.click(rb['x'] + rb['width'] * 0.5, rb['y'] + 30)
        check('Add note: taps far from a staff are rejected', 'near a staff' in await pg.inner_text('#omrSelInfo'))
        await pg.click('#omrAdd')
        await pg.evaluate("window.__failPut = false"); await pg.click('#omrSave'); await pg.wait_for_timeout(600)
        check('Scanned score saves and opens practice', await pg.evaluate("document.getElementById('practice').classList.contains('active')"))
        await wait_sheet(pg)
        check('Scanned (OMR) score is shown as engraved sheet music', await pg.evaluate("PCApp._state().sheetReady && document.querySelectorAll('#engraved g.measure').length === 9"))
        check('Scanned piano score: hands selector available', not await pg.is_disabled('#handSel'))
        print('page errors:', errs); await ctx.close()

        ctx, pg, errs = await new_page(b, worker_404=True, ocr=False)
        await pg.goto(BASE); await to_review(pg, os.path.join(HERE, 'happy.png'))
        check('Missing worker: recognition falls back and completes', await pg.evaluate("PCOMR.state.score.measures.length") == 9)
        await ctx.close()

        ctx, pg, errs = await new_page(b)
        await pg.goto(BASE); await pg.evaluate("window.__labels = ['Bb Clarinet', 'Piano']")
        await to_review(pg, os.path.join(HERE, 'together.png'), choose_other_part=True)
        check('OCR keeps the part the user chose', await pg.evaluate("PCOMR.state.partIndex") == 0)
        await pg.locator('#omrParts input').nth(1).check(); await pg.click('#omrNext2')
        await pg.wait_for_function("document.getElementById('omrIssues').children.length>0", timeout=60000)
        check('Ensemble scan: piano grand staff on every system', await pg.evaluate("PCOMR.state.score.measures.every(m => m.staves.length === 2)"))
        await ctx.close()

        ctx, pg, errs = await new_page(b)
        await pg.route('**/omr/**', lambda r: r.fulfill(status=404, body='x'))
        await pg.goto(BASE); await pg.click('#start'); await pg.click('#photos')
        check('Missing omr/ folder is reported, not silent', 'omr/' in await pg.inner_text('#libStatus'))
        await ctx.close()
        await b.close()

    passed = sum(1 for r in results if r[1])
    print('\nSUMMARY', passed, '/', len(results), 'passed')
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
