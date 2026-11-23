/*
 * Piano Companion MusicXML import/export
 *   readFile(arrayBuffer)      -> MusicXML text (handles compressed .mxl)
 *   parse(text)                -> score with parts, measures and notes
 *   choosePart(score)          -> id of the most piano-like part
 *   toSong(score, partId)      -> practice song (ties merged, repeats expanded)
 *   extractPart(text, partId)  -> MusicXML containing only that part
 *   songToMusicXML(song)       -> MusicXML for songs that have none (carols, MIDI)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./xml.js'));
  else root.PCMusicXML = factory(root.PCXml);
})(typeof self !== 'undefined' ? self : this, function (X) {
  'use strict';

  const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const UNIT_BEATS = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
  const EPS = 1e-6;
  const GRID = 192; // positions snap to 1/192 beat (exact for triplets and 32nds)
  const snap = v => Math.round(v * GRID) / GRID;
  const num = (s, d) => { const v = parseFloat(s); return isFinite(v) ? v : d; };

  /* ------------------------------ File reading ----------------------------- */

  function isZip(bytes) { return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04; }

  function unzipEntries(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a valid .mxl (zip) file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    const dec = new TextDecoder();
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
      const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
      const start = local + 30 + lnlen + lxlen;
      entries.push({ name, method, data: bytes.subarray(start, start + csize) });
      p += 46 + nlen + xlen + clen;
    }
    return entries;
  }

  async function inflate(entry) {
    if (entry.method === 0) return entry.data;
    if (entry.method !== 8) throw new Error('unsupported zip compression (method ' + entry.method + ')');
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot open compressed .mxl files; export uncompressed .musicxml instead');
    const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** ArrayBuffer of a .musicxml/.xml/.mxl file -> MusicXML text. */
  async function readFile(buffer) {
    const bytes = new Uint8Array(buffer);
    if (!isZip(bytes)) return decodeText(bytes);
    const entries = unzipEntries(bytes);
    let target = null;
    const container = entries.find(e => e.name === 'META-INF/container.xml');
    if (container) {
      const c = X.parse(decodeText(await inflate(container)));
      const rf = X.findAll(c, 'rootfile')[0];
      if (rf) target = entries.find(e => e.name === rf.attrs['full-path']);
    }
    if (!target) target = entries.find(e => /\.(musicxml|xml)$/i.test(e.name) && !/^META-INF\//.test(e.name));
    if (!target) throw new Error('no MusicXML score found inside the .mxl file');
    return decodeText(await inflate(target));
  }

  function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
    const m = /encoding=["']([^"']+)["']/i.exec(head);
    const enc = m ? m[1].toLowerCase() : 'utf-8';
    try { return new TextDecoder(enc).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
  }

  /* --------------------------------- Parsing ------------------------------- */

  function parse(text) {
    const doc = X.parse(text), r = X.root(doc);
    if (!r) throw new Error('the file is empty or is not XML');
    if (r.name === 'score-timewise') throw new Error('timewise MusicXML is not supported; export as standard (partwise) MusicXML');
    if (r.name !== 'score-partwise') throw new Error('not a MusicXML score (root element <' + r.name + '>)');

    const partList = X.child(r, 'part-list');
    const info = {};
    X.children(partList, 'score-part').forEach(sp => {
      info[sp.attrs.id] = { name: X.childText(sp, 'part-name'), abbr: X.childText(sp, 'part-abbreviation'), instrument: X.text(X.find(sp, 'score-instrument/instrument-name')) };
    });

    let title = X.text(X.find(r, 'work/work-title')) || X.childText(r, 'movement-title');
    let composer = '';
    X.children(X.child(r, 'identification'), 'creator').forEach(c => { if (!composer && (c.attrs.type === 'composer' || !c.attrs.type)) composer = X.text(c); });
    X.children(r, 'credit').forEach(c => {
      const type = X.childText(c, 'credit-type'), words = X.children(c, 'credit-words').map(X.text).join(' ').trim();
      if (!title && type === 'title') title = words;
      if (!composer && type === 'composer') composer = words;
    });

    const parts = X.children(r, 'part').map(p => parsePart(p, info[p.attrs.id] || {}));
    const tempoPart = parts.find(p => p.tempo != null);
    return {
      title: title || '', composer: composer || '', parts,
      tempo: tempoPart ? tempoPart.tempo : null,
      key: parts.length ? parts[0].key : 0,
      time: parts.length ? parts[0].time : [4, 4]
    };
  }

  /**
   * Written duration in beats. Exporters often round tuplet durations to the
   * division grid (e.g. 42/43/43 ticks for a triplet); when <type>, dots and
   * <time-modification> agree closely with <duration>, the exact value is used.
   */
  function noteDuration(c, divisions) {
    const raw = num(X.childText(c, 'duration'), 0) / divisions;
    const type = UNIT_BEATS[X.childText(c, 'type')];
    if (!type || raw <= 0) return snap(raw);
    let ideal = type, add = type;
    X.children(c, 'dot').forEach(() => { add /= 2; ideal += add; });
    const tm = X.child(c, 'time-modification');
    if (tm) ideal *= num(X.childText(tm, 'normal-notes'), 1) / num(X.childText(tm, 'actual-notes'), 1);
    // Chord members should share the chord's written value; some exporters
    // write inconsistent <duration>s for them, so trust the notation there.
    if (X.child(c, 'chord')) return snap(ideal);
    return Math.abs(ideal - raw) <= ideal * (tm ? 0.1 : 0.03) ? snap(ideal) : snap(raw);
  }

  function parsePart(partEl, meta) {
    let divisions = 1, key = null, time = null, staves = 1, tempo = null, scoreStart = 0;
    const clefs = {}, measures = [], openTies = new Map();
    let endingActive = null;
    for (const mEl of X.children(partEl, 'measure')) {
      const m = { number: mEl.attrs.number || String(measures.length + 1), implicit: mEl.attrs.implicit === 'yes', start: scoreStart, len: 0, notes: [], forward: false, backward: false, times: 2, endings: null, endingLast: false };
      let pos = 0, maxPos = 0, lastStart = 0, mTime = time;
      for (const c of X.children(mEl)) {
        if (c.name === 'attributes') {
          const d = X.childText(c, 'divisions'); if (d) divisions = num(d, divisions) || 1;
          const k = X.child(c, 'key'); if (k && key == null) key = Math.round(num(X.childText(k, 'fifths'), 0));
          const t = X.child(c, 'time');
          if (t && X.childText(t, 'beats')) {
            const beats = X.childText(t, 'beats').split('+').reduce((a, b) => a + num(b, 0), 0), bt = num(X.childText(t, 'beat-type'), 4);
            mTime = [beats, bt]; if (!time) time = mTime; m.time = mTime;
          }
          const s = X.childText(c, 'staves'); if (s) staves = Math.max(staves, num(s, 1));
          X.children(c, 'clef').forEach(cl => { const n = +(cl.attrs.number || 1); if (!clefs[n]) clefs[n] = X.childText(cl, 'sign'); });
        } else if (c.name === 'direction' || c.name === 'sound') {
          const snd = c.name === 'sound' ? c : X.child(c, 'sound');
          if (tempo == null && snd && snd.attrs.tempo) tempo = num(snd.attrs.tempo, null);
          if (tempo == null && c.name === 'direction') {
            const met = X.findAll(c, 'metronome')[0];
            if (met && X.childText(met, 'per-minute')) {
              let unit = UNIT_BEATS[X.childText(met, 'beat-unit')] || 1;
              if (X.child(met, 'beat-unit-dot')) unit *= 1.5;
              const pm = num(X.childText(met, 'per-minute'), 0);
              if (pm > 0) tempo = pm * unit;
            }
          }
        } else if (c.name === 'backup') {
          pos = Math.max(0, snap(pos - num(X.childText(c, 'duration'), 0) / divisions));
        } else if (c.name === 'forward') {
          pos = snap(pos + num(X.childText(c, 'duration'), 0) / divisions);
          maxPos = Math.max(maxPos, pos);
        } else if (c.name === 'barline') {
          const rep = X.child(c, 'repeat');
          if (rep && rep.attrs.direction === 'forward') m.forward = true;
          if (rep && rep.attrs.direction === 'backward') { m.backward = true; if (rep.attrs.times) m.times = Math.max(2, +rep.attrs.times); }
          const end = X.child(c, 'ending');
          if (end) {
            const nums = (end.attrs.number || '1').split(/[,\s]+/).map(Number).filter(n => n > 0);
            if (end.attrs.type === 'start') endingActive = nums;
            if (end.attrs.type === 'stop' || end.attrs.type === 'discontinue') { m.endings = endingActive || nums; m.endingLast = true; endingActive = null; }
          }
        } else if (c.name === 'note') {
          if (X.child(c, 'grace')) continue;
          const isChord = !!X.child(c, 'chord');
          const dur = noteDuration(c, divisions);
          const start = isChord ? lastStart : pos;
          const pitch = X.child(c, 'pitch');
          if (pitch && !X.child(c, 'cue')) {
            const step = X.childText(pitch, 'step').toUpperCase(), alter = Math.round(num(X.childText(pitch, 'alter'), 0)), oct = num(X.childText(pitch, 'octave'), 4);
            const midi = (oct + 1) * 12 + (STEP_PC[step] || 0) + alter;
            const staff = +(X.childText(c, 'staff') || 1);
            const ties = X.children(c, 'tie').map(t => t.attrs.type).concat(X.findAll(c, 'tied').map(t => t.attrs.type));
            const tieStop = ties.indexOf('stop') >= 0, tieStart = ties.indexOf('start') >= 0;
            const tkey = staff + ':' + midi, open = openTies.get(tkey), abs = scoreStart + start;
            if (tieStop && open && Math.abs(open.absEnd - abs) < 0.02) {
              open.dur += dur; open.absEnd = abs + dur;
              if (!tieStart) openTies.delete(tkey);
            } else {
              const note = { midi, offset: start, dur, staff, voice: X.childText(c, 'voice') || '1', absEnd: abs + dur };
              m.notes.push(note);
              if (tieStart) openTies.set(tkey, note); else openTies.delete(tkey);
            }
          }
          if (!isChord) { lastStart = pos; pos = snap(pos + dur); }
          maxPos = Math.max(maxPos, pos, start + dur);
        }
      }
      if (endingActive && !m.endings) m.endings = endingActive;
      const nominal = mTime ? mTime[0] * 4 / mTime[1] : 4;
      // Measures follow the time signature. Only a pickup (implicit, or a short
      // first measure) or a short final measure keeps its written length;
      // overfull measures (exporter errors) are clipped to the bar.
      const first = measures.length === 0;
      if (maxPos <= EPS) m.len = nominal;
      else if (maxPos < nominal - 0.01 && (m.implicit || first)) m.len = snap(maxPos);
      else m.len = nominal;
      m.shortLast = maxPos > EPS && maxPos < nominal - 0.01 ? snap(maxPos) : null;
      measures.push(m);
      scoreStart += m.len;
    }
    const last = measures[measures.length - 1];
    if (last && last.shortLast && measures.length > 1) { scoreStart -= last.len - last.shortLast; last.len = last.shortLast; }
    measures.forEach(m => { delete m.shortLast; m.notes.forEach(n => { delete n.absEnd; }); });
    const name = meta.name || meta.instrument || '';
    return { id: partEl.attrs.id, name, abbr: meta.abbr || '', staves, clefs, key: key || 0, time: time || [4, 4], tempo, measures, totalBeats: scoreStart, noteCount: measures.reduce((a, m) => a + m.notes.length, 0) };
  }

  /** The most piano-like part: named piano/keyboard, else two staves, else the part with most notes. */
  function choosePart(score) {
    const ps = score.parts.filter(p => p.noteCount > 0);
    if (!ps.length) return score.parts[0] ? score.parts[0].id : null;
    const named = ps.find(p => /pian|pno|klavier|keyboard|keys|cembalo|harpsichord/i.test(p.name + ' ' + p.abbr));
    if (named) return named.id;
    const two = ps.find(p => p.staves >= 2);
    if (two) return two.id;
    return ps.slice().sort((a, b) => b.noteCount - a.noteCount)[0].id;
  }

  /** Play order of measure indices with simple repeats and 1st/2nd endings expanded. */
  function playOrder(measures) {
    const order = [], taken = {};
    let i = 0, start = 0, pass = 1, jumped = false, guard = 0;
    while (i < measures.length && guard++ < measures.length * 20) {
      const m = measures[i];
      if (m.forward && !jumped) { start = i; pass = 1; }
      jumped = false;
      if (m.endings && m.endings.indexOf(pass) < 0) { i++; continue; }
      order.push(i);
      if (m.backward) {
        const t = taken[i] || 1;
        if (t < m.times) { taken[i] = t + 1; pass = t + 1; i = start; jumped = true; continue; }
        start = i + 1; pass = 1;
      } else if (m.endingLast) pass = 1;
      i++;
    }
    return order;
  }

  function toSong(score, partId, opts) {
    opts = opts || {};
    const part = score.parts.find(p => p.id === partId) || score.parts[0];
    if (!part) throw new Error('the score has no parts');
    const order = opts.expandRepeats === false ? part.measures.map((m, i) => i) : playOrder(part.measures);
    const handOf = st => (part.staves >= 2 ? (st >= 2 ? 'left' : 'right') : (part.clefs[1] === 'F' ? 'left' : 'right'));
    const notes = [], segments = [];
    let play = 0;
    for (const mi of order) {
      const m = part.measures[mi];
      segments.push({ measure: mi, number: m.number, play, score: m.start, len: m.len });
      for (const n of m.notes) {
        if (n.midi < 21 || n.midi > 108 || n.dur <= EPS) continue;
        notes.push({ midi: n.midi, startBeat: play + n.offset, durationBeats: n.dur, velocity: 0.72, hand: handOf(n.staff), staff: n.staff, measure: mi + 1, scoreBeat: m.start + n.offset });
      }
      play += m.len;
    }
    notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
    const tempo = score.tempo || part.tempo;
    return {
      title: score.title || 'Imported score', composer: score.composer || 'MusicXML import',
      bpm: Math.max(30, Math.min(220, Math.round(tempo || 100))), timeSignature: part.time.slice(), key: part.key,
      notes, totalBeats: play, segments, partName: part.name || 'Part', partId: part.id,
      source: 'MusicXML', category: 'imported'
    };
  }

  /** Keep only one part (for display); other parts and part groups are removed. */
  function extractPart(text, partId) {
    const doc = X.parse(text), r = X.root(doc);
    const pl = X.child(r, 'part-list');
    if (pl) pl.children = pl.children.filter(c => c.name !== 'part-group' && (c.name !== 'score-part' || c.attrs.id === partId));
    r.children = r.children.filter(c => c.name !== 'part' || c.attrs.id === partId);
    return X.serialize(doc);
  }

  /* ---------------------- Writing MusicXML from a song --------------------- */

  const SHARP_NAMES = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
  const FLAT_NAMES = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];
  const NOTE_VALUES = [[4, 'whole', 0], [3, 'half', 1], [2, 'half', 0], [1.5, 'quarter', 1], [1, 'quarter', 0], [0.75, 'eighth', 1], [0.5, 'eighth', 0], [0.25, '16th', 0]];

  function spell(midi, key) {
    const [step, alter] = (key < 0 ? FLAT_NAMES : SHARP_NAMES)[((midi % 12) + 12) % 12];
    return { step, alter, octave: Math.floor(midi / 12) - 1 };
  }
  function splitValue(len) {
    const out = [];
    let rest = Math.round(len * 4) / 4;
    for (const v of NOTE_VALUES) while (rest >= v[0] - EPS) { out.push(v); rest -= v[0]; }
    return out;
  }
  const esc = s => X.encode(s, true);

  /**
   * Notation for songs without MusicXML. Notes are quantised to sixteenths,
   * right hand on staff 1 and left hand on staff 2, one voice per staff,
   * with notes split at barlines and tied.
   */
  function songToMusicXML(song) {
    const ts = song.timeSignature || [4, 4], L = ts[0] * 4 / ts[1], key = song.key || 0, q = v => Math.round(v * 4) / 4;
    const hands = song.notes.some(n => n.hand === 'left') && song.notes.some(n => n.hand !== 'left') ? ['right', 'left'] : [song.notes.some(n => n.hand === 'left') ? 'left' : 'right'];
    const end = Math.max(L, ...song.notes.map(n => q(n.startBeat) + Math.max(0.25, q(n.durationBeats))));
    const nMeasures = Math.ceil(end / L - EPS);
    const staffEvents = hands.map(hand => {
      const byStart = new Map();
      song.notes.filter(n => (n.hand === 'left') === (hand === 'left')).forEach(n => {
        const s = q(n.startBeat), d = Math.max(0.25, q(n.durationBeats));
        const g = byStart.get(s) || { start: s, dur: 0, midis: [] };
        g.dur = Math.max(g.dur, d); if (g.midis.indexOf(n.midi) < 0) g.midis.push(n.midi);
        byStart.set(s, g);
      });
      const groups = [...byStart.values()].sort((a, b) => a.start - b.start);
      groups.forEach((g, i) => { const next = groups[i + 1]; if (next) g.dur = Math.min(g.dur, next.start - g.start); g.midis.sort((a, b) => a - b); });
      return groups;
    });
    const out = [
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<score-partwise version="3.1">',
      '  <work><work-title>' + esc(song.title || '') + '</work-title></work>',
      '  <identification>' + (song.composer ? '<creator type="composer">' + esc(song.composer) + '</creator>' : '') + '<encoding><software>Piano Companion</software></encoding></identification>',
      '  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>',
      '  <part id="P1">'
    ];
    for (let mi = 0; mi < nMeasures; mi++) {
      const m0 = mi * L, m1 = m0 + L;
      out.push('    <measure number="' + (mi + 1) + '">');
      if (mi === 0) {
        out.push('      <attributes><divisions>4</divisions><key><fifths>' + key + '</fifths></key><time><beats>' + ts[0] + '</beats><beat-type>' + ts[1] + '</beat-type></time>' + (hands.length > 1 ? '<staves>2</staves>' : ''));
        hands.forEach((h, k) => out.push('        <clef number="' + (k + 1) + '"><sign>' + (h === 'left' ? 'F' : 'G') + '</sign><line>' + (h === 'left' ? 4 : 2) + '</line></clef>'));
        out.push('      </attributes>');
        out.push('      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>' + Math.round(song.bpm || 100) + '</per-minute></metronome></direction-type><sound tempo="' + Math.round(song.bpm || 100) + '"/></direction>');
      }
      hands.forEach((h, k) => {
        if (k) out.push('      <backup><duration>' + Math.round(L * 4) + '</duration></backup>');
        const staffTag = hands.length > 1 ? '<staff>' + (k + 1) + '</staff>' : '';
        let t = m0;
        const emit = (len, midis, tieIn, tieOut) => {
          const parts = splitValue(len);
          parts.forEach((v, pi) => {
            const tin = tieIn || pi > 0, tout = tieOut || pi < parts.length - 1;
            const tail = '<duration>' + Math.round(v[0] * 4) + '</duration>' + (midis ? (tin ? '<tie type="stop"/>' : '') + (tout ? '<tie type="start"/>' : '') : '') + '<voice>' + (k + 1) + '</voice><type>' + v[1] + '</type>' + '<dot/>'.repeat(v[2]) + staffTag;
            const notations = midis && (tin || tout) ? '<notations>' + (tin ? '<tied type="stop"/>' : '') + (tout ? '<tied type="start"/>' : '') + '</notations>' : '';
            if (!midis) { out.push('      <note><rest/>' + tail + '</note>'); return; }
            midis.forEach((midi, ni) => {
              const p = spell(midi, key);
              out.push('      <note>' + (ni ? '<chord/>' : '') + '<pitch><step>' + p.step + '</step>' + (p.alter ? '<alter>' + p.alter + '</alter>' : '') + '<octave>' + p.octave + '</octave></pitch>' + tail + notations + '</note>');
            });
          });
        };
        for (const g of staffEvents[k]) {
          const gs = g.start, ge = g.start + g.dur;
          if (ge <= m0 + EPS || gs >= m1 - EPS) continue;
          const s = Math.max(gs, m0), e = Math.min(ge, m1);
          if (s > t + EPS) emit(s - t, null);
          emit(e - s, g.midis, gs < m0 - EPS, ge > m1 + EPS);
          t = e;
        }
        if (t < m1 - EPS) emit(m1 - t, null);
      });
      out.push('    </measure>');
    }
    out.push('  </part>', '</score-partwise>');
    return out.join('\n');
  }

  return { readFile, parse, choosePart, playOrder, toSong, extractPart, songToMusicXML, isZip };
});
