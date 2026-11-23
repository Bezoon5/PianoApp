// OMR regression tests on real screenshot fixtures (~5 px and ~3.5 px staff spacing).
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../omr/engine.js');
const M = require('../omr/model.js');
const readPGM = require('./pgm.js');
const scoreFixture = require('./score-fixture.js');
const hb = readPGM(__dirname + '/fixtures/happy-birthday.pgm');
const tw = readPGM(__dirname + '/fixtures/together-we-will-live-forever.pgm');

test('Happy Birthday: three piano systems of six staves', () => {
  const a = E.analysePage(hb.gray, hb.w, hb.h, {});
  assert.equal(a.staves.length, 6);
  assert.equal(a.layout.systems.length, 3);
  assert.deepEqual(a.layout.parts.map(p => p.kind), ['piano']);
});
test('Happy Birthday: key, metre, pickup and measure count', () => {
  const s = M.buildScore([E.analysePage(hb.gray, hb.w, hb.h, { partIndex: 0 })], {});
  assert.equal(s.key, -1);
  assert.deepEqual(s.time, [3, 4]);
  assert.equal(s.measures.length, 9);
  assert.equal(s.measures[0].pickup, true);
});
test('Happy Birthday: notehead and duration accuracy floor', () => {
  const r = scoreFixture(E.analysePage(hb.gray, hb.w, hb.h, { partIndex: 0 }), require('./fixtures/happy-birthday.truth.json'));
  assert.ok(r.heads.precision >= 0.8, 'precision ' + r.heads.precision);
  assert.ok(r.heads.recall >= 0.75, 'recall ' + r.heads.recall);
  assert.ok(r.events.durationAccuracy >= 0.9, 'durations ' + r.events.durationAccuracy);
});
test('Together We Will Live Forever: clarinet + piano per system', () => {
  const a = E.analysePage(tw.gray, tw.w, tw.h, {});
  assert.equal(a.staves.length, 9);
  assert.equal(a.layout.systems.length, 3);
  assert.deepEqual(a.layout.parts.map(p => p.kind), ['single', 'piano']);
  a.layout.systems.forEach(s => assert.deepEqual(s.slots.map(x => x.staves.length), [1, 2]));
});
test('Together We Will Live Forever: piano part recognition', () => {
  const s = M.buildScore([E.analysePage(tw.gray, tw.w, tw.h, { partIndex: 1 })], {});
  assert.equal(s.key, -2);
  assert.ok(s.measures.length >= 15 && s.measures.length <= 17);
  s.measures.forEach(m => assert.equal(m.staves.length, 2));
  assert.deepEqual(s.measures[0].staves.map(x => x.clef), ['treble', 'bass']);
});
test('Blank page produces no music', () => {
  const g = new Uint8Array(600 * 800).fill(250), a = E.analysePage(g, 600, 800, { partIndex: 0 });
  assert.equal(a.staves.length, 0);
  assert.equal(a.recognition, undefined);
});
