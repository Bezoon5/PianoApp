const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../omr/engine.js');
const readPGM = require('./pgm.js');
test('engine key vote mirrors the model rule', () => {
  assert.equal(E.voteKey([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), 0);
  assert.equal(E.voteKey([-2, -2, -2, 0, 0, 0]), -2);
});
test('part lookup is by kind and ordinal, never by position', () => {
  const piano = { kind: 'piano', ordinal: 0 }, clar = { kind: 'single', ordinal: 0 };
  const ensemble = { slots: [{ kind: 'single', staves: [0] }, { kind: 'piano', staves: [1, 2] }] };
  const pianoOnly = { slots: [{ kind: 'piano', staves: [0, 1] }] };
  const braceMissed = { slots: [{ kind: 'single', staves: [0] }, { kind: 'single', staves: [1] }] };
  assert.deepEqual(E.slotForPart(ensemble, piano).staves, [1, 2]);
  assert.deepEqual(E.slotForPart(pianoOnly, piano).staves, [0, 1]);
  assert.equal(E.slotForPart(braceMissed, piano), null);
  assert.deepEqual(E.slotForPart(ensemble, clar).staves, [0]);
});
test('piano spec on a page without a piano skips it with warnings', () => {
  const tw = readPGM(__dirname + '/fixtures/together-we-will-live-forever.pgm');
  const P = E.prepare(tw.gray, tw.w, tw.h), staves = E.detectStaves(P), layout = E.detectLayout(P, staves);
  layout.systems.forEach(s => { s.slots = s.staves.map(i => ({ kind: 'single', staves: [i] })); });
  const r = E.recognise(P, staves, layout, 0, { kind: 'piano', ordinal: 0, name: 'Piano' });
  assert.equal(r.measures.length, 0);
  assert.equal(r.warnings.length, 3);
  assert.equal(r.warnings[0].code, 'PART_NOT_FOUND');
});
test('dotted note below a line position is still recognised as dotted', () => {
  const w = 700, h = 260, g = new Uint8Array(w * h).fill(250);
  for (const y of [80, 96, 112, 128, 144]) for (let x = 40; x < 660; x++) { g[y * w + x] = 20; g[(y + 1) * w + x] = 20; }
  for (let y = 58; y <= 168; y++) for (let x = 50; x <= 62; x++) g[y * w + x] = 15;
  const head = (cx, cy) => { for (let y = -6; y <= 6; y++) for (let x = -9; x <= 9; x++) if (x * x / 81 + y * y / 36 <= 1) g[(cy + y) * w + cx + x] = 15; };
  const stem = (x, y0, y1) => { for (let y = y1; y <= y0; y++) { g[y * w + x] = 15; g[y * w + x + 1] = 15; } };
  for (const [cx, dot] of [[200, true], [400, false]]) {
    head(cx, 122); stem(cx + 8, 122, 66);
    if (dot) for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) g[(122 + y) * w + cx + 22 + x] = 15;
  }
  const evs = E.analysePage(g, w, h, { partIndex: 0, deskew: false }).recognition.measures.flatMap(m => m.staves[0].events).filter(e => e.type === 'note');
  assert.equal(evs.length, 2);
  assert.equal(evs[0].dots, 1);
  assert.equal(evs[1].dots, 0);
});
