"""Microphone listening, play along, recording and falling notes (Playwright, Chromium).
The microphone is simulated: synthesised piano tones are fed to the app's listener
at the right moments, through the Tone.js test stub's analyser.
Run: python3 tests/browser/practice63.py [chromium_path]"""
import asyncio, http.server, json, os, socket, socketserver, sys, threading
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
    return srv, 'http://127.0.0.1:%d/index.html' % port
# A fake microphone: getUserMedia succeeds; the stub analyser asks __micFeed for the newest samples,
# which are rendered from the notes scheduled in __micNotes (page clock, seconds).
FAKE_MIC = """
navigator.mediaDevices = navigator.mediaDevices || {};
navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
window.MediaRecorder = undefined;   // MIDI-only takes in this test
window.__micNotes = [];
window.__micFeed = buf => {
  const sr = 48000, now = performance.now() / 1000, n = buf.length;
  for (let i = 0; i < n; i++) buf[i] = (Math.random() - 0.5) * 0.004;
  for (const note of window.__micNotes) {
    const f0 = 440 * Math.pow(2, (note.midi - 69) / 12);
    const t0 = now - n / sr;
    if (note.t > now || note.t + note.d < t0) continue;
    for (let h = 1; h <= 6; h++) {
      const f = f0 * h * Math.sqrt(1 + 0.0004 * h * h); if (f > sr * 0.45) break;
      const amp = 0.25 * Math.pow(1 / h, 1.1) * (h === 1 && note.midi < 48 ? 0.35 : 1), w = 2 * Math.PI * f, dec = 1.2 + 0.4 * h;
      for (let i = 0; i < n; i++) {
        const t = t0 + i / sr - note.t; if (t < 0 || t > note.d) continue;
        buf[i] += amp * Math.min(1, t / 0.004) * Math.exp(-dec * t) * Math.sin(w * t);
      }
    }
  }
};
window.__playMic = (midi, inSec, dur) => { window.__micNotes.push({ midi, t: performance.now() / 1000 + inSec, d: dur || 0.5 }); };
"""
async def stub(route, f): await route.fulfill(path=os.path.join(HERE, f), content_type='text/javascript')
async def new_page(b, url):
    ctx = await b.new_context(viewport={'width': 1300, 'height': 950}, service_workers='block', accept_downloads=True)
    pg = await ctx.new_page(); pg.set_default_timeout(15000)
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.add_init_script(path=os.path.join(HERE, 'init.js')); await pg.add_init_script(FAKE_MIC)
    await pg.route('**/tone/**', lambda r: stub(r, 'tone-stub.js')); await pg.route('**/tesseract**', lambda r: stub(r, 'tesseract-stub.js')); await pg.route('**/www.verovio.org/**', lambda r: stub(r, 'verovio-stub.js'))
    await pg.goto(url); await pg.click('#start')
    await pg.click('#songs .card[data-id="silent"] .play'); await pg.wait_for_selector('#practice.active')
    return ctx, pg, errs
