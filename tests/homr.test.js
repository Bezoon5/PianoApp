// AI recognition (homr server) client-side conversion: MusicXML -> review score -> practice song.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const H = require('../omr/homr.js');
const M = require('../omr/model.js');
const MX = require('../music/musicxml.js');
const FIX = __dirname + '/fixtures/';

const midiName = m => ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][m % 12] + (Math.floor(m / 12) - 1);
const notesOf = score => M.toSong(score).notes;
/** Multiset comparison of (pitch, onset, duration), so unisons in two voices count twice. */
function compare(got, ref) {
  const pool = new Map();
  const add = (k) => pool.set(k, (pool.get(k) || 0) + 1);
  ref.forEach(n => add(n.midi + '@' + n.startBeat.toFixed(3) + '/' + n.durationBeats.toFixed(3)));
  let match = 0;
  got.forEach(n => { const k = n.midi + '@' + n.startBeat.toFixed(3) + '/' + (n.durationBeats / 0.95).toFixed(3); if (pool.get(k)) { pool.set(k, pool.get(k) - 1); match++; } });
  return { match, ref: ref.length, got: got.length };
}
/** Minimal homr-style MusicXML around some measure bodies. */
function xml(measures, opts) {
  opts = opts || {};
  const staves = opts.staves || 2;
  const attrs = '<attributes><divisions>' + (opts.div || 2) + '</divisions><key><fifths>' + (opts.key || 0) + '</fifths></key><time><beats>' + (opts.beats || 4) + '</beats><beat-type>4</beat-type></time>' +
    (staves > 1 ? '<staves>2</staves><part-symbol>brace</part-symbol><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef>' : '<clef number="1"><sign>G</sign><line>2</line></clef>') + '</attributes>';
  const parts = opts.parts || [{ id: 'P1', name: staves > 1 ? 'Piano' : 'Voice', measures }];
  return '<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>' + (opts.title || 'T') + '</work-title></work><part-list>' +
    parts.map(p => '<score-part id="' + p.id + '"><part-name>' + p.name + '</part-name></score-part>').join('') + '</part-list>' +
    parts.map(p => '<part id="' + p.id + '">' + p.measures.map((b, i) => '<measure number="' + (i + 1) + '">' + (i === 0 ? (p.attrs || attrs) : '') + b + '</measure>').join('') + '</part>').join('') + '</score-partwise>';
}
const n = (step, oct, dur, type, extra) => '<note>' + ((extra && extra.chord) ? '<chord/>' : '') + '<pitch><step>' + step + '</step><octave>' + oct + '</octave>' + (extra && extra.alter != null ? '<alter>' + extra.alter + '</alter>' : '') + '</pitch><duration>' + dur + '</duration>' + ((extra && extra.tie) || '') + '<voice>' + ((extra && extra.voice) || 1) + '</voice><type>' + type + '</type>' + ((extra && extra.dot) ? '<dot/>' : '') + ((extra && extra.tm) || '') + '<staff>' + ((extra && extra.staff) || 1) + '</staff></note>';
const r = (dur, type, extra) => '<note><rest' + ((extra && extra.measure) ? ' measure="yes"' : '') + '/><duration>' + dur + '</duration><voice>' + ((extra && extra.voice) || 1) + '</voice>' + (type ? '<type>' + type + '</type>' : '') + '<staff>' + ((extra && extra.staff) || 1) + '</staff></note>';
const back = d => '<backup><duration>' + d + '</duration></backup>';
const fwd = d => '<forward><duration>' + d + '</duration></forward>';
const bassWhole = back(8) + r(8, null, { measure: true, voice: 5, staff: 2 });

test('Happy Birthday from homr: key, metre, pickup and every note', () => {
  const s = H.toScore([{ xml: fs.readFileSync(FIX + 'homr-happy-birthday.musicxml', 'utf8'), pageIndex: 0 }], {});
  assert.equal(s.engine, 'homr');
  assert.equal(s.title, 'Happy Birthday');
  assert.equal(s.key, -1);
  assert.deepEqual(s.time, [3, 4]);
  assert.equal(s.measures.length, 9);
  assert.equal(s.measures[0].pickup, true);
  assert.equal(M.summary(s).invalid, 0);
  assert.deepEqual(s.measures[0].staves.map(x => x.clef), ['treble', 'bass']);
  assert.equal(new Set(s.measures.map(m => m.system)).size, 3, 'homr line breaks become three systems');
  const notes = notesOf(s), truth = require('./fixtures/happy-birthday.truth.json');
  const count = ['treble', 'bass'].reduce((a, c) => a + truth.notes[c].flat().filter(t => t[0] !== 'R').reduce((b, t) => b + t.split('+').length, 0), 0);
  assert.equal(notes.length, count);
  assert.ok(notes.some(x => midiName(x.midi) === 'B♭4'), 'B is flat from the key signature');
  // key-signature flats are not written as accidentals
  assert.ok(s.measures.every(m => m.staves.every(st => st.events.every(e => e.notes.every(q => q.accidental == null)))));
});

