"""Smoke test against a running recognition server with the real homr.
Usage: python3 tests/server/smoke_real.py http://localhost:7860 image.png [image2.png ...]
Set SAVE_DIR to keep each MusicXML result (CI uploads them as an artifact);
set DUMP_XML=1 to also print them into the log.
Prints what was recognised and fails if a page yields no music."""
import os, re, sys, time, requests
base, images = sys.argv[1].rstrip('/'), sys.argv[2:]
for _ in range(60):
    try:
        h = requests.get(base + '/health', timeout=5).json(); print('health:', h); break
    except Exception:
        time.sleep(5)
else:
    sys.exit('server did not come up')
ok = True
for img in images:
    t0 = time.time()
    with open(img, 'rb') as f:
        r = requests.post(base + '/recognise', files={'image': (img.split('/')[-1], f, 'image/png')}, timeout=600)
    took = time.time() - t0
    if r.status_code != 200:
        print('FAIL', img, r.status_code, r.text[:300]); ok = False; continue
    xml = r.text
    if os.environ.get('SAVE_DIR'):
        os.makedirs(os.environ['SAVE_DIR'], exist_ok=True)
        with open(os.path.join(os.environ['SAVE_DIR'], os.path.splitext(os.path.basename(img))[0] + '.musicxml'), 'w') as f: f.write(xml)
    if os.environ.get('DUMP_XML'):
        print('----- BEGIN MUSICXML %s' % os.path.basename(img)); print(xml); print('----- END MUSICXML')
    pos = re.findall(r'<!--[^>]*?imgpos[^>]*?-->', xml)
    print('  image positions: %d markers%s' % (len(pos), (', e.g. ' + ' '.join(pos[:3])) if pos else ''))
    i = xml.find('<note')
    if i >= 0: print('  first notes:', re.sub(r'\s+', ' ', xml[max(0, i - 300):i + 900]))
    notes = len(re.findall(r'<note[ >]', xml)); pitched = len(re.findall(r'<pitch>', xml)); measures = len(re.findall(r'<measure ', xml))
    print('%s: %d measures, %d notes (%d pitched) in %.0f s; title=%r; key=%s; time=%s' % (img, measures, notes, pitched, took,
          (re.search(r'<work-title>(.*?)</work-title>', xml) or [None, ''])[1], re.findall(r'<fifths>(-?\d+)</fifths>', xml)[:1], re.findall(r'<beats>(\d+)</beats><beat-type>(\d+)', xml)[:1]))
    if pitched < 10:
        print('FAIL', img, 'too few notes'); ok = False
sys.exit(0 if ok else 1)