async def main():
    srv, url = start_app()
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME) if CHROME else await p.chromium.launch()

        # 1. Microphone + Wait mode: correct notes advance, a wrong note is flagged, the app stays silent
        ctx, pg, errs = await new_page(b, url)
        await pg.click('#wait'); await pg.wait_for_timeout(300)
        await pg.click('#micBtn')
        await pg.wait_for_function("/Listening/.test(document.getElementById('micStatus').textContent)", timeout=8000)
        check('mic: calibrates, then listens', await pg.get_attribute('#micBtn', 'aria-pressed') == 'true', await pg.inner_text('#micStatus'))
        # Silent Night starts G4 A4 G4 E4
        await pg.evaluate("window.__synthLog.length = 0")
        await pg.evaluate("__playMic(67, 0.1)"); await pg.wait_for_function("PCApp._state().waitIdx === 1", timeout=5000)
        check('mic: G4 heard, wait mode moves on', True, await pg.inner_text('#micStatus'))
        await pg.evaluate("__playMic(72, 0.1)"); await pg.wait_for_timeout(900)
        st = await pg.evaluate("PCApp._state().waitIdx"); score = await pg.inner_text('#scoreOut')
        check('mic: a wrong note (C5 for A4) does not advance and counts as wrong', st == 1 and 'Accuracy 50%' in score, (st, score, await pg.inner_text('#micStatus')))
        await pg.evaluate("__playMic(69, 0.1)"); await pg.wait_for_function("PCApp._state().waitIdx === 2", timeout=5000)
        await pg.evaluate("__playMic(67, 0.1)"); await pg.wait_for_function("PCApp._state().waitIdx === 3", timeout=5000)
        check('mic: A4 then G4 heard, three notes done', True)
        log = await pg.evaluate("window.__synthLog.join('|')")
        check('mic: the app does not play the notes it hears (your piano does)', 'attack M67' not in log and 'attack M69' not in log, log[:200])
        await pg.click('#micBtn')
        check('mic: turns off', await pg.get_attribute('#micBtn', 'aria-pressed') == 'false' and await pg.is_hidden('#micMeter'))
        check('no page errors (mic + wait)', not errs, errs)
        await ctx.close()

        # 2. Play along with a MIDI keyboard: on time / late / early / wrong / missed
        ctx, pg, errs = await new_page(b, url)
        await pg.fill('#tempo', '60'); await pg.locator('#tempo').dispatch_event('input')
        await pg.click('#along'); await pg.wait_for_function("PCApp._state().along")
        check('play along: the Timing setting appears', await pg.is_visible('#tolSel'))
        st = await pg.evaluate("PCApp._state().along")
        check('play along: starts with a count-in at the set tempo', st and abs(st['spb'] - 1.0) < 1e-6, st)
        # Silent Night in 3/4 at 60 BPM: G4@0 A4@1 G4@2 E4@3 G4@4 ... ; play: on time, 150 ms late, 160 ms early, wrong key, skip E4
        plan = [(67, 0, 0), (69, 1, 0.15), (67, 2, -0.16), (61, 3.5, 0)]
        await pg.evaluate("""(plan) => { const s = PCApp._state().along; plan.forEach(([m, beat, off]) => { const at = (s.t0 + beat * s.spb + off) * 1000 - performance.now(); setTimeout(() => { __midiSend(0x90, m, 90); setTimeout(() => __midiSend(0x80, m, 0), 120); }, at); }); }""", plan)
        t0 = st['t0']
        await pg.wait_for_function("(t0) => performance.now() / 1000 > t0 + 4.25", arg=t0, timeout=15000)   # E4 (beat 3) is past its window, G4 (beat 4) not yet
        sm = (await pg.evaluate("PCApp._state().along"))['summary']
        check('play along: on time, late, early, wrong and missed are told apart', (sm['on'], sm['late'], sm['early'], sm['wrong'], sm['missed']) == (1, 1, 1, 1, 1), sm)
        txt = await pg.inner_text('#scoreOut')
        check('play along: running score shown', 'On time 1' in txt and 'late 1' in txt and 'missed 1' in txt, txt)
        await pg.click('#stop')
        hist = await pg.evaluate("PCApp._history()['silent'] || []")
        check('play along: stopping early logs the session', hist and hist[-1]['mode'] == 'along' and hist[-1]['complete'] is False, hist[-1:] if hist else hist)
        check('no page errors (play along)', not errs, errs)
        await ctx.close()

        # 3. Play along through the microphone: notes played on the beat are on time
        ctx, pg, errs = await new_page(b, url)
        await pg.click('#micBtn'); await pg.wait_for_function("/Listening/.test(document.getElementById('micStatus').textContent)", timeout=8000)
        await pg.fill('#tempo', '60'); await pg.locator('#tempo').dispatch_event('input')
        await pg.click('#along'); await pg.wait_for_function("PCApp._state().along")
        st = await pg.evaluate("PCApp._state().along")
        await pg.evaluate("(s) => { [[67, 0], [69, 1], [67, 2], [64, 3]].forEach(([m, beat]) => __playMic(m, s.t0 + beat * s.spb - performance.now() / 1000, 0.8)); }", st)
        await pg.wait_for_function("(t0) => performance.now() / 1000 > t0 + 3.8", arg=st['t0'], timeout=15000)
        sm = (await pg.evaluate("PCApp._state().along"))['summary']
        check('play along by microphone: 4 notes on the beat heard as on time', sm['on'] == 4 and sm['wrong'] == 0, sm)
        await pg.click('#stop'); await pg.click('#micBtn')
        check('no page errors (mic play along)', not errs, errs)
        await ctx.close()

        # 4. Recording, takes, playback, MIDI download
        ctx, pg, errs = await new_page(b, url)
        await pg.click('#recBtn')
        check('record: button turns into Stop recording', 'Stop recording' in await pg.inner_text('#recBtn'))
        for m in (60, 64, 67):
            await pg.evaluate("(m) => __midiSend(0x90, m, 100)", m); await pg.wait_for_timeout(150); await pg.evaluate("(m) => __midiSend(0x80, m, 0)", m); await pg.wait_for_timeout(100)
        await pg.click('#recBtn'); await pg.wait_for_function("/Saved a take/.test(document.getElementById('toolStatus').textContent)")
        check('record: take saved with 3 notes', '3 notes' in await pg.inner_text('#toolStatus'), await pg.inner_text('#toolStatus'))
        await pg.click('#takesBtn'); await pg.wait_for_selector('#takesDlg[open] .take')
        row = await pg.inner_text('#takesList .take span')
        check('takes: listed for this piece', '3 notes' in row, row)
        async with pg.expect_download() as dl: await pg.click('#takesList .take button:has-text("MIDI")')
        path = await (await dl.value).path(); data = open(path, 'rb').read()
        check('takes: MIDI download is a standard MIDI file', data[:4] == b'MThd' and b'MTrk' in data, data[:16])
        await pg.evaluate("window.__synthLog.length = 0")
        await pg.click('#takesList .take button:has-text("Play")')
        await pg.wait_for_function("window.__synthLog.some(x => /ar M64/.test(x))", timeout=5000)
        check('takes: playing a MIDI take plays its notes', True, (await pg.evaluate("window.__synthLog.slice(0, 4)")))
        await pg.wait_for_function("/Take finished/.test(document.getElementById('toolStatus').textContent)", timeout=8000)
        for i in range(11):   # only the last 10 takes are kept
            await pg.click('#recBtn'); await pg.evaluate("__midiSend(0x90, 72, 90)"); await pg.wait_for_timeout(40); await pg.evaluate("__midiSend(0x80, 72, 0)"); await pg.click('#recBtn'); await pg.wait_for_timeout(120)
        await pg.click('#takesBtn'); await pg.wait_for_selector('#takesDlg[open] .take')
        n = await pg.locator('#takesList .take').count()
        check('takes: only the last 10 are kept', n == 10, n)
        await pg.click('#takesList .take button:has-text("Delete")'); await pg.wait_for_timeout(300)
        check('takes: delete removes one', await pg.locator('#takesList .take').count() == 9)
        await pg.click('#takesDone')
        check('no page errors (recording)', not errs, errs)
        await ctx.close()

        # 5. Falling notes: notes are drawn above the key they belong to, preference remembered
        ctx, pg, errs = await new_page(b, url)
        if await pg.is_visible('#guide'): await pg.click('#guideDone')   # first-visit tips take room
        await pg.click('#fallToggle'); await pg.wait_for_timeout(300)
        check('falling notes: score hidden, road fills the space', await pg.evaluate("getComputedStyle(document.querySelector('.scorebox')).display") == 'none' and await pg.evaluate("document.getElementById('road').getBoundingClientRect().height") > 250)
        colour = await pg.evaluate("""(() => {
          const road = document.getElementById('road'), rr = road.getBoundingClientRect(), d = window.devicePixelRatio || 1, g = road.getContext('2d');
          const key = m => { const r = document.querySelector('#piano [data-m="' + m + '"]').getBoundingClientRect(); return Math.round((r.left + r.width / 2 - rr.left) * d); };
          const px = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data);
          const y = Math.round((rr.height - 12) * d);           // just above the hit line: the first note (G4) sits there
          return { g4: px(key(67), y), a4: px(key(69), y), c4: px(key(60), y) };
        })()""")
        check('falling notes: first note (G4) drawn above the G4 key, not above A4 or C4', colour['g4'][2] > 200 and colour['a4'][2] < 120 and colour['c4'][2] < 120, colour)
        await pg.reload(); await pg.click('#start'); await pg.click('#songs .card[data-id="silent"] .play'); await pg.wait_for_selector('#practice.active'); await pg.wait_for_timeout(300)
        check('falling notes: choice remembered', await pg.get_attribute('#fallToggle', 'aria-pressed') == 'true')
        await pg.click('#fallToggle'); await pg.wait_for_timeout(200)
        check('falling notes: switching back shows the score', await pg.evaluate("getComputedStyle(document.querySelector('.scorebox')).display") != 'none')
        check('no page errors (falling notes)', not errs, errs)
        await ctx.close()
        await b.close()
    srv.shutdown()
    print('%d/%d passed' % (sum(results), len(results))); sys.exit(0 if all(results) else 1)
asyncio.run(main())
