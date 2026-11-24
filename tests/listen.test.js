// Microphone listening (music/listen.js) on synthesised piano-like audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../music/listen.js');
const sr = 48000, hop = 1440;
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function run(seq, o) {
  o = o || {};
  const total = Math.max(...seq.map(e => e.t + e.d)) + 0.8, buf = new Float32Array(Math.ceil(total * sr)), r = rng(7);
  seq.forEach(e => (e.m || [e.midi]).forEach(m => L.addTone(buf, sr, m + (o.detune || 0) / 100, e.t, e.d, e.v || 0.25)));
  if (o.reverb) { const d = Math.round(0.037 * sr), d2 = Math.round(0.053 * sr); for (let i = d2; i < buf.length; i++) buf[i] += 0.35 * buf[i - d] + 0.25 * buf[i - d2]; }
  if (o.phoneMic) { const a = Math.exp(-2 * Math.PI * 150 / sr); let px = 0, py = 0; for (let i = 0; i < buf.length; i++) { const y = a * (py + buf[i] - px); px = buf[i]; py = y; buf[i] = y; } }
  for (let i = 0; i < buf.length; i++) buf[i] += (r() - 0.5) * 2 * (o.noise || 0.003);
  const quiet = new Float32Array(sr), r2 = rng(3); for (let i = 0; i < sr; i++) quiet[i] = (r2() - 0.5) * 2 * (o.noise || 0.003);
  const det = L.create({ sampleRate: sr }); det.calibrate(quiet);
  (o.ignore || []).forEach(([m, u]) => det.ignore(m, u));
  const ev = []; let ei = 0;
  for (let end = det.fftSize; end <= buf.length; end += hop) {
    if (o.wait) det.setExpected(o.wait[Math.min(ei, o.wait.length - 1)]);
    det.process(buf.subarray(end - det.fftSize, end), end / sr).forEach(e => { ev.push(e); if (e.type === 'notes') ei++; });
  }
  return ev;
}
const melody = [60, 62, 64, 65, 67, 65, 64, 62, 60, 60, 67, 72];
const seqOf = (gap, dur) => melody.map((m, i) => ({ midi: m, t: 0.3 + i * gap, d: dur }));
const heard = ev => ev.filter(e => e.type === 'notes').length;

test('single notes across C2-C7 are heard, with accurate onset times', () => {
  for (let m = 36; m <= 96; m += 6) {
    const ev = run([{ midi: m, t: 0.3, d: 0.8 }], { wait: [[m]] });
    assert.equal(ev.length, 1, 'midi ' + m + ': ' + JSON.stringify(ev));
    assert.equal(ev[0].type, 'notes');
    assert.ok(Math.abs(ev[0].time - 0.3) < 0.04, 'onset time for ' + m);
  }
});

test('melodies: repeated notes, legato, fast, out of tune, reverb, phone mic, noise', () => {
  const cases = [[{}, 0.5, 0.45], [{}, 0.4, 0.9], [{}, 0.17, 0.16], [{ detune: -20 }, 0.5, 0.45], [{ detune: 20 }, 0.5, 0.45],
    [{ reverb: true }, 0.5, 0.45], [{ phoneMic: true }, 0.5, 0.45], [{ noise: 0.02 }, 0.5, 0.45], [{ reverb: true, phoneMic: true, noise: 0.012, detune: 12 }, 0.45, 0.6]];
  for (const [o, gap, dur] of cases) {
    const ev = run(seqOf(gap, dur), Object.assign({ wait: melody.map(m => [m]) }, o));
    assert.equal(heard(ev), 12, JSON.stringify(o) + ' gap ' + gap);
    assert.ok(!ev.some(e => e.type === 'wrong'), 'no false wrong notes ' + JSON.stringify(o));
  }
});

