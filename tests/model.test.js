const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../omr/model.js');
const MX = require('../music/musicxml.js');
function score(events, opts) {
  opts = opts || {};
  return { title: 'T', tempo: 100, key: opts.key || 0, time: opts.time || [4, 4], pages: [{}], part: { name: 'Piano' }, warnings: [],
    measures: [{ id: 'm1', page: 0, system: 0, x0: 0, x1: 100, y0: 0, y1: 100, staves: [{ clef: 'treble', staff: { top: 0, bottom: 64, interline: 16, lines: [0, 16, 32, 48, 64] }, events }] }] };
}
const note = (d, base, x, extra) => Object.assign({ id: 'e' + x, type: 'note', base, dots: 0, voice: 1, x, conf: 1, notes: [{ id: 'n' + x, diatonic: d, accidental: null }] }, extra || {});
const copyMeasure = s => s.measures.push(JSON.parse(JSON.stringify(s.measures[0])));

test('key signature and measure-scoped accidentals resolve to MIDI', () => {
  const B4 = 34, E4 = 30, s = score([note(B4, 'quarter', 1), note(E4, 'quarter', 2), note(B4, 'quarter', 3), note(B4, 'quarter', 4)], { key: -2 });
  s.measures[0].staves[0].events[2].notes[0].accidental = 0;
  M.resolveMeasure(s, s.measures[0]);
  assert.deepEqual(s.measures[0].staves[0].events.map(e => e.notes[0].midi), [70, 63, 71, 71]);
});
test('validation flags wrong totals; fill-with-rests repairs them', () => {
  const s = score([note(30, 'half', 10)]); copyMeasure(s); copyMeasure(s);
  M.validate(s);
  assert.equal(s.measures[1].status, 'invalid');
  M.fillWithRests(s, s.measures[1], 0); M.validate(s);
  assert.notEqual(s.measures[1].status, 'invalid');
});
test('dotted durations', () => {
  assert.equal(M.duration({ base: 'half', dots: 1 }), 3);
  assert.equal(M.duration({ base: 'quarter', dots: 2 }), 1.75);
});
test('MusicXML export is well-formed with key, time, chords and accidentals', () => {
  const s = score([note(30, 'quarter', 1), note(31, 'quarter', 2), note(32, 'half', 3, { notes: [{ id: 'a', diatonic: 32, accidental: 1 }, { id: 'b', diatonic: 34, accidental: null }] })], { key: 1 });
  M.validate(s);
  const xml = M.toMusicXML(s);
  assert.match(xml, /<fifths>1<\/fifths>/);
  assert.match(xml, /<beats>4<\/beats><beat-type>4<\/beat-type>/);
  assert.match(xml, /<chord\/>/);
  assert.match(xml, /<accidental>sharp<\/accidental>/);
  assert.equal((xml.match(/<(?!\?|!|\/)[a-zA-Z-]+[^>]*[^/]>/g) || []).length, (xml.match(/<\/[a-zA-Z-]+>/g) || []).length);
});
test('toSong: right hand, onsets accumulate per measure, measure starts recorded', () => {
  const s = score([note(30, 'quarter', 1), note(31, 'quarter', 2), note(32, 'half', 3)]); copyMeasure(s);
  M.validate(s);
  const song = M.toSong(s);
  assert.deepEqual(song.notes.map(n => n.startBeat), [0, 1, 2, 4, 5, 6]);
  assert.ok(song.notes.every(n => n.hand === 'right'));
  assert.equal(song.totalBeats, 8);
  assert.deepEqual(song.measureStarts, [0, 4]);
});
test('MusicXML: <dot/> precedes <accidental> (schema order)', () => {
  const s = score([note(30, 'half', 1, { dots: 1, notes: [{ id: 'a', diatonic: 30, accidental: -1 }] }), note(31, 'quarter', 2)]);
  M.validate(s);
  const n = M.toMusicXML(s).split('\n').find(l => l.includes('<accidental>'));
  const order = ['<pitch>', '<duration>', '<voice>', '<type>', '<dot/>', '<accidental>', '</note>'].map(t => n.indexOf(t));
  assert.ok(order.every((p, i) => p >= 0 && (i === 0 || p > order[i - 1])), n);
});
test('accepting a red measure marks it verified; un-accepting restores it', () => {
  const s = score([note(30, 'half', 10)]); copyMeasure(s); copyMeasure(s);
  M.validate(s);
  s.measures[1].accepted = true; M.validate(s);
  assert.equal(s.measures[1].status, 'verified');
  assert.equal(s.measures[1].mismatch, true);
  s.measures[1].accepted = false; M.validate(s);
  assert.equal(s.measures[1].status, 'invalid');
});
test('key vote: one stray non-zero header cannot override a majority', () => {
  assert.equal(M.voteKey({ 0: 11, 1: 1 }), 0);
  assert.equal(M.voteKey({ 0: 3, '-2': 3 }), -2);
  assert.equal(M.voteKey({ 0: 5 }), 0);
});
test('OMR MusicXML re-imports with the same notes (scan -> MusicXML -> practice)', () => {
  const s = score([note(30, 'quarter', 1), note(31, 'quarter', 2, { dots: 1 }), note(32, 'eighth', 3), note(33, 'quarter', 4)], { key: -1 });
  M.validate(s);
  const a = M.toSong(s), b = MX.toSong(MX.parse(a.musicxml), 'P1');
  assert.deepEqual(b.notes.map(n => [n.startBeat, n.midi]), a.notes.map(n => [n.startBeat, n.midi]));
});
