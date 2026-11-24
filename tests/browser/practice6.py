"""Piano Companion 6 browser tests: hands separately, loops + speed trainer,
metronome + count-in, progress tracking, library edit and backup/restore.

Run:  python3 tests/browser/server.py 8080 &
      python3 tests/browser/practice6.py [base_url] [chromium_path]
"""
import asyncio, sys, os, json
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8080/index.html'
CHROME = sys.argv[2] if len(sys.argv) > 2 else None
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + name + (' | ' + str(detail)[:170] if detail != '' else ''))

def stub(path):
    async def handler(route):
        await route.fulfill(path=os.path.join(HERE, path), content_type='text/javascript', headers={'Access-Control-Allow-Origin': '*'})
    return handler

# Two bars of 4/4: right-hand melody on every beat, left-hand half notes.
SONG = """{ id: 'test-two-hands', title: 'Two Hands Study', composer: 'Test', bpm: 100, source: 'MusicXML', category: 'imported', timeSignature: [4, 4],
  notes: [72,74,76,77,79,77,76,74].map((m, i) => ({ midi: m, startBeat: i, durationBeats: 0.9, hand: 'right' }))
    .concat([48,52,55,48].map((m, i) => ({ midi: m, startBeat: i * 2, durationBeats: 1.9, hand: 'left' }))) }"""