test('chords: whole chords accepted, partial or wrong chords not', () => {
  const chords = [[48, 60, 64, 67], [53, 57, 60, 65], [55, 59, 62, 67], [41, 60, 64]];
  const ev = run(chords.map((c, i) => ({ m: c, t: 0.3 + i * 0.9, d: 0.85 })), { wait: chords, reverb: true });
  assert.equal(heard(ev), 4);
  assert.ok(!run([{ m: [60, 64], t: 0.3, d: 0.9 }], { wait: [[60, 64, 67]] }).some(e => e.type === 'notes'), 'partial chord');
  assert.ok(!run([{ m: [60, 63, 67], t: 0.3, d: 0.9 }], { wait: [[60, 64, 67]] }).some(e => e.type === 'notes'), 'minor for major');
});

test('wrong notes and wrong octaves are reported, never accepted', () => {
  for (const [exp, played] of [[60, 62], [64, 65], [67, 69], [60, 72], [72, 60], [48, 50]]) {
    const ev = run([{ midi: played, t: 0.3, d: 0.8 }], { wait: [[exp]] });
    assert.ok(!ev.some(e => e.type === 'notes'), exp + ' vs ' + played);
    const w = ev.find(e => e.type === 'wrong');
    if (w) assert.equal(w.midi, played);
  }
  const ev = run([{ midi: 60, t: 0.3, d: 1.2 }, { midi: 65, t: 0.8, d: 0.6 }], { wait: [[60], [64]] });
  assert.equal(heard(ev), 1);
  assert.ok(ev.some(e => e.type === 'wrong' && e.midi === 65), 'wrong note while the previous one rings');
});

test("the app's own accompaniment is ignored; noise alone triggers nothing; free play names notes", () => {
  const accomp = [{ midi: 48, t: 0.3, d: 0.9 }, { midi: 55, t: 1.3, d: 0.9 }];
  const mel = [{ midi: 64, t: 0.32, d: 0.45 }, { midi: 65, t: 0.8, d: 0.45 }, { midi: 67, t: 1.32, d: 0.45 }, { midi: 65, t: 1.8, d: 0.45 }];
  const ev = run(accomp.concat(mel), { wait: [[64], [65], [67], [65]], ignore: [[48, 1.3], [55, 2.3]] });
  assert.equal(heard(ev), 4); assert.ok(!ev.some(e => e.type === 'wrong'));
  assert.equal(run([{ midi: 60, t: 0.3, d: 0.0001, v: 0 }], { wait: [[60]], noise: 0.01 }).length, 0);
  for (let m = 40; m <= 90; m += 10) {
    const f = run([{ midi: m, t: 0.3, d: 0.6 }]);
    assert.deepEqual(f.map(e => [e.type, e.midi]), [['note', m]], 'free play ' + m);
  }
});

test('knocks, taps and notes that stop abruptly are not taken for the expected note', () => {
  for (const kind of ['knock', 'cut', 'tap']) for (let seed = 1; seed <= 10; seed++) {
    let s = seed; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const buf = new Float32Array(sr * 2);
    for (let i = 0; i < buf.length; i++) buf[i] = (r() - 0.5) * 0.004;
    if (kind === 'knock') for (let i = Math.round(0.5 * sr); i < Math.round(0.506 * sr); i++) buf[i] += (r() - 0.5) * 0.8;
    if (kind === 'cut') { const t = new Float32Array(buf.length); L.addTone(t, sr, 72, 0.3, 0.45, 0.3); for (let i = 0; i < Math.round(0.6 * sr); i++) buf[i] += t[i]; }
    if (kind === 'tap') for (let i = Math.round(0.5 * sr); i < Math.round(0.53 * sr); i++) buf[i] += 0.5 * Math.exp(-(i / sr - 0.5) * 120) * Math.sin(2 * Math.PI * 180 * i / sr);
    const q = new Float32Array(sr); for (let i = 0; i < sr; i++) q[i] = (r() - 0.5) * 0.004;
    const d = L.create({ sampleRate: sr }); d.calibrate(q); d.setExpected([69]);
    for (let end = d.fftSize; end <= buf.length; end += hop) d.process(buf.subarray(end - d.fftSize, end), end / sr).forEach(e => assert.notEqual(e.type, 'notes', kind + ' ' + seed));
  }
});
