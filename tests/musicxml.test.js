// MusicXML import/export, checked against music21 oracles for real public-domain scores.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const X = require('../music/xml.js');
const MX = require('../music/musicxml.js');
const compare = require('./compare-oracle.js');
const F = n => __dirname + '/fixtures/' + n;
async function load(name) { const b = fs.readFileSync(F(name)); return MX.parse(await MX.readFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))); }
function allNotes(score) { return score.parts.flatMap(p => MX.toSong(score, p.id, { expandRepeats: false }).notes.map(n => [n.scoreBeat, n.midi, n.durationBeats])); }
function oracle(name) { return JSON.parse(fs.readFileSync(F(name + '.oracle.json'))).parts.flatMap(p => p.notes); }

test('XML parser: entities, CDATA, comments, DOCTYPE subset, self-closing, serialize', () => {
  const d = X.parse('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><!-- c --><r a="1 &amp; 2"><t>A &lt; B &#x263A;</t><e/><c><![CDATA[<raw>]]></c></r>');
  const r = X.root(d);
  assert.equal(r.attrs.a, '1 & 2');
  assert.equal(X.childText(r, 't'), 'A < B ☺');
  assert.equal(X.child(r, 'e').children.length, 0);
  assert.equal(X.childText(r, 'c'), '<raw>');
  assert.equal(X.childText(X.root(X.parse(X.serialize(d))), 't'), 'A < B ☺');
});

// Piano part vs music21 (music21 splits a piano part into one PartStaff per staff).
// Dichterliebe: 10 of music21's notes are <cue> notes, which are not played.
for (const [name, minRecall, minDur] of [['maple-leaf-rag.mxl', 1, 1], ['clara-polonaise.mxl', 1, 1], ['bach-bwv66.mxl', 1, 1], ['lindenbaum.xml', 0.995, 0.99], ['dichterliebe-2.xml', 0.93, 0.95]]) {
  test('MusicXML vs music21 oracle: ' + name, async () => {
    const score = await load(name), id = MX.choosePart(score);
    const parts = JSON.parse(fs.readFileSync(F(name + '.oracle.json'))).parts;
    const staffParts = parts.filter(p => p.id.startsWith(id + '-'));
    const mine = staffParts.length ? MX.toSong(score, id, { expandRepeats: false }).notes.map(n => [n.scoreBeat, n.midi, n.durationBeats]) : allNotes(score);
    const ref = staffParts.length ? staffParts.flatMap(p => p.notes) : oracle(name);
    const r = compare(mine, ref);
    assert.ok(r.onsetPitch / r.oracle >= minRecall, `onset+pitch ${r.onsetPitch}/${r.oracle}`);
    assert.ok(r.exact / r.onsetPitch >= minDur, `durations ${r.exact}/${r.onsetPitch}`);
    assert.ok(r.mine - r.onsetPitch <= Math.max(1, r.mine * 0.005), 'extra notes ' + (r.mine - r.onsetPitch));
  });
}

