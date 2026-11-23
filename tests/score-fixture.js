const E = require('../omr/engine.js');
const L = 'CDEFGAB', DUR = { whole: 'w', half: 'h', quarter: 'q', eighth: 'e', '16th': 's', '32nd': 't' };
module.exports = function scoreFixture(result, truth) {
  const rec = result.recognition;
  const out = { heads: { truth: 0, detected: 0, matched: 0 }, events: { truth: 0, durationOk: 0 }, measures: rec.measures.length };
  ['treble', 'bass'].forEach((clef, k) => {
    (truth.notes[clef] || []).forEach((tm, mi) => {
      const m = rec.measures[mi], evs = m ? m.staves[k].events : [], det = [];
      evs.forEach(e => e.notes.forEach(n => { const d = E.stepToDiatonic(n.step, m.staves[k].clef); det.push(L[d % 7] + Math.floor(d / 7)); }));
      const tr = [];
      tm.forEach(t => { if (t[0] !== 'R') t.slice(0, -1).split('+').forEach(p => tr.push(p)); });
      out.heads.truth += tr.length; out.heads.detected += det.length;
      const pool = det.slice();
      tr.forEach(p => { const i = pool.indexOf(p); if (i >= 0) { pool.splice(i, 1); out.heads.matched++; } });
      out.events.truth += tm.length;
      if (evs.length === tm.length) tm.forEach((t, i) => { if (DUR[evs[i].base] === t.slice(-1)) out.events.durationOk++; });
    });
  });
  out.heads.precision = out.heads.matched / Math.max(1, out.heads.detected);
  out.heads.recall = out.heads.matched / Math.max(1, out.heads.truth);
  out.events.durationAccuracy = out.events.durationOk / Math.max(1, out.events.truth);
  return out;
};
