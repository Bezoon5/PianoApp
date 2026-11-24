"""Smoke test against a running recognition server with the real homr.
Usage: python3 tests/server/smoke_real.py http://localhost:7860 image.png [image2.png ...]
Prints what was recognised and fails if a page yields no music."""
import re, sys, time, requests
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
    notes = len(re.findall(r'<note[ >]', xml)); pitched = len(re.findall(r'<pitch>', xml)); measures = len(re.findall(r'<measure ', xml))
    print('%s: %d measures, %d notes (%d pitched) in %.0f s; title=%r; key=%s; time=%s' % (img, measures, notes, pitched, took,
          (re.search(r'<work-title>(.*?)</work-title>', xml) or [None, ''])[1], re.findall(r'<fifths>(-?\d+)</fifths>', xml)[:1], re.findall(r'<beats>(\d+)</beats><beat-type>(\d+)', xml)[:1]))
    if pitched < 10:
        print('FAIL', img, 'too few notes'); ok = False
sys.exit(0 if ok else 1)