async def midi(pg, note):
    await pg.evaluate("__midiSend(0x90, %d, 100)" % note); await pg.wait_for_timeout(30)
    await pg.evaluate("__midiSend(0x80, %d, 0)" % note); await pg.wait_for_timeout(30)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()
        ctx = await b.new_context(viewport={'width': 1366, 'height': 1024}, service_workers='block', accept_downloads=True)
        pg = await ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script(path=os.path.join(HERE, 'init.js'))
        await pg.route('**/tone/**', stub('tone-stub.js'))
        await pg.route('**/www.verovio.org/**', stub('verovio-stub.js'))
        await pg.route('**/tesseract**', lambda r: r.abort()); await pg.route('**/@tonejs/midi**', lambda r: r.abort())
        await pg.goto(BASE); await pg.click('#start'); await pg.wait_for_timeout(300)

        # One-hand piece: the hands selector is disabled
        await pg.locator('#songs .card', has_text='Silent Night').locator('.play').click(); await pg.wait_for_timeout(200)
        check('Hands selector disabled for a one-hand piece', await pg.is_disabled('#handSel'))
        await pg.click('[data-nav="library"]')

        # Save a two-hand piece and open it from the library
        await pg.evaluate("PCApp.saveSong(" + SONG + ").then(() => PCApp._render())"); await pg.wait_for_timeout(400)
        card = pg.locator('#songs .card', has_text='Two Hands Study')
        await card.locator('.play').click()
        await pg.wait_for_function("PCApp._state().sheetReady", timeout=60000)
        check('Hands selector enabled for a two-hand piece', not await pg.is_disabled('#handSel'))

        # 1. Hands separately in Listen mode
        await pg.evaluate("document.getElementById('countIn').checked = false; document.getElementById('countIn').dispatchEvent(new Event('change'))")
        await pg.select_option('#handSel', 'right')
        await pg.evaluate("__parts.length = 0"); await pg.click('#play'); await pg.wait_for_timeout(300)
        ev = await pg.evaluate("__parts[0].events.map(e => [e.midi, e.hand, e.guide])")
        guides = sorted(m for m, h, g in ev if g); played = sorted(m for m, h, g in ev if not g)
        check('Hands: right hand is guide-only, app plays the left hand', guides == sorted([72,74,76,77,79,77,76,74]) and played == [48, 48, 52, 55], (guides, played))
        lit = await pg.evaluate("""() => new Promise(ok => {
            const k = document.querySelector('#piano [data-m="72"]'), seen = [];
            const mo = new MutationObserver(() => seen.push(k.classList.contains('guide')));
            mo.observe(k, { attributes: true, attributeFilter: ['class'] });
            __synthLog.length = 0;
            __parts[0].cb(0, __parts[0].events.find(e => e.guide && e.midi === 72));
            setTimeout(() => { mo.disconnect(); ok({ seen, sounded: __synthLog.some(l => /ar M72/.test(l)) }); }, 60); })""")
        check('Hands: guide notes light the keys without sounding', True in lit['seen'] and not lit['sounded'], lit)
        check('Hands: status explains who plays what', 'right hand' in await pg.inner_text('#toolStatus'))
        await pg.click('#stop'); await pg.select_option('#handSel', 'both')

        # 2. Count-in
        await pg.evaluate("document.getElementById('countIn').checked = true; document.getElementById('countIn').dispatchEvent(new Event('change'))")
        await pg.evaluate("__clicks.length = 0"); await pg.click('#play'); await pg.wait_for_timeout(200)
        ci = await pg.evaluate("({ clicks: __clicks.map(c => [c.time, c.accent]), start: __tstart.time })")
        gaps = [round(ci['clicks'][i + 1][0] - ci['clicks'][i][0], 3) for i in range(len(ci['clicks']) - 1)]
        check('Count-in: one bar of 4 clicks, accented downbeat, music starts a beat after the last click',
              len(ci['clicks']) == 4 and ci['clicks'][0][1] and not any(c[1] for c in ci['clicks'][1:]) and all(abs(g - 0.6) < 0.01 for g in gaps) and abs(ci['start'] - ci['clicks'][-1][0] - 0.6) < 0.01, (gaps, ci['start'] - ci['clicks'][-1][0]))
        await pg.click('#stop')

        # 3. Metronome
        await pg.check('#metro'); await pg.uncheck('#countIn')
        await pg.evaluate("__parts.length = 0"); await pg.click('#play'); await pg.wait_for_timeout(200)
        m = await pg.evaluate("__parts.length > 1 ? __parts[1].events.map(e => [e.time, e.accent]) : null")
        check('Metronome: a click on every beat with accented downbeats', m == [['0i', True], ['192i', False], ['384i', False], ['576i', False], ['768i', True], ['960i', False], ['1152i', False], ['1344i', False]], m)
        await pg.click('#stop'); await pg.uncheck('#metro')

        # 4. Loop + speed trainer (Listen)
        await pg.fill('#loopFrom', '2'); await pg.fill('#loopTo', '2'); await pg.click('#loopBtn')
        check('Loop: shown in the sheet music (bar 2 marked)', await pg.evaluate("[...document.querySelectorAll('#engraved g.measure')].map(g => g.classList.contains('pc-loop'))") == [False, True])
        await pg.check('#trainer'); await pg.fill('#tempo', '100'); await pg.dispatch_event('#tempo', 'input')
        await pg.click('#play'); await pg.wait_for_timeout(200)
        t = await pg.evaluate("__tstart")
        check('Loop: transport loops bar 2 and starts there', t['loop'] and t['loopStart'] == '768i' and t['loopEnd'] == '1536i' and t['offset'] == '768i', t)
        check('Speed trainer: starts at 70% of the target tempo', t['bpm'] == 70, t['bpm'])
        await pg.evaluate("Tone.Transport.ticks = 1500"); await pg.wait_for_timeout(80)
        await pg.evaluate("Tone.Transport.ticks = 800"); await pg.wait_for_timeout(80)
        bpm1, st1 = await pg.evaluate("Tone.Transport.bpm.value"), await pg.inner_text('#toolStatus')
        for _ in range(6):
            await pg.evaluate("Tone.Transport.ticks = 1500"); await pg.wait_for_timeout(50)
            await pg.evaluate("Tone.Transport.ticks = 800"); await pg.wait_for_timeout(50)
        bpm2, st2 = await pg.evaluate("Tone.Transport.bpm.value"), await pg.inner_text('#toolStatus')
        check('Speed trainer: +5% per loop pass, capped at the target', bpm1 == 75 and 'pass 2' in st1 and bpm2 == 100 and 'target reached' in st2, (bpm1, st1, bpm2, st2))
        await pg.click('#stop')
        await pg.fill('#loopTo', '1'); await pg.dispatch_event('#loopTo', 'change')
        check('Loop: backwards range is rejected with a message', 'at or after' in await pg.inner_text('#toolStatus'))
        await pg.fill('#loopTo', '2'); await pg.dispatch_event('#loopTo', 'change')
        await pg.click('#loopBtn'); await pg.uncheck('#trainer')
        check('Loop: turning it off clears the marking', not await pg.evaluate("PCApp._state().loopOn") and await pg.evaluate("document.querySelectorAll('#engraved g.pc-loop').length") == 0)

        # 5. Wait mode, right hand: accompaniment, wrong notes, trickiest bars, progress
        await pg.select_option('#handSel', 'right'); await pg.click('#wait'); await pg.wait_for_timeout(250)
        s = await pg.evaluate("PCApp._state()")
        check('Wait mode (right hand): only right-hand chords are expected', s['waitEvs'] == 8, s)
        await pg.evaluate("__synthLog.length = 0")
        await midi(pg, 72)
        log = await pg.evaluate("__synthLog.slice()")
        check('Wait mode: the app plays the left hand when you play the right', any(l.endswith('ar M48') for l in log), log)
        for n in [74, 76, 77]: await midi(pg, n)
        await midi(pg, 60); await midi(pg, 61)          # two wrong notes in bar 2
        for n in [79, 77, 76, 74]: await midi(pg, n)
        await pg.wait_for_selector('#summaryDlg[open]', timeout=3000)
        summ = await pg.inner_text('#summaryBody')
        check('Summary: accuracy, trickiest bar and loop button', '80%' in summ and 'Bar 2' in summ and 'Loop this bar' in summ, summ.replace('\n', ' / '))
        h = await pg.evaluate("PCApp._history()['test-two-hands']")
        check('Progress: session saved with hand and trickiest bar', len(h) == 1 and h[0]['complete'] and h[0]['hand'] == 'right' and h[0]['tricky'] == ['2'] and h[0]['accuracy'] == 80, h)
        await pg.click('#summaryBody button[data-bar="2"]'); await pg.wait_for_timeout(250)
        s = await pg.evaluate("PCApp._state()")
        check('“Loop this bar” loops bar 2 in Wait mode', s['loopOn'] and s['waitEvs'] == 4 and await pg.input_value('#loopFrom') == '2', s)
        for n in [79, 77, 76, 74]: await midi(pg, n)
        s = await pg.evaluate("PCApp._state()")
        check('Wait-mode loop: completing the bar starts the next pass', s['waitPasses'] == 1 and s['waitIdx'] == 0 and '1 pass completed' in await pg.inner_text('#toolStatus'), s)
        await pg.click('[data-nav="library"]'); await pg.wait_for_timeout(400)
        h = await pg.evaluate("PCApp._history()['test-two-hands']")
        check('Progress: leaving a loop session records it as unfinished', len(h) == 2 and not h[1]['complete'] and h[1]['loop'] == 'bar 2' and h[1]['passes'] == 1, h[-1])
        prog = await card.locator('.progress').inner_text()
        check('Library card shows practice count, best and when', prog == 'Practised 2× · best 100% · today', prog)
        check('Library shows the practice streak', '1-day practice streak' in await pg.inner_text('#streak'))

        # 6. Rename, backup, delete, restore
        await card.locator('.edit').click(); await pg.fill('#editTitle', 'Two Hands (renamed)'); await pg.click('#editSave'); await pg.wait_for_timeout(300)
        check('Rename updates the library', await pg.locator('#songs .card', has_text='Two Hands (renamed)').count() == 1)
        await pg.click('#settings')
        async with pg.expect_download() as dl: await pg.click('#backupBtn')
        d = await dl.value; path = os.path.join(HERE, 'backup-test.json'); await d.save_as(path)
        data = json.load(open(path))
        check('Backup file contains the piece and its history', data['format'] == 'piano-companion-backup' and any(s['title'] == 'Two Hands (renamed)' for s in data['songs']) and len(data['history']['test-two-hands']) == 2, (d.suggested_filename, await pg.inner_text('#backupStatus')))
        await pg.click('#settingsDone')
        c2 = pg.locator('#songs .card', has_text='Two Hands (renamed)')
        await c2.locator('.edit').click(); await pg.click('#editDelete')
        armed = await pg.inner_text('#editDelete')
        await pg.click('#editDelete'); await pg.wait_for_timeout(300)
        check('Delete needs a second tap, then removes the piece and its history', armed == 'Tap again to delete' and await c2.count() == 0 and 'test-two-hands' not in await pg.evaluate("PCApp._history()"), armed)
        await pg.click('#settings')
        async with pg.expect_file_chooser() as fc: await pg.click('#restoreBtn')
        await (await fc.value).set_files(path); await pg.wait_for_timeout(500)
        rs = await pg.inner_text('#backupStatus'); await pg.click('#settingsDone'); await pg.wait_for_timeout(300)
        back = pg.locator('#songs .card', has_text='Two Hands (renamed)')
        check('Restore brings back the piece and its history', 'Restored: 1 new piece' in rs and await back.count() == 1 and (await back.locator('.progress').inner_text()).startswith('Practised 2×'), rs)
        bad = os.path.join(HERE, 'not-a-backup.json'); open(bad, 'w').write('{"hello": 1}')
        await pg.click('#settings')
        async with pg.expect_file_chooser() as fc: await pg.click('#restoreBtn')
        await (await fc.value).set_files(bad); await pg.wait_for_timeout(300)
        check('Restoring a wrong file gives a clear message', 'not a Piano Companion backup' in await pg.inner_text('#backupStatus'))
        await pg.click('#settingsDone')
        for f in (path, bad): os.remove(f)

        # 7. Built-in pieces cannot be edited
        check('Built-in carols have no Edit button', await pg.locator('#songs .card', has_text='Silent Night').locator('.edit').count() == 0)
        check('No page errors', not errs, errs)
        await b.close()
    passed = sum(1 for r in results if r[1])
    print('\nSUMMARY', passed, '/', len(results), 'passed')
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
