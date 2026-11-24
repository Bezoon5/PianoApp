/*
 * Piano Companion: listening to an acoustic or digital piano through the microphone.
 *
 *   const L = PCListen.create({ sampleRate })
 *   L.calibrate(samples)        quiet-room noise profile (a second of audio)
 *   L.setExpected([midi…])      notes the player should play next (null = free play)
 *   L.ignore(midi, untilTime)   notes the app itself is sounding (accompaniment)
 *   L.process(window, time)     -> events for the newest audio (window = last fftSize samples)
 *
 * Events: { type: 'notes', midis, time }   expected notes heard (all of a chord)
 *         { type: 'wrong', midi, time }    a clearly different note was played
 *         { type: 'note', midi, time }     free play: the note that was played
 * `time` is when the note started (onset), in the same clock as process().
 *
 * Recognising every note of any chord from audio is unreliable, so this is
 * "score-informed": it checks whether the notes the player should play are
 * present (fundamental and overtones above the room's noise, and not explained
 * by a lower octave), which works for single notes and simple chords. For free
 * play and wrong-note detection it picks the single strongest pitch.
 *
 * Pure JavaScript (own FFT), so the same code runs in the browser and in tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCListen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const freqOf = m => 440 * Math.pow(2, (m - 69) / 12);
  const LOW = 36, HIGH = 96;            // C2..C7: where microphone detection is dependable
  const CENTS = Math.pow(2, 35 / 1200);  // search ±35 cents around each harmonic

  /* ------------------------------- FFT ------------------------------------ */
  function fftMag(input, n) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (input[i] || 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
    const mag = new Float32Array(n >> 1);
    for (let i = 0; i < mag.length; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  }

  function rmsDb(buf, from, to) {
    let s = 0;
    for (let i = from; i < to; i++) s += buf[i] * buf[i];
    return 10 * Math.log10(s / Math.max(1, to - from) + 1e-12);
  }

  function create(opts) {
    opts = opts || {};
    const sr = opts.sampleRate || 48000;
    const n = opts.fftSize || 8192;                     // ~170 ms at 48 kHz: resolves low notes
    const short = Math.min(1024, n);                     // ~21 ms: sharp onset timing
    const binHz = sr / n;
    let noise = null;                                    // per-bin noise magnitude
    let noiseDb = -70;                                   // quiet-room level (short window)
    let expected = null;
    const ignored = new Map();                           // midi -> until time
    const recentDb = [];                                 // [time, db] of the short window
    let pending = null;                                  // listening window after an onset
    let lastOnset = -1;
    let prevShort = null, prevLong = null;               // previous spectra (onset flux, "new" notes)
    const fluxHist = [];
    const SHORT_N = 2048, maxFluxBin = Math.floor(4500 / (sr / SHORT_N));

    function peak(mag, f) {
      const lo = Math.max(1, Math.floor(f / CENTS / binHz)), hi = Math.min(mag.length - 2, Math.ceil(f * CENTS / binHz));
      let best = 0, at = lo;
      for (let b = lo; b <= hi; b++) if (mag[b] > best) { best = mag[b]; at = b; }
      // Only a genuine peak counts: the slope of a neighbouring note's peak (leakage)
      // has its maximum at the edge of the search window.
      if (!(mag[at] >= mag[at - 1] && mag[at] >= mag[at + 1]) || ((at === lo || at === hi) && Math.max(mag[lo - 1], mag[hi + 1]) > best)) return { v: 0, snr: 0 };
      // ...and it must stand out from the spectrum between this note and its neighbours:
      // a tone is a narrow peak, a knock or click is broadband.
      // Background: a ring just outside the peak's main lobe (the window spreads a pure
      // tone over ±2 bins), at least 4 bins wide, or out to ±110 cents for high notes.
      const ex = 3, ringLo = Math.max(1, Math.min(lo - ex - 4, Math.floor(f / Math.pow(2, 110 / 1200) / binHz))), ringHi = Math.min(mag.length - 1, Math.max(hi + ex + 4, Math.ceil(f * Math.pow(2, 110 / 1200) / binHz)));
      // The median ignores a neighbouring chord note's peak inside the ring.
      const ring = [];
      for (let b = ringLo; b <= ringHi; b++) if (b < lo - ex || b > hi + ex) ring.push(mag[b]);
      ring.sort((x, y) => x - y);
      // Below ~350 Hz neighbouring chord notes are only a few bins apart, so the ring
      // would land on their peaks; the higher harmonics (always checked) catch clicks.
      if (f >= 350 && ring.length && best < 3 * ring[ring.length >> 1]) return { v: 0, snr: 0 };
      const floor = noise ? noise[at] : 0;
      return { v: best, snr: floor > 0 ? best / floor : best * 1e6 };
    }

    /** How strongly a note is present: harmonic peaks above the noise, with an octave check. */
    function evidence(mag, midi) {
      const f0 = freqOf(midi), B = 0.0004;
      let s = 0, maxH = 0, h1 = 0, h3 = 0, strongCount = 0;
      for (let h = 1; h <= 6; h++) {
        const f = f0 * h * Math.sqrt(1 + B * h * h);
        if (f > sr * 0.45) break;
        const p = peak(mag, f), v = p.snr > 4 ? p.v : 0;
        if (h === 1) h1 = v;
        if (h === 3) h3 = v;
        if (v > maxH) maxH = v;
        if (p.snr > 6) strongCount++;
        s += v / Math.sqrt(h);
      }
      // A real note has its fundamental (or, for bass notes, its 3rd harmonic) and
      // at least two clear harmonics; otherwise the energy belongs to another note.
      const rooted = h1 >= 0.12 * maxH || (midi < 52 && h3 >= 0.2 * maxH);
      return { score: rooted && strongCount >= (midi > 84 ? 1 : 2) ? s : 0, h1 };
    }

    /**
     * The expected note's energy may come from the octave below (its 2nd harmonic).
     * When that lower note is one the app is playing, only reject if the lower note
     * is clearly strong enough to account for it on its own.
     */
    function explainedByLowerOctave(mag, midi, exp, time) {
      if (midi - 12 < LOW || exp.indexOf(midi - 12) >= 0) return false;
      const me = evidence(mag, midi), lower = evidence(mag, midi - 12);
      if (!(lower.score > 0)) return false;
      return isIgnored(midi - 12, time) ? lower.h1 > 1.2 * me.h1 : lower.h1 > 0.6 * me.h1;
    }

    function strongest(mag, skip) {
      let best = null, bs = 0, all = [];
      for (let m = LOW; m <= HIGH; m++) {
        if (skip && skip(m)) continue;
        const e = evidence(mag, m);
        all.push(e.score);
        if (e.score > bs) { bs = e.score; best = m; }
      }
      if (best == null) return null;
      // Prefer the lowest octave that explains the peak (avoid reporting an overtone).
      for (const k of [12, 24]) {
        const m = best - k;
        if (m >= LOW && !(skip && skip(m))) {
          const e = evidence(mag, m);
          if (e.score > bs * 0.55 && e.h1 > 0) best = m;
        }
      }
      const sorted = all.slice().sort((a, b) => b - a), med = sorted[Math.floor(sorted.length / 2)] || 0;
      return bs > Math.max(med * 6, 1e-9) ? best : null;
    }

    function calibrate(samples) {
      const frames = [];
      for (let i = 0; i + n <= samples.length; i += n >> 1) frames.push(fftMag(samples.subarray ? samples.subarray(i, i + n) : samples.slice(i, i + n), n));
      if (!frames.length) frames.push(fftMag(samples, n));
      noise = new Float32Array(n >> 1);
      frames.forEach(f => { for (let b = 0; b < noise.length; b++) noise[b] += f[b] / frames.length; });
      // smooth across neighbouring bins so a single quiet bin doesn't look like a peak
      const sm = new Float32Array(noise.length);
      for (let b = 0; b < noise.length; b++) { let s = 0, c = 0; for (let k = -3; k <= 3; k++) { const v = noise[b + k]; if (v != null) { s += v; c++; } } sm[b] = Math.max(s / c, 1e-7); }
      noise = sm;
      noiseDb = rmsDb(samples, 0, samples.length);
    }

    function setExpected(midis) {
      const next = midis && midis.length ? midis.slice().sort((a, b) => a - b) : null;
      if (String(next) === String(expected)) return;   // same notes: keep listening
      expected = next; pending = null;
    }
    function ignore(midi, until) { ignored.set(midi, Math.max(ignored.get(midi) || 0, until)); }
    const isIgnored = (m, t) => (ignored.get(m) || 0) > t;

    function process(win, time) {
      if (!noise) calibrate(new Float32Array(n));
      const out = [];
      // 1. Onset: new frequencies appearing (spectral flux on a short window). Unlike
      //    loudness, this also catches a note played while the previous one rings.
      const db = rmsDb(win, win.length - short, win.length);
      const ms = fftMag(win.subarray ? win.subarray(win.length - SHORT_N) : win.slice(win.length - SHORT_N), SHORT_N);
      let flux = 0;
      if (prevShort) for (let b = 3; b < maxFluxBin; b++) { const d = Math.log(ms[b] + 1e-4) - Math.log(prevShort[b] + 1e-4); if (d > 0) flux += d; }
      prevShort = ms;
      const sortedFlux = fluxHist.slice().sort((x, y) => x - y), medFlux = sortedFlux.length ? sortedFlux[sortedFlux.length >> 1] : flux;
      fluxHist.push(flux); if (fluxHist.length > 24) fluxHist.shift();
      recentDb.push([time, db]);
      while (recentDb.length && recentDb[0][0] < time - 0.12) recentDb.shift();
      const since = recentDb.filter(r => r[0] > lastOnset + 0.01);
      const minDb = since.length ? Math.min(...since.map(r => r[1])) : db;
      const loud = db > noiseDb + 12, rose = db - minDb > 7, newPartials = flux > Math.max(medFlux * 3, maxFluxBin * 0.6);
      const onset = loud && (rose || newPartials) && time - lastOnset > 0.08;
      const mag = fftMag(win.length > n ? win.subarray(win.length - n) : win, n);
      const before = prevLong || mag;
      prevLong = mag;
      if (onset) {
        lastOnset = time;
        if (pending) finish(pending, out);
        pending = { start: time - short / sr / 2, seen: new Set(), wrong: new Map(), done: false, frames: 0, base: before };
      }
      if (!pending) return out;
      // 2. Collect pitch evidence for ~350 ms after the onset (the long window needs a moment to fill).
      const age = time - pending.start;
      if (age > 0.04) {
        pending.frames++;
        // a wrong note must be new: clearly stronger than just before the onset
        const isNew = m => evidence(mag, m).score > 2 * evidence(pending.base, m).score + 1e-9;
        if (expected) {
          expected.forEach(m => { if (!pending.seen.has(m) && evidence(mag, m).score > 0 && !explainedByLowerOctave(mag, m, expected, time)) pending.seen.add(m); });
          if (expected.every(m => pending.seen.has(m))) { out.push({ type: 'notes', midis: expected.slice(), time: pending.start }); pending = null; return out; }
          const s = strongest(mag, m => expected.indexOf(m) >= 0 || isIgnored(m, time));
          if (s != null && isNew(s) && evidence(mag, s).score > Math.max(...expected.map(m => evidence(mag, m).score)) * 2) pending.wrong.set(s, (pending.wrong.get(s) || 0) + 1);
        } else {
          const s = strongest(mag, m => isIgnored(m, time));
          if (s != null && isNew(s)) pending.wrong.set(s, (pending.wrong.get(s) || 0) + 1);
          if (pending.frames >= 3) { finish(pending, out); pending = null; return out; }
        }
      }
      if (pending && age > 0.35) { finish(pending, out); pending = null; }
      return out;
    }

    function finish(p, out) {
      if (p.done) return;
      p.done = true;
      let best = null, bc = 0;
      p.wrong.forEach((c, m) => { if (c > bc) { bc = c; best = m; } });
      if (!expected) { if (best != null) out.push({ type: 'note', midi: best, time: p.start }); return; }
      // A wrong note needs to be the clear winner in at least two frames.
      if (best != null && bc >= 2) out.push({ type: 'wrong', midi: best, time: p.start });
    }

    return { calibrate, setExpected, ignore, process, fftSize: n, sampleRate: sr, get noiseDb() { return noiseDb; } };
  }

  /* -------------------- Test signal: a simple piano-like tone -------------------- */
  /** Adds a decaying, slightly inharmonic tone to `buf` (for tests and calibration demos). */
  function addTone(buf, sr, midi, start, dur, vel) {
    const f0 = freqOf(midi), B = 0.0004, a0 = (vel == null ? 0.3 : vel);
    const i0 = Math.round(start * sr), i1 = Math.min(buf.length, Math.round((start + dur) * sr));
    for (let h = 1; h <= 8; h++) {
      const f = f0 * h * Math.sqrt(1 + B * h * h);
      if (f > sr * 0.45) break;
      let amp = a0 * Math.pow(1 / h, 1.1);
      if (h === 1 && midi < 48) amp *= 0.35;   // weak fundamentals in the bass
      const decay = 1.2 + 0.4 * h, w = 2 * Math.PI * f / sr;
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / sr, env = Math.min(1, t / 0.004) * Math.exp(-decay * t) * Math.min(1, (i1 - i) / (0.02 * sr));
        buf[i] += amp * env * Math.sin(w * (i - i0));
      }
    }
    return buf;
  }

  return { create, fftMag, freqOf, addTone, LOW, HIGH };
});
