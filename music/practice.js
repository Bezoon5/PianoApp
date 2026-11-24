/*
 * Piano Companion practice logic (v6). Pure functions, no DOM: used by app.js
 * and tested in Node.
 *   Hands separately : inHand, waitEvents, accompaniment
 *   Loops            : resolveLoop, speedTrainer
 *   Metronome        : clicks, countIn
 *   Progress         : addSession, summarise, streak, trickiest, relativeDay
 *   Backup           : makeBackup, readBackup, mergeHistory, mergeSongs, unbackedUp
 *   Play along       : timingJudge (on time / early / late / missed / wrong)
 *   Recording        : takeToMidi (a recorded take as a standard MIDI file)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCPractice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const EPS = 1e-6, CHORD_TOL = 0.02, DAY = 86400000;

  /* ----------------------------- Hands separately ---------------------------- */
  /** Notes without a hand count as right hand. */
  function inHand(n, hand) {
    if (!hand || hand === 'both') return true;
    return hand === 'left' ? n.hand === 'left' : n.hand !== 'left';
  }

  /** Chords the player must play, for the chosen hand(s), within [start, end). */
  function waitEvents(notes, opts) {
    opts = opts || {};
    const hand = opts.hand || 'both', start = opts.start != null ? opts.start : 0, end = opts.end != null ? opts.end : Infinity;
    const out = [];
    notes.filter(n => inHand(n, hand) && n.startBeat >= start - EPS && n.startBeat < end - EPS)
      .slice().sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi)
      .forEach(n => {
        const last = out[out.length - 1];
        if (last && Math.abs(last.beat - n.startBeat) < CHORD_TOL) { if (last.midis.indexOf(n.midi) < 0) last.midis.push(n.midi); last.notes.push(n); }
        else out.push({ beat: n.startBeat, midis: [n.midi], notes: [n] });
      });
    return out;
  }

  /** The other hand's notes, which the app plays itself, starting in [t0, t1). */
  function accompaniment(notes, hand, t0, t1) {
    if (!hand || hand === 'both') return [];
    const other = hand === 'left' ? 'right' : 'left';
    return notes.filter(n => inHand(n, other) && n.startBeat >= t0 - EPS && n.startBeat < t1 - EPS);
  }

  /* ---------------------------------- Loops ---------------------------------- */
  /**
   * Loop range from printed bar numbers. `segments` are playback segments
   * ({ number, play, len }); with repeats a bar number can occur more than
   * once, so the first occurrence of `from` and the next `to` after it are used.
   */
  function resolveLoop(segments, from, to) {
    from = String(from).trim(); to = String(to).trim();
    if (!from || !to) return { error: 'Enter the first and last bar of the loop.' };
    const a = segments.findIndex(s => String(s.number) === from);
    if (a < 0) return { error: 'Bar ' + from + ' is not in this piece.' };
    // Search forward within the same pass through the music: stop where a
    // repeat jumps back, so "8 to 5" is an error rather than a loop that
    // wraps round the repeat.
    let b = -1;
    for (let i = a; i < segments.length; i++) {
      if (i > a && segments[i].measure != null && segments[i].measure < segments[i - 1].measure) break;
      if (String(segments[i].number) === to) { b = i; break; }
    }
    if (b < 0) return { error: 'Bar ' + to + ' must come at or after bar ' + from + '.' };
    return { from: a, to: b, startBeat: segments[a].play, endBeat: segments[b].play + segments[b].len, bars: b - a + 1, label: from === to ? 'bar ' + from : 'bars ' + from + '–' + to };
  }

  /** Speed trainer: start at startPct% of the target and add 5% per completed pass. */
  function speedTrainer(target, startPct, pass) {
    const pct = Math.min(1, (startPct || 70) / 100 + 0.05 * Math.max(0, pass || 0));
    return Math.max(20, Math.min(target, Math.round(target * pct)));
  }

  /* -------------------------------- Metronome -------------------------------- */
  /** Beats (in quarter notes) between clicks: compound metres click dotted quarters. */
  function clickStep(timeSig) {
    const ts = timeSig || [4, 4], unit = 4 / ts[1];
    return ts[1] === 8 && ts[0] % 3 === 0 && ts[0] > 3 ? unit * 3 : unit;
  }
  /**
   * Metronome clicks for playback segments overlapping [start, end). Clicks are
   * aligned to the end of short (pickup) bars; only full bars get an accented
   * downbeat.
   */
  function clicks(segments, timeSig, start, end) {
    const ts = timeSig || [4, 4], step = clickStep(ts), full = ts[0] * 4 / ts[1], out = [];
    start = start || 0; end = end == null ? Infinity : end;
    for (const s of segments) {
      if (s.play + s.len <= start + EPS || s.play >= end - EPS) continue;
      const first = s.len - Math.floor(s.len / step + EPS) * step;
      for (let t = first; t < s.len - EPS; t += step) {
        const beat = s.play + t;
        if (beat < start - EPS || beat >= end - EPS) continue;
        out.push({ beat, accent: t < EPS && s.len >= full - EPS });
      }
    }
    return out;
  }
  /** Count-in clicks for one bar: offsets in beats from the start of the count-in. */
  function countIn(timeSig) {
    const ts = timeSig || [4, 4], step = clickStep(ts), full = ts[0] * 4 / ts[1], out = [];
    for (let t = 0; t < full - EPS; t += step) out.push({ beat: t, accent: t < EPS });
    return { clicks: out, beats: full };
  }

  /* --------------------------------- Progress -------------------------------- */
  function addSession(history, songId, session, max) {
    max = max || 50;
    const list = (history[songId] = (history[songId] || []).concat([session]));
    if (list.length > max) list.splice(0, list.length - max);
    return history;
  }
  function summarise(sessions) {
    sessions = sessions || [];
    if (!sessions.length) return { count: 0, best: null, last: null, lastAccuracy: null, seconds: 0 };
    const scored = sessions.filter(s => s.accuracy != null);
    const last = sessions[sessions.length - 1];
    return {
      count: sessions.length,
      best: scored.length ? Math.max.apply(null, scored.map(s => s.accuracy)) : null,
      last: last.date, lastAccuracy: last.accuracy,
      seconds: sessions.reduce((a, s) => a + (s.seconds || 0), 0)
    };
  }
  function dayKey(ms) { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  /** Consecutive days with practice, ending today (or yesterday, if not yet today). */
  function streak(dates, now) {
    now = now || Date.now();
    const days = new Set(dates.map(dayKey));
    let d = now;
    if (!days.has(dayKey(d))) d -= DAY;
    let n = 0;
    while (days.has(dayKey(d))) { n++; d -= DAY; }
    return n;
  }
  /** Bars with the most wrong notes: [{ bar, wrong, hits }], worst first, max 3. */
  function trickiest(barStats, max) {
    return Object.keys(barStats || {}).map(k => ({ bar: k, wrong: barStats[k].wrong || 0, hits: barStats[k].hits || 0 }))
      .filter(b => b.wrong > 0).sort((a, b) => b.wrong - a.wrong || a.hits - b.hits).slice(0, max || 3);
  }
  function relativeDay(ms, now) {
    now = now || Date.now();
    const diff = Math.round((new Date(new Date(now).toDateString()) - new Date(new Date(ms).toDateString())) / DAY);
    return diff <= 0 ? 'today' : diff === 1 ? 'yesterday' : diff + ' days ago';
  }

  /* ---------------------------------- Backup --------------------------------- */
  const FORMAT = 'piano-companion-backup';
  function makeBackup(songs, history, now) {
    return { format: FORMAT, version: 1, app: 'Piano Companion 6', exported: new Date(now || Date.now()).toISOString(), songs: songs || [], history: history || {} };
  }
  function readBackup(obj) {
    if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch (e) { throw new Error('the file is not valid JSON'); } }
    if (!obj || obj.format !== FORMAT || !Array.isArray(obj.songs)) throw new Error('this is not a Piano Companion backup file');
    const songs = obj.songs.filter(s => s && typeof s.id === 'string' && Array.isArray(s.notes) && s.notes.length);
    return { songs, history: obj.history && typeof obj.history === 'object' ? obj.history : {}, skipped: obj.songs.length - songs.length };
  }
  /** Union of two histories; sessions are matched by id, sorted by date. */
  function mergeHistory(a, b, max) {
    max = max || 50;
    const out = {};
    for (const src of [a || {}, b || {}]) Object.keys(src).forEach(id => {
      const seen = new Set((out[id] || []).map(s => s.id));
      out[id] = (out[id] || []).concat((src[id] || []).filter(s => s && !seen.has(s.id)));
    });
    Object.keys(out).forEach(id => { out[id].sort((x, y) => x.date - y.date); if (out[id].length > max) out[id] = out[id].slice(-max); });
    return out;
  }

  /**
   * Restoring a backup on a device that already has pieces: new pieces are added,
   * identical ones skipped, and when both copies changed the newer one wins
   * (by updatedAt; a copy with a date beats one without).
   */
  function mergeSongs(local, incoming) {
    const have = new Map((local || []).map(s => [s.id, s]));
    const out = { write: [], added: 0, updated: 0, kept: 0, same: 0 };
    (incoming || []).forEach(s => {
      const mine = have.get(s.id);
      if (!mine) { out.write.push(s); out.added++; return; }
      if (JSON.stringify(mine) === JSON.stringify(s)) { out.same++; return; }
      const a = mine.updatedAt || 0, b = s.updatedAt || 0;
      if (b > a || (!a && !b)) { out.write.push(s); out.updated++; } else out.kept++;
    });
    return out;
  }
  /** Pieces changed since the last backup (all of them if there never was one). */
  function unbackedUp(songs, lastBackup) {
    return (songs || []).filter(s => !s.builtin && (!lastBackup || (s.updatedAt || 0) > lastBackup));
  }

  /* -------------------------------- Play along -------------------------------- */
  const TOLERANCE = { strict: 0.05, normal: 0.09, relaxed: 0.14 };   // seconds counted as "on time"
  /**
   * Judges notes played along with the music. expected: [{ beat, midi, ... }];
   * opts: { spb (seconds per beat), tolerance: 'strict'|'normal'|'relaxed' or seconds }.
   * press(midi, beat) -> { result: 'on'|'early'|'late'|'wrong', ms, note }
   * sweep(beat)       -> notes now too late to play, marked missed
   */
  function timingJudge(expected, opts) {
    opts = opts || {};
    const spb = opts.spb || 0.6;
    const tol = typeof opts.tolerance === 'number' ? opts.tolerance : TOLERANCE[opts.tolerance || 'normal'];
    const windowS = Math.max(0.2, Math.min(0.4, spb * 0.5), tol * 2);   // how far off still counts as that note
    const notes = expected.map((n, i) => Object.assign({}, n, { i, result: null, ms: null }));
    const extra = [];
    function press(midi, beat) {
      let best = null, bd = Infinity;
      for (const n of notes) {
        if (n.result || n.midi !== midi) continue;
        const d = Math.abs(beat - n.beat) * spb;
        if (d <= windowS && d < bd) { bd = d; best = n; }
      }
      if (!best) { const w = { result: 'wrong', midi, beat, ms: null }; extra.push(w); return w; }
      const ms = Math.round((beat - best.beat) * spb * 1000);
      best.ms = ms;
      best.result = Math.abs(ms) <= tol * 1000 ? 'on' : ms < 0 ? 'early' : 'late';
      return { result: best.result, ms, note: best };
    }
    function sweep(beat) {
      const out = [];
      for (const n of notes) if (!n.result && (beat - n.beat) * spb > windowS) { n.result = 'missed'; out.push(n); }
      return out;
    }
    function summary() {
      const c = { on: 0, early: 0, late: 0, missed: 0, wrong: extra.length };
      let sum = 0, k = 0;
      notes.forEach(n => { if (n.result && c[n.result] != null) c[n.result]++; if (n.ms != null) { sum += n.ms; k++; } });
      const played = c.on + c.early + c.late;
      return Object.assign(c, {
        total: notes.length, played,
        meanMs: k ? Math.round(sum / k) : null,                                   // < 0: rushing, > 0: dragging
        timing: played ? Math.round(c.on / played * 100) : null,                 // on time, of the notes played
        accuracy: notes.length + c.wrong ? Math.round(played / (notes.length + c.wrong) * 100) : null
      });
    }
    return { press, sweep, summary, notes, windowMs: Math.round(windowS * 1000), toleranceMs: Math.round(tol * 1000) };
  }

  /* -------------------------------- Recording --------------------------------- */
  /**
   * A take ([{ t: ms, midi, vel, on: bool }]) as a format-0 standard MIDI file
   * (Uint8Array) at 120 BPM, 480 ticks per beat, so 1 ms = 0.96 ticks.
   */
  function takeToMidi(events, name) {
    const bytes = [], vlq = v => { const st = [v & 0x7f]; while ((v >>= 7)) st.unshift((v & 0x7f) | 0x80); bytes.push(...st); };
    const meta = (type, data) => { bytes.push(0, 0xff, type); vlq(data.length); bytes.push(...data); };
    meta(0x51, [0x07, 0xa1, 0x20]);                                                 // 500000 µs per beat = 120 BPM
    if (name) meta(0x03, Array.from(unescape(encodeURIComponent(String(name).slice(0, 60)))).map(ch => ch.charCodeAt(0)));
    let last = 0;
    events.slice().sort((a, b) => a.t - b.t || (a.on ? 1 : -1)).forEach(e => {
      const tick = Math.max(last, Math.round(e.t * 0.96));
      vlq(tick - last); last = tick;
      bytes.push(e.on ? 0x90 : 0x80, Math.max(0, Math.min(127, e.midi)), e.on ? Math.max(1, Math.min(127, Math.round((e.vel || 0.7) * 127))) : 64);
    });
    bytes.push(0, 0xff, 0x2f, 0);
    const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0];
    const len = bytes.length, track = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
    return new Uint8Array(head.concat(track, bytes));
  }

  return { inHand, waitEvents, accompaniment, resolveLoop, speedTrainer, clickStep, clicks, countIn, addSession, summarise, streak, trickiest, relativeDay, dayKey, makeBackup, readBackup, mergeHistory, mergeSongs, unbackedUp, timingJudge, takeToMidi, TOLERANCE };
});
