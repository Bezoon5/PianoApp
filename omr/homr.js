/*
 * Piano Companion: AI recognition through a homr server (see server/README.md).
 *
 *   normaliseUrl(text)                   -> 'https://host' (no trailing slash) or ''
 *   health(url, key, opts)               -> server status JSON (throws friendly errors)
 *   recognisePage(blob, opts)            -> { xml, seconds } for one page image
 *   parse(xmlText)                       -> parts, measures and events read from homr's MusicXML
 *   choosePart(parsed, spec)             -> the part to review (piano by default)
 *   toScore(pages, meta)                 -> editable review score (same shape as OMRModel.buildScore)
 *
 * homr returns notes and rhythms but no positions on the photo, so the review
 * score gets a clean synthetic layout. Systems follow homr's line breaks when
 * it reports them, so the recognised view lines up with the photo row by row.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../music/xml.js'), require('./model.js'));
  else root.OMRHomr = factory(root.PCXml, root.OMRModel);
})(typeof self !== 'undefined' ? self : this, function (X, M) {
  'use strict';

  const EPS = 1e-6;
  const LETTER = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
  const TYPE_MAP = { maxima: 'whole', long: 'whole', breve: 'whole', whole: 'whole', half: 'half', quarter: 'quarter', eighth: 'eighth', '16th': '16th', '32nd': '32nd', '64th': '32nd', '128th': '32nd' };
  const PIECES = [[4, 'whole', 0], [3, 'half', 1], [2, 'half', 0], [1.5, 'quarter', 1], [1, 'quarter', 0], [0.75, 'eighth', 1], [0.5, 'eighth', 0], [0.25, '16th', 0], [0.125, '32nd', 0]];
  const num = (s, d) => { const v = parseFloat(s); return isFinite(v) ? v : d; };
  let uid = 0;
  const id = p => p + 'h' + (++uid).toString(36) + Math.random().toString(36).slice(2, 6);

  /* ------------------------------- Server client ------------------------------- */

  function normaliseUrl(text) {
    let u = String(text || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = (/^(localhost|127\.0\.0\.1)(:|$)/i.test(u) ? 'http://' : 'https://') + u;
    try { const p = new URL(u); return (p.origin + p.pathname).replace(/\/+$/, ''); } catch (e) { return ''; }
  }

  function friendly(err, url) {
    if (err && err.name === 'AbortError') return new Error(err.timedOut ? 'the recognition server did not answer in time' : 'recognition was cancelled');
    if (err instanceof TypeError) return new Error('could not reach the recognition server at ' + url + '; check the address, your connection, and that the server allows this website');
    return err;
  }

  async function call(url, path, init, timeoutMs, signal) {
    const ctl = new AbortController(), onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    try {
      const res = await fetch(url + path, Object.assign({}, init, { signal: ctl.signal }));
      let body = null;
      if (!res.ok) {
        try { body = await res.json(); } catch (e) { /* not JSON */ }
        const msg = body && body.error ? body.error : 'server error ' + res.status;
        const e = new Error(msg); e.status = res.status; throw e;
      }
      return res;
    } catch (err) {
      if (err && err.name === 'AbortError') err.timedOut = timedOut;
      throw friendly(err, url);
    } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); }
  }

  /** Server status. A sleeping free server can take a minute or two to wake. */
  async function health(url, key, opts) {
    opts = opts || {};
    url = normaliseUrl(url);
    if (!url) throw new Error('no recognition server address is set (Settings → Photo recognition)');
    const res = await call(url, '/health', { headers: key ? { 'X-API-Key': key } : {} }, opts.timeoutMs || 150000, opts.signal);
    const j = await res.json();
    if (!j || j.engine !== 'homr') throw new Error('that address answered, but it is not a Piano Companion recognition server');
    return j;
  }

  /** Send one page image; resolves with homr's MusicXML. */
  async function recognisePage(blob, opts) {
    opts = opts || {};
    const url = normaliseUrl(opts.url);
    if (!url) throw new Error('no recognition server address is set (Settings → Photo recognition)');
    const fd = new FormData();
    fd.append('image', blob, 'page.' + (/png/.test(blob.type) ? 'png' : 'jpg'));
    if (opts.tempo) fd.append('tempo', String(Math.round(opts.tempo)));
    const t0 = Date.now();
    const res = await call(url, '/recognise', { method: 'POST', body: fd, headers: opts.key ? { 'X-API-Key': opts.key } : {} }, opts.timeoutMs || 420000, opts.signal);
    const xml = await res.text();
    if (!/<score-partwise/.test(xml)) throw new Error('the server replied, but not with MusicXML');
    return { xml, seconds: num(res.headers.get('X-Recognition-Seconds'), (Date.now() - t0) / 1000) };
  }

  /* --------------------------------- Parsing ---------------------------------- */

  /** Read homr's MusicXML into parts -> measures -> staves -> voices -> events (times in beats). */
  function parse(text) {
    const r = X.root(X.parse(text));
    if (!r || r.name !== 'score-partwise') throw new Error('not a partwise MusicXML score');
    const names = {};
    X.children(X.child(r, 'part-list'), 'score-part').forEach(sp => { names[sp.attrs.id] = X.childText(sp, 'part-name'); });
    const title = X.text(X.find(r, 'work/work-title')) || X.childText(r, 'movement-title');
    let tempo = null;
    const parts = X.children(r, 'part').map(p => {
      let divisions = 1, staves = 1, key = null, time = null;
      const clefs = {}, measures = [], notes = { count: 0 }, flags = { grace: 0, keyChange: 0, timeChange: 0, cue: 0 };
      X.children(p, 'measure').forEach(mEl => {
        const m = { number: mEl.attrs.number, newSystem: false, clefs: null, time: time, events: [] };
        let pos = 0, lastStart = 0, lastEvent = null;
        for (const c of X.children(mEl)) {
          if (c.name === 'print' && (c.attrs['new-system'] === 'yes' || c.attrs['new-page'] === 'yes')) m.newSystem = true;
          else if (c.name === 'attributes') {
            const d = X.childText(c, 'divisions'); if (d) divisions = num(d, divisions) || 1;
            const s = X.childText(c, 'staves'); if (s) staves = Math.max(staves, num(s, 1));
            const k = X.child(c, 'key');
            if (k && X.childText(k, 'fifths') !== '') { const f = Math.round(num(X.childText(k, 'fifths'), 0)); if (key == null) key = f; else if (f !== key) flags.keyChange++; }
            const t = X.child(c, 'time');
            if (t && X.childText(t, 'beats')) {
              const ts = [X.childText(t, 'beats').split('+').reduce((a, b) => a + num(b, 0), 0), num(X.childText(t, 'beat-type'), 4)];
              if (!time) time = ts; else if (ts.join('/') !== time.join('/')) flags.timeChange++;
              m.time = ts;
            }
            X.children(c, 'clef').forEach(cl => { clefs[+(cl.attrs.number || 1)] = X.childText(cl, 'sign') === 'F' ? 'bass' : 'treble'; });
          } else if (c.name === 'direction' || c.name === 'sound') {
            const snd = c.name === 'sound' ? c : X.child(c, 'sound');
            if (tempo == null && snd && snd.attrs.tempo) tempo = num(snd.attrs.tempo, null);
            const met = c.name === 'direction' ? X.findAll(c, 'metronome')[0] : null;
            if (tempo == null && met && X.childText(met, 'per-minute')) tempo = num(X.childText(met, 'per-minute'), null);
          } else if (c.name === 'backup') pos = Math.max(0, pos - num(X.childText(c, 'duration'), 0) / divisions);
          else if (c.name === 'forward') pos += num(X.childText(c, 'duration'), 0) / divisions;
          else if (c.name === 'note') {
            if (X.child(c, 'grace')) { flags.grace++; continue; }
            if (X.child(c, 'cue')) { flags.cue++; continue; }
            const chord = !!X.child(c, 'chord'), restEl = X.child(c, 'rest');
            const dur = num(X.childText(c, 'duration'), 0) / divisions;
            const staff = +(X.childText(c, 'staff') || 1), voice = +(X.childText(c, 'voice') || 1);
            const pitchEl = X.child(c, 'pitch');
            let pitch = null;
            if (pitchEl && !restEl) {
              const ties = X.children(c, 'tie').map(t => t.attrs.type).concat(X.findAll(c, 'tied').map(t => t.attrs.type));
              const step = X.childText(pitchEl, 'step').toUpperCase();
              pitch = {
                diatonic: num(X.childText(pitchEl, 'octave'), 4) * 7 + (LETTER[step] != null ? LETTER[step] : 0),
                alter: Math.round(num(X.childText(pitchEl, 'alter'), 0)),
                shown: X.childText(c, 'accidental') !== '', tieStart: ties.indexOf('start') >= 0, tieStop: ties.indexOf('stop') >= 0
              };
              notes.count++;
            }
            if (chord && lastEvent && lastEvent.staff === staff && pitch) { lastEvent.pitches.push(pitch); continue; }
            const start = chord ? lastStart : pos;
            const tm = X.child(c, 'time-modification');
            const actual = tm ? num(X.childText(tm, 'actual-notes'), 1) : 1, normal = tm ? num(X.childText(tm, 'normal-notes'), 1) : 1;
            const typeText = X.childText(c, 'type');
            const ev = {
              staff, voice, start, dur, rest: !pitch, measureRest: !!(restEl && restEl.attrs.measure === 'yes'),
              type: typeText, base: TYPE_MAP[typeText] || null, odd: !!typeText && !TYPE_MAP[typeText] || /breve|long|maxima|64th|128th/.test(typeText),
              dots: X.children(c, 'dot').length, tuplet: actual !== normal && actual > 0 && normal > 0 ? { actual, normal } : null,
              pitches: pitch ? [pitch] : []
            };
            m.events.push(ev); lastEvent = ev;
            if (!chord) { lastStart = pos; pos += dur; }
          }
        }
        m.clefs = Object.assign({}, clefs);
        measures.push(m);
      });
      return { id: p.attrs.id, name: names[p.attrs.id] || '', staves, key: key || 0, time, measures, noteCount: notes.count, flags };
    });
    return { title: title || '', tempo, parts };
  }

  /** Piano (two staves) unless the layout step chose a single-staff part. */
  function choosePart(parsed, spec) {
    const ps = parsed.parts.filter(p => p.noteCount > 0);
    if (!ps.length) return parsed.parts[0] || null;
    if (spec && spec.kind === 'single') {
      const singles = ps.filter(p => p.staves === 1);
      if (singles.length) return singles[Math.min(spec.ordinal || 0, singles.length - 1)];
    }
    return ps.find(p => p.staves >= 2) || ps.find(p => /pian|pno|key/i.test(p.name)) || ps.slice().sort((a, b) => b.noteCount - a.noteCount)[0];
  }

  /* ------------------------- Conversion to review score ------------------------ */

  /** Split a length in beats into rest values (largest first). */
  function pieces(len) {
    const out = [];
    let rest = Math.round(len * 96) / 96;
    for (const p of PIECES) while (rest >= p[0] - EPS) { out.push(p); rest -= p[0]; }
    return out;
  }

  /** Closest single written value (with dots) for an event without a usable <type>. */
  function bestValue(dur) {
    let best = PIECES[4], bd = Infinity;
    for (const p of PIECES) { const d = Math.abs(p[0] - dur); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  function newEvent(type, base, dots, start, extra) {
    return Object.assign({ id: id('e'), type, base, dots, voice: 1, x: 0, stemDir: null, conf: 0.9, verified: false, notes: [], start, tuplet: null }, extra || {});
  }

  /** One homr measure -> review staves (voices 1-2, gaps filled with rests). */
  function convertMeasure(pm, nStaves, mLen, warn) {
    const byStaff = [];
    for (let s = 1; s <= nStaves; s++) byStaff.push(pm.events.filter(e => e.staff === s));
    let target = 0;
    pm.events.forEach(e => { target = Math.max(target, e.start + e.dur); });
    if (target <= EPS) target = mLen;
    return byStaff.map((evs, k) => {
      const voices = [...new Set(evs.map(e => e.voice))].sort((a, b) => a - b);
      if (voices.length > 2) warn('more than two voices on one staff; extra voices were merged');
      const out = [];
      const runs = voices.length ? voices.map((v, vi) => ({ voice: vi === 0 ? 1 : 2, evs: evs.filter(e => e.voice === v).sort((a, b) => a.start - b.start) })) : [{ voice: 1, evs: [] }];
      const merged = {};
      runs.forEach(r => { (merged[r.voice] = merged[r.voice] || []).push(...r.evs); });
      const two = Object.keys(merged).length > 1;
      Object.keys(merged).forEach(vk => {
        const v = +vk, list = merged[v].sort((a, b) => a.start - b.start);
        let cursor = 0;
        const gap = (from, to) => { let t = from; pieces(to - from).forEach(p => { out.push(newEvent('rest', p[1], p[2], t, { voice: v, gap: true })); t += p[0]; }); };
        for (const e of list) {
          if (e.start > cursor + 0.01) gap(cursor, e.start);
          const overlap = e.start < cursor - 0.01;
          let made = [];
          if (e.measureRest || (e.rest && !e.base)) {
            let t = e.start;
            pieces(e.measureRest ? (e.dur > EPS ? e.dur : mLen) : e.dur).forEach(p => { made.push(newEvent('rest', p[1], p[2], t, { voice: v })); t += p[0]; });
          } else {
            const val = e.base ? [null, e.base, Math.min(2, e.dots)] : bestValue(e.dur);
            const ev = newEvent(e.rest ? 'rest' : 'note', val[1], val[2], e.start, { voice: v, tuplet: e.tuplet });
            if (!e.rest) ev.notes = e.pitches.map(p => ({ id: id('n'), diatonic: p.diatonic, alter: p.alter, shown: p.shown, accidental: null, x: 0, y: null, conf: 0.9, tieStart: p.tieStart || undefined, tieStop: p.tieStop || undefined }));
            if (two && !e.rest) ev.stemDir = v === 1 ? 'up' : 'down';
            const written = M.duration(ev);
            if (e.odd || !e.base || (e.dur > EPS && Math.abs(written - e.dur) > Math.max(0.02, e.dur * 0.02))) ev.conf = 0.45;
            made = [ev];
          }
          if (overlap) made.forEach(x => { x.conf = Math.min(x.conf, 0.4); });
          out.push(...made);
          cursor = Math.max(cursor, e.start + (e.dur > EPS ? e.dur : made.reduce((a, x) => a + M.duration(x), 0)));
        }
        // Secondary voices often stop early (homr skips with <forward>); pad them so
        // the measure still adds up. The main voice is left alone so gaps stay visible.
        if (v === 2 && cursor < target - 0.01) gap(cursor, target);
        if (v === 1 && !list.length) gap(0, target);
      });
      return out;
    });
  }

  /** Same order and rules as OMRModel.resolveMeasure: only write accidentals that change the pitch or were printed. */
  function assignAccidentals(events, key) {
    const carry = {};
    events.slice().sort((a, b) => a.x - b.x || a.start - b.start).forEach(e => e.notes.forEach(n => {
      const letter = ((n.diatonic % 7) + 7) % 7;
      const expected = carry[n.diatonic] != null ? carry[n.diatonic] : M.keyAlter(letter, key);
      if (n.shown || n.alter !== expected) { n.accidental = n.alter; carry[n.diatonic] = n.alter; }
      delete n.alter; delete n.shown;
    }));
  }

  const IL = 10, PAGE_W = 1000, MARGIN = 40;

  /**
   * pages: [{ xml, pageIndex }] in order. meta: { title, composer, tempo, spec }.
   * Returns an editable score for the review screen, plus score.pageMap (photo index per score page).
   */
  function toScore(pages, meta) {
    meta = meta || {};
    const score = { version: 2, engine: 'homr', title: meta.title || '', composer: meta.composer || '', tempo: meta.tempo || 90, key: 0, time: null, part: null, pages: [], measures: [], warnings: [], pageMap: [] };
    let keySet = false, foundTempo = null, foundTitle = '';
    pages.forEach((pg, pi) => {
      const warnSet = new Set(), warn = msg => warnSet.add(msg), photo = pg.pageIndex != null ? pg.pageIndex : pi;
      let parsed;
      try { parsed = parse(pg.xml); } catch (e) { score.warnings.push({ page: score.pages.length, photoPage: photo, code: 'BAD_XML', message: 'could not read the server result (' + e.message + ')' }); return; }
      if (!foundTitle && parsed.title) foundTitle = parsed.title;
      if (foundTempo == null && parsed.tempo) foundTempo = parsed.tempo;
      const part = choosePart(parsed, meta.spec);
      if (!part || !part.measures.length) { score.warnings.push({ page: score.pages.length, photoPage: photo, code: 'NO_MUSIC', message: 'no measures were recognised' }); return; }
      if (parsed.parts.length > 1) warn('found ' + parsed.parts.length + ' parts (' + parsed.parts.map(p => (p.name || p.id) + (p.staves > 1 ? ' ×2 staves' : '')).join(', ') + '); reviewing ' + (part.name || part.id) + (part.staves > 1 ? ' (grand staff)' : ''));
      if (!keySet) { score.key = part.key; keySet = true; }
      if (!score.time && part.time) score.time = part.time.slice();
      if (!score.part) score.part = { name: part.staves > 1 ? 'Piano' : (part.name || 'Part'), kind: part.staves > 1 ? 'piano' : 'single', ordinal: 0, staves: part.staves };
      if (part.flags.grace) warn(part.flags.grace + ' grace note(s) are not played');
      if (part.flags.keyChange) warn('a key change was found; check accidentals after it');
      if (part.flags.timeChange) warn('a time-signature change was found; measures after it may show as not adding up');
      const nStaves = Math.min(2, part.staves || 1);
      if (part.staves > 2) warn('only the first two staves of ' + (part.name || 'this part') + ' are shown');
      const pageNo = score.pages.length;
      const time = score.time || part.time || [4, 4];
      const pageMeasures = part.measures.map((pm, mi) => {
        const mLen = M.measureLength(pm.time || time);
        const staves = convertMeasure(pm, nStaves, mLen, warn);
        const clefs = [];
        for (let s = 1; s <= nStaves; s++) clefs.push(pm.clefs[s] || (nStaves === 2 && s === 2 ? 'bass' : 'treble'));
        return { pm, staves, clefs, mLen, newSystem: pm.newSystem && mi > 0 };
      });
      layoutPage(score, pageMeasures, pageNo, nStaves);
      score.pageMap.push(photo);
      warnSet.forEach(message => score.warnings.push({ page: pageNo, photoPage: photo, code: 'NOTE', message }));
    });
    if (!score.time) score.time = score.measures.length ? M.inferTime(score) : [4, 4];
    if (!meta.title && foundTitle) score.title = foundTitle;
    if (!score.title) score.title = 'Recognised score';
    if (!meta.tempoEdited && foundTempo) score.tempo = Math.max(30, Math.min(220, Math.round(foundTempo)));
    score.measures.forEach(m => m.staves.forEach(st => assignAccidentals(st.events, score.key)));
    score.measures.forEach(m => m.staves.forEach(st => st.events.forEach(e => { delete e.start; delete e.gap; })));
    M.validate(score);
    return score;
  }

  /** Synthetic engraving-like layout: systems of justified measures on a 1000-unit-wide page. */
  function layoutPage(score, list, pageNo, nStaves) {
    const keyW = IL * (3.4 + Math.abs(score.key) * 0.8);
    const staffGap = IL * 7, staffH = IL * 4;
    const sysH = nStaves * staffH + (nStaves - 1) * staffGap;
    const widthOf = item => {
      const onsets = new Set();
      item.staves.forEach(st => st.forEach(e => onsets.add(Math.round(e.start * 48))));
      return Math.max(IL * 9, IL * 3 + onsets.size * IL * 3.3);
    };
    // Rows: homr's line breaks when available, otherwise pack by width.
    const rows = [];
    const hasBreaks = list.some(it => it.newSystem);
    let row = [], used = 0;
    list.forEach((it, i) => {
      const w = widthOf(it), header = keyW + (pageNo === 0 && rows.length === 0 ? IL * 2.6 : 0) + IL;
      const avail = PAGE_W - 2 * MARGIN - header;
      if (row.length && (hasBreaks ? it.newSystem : used + w > avail)) { rows.push(row); row = []; used = 0; }
      row.push({ it, w }); used += w;
      if (i === list.length - 1) rows.push(row);
    });
    let y = MARGIN + IL * 4;
    rows.forEach((r, ri) => {
      const header = keyW + (pageNo === 0 && ri === 0 ? IL * 2.6 : 0) + IL;
      const left = MARGIN, avail = PAGE_W - 2 * MARGIN - header;
      const natural = r.reduce((a, c) => a + c.w, 0);
      const k = ri === rows.length - 1 && natural < avail * 0.6 && rows.length > 1 ? 1 : avail / natural;
      const right = left + header + natural * k;
      const tops = []; for (let s = 0; s < nStaves; s++) tops.push(y + s * (staffH + staffGap));
      const staffGeo = tops.map(t => ({ top: t, bottom: t + staffH, left, right, interline: IL, lines: [0, 1, 2, 3, 4].map(i => t + i * IL) }));
      let x = left + header;
      r.forEach(({ it, w }) => {
        const x0 = x, x1 = x + w * k;
        x = x1;
        const m = {
          id: id('m'), page: pageNo, system: ri,
          x0, x1, y0: tops[0] - IL * 3, y1: tops[tops.length - 1] + staffH + IL * 3, accepted: false,
          staves: it.staves.map((evs, s) => {
            const st = staffGeo[s], span = Math.max(1e-3, it.mLen);
            evs.forEach(e => {
              e.x = x0 + IL * 1.8 + Math.min(1, e.start / span) * (x1 - x0 - IL * 3.2) + (e.voice === 2 && e.type === 'rest' ? IL * 0.6 : 0);
              if (e.type === 'rest') e.y = st.lines[2];
              e.notes.forEach(n => { n.x = e.x; n.y = st.bottom - (n.diatonic - M.clefBase(it.clefs[s])) * IL / 2; });
            });
            evs.sort((a, b) => a.x - b.x);
            return { clef: it.clefs[s], staff: st, events: evs };
          })
        };
        score.measures.push(m);
      });
      y += sysH + IL * 11;
    });
    score.pages.push({ index: pageNo, width: PAGE_W, height: Math.max(400, y - IL * 4 + MARGIN), interline: IL, skew: 0, synthetic: true });
  }

  return { normaliseUrl, health, recognisePage, parse, choosePart, toScore, pieces };
});
