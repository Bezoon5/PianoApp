// v6 practice logic: hands, loops, metronome, progress, backup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const P = require('../music/practice.js');
const MX = require('../music/musicxml.js');

const song = [
  { midi: 72, startBeat: 0, durationBeats: 1, hand: 'right' }, { midi: 76, startBeat: 0, durationBeats: 1, hand: 'right' },
  { midi: 48, startBeat: 0, durationBeats: 2, hand: 'left' },
  { midi: 74, startBeat: 1, durationBeats: 1, hand: 'right' },
  { midi: 50, startBeat: 1.5, durationBeats: 0.5, hand: 'left' },
  { midi: 72, startBeat: 2, durationBeats: 1 },                       // no hand -> right
  { midi: 43, startBeat: 2, durationBeats: 2, hand: 'left' }
];

test('hands: wait events group chords for the chosen hand only', () => {
  assert.deepEqual(P.waitEvents(song, { hand: 'right' }).map(e => [e.beat, e.midis]), [[0, [72, 76]], [1, [74]], [2, [72]]]);
  assert.deepEqual(P.waitEvents(song, { hand: 'left' }).map(e => [e.beat, e.midis]), [[0, [48]], [1.5, [50]], [2, [43]]]);
  assert.deepEqual(P.waitEvents(song, { hand: 'both' }).map(e => e.midis), [[48, 72, 76], [74], [50], [43, 72]]);
});
test('hands: wait events respect a loop range [start, end)', () => {
  assert.deepEqual(P.waitEvents(song, { hand: 'both', start: 1, end: 2 }).map(e => e.beat), [1, 1.5]);
});
test('hands: the app plays the other hand between chords', () => {
  assert.deepEqual(P.accompaniment(song, 'right', 0, 1).map(n => n.midi), [48]);
  assert.deepEqual(P.accompaniment(song, 'right', 1, 2).map(n => n.midi), [50]);
  assert.deepEqual(P.accompaniment(song, 'left', 0, 1.5).map(n => n.midi), [72, 76, 74]);
  assert.deepEqual(P.accompaniment(song, 'both', 0, 9), []);
});

test('loops: bars resolved through repeats (Maple Leaf Rag)', async () => {
  const b = fs.readFileSync(__dirname + '/fixtures/maple-leaf-rag.mxl');
  const sc = MX.parse(await MX.readFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)));
  const segs = MX.toSong(sc, 'P1').segments;
  const r = P.resolveLoop(segs, 5, 8);
  assert.equal(r.bars, 4);
  assert.equal(r.startBeat, segs[5].play);              // bar 0 is a pickup, so bar 5 is segment 5
  assert.equal(r.endBeat - r.startBeat, 8);             // 4 bars of 2/4
  assert.equal(r.label, 'bars 5–8');
  assert.equal(P.resolveLoop(segs, 7, 7).label, 'bar 7');
  assert.match(P.resolveLoop(segs, 8, 5).error, /at or after/, 'does not wrap round the repeat');
  assert.equal(P.resolveLoop(segs, 14, 16).bars, 3, 'up to the end of the first time through');
  assert.match(P.resolveLoop(segs, 500, 501).error, /not in this piece/);
  assert.match(P.resolveLoop(segs, '', 3).error, /first and last/);
});
test('loops: speed trainer climbs 5% per pass and stops at the target', () => {
  assert.deepEqual([0, 1, 2, 5, 6, 20].map(p => P.speedTrainer(100, 70, p)), [70, 75, 80, 95, 100, 100]);
  assert.equal(P.speedTrainer(60, 70, 0), 42);
});

