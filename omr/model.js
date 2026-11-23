/*
 * Piano Companion score model
 * Editable score built from OMR pages: pitch resolution (clef, key, accidentals),
 * measure validation, MusicXML export and practice-song conversion.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMRModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const PC = [0, 2, 4, 5, 7, 9, 11];
  const DUR = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };
  const BASES = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'];
  const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];
  const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];
  const KEY_NAMES = { '-7': 'C♭ major', '-6': 'G♭ major', '-5': 'D♭ major', '-4': 'A♭ major', '-3': 'E♭ major', '-2': 'B♭ major', '-1': 'F major', '0': 'C major', '1': 'G major', '2': 'D major', '3': 'A major', '4': 'E major', '5': 'B major', '6': 'F♯ major', '7': 'C♯ major' };
  const TIME_CHOICES = [[2, 4], [3, 4], [4, 4], [2, 2], [3, 8], [6, 8], [9, 8], [12, 8], [5, 4]];

  let uid = 0;
  const id = p => (p || 'e') + (++uid).toString(36) + Math.random().toString(36).slice(2, 6);

  function clefBase(clef) { return clef === 'bass' ? 2 * 7 + 4 : 4 * 7 + 2; }
  function diatonicName(d) { return LETTERS[((d % 7) + 7) % 7] + Math.floor(d / 7); }
  function keyAlter(letterIdx, key) {
    if (key > 0) return SHARP_ORDER.slice(0, key).indexOf(letterIdx) >= 0 ? 1 : 0;
    if (key < 0) return FLAT_ORDER.slice(0, -key).indexOf(letterIdx) >= 0 ? -1 : 0;
    return 0;
  }
  function duration(e) { const b = DUR[e.base] || 1; return e.dots === 2 ? b * 1.75 : e.dots === 1 ? b * 1.5 : b; }
  function measureLength(time) { return time[0] * 4 / time[1]; }

  /** A lone non-zero vote cannot override a clear majority. */
  function voteKey(votes) {
    let total = 0;
    Object.keys(votes).forEach(k => { total += votes[k]; });
    const nz = Object.keys(votes).filter(k => +k !== 0).sort((a, b) => votes[b] - votes[a]);
    if (nz.length && votes[nz[0]] >= 2 && votes[nz[0]] / Math.max(1, total) >= 0.4) return +nz[0];
    const all = Object.keys(votes).sort((a, b) => votes[b] - votes[a]);
    return all.length ? +all[0] : 0;
  }

  function buildScore(pages, meta) {
    meta = meta || {};
    const score = { version: 2, title: meta.title || 'Recognised score', composer: meta.composer || '', tempo: meta.tempo || 90, key: 0, time: [4, 4], part: null, pages: [], measures: [], warnings: [] };
    const keyVotes = {};
    pages.forEach((pg, pi) => {
      const rec = pg.recognition;
      if (!rec) return;
      score.part = score.part || rec.part;
      rec.headers.forEach(row => row.forEach(hh => { keyVotes[hh.key] = (keyVotes[hh.key] || 0) + 1; }));
      (rec.warnings || []).forEach(w => score.warnings.push(Object.assign({ page: pi }, w)));
      score.pages.push({ index: pi, width: pg.width, height: pg.height, interline: pg.interline, skew: pg.skew });
      rec.measures.forEach(m => {
        score.measures.push({
          id: id('m'), page: score.pages.length - 1, system: m.system, x0: m.x0, x1: m.x1, y0: m.y0, y1: m.y1, accepted: false,
          staves: m.staves.map(st => ({
            clef: st.clef, staff: st.staff,
            events: st.events.map(e => ({
              id: id('e'), type: e.type, base: e.base, dots: e.dots || 0, voice: e.voice || 1, x: e.x,
              stemDir: e.stemDir || null, conf: e.conf, verified: false, y: e.y, restBox: e.restBox,
              notes: (e.notes || []).map(n => ({ id: id('n'), diatonic: clefBase(st.clef) + n.step, accidental: null, x: n.x, y: n.y, conf: n.conf }))
            }))
          }))
        });
      });
    });
    score.key = meta.key != null ? meta.key : voteKey(keyVotes);
    score.time = meta.time || inferTime(score);
    validate(score);
    return score;
  }

  function inferTime(score) {
    const votes = {};
    score.measures.forEach((m, i) => {
      if (i === 0 || i === score.measures.length - 1) return;
      m.staves.forEach(st => { const t = voiceTotals(st)[1] || 0; if (t > 0) { const k = Math.round(t * 2) / 2; votes[k] = (votes[k] || 0) + 1; } });
    });
    const best = +Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0] || 4;
    return ({ 1.5: [3, 8], 2: [2, 4], 3: [3, 4], 4: [4, 4], 4.5: [9, 8], 5: [5, 4], 6: [12, 8] })[best] || [4, 4];
  }

  function voiceTotals(st) {
    const t = {};
    st.events.forEach(e => { t[e.voice || 1] = (t[e.voice || 1] || 0) + duration(e); });
    return t;
  }

  /** Validate measures. An accepted measure is 'verified' even if totals differ. */
  function validate(score) {
    const len = measureLength(score.time), eps = 1e-6;
    score.measures.forEach((m, i) => {
      let invalid = false, minConf = 1, verified = true, any = false;
      const details = [];
      m.staves.forEach((st, k) => {
        const totals = voiceTotals(st), voices = Object.keys(totals);
        if (!voices.length) { details.push({ staff: k, voice: 1, total: 0, expected: len, ok: false, empty: true }); invalid = true; }
        voices.forEach(v => {
          const ok = Math.abs(totals[v] - len) < eps;
          details.push({ staff: k, voice: +v, total: totals[v], expected: len, ok });
          if (!ok) invalid = true;
        });
        st.events.forEach(e => { any = true; minConf = Math.min(minConf, e.verified ? 1 : e.conf); if (!e.verified) verified = false; });
      });
      let pickup = false;
      if (invalid && (i === 0 || i === score.measures.length - 1)) {
        const totals = details.filter(d => !d.empty).map(d => d.total);
        if (totals.length && totals.every(t => t < len - eps && Math.abs(t - totals[0]) < eps)) { pickup = true; invalid = false; }
      }
      m.pickup = pickup; m.details = details; m.minConf = any ? minConf : 0; m.mismatch = invalid;
      if (m.accepted) m.status = 'verified';
      else m.status = invalid ? 'invalid' : (verified && any ? 'verified' : (m.minConf < 0.6 ? 'uncertain' : 'ok'));
    });
    return summary(score);
  }

  function summary(score) {
    const s = { measures: score.measures.length, invalid: 0, uncertain: 0, ok: 0, verified: 0, notes: 0 };
    score.measures.forEach(m => { s[m.status]++; m.staves.forEach(st => st.events.forEach(e => { s.notes += e.notes.length; })); });
    return s;
  }

  function resolveMeasure(score, m) {
    m.staves.forEach(st => {
      const carry = {};
      st.events.slice().sort((a, b) => a.x - b.x).forEach(e => e.notes.forEach(n => {
        const letter = ((n.diatonic % 7) + 7) % 7, octave = Math.floor(n.diatonic / 7);
        let alter;
        if (n.accidental != null) { alter = n.accidental; carry[n.diatonic] = alter; }
        else if (carry[n.diatonic] != null) alter = carry[n.diatonic];
        else alter = keyAlter(letter, score.key);
        n.alter = alter;
        n.midi = (octave + 1) * 12 + PC[letter] + alter;
        n.name = LETTERS[letter] + (alter === 1 ? '♯' : alter === -1 ? '♭' : alter === 2 ? '𝄪' : alter === -2 ? '𝄫' : '') + octave;
      }));
    });
  }

  function toSong(score, opts) {
    opts = opts || {};
    const len = measureLength(score.time), notes = [], measureStarts = [];
    let start = 0;
    score.measures.forEach((m, mi) => {
      resolveMeasure(score, m);
      measureStarts.push(start);
      const mLen = m.pickup ? (Math.max.apply(null, m.details.map(d => d.total).concat([0])) || len) : len;
      m.staves.forEach((st, k) => {
        const onset = {};
        st.events.slice().sort((a, b) => a.x - b.x).forEach(e => {
          const v = e.voice || 1, t = onset[v] || 0, d = duration(e);
          if (e.type === 'note') e.notes.forEach(n => {
            if (n.midi < 21 || n.midi > 108) return;
            notes.push({ midi: n.midi, startBeat: start + t, durationBeats: d * 0.95, velocity: 0.72, hand: st.clef === 'bass' || k === 1 ? 'left' : 'right', staff: k + 1, measure: mi + 1 });
          });
          onset[v] = t + d;
        });
      });
      start += mLen;
    });
    notes.sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);
    return {
      id: opts.id || 'omr-' + Date.now().toString(36), title: score.title, composer: score.composer || 'Recognised score · reviewed',
      bpm: score.tempo || 90, source: 'OMR', category: 'imported', timeSignature: score.time.slice(), key: score.key, notes,
      totalBeats: start, measureStarts, musicxml: toMusicXML(score),
      omr: { measures: score.measures.length, summary: summary(score), reviewedAt: new Date().toISOString() }
    };
  }

  const ACC_XML = { '1': 'sharp', '-1': 'flat', '0': 'natural', '2': 'double-sharp', '-2': 'flat-flat' };
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]); }

  /** MusicXML 3.1 partwise; <note> children follow the schema order. */
  function toMusicXML(score) {
    const DIV = 8, staves = score.measures.length ? score.measures[0].staves.length : 1;
    const name = score.part && score.part.name ? score.part.name : 'Piano';
    const firstPickup = score.measures[0] && score.measures[0].pickup;
    const out = [
      '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
      '<score-partwise version="3.1">',
      '  <work><work-title>' + esc(score.title) + '</work-title></work>',
      '  <identification>' + (score.composer ? '<creator type="composer">' + esc(score.composer) + '</creator>' : '') + '<encoding><software>Piano Companion OMR</software><encoding-date>' + new Date().toISOString().slice(0, 10) + '</encoding-date></encoding></identification>',
      '  <part-list><score-part id="P1"><part-name>' + esc(name) + '</part-name></score-part></part-list>',
      '  <part id="P1">'
    ];
    score.measures.forEach((m, mi) => {
      resolveMeasure(score, m);
      const num = firstPickup ? mi : mi + 1;
      out.push('    <measure number="' + num + '"' + (m.pickup ? ' implicit="yes"' : '') + '>');
      if (mi === 0) {
        out.push('      <attributes><divisions>' + DIV + '</divisions><key><fifths>' + score.key + '</fifths></key><time><beats>' + score.time[0] + '</beats><beat-type>' + score.time[1] + '</beat-type></time>' + (staves > 1 ? '<staves>' + staves + '</staves>' : ''));
        m.staves.forEach((st, k) => out.push('        <clef number="' + (k + 1) + '"><sign>' + (st.clef === 'bass' ? 'F' : 'G') + '</sign><line>' + (st.clef === 'bass' ? 4 : 2) + '</line></clef>'));
        out.push('      </attributes>');
        out.push('      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>' + Math.round(score.tempo) + '</per-minute></metronome></direction-type><sound tempo="' + Math.round(score.tempo) + '"/></direction>');
      }
      let written = 0, voiceNo = 0;
      m.staves.forEach((st, k) => {
        const byVoice = {};
        st.events.forEach(e => { (byVoice[e.voice || 1] = byVoice[e.voice || 1] || []).push(e); });
        Object.keys(byVoice).sort().forEach(v => {
          if (written > 0) out.push('      <backup><duration>' + written + '</duration></backup>');
          written = 0; voiceNo++;
          byVoice[v].sort((a, b) => a.x - b.x).forEach(e => {
            const dur = Math.max(1, Math.round(duration(e) * DIV));
            written += dur;
            const after = (acc) => '<duration>' + dur + '</duration><voice>' + voiceNo + '</voice><type>' + e.base + '</type>' + '<dot/>'.repeat(e.dots || 0) + (acc || '') + (staves > 1 ? '<staff>' + (k + 1) + '</staff>' : '');
            if (e.type === 'rest' || !e.notes.length) { out.push('      <note><rest/>' + after('') + '</note>'); return; }
            e.notes.slice().sort((a, b) => a.diatonic - b.diatonic).forEach((n, ni) => {
              const letter = ((n.diatonic % 7) + 7) % 7, octave = Math.floor(n.diatonic / 7), alter = n.alter || 0;
              const acc = n.accidental != null ? '<accidental>' + ACC_XML[n.accidental] + '</accidental>' : '';
              out.push('      <note>' + (ni ? '<chord/>' : '') + '<pitch><step>' + LETTERS[letter] + '</step>' + (alter ? '<alter>' + alter + '</alter>' : '') + '<octave>' + octave + '</octave></pitch>' + after(acc) + '</note>');
            });
          });
        });
      });
      out.push('    </measure>');
    });
    out.push('  </part>', '</score-partwise>');
    return out.join('\n');
  }

  function findEvent(score, eventId) {
    for (const m of score.measures) for (let k = 0; k < m.staves.length; k++) {
      const st = m.staves[k], i = st.events.findIndex(e => e.id === eventId);
      if (i >= 0) return { measure: m, staffIndex: k, staff: st, event: st.events[i], index: i };
    }
    return null;
  }

  function fillWithRests(score, m, staffIndex) {
    if (m.pickup) return 0;
    const len = measureLength(score.time), st = m.staves[staffIndex], totals = voiceTotals(st);
    if (!Object.keys(totals).length) totals[1] = 0;
    let added = 0;
    Object.keys(totals).forEach(v => {
      let missing = len - totals[v];
      let x = Math.max.apply(null, st.events.filter(e => (e.voice || 1) === +v).map(e => e.x).concat([m.x0])) + 8;
      for (const b of BASES) while (missing >= DUR[b] - 1e-9) {
        st.events.push({ id: id('e'), type: 'rest', base: b, dots: 0, voice: +v, x: Math.min(x, m.x1 - 4), notes: [], conf: 1, verified: true, added: true });
        missing -= DUR[b]; x += 6; added++;
      }
    });
    return added;
  }

  function newNote(diatonic, x, y) { return { id: id('n'), diatonic, accidental: null, x, y, conf: 1 }; }
  function newEvent(type, base, x, voice) { return { id: id('e'), type, base, dots: 0, voice: voice || 1, x, notes: [], conf: 1, verified: true, added: true }; }

  return {
    LETTERS, DUR, BASES, KEY_NAMES, TIME_CHOICES,
    clefBase, diatonicName, keyAlter, duration, measureLength, voteKey,
    buildScore, inferTime, validate, summary, resolveMeasure, toSong, toMusicXML,
    findEvent, fillWithRests, newNote, newEvent, voiceTotals
  };
});