test('real scores through the homr path match the MusicXML importer note for note', async () => {
  for (const f of ['bach-bwv66.mxl', 'clara-polonaise.mxl', 'maple-leaf-rag.mxl', 'lindenbaum.xml', 'dichterliebe-2.xml']) {
    const text = await MX.readFile(fs.readFileSync(FIX + f));
    const sc = MX.parse(text), pid = MX.choosePart(sc), ref = MX.toSong(sc, pid, { expandRepeats: false }).notes;
    const s = H.toScore([{ xml: sc.parts.length > 1 ? MX.extractPart(text, pid) : text, pageIndex: 0 }], {});
    const c = compare(notesOf(s), ref);
    assert.ok(c.match / c.ref >= 0.97, f + ': ' + c.match + '/' + c.ref + ' notes match (got ' + c.got + ')');
    assert.ok(M.summary(s).invalid <= 2, f + ': ' + M.summary(s).invalid + ' measures do not add up');
  }
});

test('voices 5-8 on staff 2, forward gaps and whole-bar rests add up', () => {
  const m1 = n('C', 5, 4, 'half', { voice: 1 }) + n('E', 4, 4, 'half', { voice: 1 }) + back(8) + n('G', 4, 2, 'quarter', { voice: 2 }) + fwd(6) + bassWhole;
  const s = H.toScore([{ xml: xml([m1, m1]), pageIndex: 0 }], {});
  const st0 = s.measures[0].staves[0];
  assert.deepEqual([...new Set(st0.events.map(e => e.voice))].sort(), [1, 2]);
  assert.equal(M.summary(s).invalid, 0, JSON.stringify(s.measures[0].details));
  assert.equal(s.measures[0].staves[1].events[0].type, 'rest');
  assert.equal(M.duration(s.measures[0].staves[1].events[0]), 4);
  const v2 = st0.events.filter(e => e.voice === 2);
  assert.equal(v2[0].stemDir, 'down');
  assert.equal(v2.filter(e => e.type === 'rest').reduce((a, e) => a + M.duration(e), 0), 3, 'secondary voice padded with rests');
});

test('whole-bar rest in 3/4 becomes a dotted half', () => {
  const m = n('C', 4, 6, 'half', { dot: true }) + back(6) + r(6, null, { measure: true, voice: 5, staff: 2 });
  const s = H.toScore([{ xml: xml([m, m], { beats: 3 }), pageIndex: 0 }], {});
  const e = s.measures[1].staves[1].events[0];
  assert.equal(e.base, 'half'); assert.equal(e.dots, 1);
  assert.equal(M.summary(s).invalid, 0);
});

test('ties across the barline play as one note and survive MusicXML export', () => {
  const tieS = { tie: '<tie type="start"/>' }, tieE = { tie: '<tie type="stop"/>' };
  const m1 = n('C', 4, 4, 'half') + n('G', 4, 4, 'half', tieS) + bassWhole;
  const m2 = n('G', 4, 4, 'half', tieE) + n('E', 4, 4, 'half') + bassWhole;
  const s = H.toScore([{ xml: xml([m1, m2]), pageIndex: 0 }], {});
  const g = notesOf(s).filter(x => x.midi === 67);
  assert.equal(g.length, 1);
  assert.equal(+(g[0].durationBeats / 0.95).toFixed(3), 4);
  const out = M.toMusicXML(s);
  assert.match(out, /<tie type="start"\/>/); assert.match(out, /<tied type="stop"\/>/);
  const back2 = MX.toSong(MX.parse(out), 'P1').notes.filter(x => x.midi === 67);
  assert.equal(back2.length, 1, 'exported MusicXML keeps the tie');
});

test('triplets keep their timing in review, playback and export', () => {
  // divisions 6: triplet eighth = 2, quarter = 6, half = 12, bar = 24
  const tm = '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  const m = ['C', 'D', 'E'].map(x => n(x, 4, 2, 'eighth', { tm })).join('') + n('F', 4, 6, 'quarter') + n('G', 4, 12, 'half') + back(24) + r(24, null, { measure: true, voice: 5, staff: 2 });
  const s = H.toScore([{ xml: xml([m, m], { div: 6 }), pageIndex: 0 }], {});
  assert.equal(M.summary(s).invalid, 0, JSON.stringify(s.measures[0].details));
  const starts = notesOf(s).filter(x => x.measure === 2).map(x => +(x.startBeat - 4).toFixed(3));
  assert.deepEqual(starts.slice(0, 4), [0, 0.333, 0.667, 1]);
  assert.match(M.toMusicXML(s), /<actual-notes>3<\/actual-notes>/);
  const again = MX.toSong(MX.parse(M.toMusicXML(s)), 'P1').notes.filter(x => x.measure === 2).map(x => +(x.startBeat - 4).toFixed(3));
  assert.deepEqual(again.slice(0, 4), [0, 0.333, 0.667, 1], 'exported triplets re-import with the same timing');
});

