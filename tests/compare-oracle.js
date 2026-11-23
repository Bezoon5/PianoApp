// Tolerance-based comparison of parsed notes with a music21 oracle.
module.exports = function compare(mine, oracle, tol) {
  tol = tol || 0.02;
  const byMidi = new Map();
  oracle.forEach(n => { const a = byMidi.get(n[1]) || []; a.push({ n, used: false }); byMidi.set(n[1], a); });
  let exact = 0, onset = 0; const missing = [];
  mine.forEach(m => {
    const cands = byMidi.get(m[1]) || [];
    let best = null;
    for (const c of cands) if (!c.used && Math.abs(c.n[0] - m[0]) < tol) { if (!best || Math.abs(c.n[2] - m[2]) < Math.abs(best.n[2] - m[2])) best = c; }
    if (!best) { missing.push(m); return; }
    best.used = true; onset++;
    if (Math.abs(best.n[2] - m[2]) < tol) exact++;
  });
  const unmatched = []; byMidi.forEach(a => a.forEach(c => { if (!c.used) unmatched.push(c.n); }));
  return { mine: mine.length, oracle: oracle.length, onsetPitch: onset, exact, extra: missing, notFound: unmatched };
};