test('compressed .mxl is unzipped (container.xml rootfile)', async () => {
  const s = await load('maple-leaf-rag.mxl');
  assert.equal(s.parts.length, 1);
  assert.equal(s.parts[0].staves, 2);
  assert.equal(s.parts[0].measures.length, 85);
});
test('part choice: piano in voice+piano and named parts', async () => {
  const l = await load('lindenbaum.xml');
  assert.equal(l.title, 'Der Lindenbaum');
  assert.equal(l.composer, 'Franz Schubert');
  assert.deepEqual(l.parts.map(p => p.name), ['Voice', 'Piano']);
  assert.equal(MX.choosePart(l), 'P2');
  const d = await load('dichterliebe-2.xml');
  assert.equal(MX.choosePart(d), 'P2', 'two-staff part chosen when names are generic');
});
test('piano song: hands from staves, tempo, key, metre', async () => {
  const s = MX.toSong(await load('clara-polonaise.mxl'), 'P1');
  assert.equal(s.bpm, 96);
  assert.deepEqual(s.timeSignature, [3, 4]);
  assert.ok(s.notes.some(n => n.hand === 'left') && s.notes.some(n => n.hand === 'right'));
  assert.ok(s.notes.every(n => (n.staff === 1) === (n.hand === 'right')));
});
test('repeats: Maple Leaf Rag strains AA BB CC DD with 1st/2nd endings', async () => {
  const sc = await load('maple-leaf-rag.mxl'), p = sc.parts[0];
  const order = MX.playOrder(p.measures).map(i => +p.measures[i].number);
  const seq = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const expected = [].concat(seq(0, 16), seq(1, 15), seq(17, 33), seq(18, 32), seq(34, 66), seq(51, 65), seq(67, 83), seq(68, 82), [84]);
  assert.deepEqual(order, expected);
  const song = MX.toSong(sc, 'P1');
  assert.equal(song.segments.length, expected.length);
  assert.equal(song.totalBeats, song.segments.reduce((a, s) => a + s.len, 0));
});
test('repeats: backward repeat without forward returns to the previous repeat', async () => {
  const p = (await load('clara-polonaise.mxl')).parts[0];
  const order = MX.playOrder(p.measures).map(i => +p.measures[i].number);
  const seq = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  assert.deepEqual(order, [].concat(seq(1, 8), seq(1, 8), seq(9, 28), seq(9, 28), seq(29, 40)));
});
test('repeats: times="3" and endings 1,2 / 3', () => {
  const m = (o) => Object.assign({ notes: [], forward: false, backward: false, times: 2, endings: null, endingLast: false }, o);
  const ms = [m({ forward: true }), m({}), m({ endings: [1, 2], endingLast: true, backward: true, times: 3 }), m({ endings: [3], endingLast: true }), m({})];
  assert.deepEqual(MX.playOrder(ms), [0, 1, 2, 0, 1, 2, 0, 1, 3, 4]);
});
test('ties merge into one sounding note across a barline', () => {
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
    <measure number="1"><attributes><divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <note><rest/><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/><type>quarter</type></note></measure>
    <measure number="2"><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><tie type="stop"/><type>half</type></note></measure></part></score-partwise>`;
  const s = MX.toSong(MX.parse(xml), 'P1');
  assert.deepEqual(s.notes.map(n => [n.startBeat, n.midi, n.durationBeats]), [[1, 60, 3]]);
});
test('tuplets: rounded division durations snap to exact thirds', () => {
  const note = d => `<note><pitch><step>C</step><octave>4</octave></pitch><duration>${d}</duration><type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification></note>`;
  const xml = `<score-partwise><part-list><score-part id="P1"/></part-list><part id="P1"><measure number="1"><attributes><divisions>64</divisions><time><beats>1</beats><beat-type>4</beat-type></time></attributes>${note(21)}${note(22)}${note(21)}</measure></part></score-partwise>`;
  const s = MX.toSong(MX.parse(xml), 'P1');
  assert.deepEqual(s.notes.map(n => +n.startBeat.toFixed(6)), [0, +(1 / 3).toFixed(6), +(2 / 3).toFixed(6)]);
});
test('extractPart keeps only the chosen part', async () => {
  const text = fs.readFileSync(F('lindenbaum.xml'), 'utf8');
  const one = MX.parse(MX.extractPart(text, 'P2'));
  assert.deepEqual(one.parts.map(p => p.id), ['P2']);
  assert.equal(one.title, 'Der Lindenbaum');
  assert.equal(one.parts[0].noteCount, MX.parse(text).parts[1].noteCount);
});
test('rejects non-MusicXML and timewise files with a clear message', () => {
  assert.throws(() => MX.parse('<html></html>'), /not a MusicXML score/);
  assert.throws(() => MX.parse('<score-timewise/>'), /timewise/);
});
test('songToMusicXML round-trips a two-hand song with chords and barline ties', () => {
  const song = { title: 'T & U', bpm: 90, timeSignature: [3, 4], key: -1, notes: [
    { midi: 65, startBeat: 0, durationBeats: 1, hand: 'right' }, { midi: 69, startBeat: 0, durationBeats: 1, hand: 'right' },
    { midi: 70, startBeat: 1, durationBeats: 3.5, hand: 'right' },
    { midi: 41, startBeat: 0, durationBeats: 3, hand: 'left' }, { midi: 48, startBeat: 4.5, durationBeats: 0.5, hand: 'left' }] };
  const back = MX.toSong(MX.parse(MX.songToMusicXML(song)), 'P1');
  const sig = s => s.notes.map(n => [n.startBeat, n.midi, n.durationBeats, n.hand].join('|')).sort();
  assert.deepEqual(sig(back), sig(song));
  assert.equal(back.title, 'T & U');
  assert.deepEqual(back.timeSignature, [3, 4]);
});