test('metronome: one click per beat, accents on full-bar downbeats, pickup aligned to bar end', () => {
  const segs = [{ number: '0', play: 0, len: 1 }, { number: '1', play: 1, len: 3 }, { number: '2', play: 4, len: 3 }];
  const c = P.clicks(segs, [3, 4], 0, 7);
  assert.deepEqual(c.map(x => x.beat), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(c.filter(x => x.accent).map(x => x.beat), [1, 4]);
  const half = P.clicks([{ number: '0', play: 0, len: 0.5 }, { number: '1', play: 0.5, len: 2 }], [2, 4], 0, 3);
  assert.deepEqual(half.map(x => x.beat), [0.5, 1.5]);
});
test('metronome: compound 6/8 clicks dotted quarters; range limits clicks', () => {
  const c = P.clicks([{ number: '1', play: 0, len: 3 }, { number: '2', play: 3, len: 3 }], [6, 8], 0, 6);
  assert.deepEqual(c.map(x => [x.beat, x.accent]), [[0, true], [1.5, false], [3, true], [4.5, false]]);
  assert.deepEqual(P.clicks([{ number: '1', play: 0, len: 4 }, { number: '2', play: 4, len: 4 }], [4, 4], 4, 8).map(x => x.beat), [4, 5, 6, 7]);
});
test('metronome: count-in is one bar', () => {
  assert.deepEqual(P.countIn([3, 4]), { clicks: [{ beat: 0, accent: true }, { beat: 1, accent: false }, { beat: 2, accent: false }], beats: 3 });
  assert.equal(P.countIn([6, 8]).clicks.length, 2);
});

test('progress: sessions summarised and capped', () => {
  let h = {};
  for (let i = 0; i < 55; i++) h = P.addSession(h, 's1', { id: 'x' + i, date: i, accuracy: i % 10 === 3 ? 97 : 80, seconds: 10 });
  assert.equal(h.s1.length, 50);
  const s = P.summarise(h.s1);
  assert.equal(s.count, 50); assert.equal(s.best, 97); assert.equal(s.seconds, 500); assert.equal(s.last, 54);
  assert.deepEqual(P.summarise([]), { count: 0, best: null, last: null, lastAccuracy: null, seconds: 0 });
});
test('progress: streak counts consecutive days ending today or yesterday', () => {
  const now = new Date(2026, 10, 23, 18).getTime(), d = n => new Date(2026, 10, 23 - n, 12).getTime();
  assert.equal(P.streak([d(0), d(1), d(1), d(2), d(4)], now), 3);
  assert.equal(P.streak([d(1), d(2)], now), 2, 'not yet practised today');
  assert.equal(P.streak([d(3)], now), 0);
  assert.equal(P.relativeDay(d(0), now), 'today');
  assert.equal(P.relativeDay(d(1), now), 'yesterday');
  assert.equal(P.relativeDay(d(5), now), '5 days ago');
});
test('progress: trickiest bars ranked by wrong notes', () => {
  assert.deepEqual(P.trickiest({ 1: { wrong: 0, hits: 5 }, 2: { wrong: 4, hits: 3 }, 7: { wrong: 4, hits: 1 }, 9: { wrong: 1, hits: 9 }, 3: { wrong: 2, hits: 0 } }).map(b => b.bar), ['7', '2', '3']);
});

test('backup: round trip, validation and history merge', () => {
  const songs = [{ id: 'xml-1', title: 'A', notes: [{ midi: 60, startBeat: 0, durationBeats: 1 }] }, { id: 'bad', title: 'B', notes: [] }];
  const hist = { 'xml-1': [{ id: 'a', date: 2 }] };
  const back = P.readBackup(JSON.stringify(P.makeBackup(songs, hist, 0)));
  assert.deepEqual(back.songs.map(s => s.id), ['xml-1']);
  assert.equal(back.skipped, 1);
  assert.throws(() => P.readBackup('{"songs":[]}'), /not a Piano Companion backup/);
  assert.throws(() => P.readBackup('nope'), /not valid JSON/);
  const merged = P.mergeHistory({ s: [{ id: 'a', date: 2 }, { id: 'b', date: 5 }] }, { s: [{ id: 'a', date: 2 }, { id: 'c', date: 3 }], t: [{ id: 'd', date: 1 }] });
  assert.deepEqual(merged.s.map(x => x.id), ['a', 'c', 'b']);
  assert.deepEqual(merged.t.map(x => x.id), ['d']);
});

test('restore merges: new pieces added, identical skipped, newer copy wins', () => {
  const P = require('../music/practice.js');
  const a = { id: 'a', title: 'A', notes: [1], updatedAt: 100 };
  const local = [a, { id: 'b', title: 'B local', notes: [1], updatedAt: 300 }, { id: 'c', title: 'C old', notes: [1], updatedAt: 100 }, { id: 'd', title: 'D', notes: [1] }];
  const incoming = [Object.assign({}, a), { id: 'b', title: 'B backup', notes: [1], updatedAt: 200 }, { id: 'c', title: 'C new', notes: [1], updatedAt: 200 }, { id: 'd', title: 'D edited', notes: [1] }, { id: 'e', title: 'E', notes: [1] }];
  const m = P.mergeSongs(local, incoming);
  assert.deepEqual(m.write.map(s => s.title), ['C new', 'D edited', 'E']);
  assert.deepEqual([m.added, m.updated, m.kept, m.same], [1, 2, 1, 1]);
});

test('backup reminder counts pieces changed since the last backup', () => {
  const P = require('../music/practice.js');
  const songs = [{ id: 'x', updatedAt: 50 }, { id: 'y', updatedAt: 150 }, { id: 'z' }, { id: 'k', builtin: true }];
  assert.deepEqual(P.unbackedUp(songs, 0).map(s => s.id), ['x', 'y', 'z']);
  assert.deepEqual(P.unbackedUp(songs, 100).map(s => s.id), ['y']);
});

test('play along: on time, early, late, wrong and missed notes', () => {
  const P = require('../music/practice.js');
  const exp = [{ beat: 0, midi: 60 }, { beat: 1, midi: 62 }, { beat: 2, midi: 64 }, { beat: 3, midi: 65 }, { beat: 4, midi: 67 }];
  const j = P.timingJudge(exp, { spb: 0.5, tolerance: 'normal' });   // 120 BPM, ±90 ms on time
  assert.equal(j.press(60, 0.1).result, 'on');                        // 50 ms late
  const e = j.press(62, 0.7);                                          // 150 ms early
  assert.equal(e.result, 'early'); assert.equal(e.ms, -150);
  assert.equal(j.press(64, 2.3).result, 'late');                       // 150 ms late
  assert.equal(j.press(61, 3).result, 'wrong');                        // wrong key
  assert.equal(j.press(60, 1.5).result, 'wrong', 'a note already played does not count twice');
  assert.deepEqual(j.sweep(3.2).map(n => n.midi), []);                 // 65 not yet too late (window 250 ms)
  assert.deepEqual(j.sweep(3.6).map(n => n.midi), [65]);
  assert.equal(j.press(67, 4).result, 'on');
  const s = j.summary();
  assert.deepEqual([s.on, s.early, s.late, s.missed, s.wrong, s.total], [2, 1, 1, 1, 2, 5]);
  assert.equal(s.timing, 50); assert.equal(s.accuracy, 57); assert.equal(s.meanMs, 13);
  // chords: each note is matched on its own
  const c = P.timingJudge([{ beat: 0, midi: 60 }, { beat: 0, midi: 64 }], { spb: 0.5 });
  assert.equal(c.press(64, 0.02).result, 'on'); assert.equal(c.press(60, -0.02).result, 'on');
  assert.equal(P.timingJudge([], { spb: 0.5, tolerance: 'strict' }).toleranceMs, 50);
});

test('a recorded take becomes a valid standard MIDI file', () => {
  const P = require('../music/practice.js');
  const midi = P.takeToMidi([{ t: 0, midi: 60, vel: 0.8, on: true }, { t: 500, midi: 60, on: false }, { t: 500, midi: 64, vel: 0.5, on: true }, { t: 1000, midi: 64, on: false }], 'My take');
  const txt = String.fromCharCode(...midi.slice(0, 4)) + String.fromCharCode(...midi.slice(14, 18));
  assert.equal(txt, 'MThdMTrk');
  const len = (midi[18] << 24) | (midi[19] << 16) | (midi[20] << 8) | midi[21];
  assert.equal(len, midi.length - 22, 'track length matches');
  // parse it back with the app's own MIDI reader if available, else check events by hand
  const body = Array.from(midi.slice(22));
  assert.ok(body.join(',').includes([0x90, 60, 102].join(',')), 'note on C4 velocity 102');
  assert.ok(body.join(',').includes([0x83, 0x60, 0x80, 60].join(',')), '480 ticks later C4 off');
  assert.deepEqual(body.slice(-4), [0, 0xff, 0x2f, 0], 'end of track');
});