test('accidentals: only pitch-changing or printed ones are kept, carried within the bar', () => {
  // F major: F#4 then F4 (needs a natural), then B4 (flat from key) and B natural
  const m = n('F', 4, 2, 'quarter', { alter: 1 }) + n('F', 4, 2, 'quarter') + n('B', 4, 2, 'quarter', { alter: -1 }) + n('B', 4, 2, 'quarter') + bassWhole;
  const s = H.toScore([{ xml: xml([m, m], { key: -1 }), pageIndex: 0 }], {});
  const evs = s.measures[0].staves[0].events;
  assert.deepEqual(evs.map(e => e.notes[0].accidental), [1, 0, null, 0]);
  assert.deepEqual(notesOf(s).filter(x => x.measure === 1 && x.hand === 'right').map(x => midiName(x.midi)), ['F♯4', 'F4', 'B♭4', 'B4']);
});

test('grace notes are skipped with a warning; chords stay together', () => {
  const grace = '<note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>';
  const m = grace + n('C', 4, 8, 'whole') + n('E', 4, 8, 'whole', { chord: true }) + n('G', 4, 8, 'whole', { chord: true }) + bassWhole;
  const s = H.toScore([{ xml: xml([m, m]), pageIndex: 0 }], {});
  assert.equal(s.measures[0].staves[0].events.length, 1);
  assert.equal(s.measures[0].staves[0].events[0].notes.length, 3);
  assert.ok(s.warnings.some(w => /grace/.test(w.message)));
});

test('several parts: piano is chosen unless a single-staff part was asked for', () => {
  const voiceAttrs = '<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef number="1"><sign>G</sign><line>2</line></clef></attributes>';
  const vm = n('A', 4, 8, 'whole');
  const pm = n('C', 4, 8, 'whole') + bassWhole;
  const doc = xml(null, { parts: [{ id: 'P1', name: 'Voice', attrs: voiceAttrs, measures: [vm] }, { id: 'P2', name: 'Piano', measures: [pm] }] });
  const s = H.toScore([{ xml: doc, pageIndex: 0 }], {});
  assert.equal(s.part.kind, 'piano'); assert.equal(s.measures[0].staves.length, 2);
  assert.ok(s.warnings.some(w => /found 2 parts/.test(w.message)));
  const v = H.toScore([{ xml: doc, pageIndex: 0 }], { spec: { kind: 'single', ordinal: 0 } });
  assert.equal(v.measures[0].staves.length, 1);
  assert.equal(notesOf(v)[0].midi, 69);
});

test('pages are joined in order and mapped back to their photos', () => {
  const page = fs.readFileSync(FIX + 'homr-happy-birthday.musicxml', 'utf8');
  const s = H.toScore([{ xml: page, pageIndex: 0 }, { xml: 'not xml', pageIndex: 1 }, { xml: page, pageIndex: 2 }], { title: 'Mine', tempo: 100 });
  assert.equal(s.title, 'Mine'); assert.equal(s.tempo, 100);
  assert.equal(s.pages.length, 2);
  assert.deepEqual(s.pageMap, [0, 2]);
  assert.equal(s.measures.length, 18);
  assert.ok(s.warnings.some(w => w.code === 'BAD_XML'));
  assert.ok(s.measures.filter(m => m.page === 1).length === 9);
});

test('review edits still work on homr scores (undo snapshot, fill with rests, export)', () => {
  const s = H.toScore([{ xml: fs.readFileSync(FIX + 'homr-happy-birthday.musicxml', 'utf8'), pageIndex: 0 }], {});
  const m = s.measures[3], st = m.staves[0];
  st.events.pop();
  M.validate(s);
  assert.equal(m.status, 'invalid');
  M.fillWithRests(s, m, 0);
  M.validate(s);
  assert.notEqual(m.status, 'invalid');
  const song = M.toSong(s);
  assert.equal(song.source, 'OMR');
  assert.ok(MX.parse(song.musicxml).parts[0].noteCount > 40);
});

test('server addresses are normalised', () => {
  assert.equal(H.normaliseUrl('me-piano.hf.space/'), 'https://me-piano.hf.space');
  assert.equal(H.normaliseUrl(' localhost:7860 '), 'http://localhost:7860');
  assert.equal(H.normaliseUrl('https://x.example/api/'), 'https://x.example/api');
  assert.equal(H.normaliseUrl(''), '');
});
