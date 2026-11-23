/*
 * Piano Companion OMR engine (v5.1)
 * Pure functions on grayscale pixel buffers. Runs in a Web Worker, on the
 * main thread, or in Node (tests). No DOM access.
 *
 *   prepare()      scale to a normalised staff space, binarise, deskew
 *   detectStaves() five-line staff detection with horizontal extents
 *   detectLayout() systems, braces, grand staves, instrument parts
 *   recognise()    staff-line removal, header, noteheads, stems, beams,
 *                  dots, rests, barlines -> measures of events
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMREngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET_INTERLINE = 16;

  /* ------------------------------ Utilities ------------------------------ */

  function otsu(gray) {
    const hist = new Float64Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function resize(gray, w, h, scale) {
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    const out = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
        out[y * nw + x] = (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) + (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
      }
    }
    return { gray: out, w: nw, h: nh };
  }

  /** Background-relative binarisation (paper level per block, interpolated). 1 = ink. */
  function binarise(gray, w, h, block, strictInk) {
    block = Math.max(16, block | 0);
    const bx = Math.ceil(w / block), by = Math.ceil(h / block);
    const bg = new Float32Array(bx * by), hist = new Uint32Array(256);
    for (let j = 0; j < by; j++) for (let i = 0; i < bx; i++) {
      hist.fill(0);
      let n = 0;
      const x0 = i * block, y0 = j * block, x1 = Math.min(w, x0 + block * 2), y1 = Math.min(h, y0 + block * 2);
      for (let y = Math.max(0, y0 - block); y < y1; y += 2) for (let x = Math.max(0, x0 - block); x < x1; x += 2) { hist[gray[y * w + x]]++; n++; }
      let acc = 0, v = 255;
      for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= n * 0.05) { v = t; break; } }
      bg[j * bx + i] = Math.max(60, v);
    }
    const bin = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(by - 1, Math.max(0, y / block - 0.5)), j0 = Math.floor(fy), j1 = Math.min(by - 1, j0 + 1), ty = fy - j0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bx - 1, Math.max(0, x / block - 0.5)), i0 = Math.floor(fx), i1 = Math.min(bx - 1, i0 + 1), tx = fx - i0;
        const b = (bg[j0 * bx + i0] * (1 - tx) + bg[j0 * bx + i1] * tx) * (1 - ty) + (bg[j1 * bx + i0] * (1 - tx) + bg[j1 * bx + i1] * tx) * ty;
        const v = gray[y * w + x];
        if (strictInk != null) bin[y * w + x] = v < b - (b - strictInk) * 0.45 ? 1 : 0;
        else bin[y * w + x] = v < b * 0.86 && v < b - 22 ? 1 : 0;
      }
    }
    return bin;
  }

  /** Line thickness / interline from vertical run lengths. */
  function estimateInterline(bin, w, h) {
    const black = new Float64Array(h + 1), pair = new Float64Array(h + 1);
    const step = Math.max(1, Math.floor(w / 400));
    for (let x = 0; x < w; x += step) {
      let y = 0, prevBlack = -1;
      while (y < h) {
        const v = bin[y * w + x];
        let len = 0;
        while (y < h && bin[y * w + x] === v) { len++; y++; }
        if (v) prevBlack = len;
        else if (prevBlack > 0 && y < h) pair[prevBlack + len]++;
        if (v) black[len]++;
      }
    }
    let th = 1, bestB = 0;
    for (let i = 1; i < Math.min(h, 40); i++) if (black[i] > bestB) { bestB = black[i]; th = i; }
    let il = 0, bestP = 0;
    for (let i = 3; i < Math.min(h, 200); i++) if (pair[i] > bestP) { bestP = pair[i]; il = i; }
    return { interline: il, thickness: th };
  }

  /** Interline from the autocorrelation of the high-passed row darkness profile. */
  function estimateInterlineProfile(gray, w, h) {
    const p = new Float64Array(h);
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += 255 - gray[y * w + x]; p[y] = s; }
    const k = Math.max(4, Math.round(h / 60)), d = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, y - k); j <= Math.min(h - 1, y + k); j++) { s += p[j]; n++; }
      d[y] = Math.max(0, p[y] - s / n);
    }
    const maxL = Math.min(80, Math.floor(h / 4)), sc = new Float64Array(maxL + 2);
    for (let L = 2; L <= maxL; L++) { let s = 0; for (let y = 0; y + L < h; y++) s += d[y] * d[y + L]; sc[L] = s; }
    let top = 0;
    for (let L = 2; L <= maxL; L++) top = Math.max(top, sc[L]);
    if (!top) return 0;
    for (let L = 2; L <= maxL; L++) {
      const v = sc[L] / top;
      if (v < 0.5 || sc[L] < sc[L + 1] * 0.98) continue;
      const nxt = sc[L + 1] / top, prv = sc[L - 1] / top;
      if (nxt >= v * 0.5) return (L * v + (L + 1) * nxt) / (v + nxt);
      if (prv >= v * 0.5) return (L * v + (L - 1) * prv) / (v + prv);
      return L;
    }
    return 0;
  }

  function rotateBuf(src, w, h, angleDeg, fill) {
    const a = angleDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), cx = w / 2, cy = h / 2;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = Math.round(c * dx + s * dy + cx), sy = Math.round(-s * dx + c * dy + cy);
      out[y * w + x] = sx >= 0 && sy >= 0 && sx < w && sy < h ? src[sy * w + sx] : fill;
    }
    return out;
  }

  /** Deskew: the angle that maximises horizontal projection energy. */
  function estimateSkew(bin, w, h) {
    const sub = Math.max(1, Math.floor(w / 600));
    let best = 0, bestScore = -1;
    for (let deg = -4; deg <= 4.001; deg += 0.25) {
      const t = Math.tan(deg * Math.PI / 180), proj = new Float64Array(h * 2 + 10);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x += sub) {
        if (!bin[y * w + x]) continue;
        const yy = Math.round(y - (x - w / 2) * t) + Math.floor(h / 2);
        if (yy >= 0 && yy < proj.length) proj[yy]++;
      }
      let score = 0;
      for (let i = 0; i < proj.length; i++) score += proj[i] * proj[i];
      if (score > bestScore) { bestScore = score; best = deg; }
    }
    return best;
  }

  function paperLevel(gray, frac) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i += 5) hist[gray[i]]++;
    let acc = 0;
    const tot = Math.ceil(gray.length / 5);
    for (let t = 255; t >= 0; t--) { acc += hist[t]; if (acc >= tot * frac) return t; }
    return 255;
  }

  /* -------------------------------- Prepare ------------------------------ */

  function prepare(gray, w, h, opts) {
    opts = opts || {};
    let native = estimateInterlineProfile(gray, w, h);
    if (!native || native < 2.5) {
      const t0 = otsu(gray), quick = new Uint8Array(w * h);
      for (let i = 0; i < quick.length; i++) quick[i] = gray[i] < Math.min(220, t0 + 20) ? 1 : 0;
      native = estimateInterline(quick, w, h).interline || 8;
    }
    const scale = Math.max(0.25, Math.min(5, TARGET_INTERLINE / native));
    const r = Math.abs(scale - 1) < 0.03 ? { gray: gray, w: w, h: h } : resize(gray, w, h, scale);
    let bin = binarise(r.gray, r.w, r.h, TARGET_INTERLINE * 2);
    let angle = 0;
    if (opts.deskew !== false) {
      angle = estimateSkew(bin, r.w, r.h);
      if (Math.abs(angle) >= 0.25) {
        bin = rotateBuf(bin, r.w, r.h, -angle, 0);
        r.gray = rotateBuf(r.gray, r.w, r.h, -angle, 255);
      } else angle = 0;
    }
    const fine = estimateInterline(bin, r.w, r.h);
    const hist = new Uint32Array(256);
    for (let i = 0; i < r.gray.length; i += 3) hist[r.gray[i]]++;
    let acc = 0, inkLevel = 0;
    const tot = Math.ceil(r.gray.length / 3);
    for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= tot * 0.004) { inkLevel = t; break; } }
    const ink = binarise(r.gray, r.w, r.h, TARGET_INTERLINE * 2, inkLevel);
    return {
      gray: r.gray, bin, ink, inkLevel, w: r.w, h: r.h, scale, skew: angle, nativeInterline: native,
      interline: native * scale, thickness: Math.max(1, fine.thickness)
    };
  }

  /* -------------------------------- Staves ------------------------------- */

  function detectStaves(P) {
    const { bin, gray, w, h } = P, il = P.interline;
    const paper = paperLevel(gray, 0.3);
    const faint = Math.min(paper - 10, 245);
    const prof = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x += 2) { const v = paper - gray[y * w + x]; if (v > 6) s += v; }
      prof[y] = s;
    }
    const r = Math.max(1, Math.round(il * 0.12)), sm = new Float64Array(h);
    for (let y = 0; y < h; y++) { let s = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) s += prof[yy]; } sm[y] = s; }
    const peaks = [];
    for (let y = 1; y < h - 1; y++) if (sm[y] > 0 && sm[y] >= sm[y - 1] && sm[y] > sm[y + 1]) peaks.push(y);
    // Refine each peak to the darkness centroid (flat-topped peaks were off by up to 2 px).
    for (let i = 0; i < peaks.length; i++) {
      const y = peaks[i];
      let s = 0, sy = 0;
      for (let k = -r - 1; k <= r + 1; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += prof[yy]; sy += prof[yy] * yy; } }
      peaks[i] = s > 0 ? { y: Math.round(sy / s * 2) / 2, at: y } : { y, at: y };
    }
    const pv = peaks.map(p => sm[p.at]).sort((a, b) => b - a);
    const ref = pv.length ? pv[Math.min(pv.length - 1, Math.max(4, Math.floor(pv.length * 0.03)))] : 0;
    const lines = [];
    for (const p of peaks) {
      const y = p.y, v = sm[p.at];
      if (v < ref * 0.28) continue;
      const last = lines[lines.length - 1];
      if (last && y - last.y < il * 0.45) { if (v > last.v) lines[lines.length - 1] = { y, v }; continue; }
      lines.push({ y, v });
    }
    const inkImg = P.ink || bin;
    for (const L of lines) {
      let rows = 0, srows = 0;
      for (let y = Math.round(L.y - il * 0.3); y <= Math.round(L.y + il * 0.3); y++) {
        if (y < 0 || y >= h) continue;
        let c = 0, c2 = 0;
        for (let x = 0; x < w; x += 4) { c += bin[y * w + x]; c2 += inkImg[y * w + x]; }
        if (c > w / 4 * 0.3) rows++;
        if (c2 > w / 4 * 0.3) srows++;
      }
      L.t = Math.max(1, srows || rows);
    }
    const staves = [], used = new Uint8Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      if (used[i]) continue;
      const group = [i];
      let last = i;
      for (let j = i + 1; j < lines.length && group.length < 5; j++) {
        const d = lines[j].y - lines[last].y;
        if (d < il * 0.75) continue;
        if (d > il * 1.3) break;
        group.push(j); last = j;
      }
      if (group.length !== 5) continue;
      const ys = group.map(k => lines[k].y), sp = (ys[4] - ys[0]) / 4;
      if (Math.abs(sp - il) > il * 0.25) continue;
      const ext = staffExtent(gray, bin, w, h, ys, faint, sp);
      if (ext.right - ext.left < sp * 8) continue;
      group.forEach(k => { used[k] = 1; });
      staves.push({ index: staves.length, lines: ys, thick: group.map(k => lines[k].t), top: ys[0], bottom: ys[4], interline: sp, left: ext.left, right: ext.right });
    }
    return staves;
  }

  function staffExtent(gray, bin, w, h, ys, faint, sp) {
    const present = new Uint8Array(w), r = Math.max(1, Math.round(sp * 0.15));
    for (let x = 0; x < w; x++) {
      let c = 0;
      for (const yc of ys) {
        let hit = 0;
        for (let y = Math.round(yc - r); y <= Math.round(yc + r); y++) if (y >= 0 && y < h && (bin[y * w + x] || gray[y * w + x] < faint)) { hit = 1; break; }
        c += hit;
      }
      let sp4 = 0;
      for (let k = 0; k < 4; k++) if (bin[Math.round((ys[k] + ys[k + 1]) / 2) * w + x]) sp4++;
      present[x] = c >= 4 && sp4 <= 1 ? 1 : 0;
    }
    const gap = Math.round(sp * 2.5);
    let best = { left: 0, right: 0 }, start = -1, lastOn = -1;
    for (let x = 0; x <= w; x++) {
      if (x < w && present[x]) { if (start < 0) start = x; lastOn = x; }
      else if (start >= 0 && (x === w || x - lastOn > gap)) {
        if (lastOn - start > best.right - best.left) best = { left: start, right: lastOn };
        start = -1;
      }
    }
    return best;
  }

  /* -------------------------------- Layout ------------------------------- */

  function columnCoverage(bin, w, x, y0, y1) {
    let n = 0, t = 0;
    for (let y = Math.round(y0); y <= Math.round(y1); y++) { t++; if (bin[y * w + x]) n++; }
    return t ? n / t : 0;
  }

  function connected(P, a, b) {
    const { bin, w } = P, il = a.interline, left = Math.max(a.left, b.left);
    for (let x = Math.max(0, Math.round(left - il)); x <= Math.min(w - 1, Math.round(left + il)); x++) {
      if (columnCoverage(bin, w, x, a.bottom + 1, b.top - 1) > 0.92) return true;
    }
    return false;
  }

  function braceBetween(P, a, b) {
    const { bin, w } = P, il = a.interline, left = Math.min(a.left, b.left);
    const x0 = Math.max(0, Math.round(left - il * 2.4)), x1 = Math.max(0, Math.round(left - il * 0.25));
    if (x1 <= x0) return false;
    const y0 = Math.round(a.top + il * 0.5), y1 = Math.round(b.bottom - il * 0.5);
    let run = 0, best = 0, gap = 0;
    for (let y = y0; y <= y1; y++) {
      let hit = false;
      for (let x = x0; x <= x1; x++) if (bin[y * w + x]) { hit = true; break; }
      if (hit) { run += 1 + gap; gap = 0; best = Math.max(best, run); }
      else if (++gap > 2) { run = 0; gap = 0; }
    }
    return best >= (y1 - y0) * 0.85;
  }

  function detectLayout(P, staves) {
    const systems = [], gaps = [];
    for (let i = 0; i + 1 < staves.length; i++) gaps.push(staves[i + 1].top - staves[i].bottom);
    const links = staves.map((s, i) => i + 1 < staves.length && connected(P, s, staves[i + 1]));
    const anyLink = links.some(Boolean);
    let gapThr = Infinity;
    if (gaps.length) {
      const sorted = gaps.slice().sort((x, y) => x - y);
      let jump = 0;
      for (let i = 0; i + 1 < sorted.length; i++) {
        const j = sorted[i + 1] / Math.max(1, sorted[i]);
        if (j > jump) { jump = j; gapThr = (sorted[i] + sorted[i + 1]) / 2; }
      }
      if (jump < 1.25) gapThr = Infinity;
    }
    let cur = null;
    for (let i = 0; i < staves.length; i++) {
      if (!cur) { cur = { index: systems.length, staves: [i] }; systems.push(cur); }
      if (i + 1 >= staves.length) break;
      let join;
      if (gapThr !== Infinity) join = gaps[i] < gapThr;
      else if (anyLink) join = links[i] || braceBetween(P, staves[i], staves[i + 1]);
      else join = braceBetween(P, staves[i], staves[i + 1]);
      if (join) cur.staves.push(i + 1); else cur = null;
    }
    for (const sys of systems) {
      sys.grand = [];
      for (let k = 0; k + 1 < sys.staves.length; k++) {
        if (braceBetween(P, staves[sys.staves[k]], staves[sys.staves[k + 1]])) { sys.grand.push([sys.staves[k], sys.staves[k + 1]]); k++; }
      }
      if (!sys.grand.length) {
        if (sys.staves.length === 2) sys.grand.push(sys.staves.slice());
        else if (sys.staves.length >= 3) sys.grand.push(sys.staves.slice(-2));
      }
      sys.slots = [];
      for (let k = 0; k < sys.staves.length; k++) {
        const g = sys.grand.find(p => p[0] === sys.staves[k]);
        if (g) { sys.slots.push({ kind: 'piano', staves: g.slice() }); k++; }
        else sys.slots.push({ kind: 'single', staves: [sys.staves[k]] });
      }
    }
    const sig = s => s.slots.map(x => x.kind).join('+'), counts = {};
    systems.forEach(s => { counts[sig(s)] = (counts[sig(s)] || 0) + 1; });
    const common = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
    const kinds = common ? common.split('+') : [];
    let instr = 0;
    const parts = kinds.map((k, i) => ({
      id: 'P' + (i + 1), slot: i, kind: k,
      ordinal: kinds.slice(0, i).filter(x => x === k).length,
      name: k === 'piano' ? 'Piano' : 'Instrument ' + (++instr),
      staves: k === 'piano' ? 2 : 1
    }));
    return { systems, parts, consistent: systems.every(s => sig(s) === common) };
  }

  /** Find the slot for a part by kind and ordinal, never by position alone. */
  function slotForPart(sys, part) {
    if (!part) return sys.slots[0] || null;
    const same = sys.slots.filter(s => s.kind === part.kind);
    if (same.length) return same[Math.min(part.ordinal || 0, same.length - 1)];
    return null;
  }

  /* --------------------------- Symbol recognition ------------------------ */

  function removeStaffLines(P, staves, src) {
    const bin = src || P.ink || P.bin, w = P.w, h = P.h, clean = bin.slice();
    for (const s of staves) for (let li = 0; li < 5; li++) {
      const yc = s.lines[li], t = Math.max(1, s.thick[li]);
      const y0 = Math.round(yc - t / 2 - 0.5), y1 = Math.round(yc + t / 2 + 0.5);
      for (let x = Math.max(0, s.left - 2); x <= Math.min(w - 1, s.right + 2); x++) {
        const above = y0 - 1 >= 0 ? bin[(y0 - 1) * w + x] : 0, below = y1 + 1 < h ? bin[(y1 + 1) * w + x] : 0;
        if (!above && !below) {
          for (let y = y0; y <= y1; y++) if (y >= 0 && y < h) clean[y * w + x] = 0;
        } else if (!above || !below) {
          const keep = above ? [y0, y0 + Math.floor((y1 - y0) / 2)] : [y0 + Math.ceil((y1 - y0) / 2), y1];
          for (let y = y0; y <= y1; y++) if ((y < keep[0] || y > keep[1]) && y >= 0 && y < h) clean[y * w + x] = 0;
        }
      }
    }
    return clean;
  }

  function integral(img, w, h) {
    const ii = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rs = 0;
      for (let x = 0; x < w; x++) { rs += img[y * w + x]; ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + rs; }
    }
    return ii;
  }

  function makeBox(ii, w, h) {
    return function (x0, y0, x1, y1) {
      x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
      x1 = Math.min(w - 1, Math.round(x1)); y1 = Math.min(h - 1, Math.round(y1));
      if (x1 < x0 || y1 < y0) return 0;
      const s = ii[(y1 + 1) * (w + 1) + x1 + 1] - ii[y0 * (w + 1) + x1 + 1] - ii[(y1 + 1) * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      return s / ((x1 - x0 + 1) * (y1 - y0 + 1));
    };
  }

  function components(img, w, h, y0, y1, x0, x1) {
    y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h - 1, Math.round(y1));
    x0 = Math.max(0, Math.round(x0)); x1 = Math.min(w - 1, Math.round(x1));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < 1 || bh < 1) return [];
    const lab = new Int32Array(bw * bh), comps = [], stack = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      if (lab[y * bw + x] || !img[(y + y0) * w + x + x0]) continue;
      const c = { id: comps.length + 1, x0: x, y0: y, x1: x, y1: y, n: 0 };
      lab[y * bw + x] = c.id; stack.push(x, y);
      while (stack.length) {
        const cy = stack.pop(), cx = stack.pop();
        c.n++;
        if (cx < c.x0) c.x0 = cx; if (cx > c.x1) c.x1 = cx;
        if (cy < c.y0) c.y0 = cy; if (cy > c.y1) c.y1 = cy;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const k = ny * bw + nx;
          if (lab[k] || !img[(ny + y0) * w + nx + x0]) continue;
          lab[k] = c.id; stack.push(nx, ny);
        }
      }
      comps.push(c);
    }
    comps.forEach(c => { c.x0 += x0; c.x1 += x0; c.y0 += y0; c.y1 += y0; c.w = c.x1 - c.x0 + 1; c.h = c.y1 - c.y0 + 1; });
    return comps;
  }

  function verticalStrokes(img, w, c) {
    let groups = 0, inG = false;
    for (let x = c.x0; x <= c.x1; x++) {
      let n = 0;
      for (let y = c.y0; y <= c.y1; y++) n += img[y * w + x];
      const on = n >= c.h * 0.55;
      if (on && !inG) groups++;
      inG = on;
    }
    return groups;
  }

  /** Clef, key signature and time signature at the start of a staff. */
  function readHeader(clean, w, h, staff) {
    const il = staff.interline;
    const comps = components(clean, w, h, staff.top - il * 3, staff.bottom + il * 3, staff.left + 1, Math.min(staff.right, staff.left + il * 16))
      .filter(c => c.n > il * 0.6 && c.y1 > staff.top - il * 0.5 && c.y0 < staff.bottom + il * 0.5)
      .sort((a, b) => a.x0 - b.x0);
    const head = { clef: null, clefBox: null, key: 0, keyBoxes: [], timeBoxes: [], musicStart: staff.left + il * 2 };
    if (!comps.length) return head;
    let i = 0;
    while (i < comps.length && (comps[i].h < il * 1.5 || comps[i].w < il * 0.45)) i++;
    const clef = comps[i];
    if (!clef || clef.x0 > staff.left + il * 3) return head;
    head.clef = clef.h > il * 4.6 ? 'treble' : 'bass';
    head.clefBox = clef;
    let end = clef.x1;
    for (let k = i + 1; k < comps.length && comps[k].x0 <= end + il * 0.2; k++) end = Math.max(end, comps[k].x1);
    let j = comps.findIndex(c => c.x0 > end);
    if (j < 0) { head.musicStart = end + il; return head; }
    let flats = 0, sharps = 0, prevX = end;
    while (j < comps.length) {
      const c = comps[j];
      if (c.x0 - prevX > il * 1.6) break;
      if (!(c.h >= il * 1.4 && c.h <= il * 3.6 && c.w <= il * 1.4 && c.w >= il * 0.4)) break;
      if (verticalStrokes(clean, w, c) >= 2) sharps++; else flats++;
      head.keyBoxes.push(c);
      prevX = c.x1; j++;
      if (head.keyBoxes.length >= 7) break;
    }
    head.key = sharps > flats ? sharps : -flats;
    const mid = (staff.top + staff.bottom) / 2;
    const cand = comps.slice(j).filter(c => c.x0 - prevX < il * 2.6 && c.x0 < prevX + il * 4);
    const upper = cand.filter(c => c.y1 <= mid + il * 0.4 && c.y0 >= staff.top - il * 0.6 && c.h >= il * 1.2 && c.h <= il * 2.6);
    const lower = cand.filter(c => c.y0 >= mid - il * 0.4 && c.y1 <= staff.bottom + il * 0.6 && c.h >= il * 1.2 && c.h <= il * 2.6);
    let tsEnd = prevX;
    for (const c of cand) {
      if (c.h >= il * 3.3 && c.h <= il * 4.8 && c.w >= il * 0.8 && c.w <= il * 2.6 && c.y0 >= staff.top - il * 0.6 && c.y1 <= staff.bottom + il * 0.6) {
        head.timeBoxes.push(c); tsEnd = Math.max(tsEnd, c.x1);
      }
    }
    for (const u of upper) {
      const l = lower.find(q => Math.abs((q.x0 + q.x1) / 2 - (u.x0 + u.x1) / 2) < il * 0.9);
      if (l) { head.timeBoxes.push(u, l); tsEnd = Math.max(tsEnd, u.x1, l.x1); }
    }
    head.musicStart = (head.timeBoxes.length ? tsEnd : prevX) + il * 0.35;
    return head;
  }

  function stepToDiatonic(step, clef) { return (clef === 'bass' ? 2 * 7 + 4 : 4 * 7 + 2) + step; }

  function findNoteheads(ctx, staff, region) {
    const { box, il } = ctx, cands = [];
    for (let y = Math.round(region.y0); y <= region.y1; y++) {
      for (let x = Math.round(region.x0 + il * 0.5); x <= region.x1 - il * 0.5; x++) {
        const core = box(x - il * 0.5, y - il * 0.2, x + il * 0.5, y + il * 0.2);
        if (core < 0.75) continue;
        const cap = box(x - il * 0.3, y - il * 0.4, x + il * 0.3, y + il * 0.4);
        if (cap < 0.75) continue;
        const left = box(x - il * 1.5, y - il * 0.3, x - il * 0.85, y + il * 0.3);
        const right = box(x + il * 0.85, y - il * 0.3, x + il * 1.5, y + il * 0.3);
        if (left > 0.7 && right > 0.7) continue;
        const cs = il * 0.12;
        let corners = 0;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const cx = x + sx * il * 0.6, cy = y + sy * il * 0.48;
          if (box(cx - cs, cy - cs, cx + cs, cy + cs) > 0.75) corners++;
        }
        if (corners >= 3) continue;
        const up = box(x - il * 0.42, y - il * 1.3, x + il * 0.42, y - il * 0.75);
        const down = box(x - il * 0.42, y + il * 0.75, x + il * 0.42, y + il * 1.3);
        if (up > 0.8 && down > 0.8) continue;
        cands.push({ x, y, score: Math.min(core, cap), type: 'filled' });
      }
    }
    for (let y = Math.round(region.y0); y <= region.y1; y++) {
      for (let x = Math.round(region.x0 + il * 0.5); x <= region.x1 - il * 0.5; x++) {
        const inner = box(x - il * 0.16, y - il * 0.1, x + il * 0.16, y + il * 0.1);
        if (inner > 0.15) continue;
        const outer = box(x - il * 0.62, y - il * 0.45, x + il * 0.62, y + il * 0.45);
        if (outer < 0.3 || outer > 0.78) continue;
        const l = box(x - il * 0.62, y - il * 0.15, x - il * 0.38, y + il * 0.15);
        const r = box(x + il * 0.38, y - il * 0.15, x + il * 0.62, y + il * 0.15);
        const t = box(x - il * 0.15, y - il * 0.5, x + il * 0.15, y - il * 0.3);
        const b = box(x - il * 0.15, y + il * 0.3, x + il * 0.15, y + il * 0.5);
        if (l < 0.45 || r < 0.45 || t < 0.35 || b < 0.35) continue;
        const farL = box(x - il * 1.25, y - il * 0.2, x - il * 0.8, y + il * 0.2);
        const farR = box(x + il * 0.8, y - il * 0.2, x + il * 1.25, y + il * 0.2);
        if (farL > 0.6 && farR > 0.6) continue;
        cands.push({ x, y, score: 0.55 + (l + r + t + b) / 4 * 0.4 - inner, type: 'open' });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const heads = [];
    for (const c of cands) {
      if (heads.some(hd => Math.abs(hd.x - c.x) < il * 0.95 && Math.abs(hd.y - c.y) < il * 0.75)) continue;
      heads.push(c);
    }
    return heads;
  }

  function refineHead(ctx, hd) {
    const { clean, w, h, il } = ctx;
    for (let it = 0; it < 3; it++) {
      let sx = 0, sy = 0, n = 0;
      const rx = Math.round(il * 0.6), ry = Math.round(il * 0.5);
      for (let y = Math.round(hd.y) - ry; y <= Math.round(hd.y) + ry; y++) {
        if (y < 0 || y >= h) continue;
        let rowN = 0, rowX = 0;
        for (let x = Math.round(hd.x) - rx; x <= Math.round(hd.x) + rx; x++) if (x >= 0 && x < w && clean[y * w + x]) { rowN++; rowX += x; }
        if (rowN >= il * 0.35 && rowN <= il * 1.15) { sx += rowX; sy += y * rowN; n += rowN; }
      }
      if (!n) break;
      hd.x = sx / n; hd.y = sy / n;
    }
  }

  function dedupeHeads(heads, il) {
    heads.sort((a, b) => b.score - a.score);
    const out = [];
    for (const c of heads) if (!out.some(o => Math.abs(o.x - c.x) < il * 0.8 && Math.abs(o.y - c.y) < il * 0.6)) out.push(c);
    return out;
  }

  function classifyHead(ctx, hd) {
    const { gray, w, h, il, paper } = ctx;
    let s = 0, n = 0;
    const r = Math.max(1, Math.round(il * 0.12));
    for (let y = Math.round(hd.y) - r; y <= Math.round(hd.y) + r; y++) for (let x = Math.round(hd.x) - r; x <= Math.round(hd.x) + r; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      s += gray[y * w + x]; n++;
    }
    const centre = n ? s / n : 0, ink = ctx.inkLevel || 0, span = Math.max(30, paper - ink), rel = (centre - ink) / span;
    hd.centre = centre; hd.openness = rel;
    hd.type = rel > 0.2 ? 'open' : 'filled';
    hd.typeConf = rel > 0.45 || rel < 0.08 ? 0.9 : 0.55;
  }

  function ledgerOk(ctx, staff, hd) {
    const { bin, w, il } = ctx;
    const step = Math.round((staff.bottom - hd.y) / (il / 2));
    if (step >= -1 && step <= 9) return true;
    const need = [];
    if (step <= -2) for (let k = -2; k >= step; k -= 2) need.push(k);
    else for (let k = 10; k <= step; k += 2) need.push(k);
    for (const k of need) {
      const y = Math.round(staff.bottom - k * il / 2);
      let found = false;
      for (let dy = -2; dy <= 2 && !found; dy++) {
        let run = 0, best = 0;
        for (let x = Math.round(hd.x - il * 1.1); x <= Math.round(hd.x + il * 1.1); x++) {
          if (x >= 0 && x < w && bin[(y + dy) * w + x]) { run++; best = Math.max(best, run); } else run = 0;
        }
        if (best >= il * 1.3) found = true;
      }
      if (!found) return false;
    }
    return Math.abs(step) <= 16;
  }

  function verticalRun(img, w, h, x, y, dir) {
    let n = 0, gap = 0, yy = y;
    while (yy >= 0 && yy < h) {
      if (img[yy * w + x]) { n += 1 + gap; gap = 0; }
      else if (++gap > 2) break;
      yy += dir;
    }
    return n;
  }

  function stemFor(ctx, hd) {
    const clean = ctx.loose, w = ctx.w, h = ctx.h, il = ctx.il;
    let best = { len: 0 };
    const tryCol = (x, dir) => {
      if (x < 0 || x >= w) return;
      let bestStart = 0;
      for (let dy = -Math.round(il * 0.3); dy <= Math.round(il * 0.3); dy++) {
        const len = verticalRun(clean, w, h, x, Math.round(hd.y + dy), dir);
        if (len > bestStart) bestStart = len;
      }
      if (bestStart > best.len) best = { len: bestStart, x, dir };
    };
    for (let dx = Math.round(il * 0.35); dx <= Math.round(il * 0.85); dx++) { tryCol(Math.round(hd.x + dx), -1); tryCol(Math.round(hd.x - dx), 1); }
    if (best.len < il * 2.2) for (let dx = Math.round(il * 0.35); dx <= Math.round(il * 0.85); dx++) { tryCol(Math.round(hd.x - dx), -1); tryCol(Math.round(hd.x + dx), 1); }
    if (best.len >= il * 2.2) return { x: best.x, dir: best.dir < 0 ? 'up' : 'down', y0: hd.y, y1: hd.y + best.dir * best.len, len: best.len };
    return null;
  }

  function countBeams(ctx, stem) {
    if (!stem) return 0;
    const { clean, w, h, il } = ctx, inward = stem.dir === 'up' ? 1 : -1;
    let best = 0;
    for (const off of [-0.75, -0.55, 0.55, 0.75]) {
      const x = Math.round(stem.x + off * il);
      if (x < 0 || x >= w) continue;
      let segs = 0, inSeg = false, segLen = 0;
      for (let k = -Math.round(il * 0.3); k <= Math.round(il * 2.0); k++) {
        const y = Math.round(stem.y1 + inward * k);
        if (y < 0 || y >= h) continue;
        if (clean[y * w + x]) { segLen++; inSeg = true; }
        else if (inSeg) { if (segLen >= il * 0.25) segs++; inSeg = false; segLen = 0; }
      }
      if (inSeg && segLen >= il * 0.25 && segLen <= il * 1.2) segs++;
      if (segs > best) best = segs;
    }
    return Math.min(3, best);
  }

  /** Line/space test uses the rounded staff step. */
  function hasDot(ctx, hd, staff) {
    const { box, il } = ctx;
    const step = Math.round((staff.bottom - hd.y) / (il / 2));
    const onLine = ((step % 2) + 2) % 2 === 0;
    const ys = onLine ? [hd.y - il * 0.5, hd.y + il * 0.5] : [hd.y];
    for (const y of ys) {
      for (let dx = il * 1.0; dx <= il * 1.8; dx += il * 0.1) {
        const x = hd.x + dx;
        if (box(x - il * 0.13, y - il * 0.13, x + il * 0.13, y + il * 0.13) < 0.8) continue;
        if (box(x - il * 0.4, y - il * 0.4, x + il * 0.4, y + il * 0.4) < 0.35) return true;
      }
    }
    return false;
  }

  function findBarlines(ctx, staves, region) {
    const clean = ctx.loose, w = ctx.w, il = ctx.il;
    const top = staves[0].top, bottom = staves[staves.length - 1].bottom;
    const span = staves.length > 1 ? staves[0].bottom - staves[0].top : bottom - top;
    const xs = [];
    for (let x = Math.round(region.x0); x <= Math.round(region.x1); x++) {
      if (x < 0 || x >= w) continue;
      let ok = true;
      for (const s of staves) if (columnCoverage(clean, w, x, s.top + 1, s.bottom - 1) < 0.9) { ok = false; break; }
      if (!ok) continue;
      let run = 0, best = 0;
      for (let y = Math.round(top); y <= Math.round(bottom); y++) { if (clean[y * w + x]) { run++; if (run > best) best = run; } else run = 0; }
      if (best < span * 0.97) continue;
      if (columnCoverage(clean, w, x, top - il * 1.2, top - il * 0.4) > 0.6 || columnCoverage(clean, w, x, bottom + il * 0.4, bottom + il * 1.2) > 0.6) continue;
      xs.push(x);
    }
    const bars = [];
    for (const x of xs) {
      const last = bars[bars.length - 1];
      if (last && x - last.x1 <= il * 0.9) last.x1 = x; else bars.push({ x0: x, x1: x });
    }
    return bars.filter(b => b.x1 - b.x0 <= il * 1.2).map(b => ({ x: (b.x0 + b.x1) / 2, x0: b.x0, x1: b.x1, final: b.x1 - b.x0 > il * 0.45 }));
  }

  function findRests(ctx, staff, region, heads, stems) {
    const { clean, w, h, il, box } = ctx;
    const comps = components(clean, w, h, staff.top - il * 0.5, staff.bottom + il * 0.5, region.x0, region.x1);
    const rests = [], mid = staff.lines[2];
    for (const c of comps) {
      const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
      if (heads.some(hd => hd.x >= c.x0 - il * 0.3 && hd.x <= c.x1 + il * 0.3 && hd.y >= c.y0 - il * 0.3 && hd.y <= c.y1 + il * 0.3)) continue;
      if (stems.some(s => s && s.x >= c.x0 - 1 && s.x <= c.x1 + 1)) continue;
      const density = c.n / (c.w * c.h);
      if (c.h >= il * 0.3 && c.h <= il * 0.75 && c.w >= il * 0.8 && c.w <= il * 1.7 && density > 0.7) {
        const hangs = Math.abs(c.y0 - staff.lines[1]) < il * 0.35, sits = Math.abs(c.y1 - staff.lines[2]) < il * 0.35;
        if (hangs || sits) { rests.push({ x: cx, y: cy, type: hangs ? 'whole' : 'half', box: c, conf: 0.8 }); continue; }
      }
      if (c.h >= il * 2.0 && c.h <= il * 3.4 && c.w >= il * 0.45 && c.w <= il * 1.3 && Math.abs(cy - mid) < il * 0.9 && density > 0.2 && density < 0.7) {
        if (verticalStrokes(clean, w, c) <= 1) { rests.push({ x: cx, y: cy, type: 'quarter', box: c, conf: 0.6 }); continue; }
      }
      if (c.h >= il * 1.2 && c.h < il * 2.0 && c.w >= il * 0.45 && c.w <= il * 1.2 && Math.abs(cy - mid) < il * 1.2) {
        if (box(c.x0, c.y0, c.x0 + il * 0.45, c.y0 + il * 0.45) > 0.55) rests.push({ x: cx, y: cy, type: 'eighth', box: c, conf: 0.45 });
      }
    }
    return rests;
  }

  const DUR = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125 };

  /** Beams between neighbouring stems, including beams lying on a staff line. */
  function linkBeams(ctx, staff, events) {
    const { ink, w, h, il } = ctx;
    const notes = events.filter(e => e.stem).sort((a, b) => a.x - b.x);
    const dark = (x, y) => x >= 0 && y >= 0 && x < w && y < h && ink[Math.round(y) * w + Math.round(x)];
    const covered = (A, B, off) => {
      const dir = A.stemDir === 'up' ? 1 : -1;
      let ok = 0, n = 0;
      for (let x = A.stem.x + 1; x <= B.stem.x - 1; x++) {
        const t = (x - A.stem.x) / (B.stem.x - A.stem.x), y = A.stem.y1 + (B.stem.y1 - A.stem.y1) * t + dir * off;
        n++;
        let hit = false;
        for (let dy = -Math.round(il * 0.12); dy <= Math.round(il * 0.12) && !hit; dy++) if (dark(x, y + dy)) hit = true;
        if (hit) ok++;
      }
      return n ? ok / n : 0;
    };
    const vrun = (x, y) => {
      let best = 0;
      for (let y0 = Math.round(y - il * 0.45); y0 <= Math.round(y + il * 0.45); y0++) {
        if (!dark(x, y0) || dark(x, y0 - 1)) continue;
        let run = 0; while (dark(x, y0 + run) && run < il * 2) run++;
        if (Math.abs(y0 + run / 2 - y) < il * 0.5) best = Math.max(best, run);
      }
      return best;
    };
    const isBeam = (A, B, off0, lo, hi) => {
      let bestC = 0;
      const good = [];
      for (let o = off0 + (lo != null ? lo : -il * 0.6); o <= off0 + (hi != null ? hi : il * 0.9); o += 1) {
        const c = covered(A, B, o);
        if (c > bestC) bestC = c;
        if (c >= 0.9) good.push(o);
      }
      if (bestC < 0.9) return false;
      let k = 0; while (k + 1 < good.length && good[k + 1] - good[k] <= 1.01) k++;
      const off = (good[0] + good[k]) / 2;
      A.beamOff = A.beamOff || off;
      const dir = A.stemDir === 'up' ? 1 : -1, y = (A.stem.y1 + B.stem.y1) / 2 + dir * off;
      if (!staff.lines.some(L => Math.abs(L - y) < il * 0.4)) return true;
      const xm = Math.round((A.stem.x + B.stem.x) / 2);
      const line = staff.lines.reduce((p, L) => Math.abs(L - y) < Math.abs(p - y) ? L : p, staff.lines[0]);
      const li = staff.lines.indexOf(line), samples = [];
      for (const xr of [A.stem.x - il * 1.2, A.stem.x - il * 2, B.stem.x + il * 1.2, B.stem.x + il * 2]) samples.push(vrun(Math.round(xr), line));
      samples.sort((p, q) => p - q);
      const ref = Math.max(staff.thick ? staff.thick[li] || 1 : 1, samples[2] || 1);
      return vrun(xm, y) >= ref + Math.max(2, il * 0.12);
    };
    for (let i = 0; i + 1 < notes.length; i++) {
      const A = notes[i], B = notes[i + 1];
      if (A.stemDir !== B.stemDir || B.stem.x - A.stem.x > il * 6 || B.stem.x - A.stem.x < il * 0.8) continue;
      if (!isBeam(A, B, 0)) continue;
      let count = 1;
      const first = A.beamOff || 0;
      A.beamOff = 0;
      const dir = A.stemDir === 'up' ? 1 : -1, xm = Math.round((A.stem.x + B.stem.x) / 2);
      const ym = (A.stem.y1 + B.stem.y1) / 2 + dir * first;
      let run = 0; while (dark(xm, ym + dir * run) && run < il) run++;
      if (!dark(xm, ym + dir * (run + 1)) && isBeam(A, B, first, run + il * 0.32, run + il * 0.75)) count = 2;
      A.beamOff = 0;
      for (const E of [A, B]) E.linkCount = Math.max(E.linkCount || 0, count);
    }
    for (const E of notes) {
      if (E.linkCount) {
        if (E.base !== 'half' && E.base !== 'whole') E.base = E.linkCount >= 2 ? '16th' : 'eighth';
        E.beams = E.linkCount; E.beamed = true; delete E.linkCount;
      } else if (E.beams > 0 && E.base !== 'half' && E.base !== 'whole') E.conf = Math.min(E.conf, 0.55);
      delete E.beamOff;
    }
  }

  function recogniseStaff(ctx, staff, header, regionY, bars) {
    const { il } = ctx;
    const region = { x0: header.musicStart, x1: staff.right - il * 0.2, y0: regionY[0], y1: regionY[1] };
    let heads = findNoteheads(ctx, staff, region).filter(hd => !bars.some(b => Math.abs(hd.x - b.x) < il * 0.45));
    heads.forEach(hd => refineHead(ctx, hd));
    heads = dedupeHeads(heads, il);
    heads.forEach(hd => classifyHead(ctx, hd));
    heads = heads.filter(hd => ledgerOk(ctx, staff, hd));
    const notes = heads.map(hd => {
      const stepF = (staff.bottom - hd.y) / (il / 2), step = Math.round(stepF);
      return { hd, stem: stemFor(ctx, hd), step, pitchConf: 1 - Math.min(1, Math.abs(stepF - step) * 2) };
    });
    const kept = notes.filter(n => {
      if (n.stem) return true;
      const mate = notes.find(m => m !== n && m.stem && Math.abs(m.hd.x - n.hd.x) < il * 1.4 && Math.abs(m.hd.y - n.hd.y) < il * 2.6);
      if (mate) { n.stem = mate.stem; n.shared = true; return true; }
      if (n.hd.type === 'open') return n.step >= -4 && n.step <= 12 && n.hd.score > 0.75;
      return false;
    });
    const rests = findRests(ctx, staff, region, kept.map(n => n.hd), kept.map(n => n.stem));
    kept.sort((a, b) => a.hd.x - b.hd.x);
    const chords = [];
    for (const n of kept) {
      let target = null;
      for (const c of chords) {
        if (c.stem && n.stem && Math.abs(c.stem.x - n.stem.x) <= il * 0.35 && c.stem.dir === n.stem.dir) { target = c; break; }
        if ((!c.stem || !n.stem) && Math.abs(c.x - n.hd.x) < il * 0.7) { target = c; break; }
      }
      if (target) { target.heads.push(n); if (!target.stem && n.stem) target.stem = n.stem; }
      else chords.push({ x: n.hd.x, stem: n.stem, heads: [n] });
    }
    const events = [];
    for (const c of chords) {
      const open = Math.max.apply(null, c.heads.map(n => n.hd.openness || 0));
      c.type = open > 0.3 || c.heads.filter(n => n.hd.type === 'open').length * 2 > c.heads.length ? 'open' : 'filled';
      c.typeConf = Math.min.apply(null, c.heads.map(n => n.hd.typeConf || 0.7));
      const beams = c.type === 'filled' ? countBeams(ctx, c.stem) : 0;
      const base = c.type === 'open' ? (c.stem ? 'half' : 'whole') : ['quarter', 'eighth', '16th', '32nd'][beams];
      const headConf = Math.min.apply(null, c.heads.map(n => Math.min(1, (n.hd.score - 0.5) / 0.45)));
      const pitchConf = Math.min.apply(null, c.heads.map(n => n.pitchConf));
      let durConf = c.type === 'filled' ? (c.stem ? 0.85 : 0.45) : (c.stem ? 0.8 : 0.6);
      if (beams >= 2) durConf -= 0.15;
      durConf = Math.min(durConf, c.typeConf + 0.05);
      events.push({
        type: 'note', x: c.x, base, dots: c.heads.some(n => hasDot(ctx, n.hd, staff)) ? 1 : 0, beams,
        stemDir: c.stem ? c.stem.dir : null, stem: c.stem ? { x: c.stem.x, y0: c.stem.y0, y1: c.stem.y1 } : null,
        notes: c.heads.map(n => ({ step: n.step, x: n.hd.x, y: n.hd.y, accidental: null, centre: n.hd.centre, conf: Math.min(n.pitchConf, Math.min(1, (n.hd.score - 0.5) / 0.45)) })),
        conf: Math.max(0.05, Math.min(headConf, pitchConf, durConf))
      });
    }
    linkBeams(ctx, staff, events);
    for (const r of rests) events.push({ type: 'rest', x: r.x, base: r.type, dots: 0, beams: 0, notes: [], conf: r.conf, y: r.y, restBox: { x0: r.box.x0, y0: r.box.y0, x1: r.box.x1, y1: r.box.y1 } });
    events.sort((a, b) => a.x - b.x);
    return events;
  }

  function assignVoices(events, il) {
    let twoVoice = false;
    for (let i = 0; i < events.length; i++) for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (Math.abs(a.x - b.x) > il * 1.2 || a.type !== 'note' || b.type !== 'note') continue;
      if ((a.stemDir && b.stemDir && a.stemDir !== b.stemDir) || (a.base !== b.base && Math.abs(a.x - b.x) < il * 0.6)) twoVoice = true;
    }
    for (const e of events) e.voice = !twoVoice || e.type === 'rest' || e.stemDir === 'up' ? 1 : 2;
    return twoVoice;
  }

  /** Key vote: a lone non-zero reading cannot override a clear majority. */
  function voteKey(values) {
    const votes = {};
    values.forEach(k => { votes[k] = (votes[k] || 0) + 1; });
    const total = values.length || 1;
    const nz = Object.keys(votes).filter(k => +k !== 0).sort((a, b) => votes[b] - votes[a]);
    if (nz.length && votes[nz[0]] >= 2 && votes[nz[0]] / total >= 0.4) return +nz[0];
    const all = Object.keys(votes).sort((a, b) => votes[b] - votes[a]);
    return all.length ? +all[0] : 0;
  }

  function recognise(P, staves, layout, partIndex, partSpec) {
    const clean = removeStaffLines(P, staves, P.ink), looseClean = removeStaffLines(P, staves, P.bin);
    const ii = integral(clean, P.w, P.h);
    const ctx = { ink: P.ink, inkLevel: P.inkLevel, clean, loose: looseClean, bin: P.bin, gray: P.gray, paper: paperLevel(P.gray, 0.3), w: P.w, h: P.h, il: P.interline, box: makeBox(ii, P.w, P.h) };
    const part = partSpec || layout.parts[partIndex] || layout.parts[0];
    const measures = [], headers = [], sysOut = [], warnings = [];
    for (const sys of layout.systems) {
      const slot = slotForPart(sys, part);
      if (!slot) { warnings.push({ system: sys.index, code: 'PART_NOT_FOUND', message: 'System ' + (sys.index + 1) + ': no ' + (part ? part.kind : '') + ' staff found; skipped.' }); continue; }
      const st = slot.staves.map(i => staves[i]), il = st[0].interline;
      const regions = st.map(s => {
        const idx = staves.indexOf(s), prev = staves[idx - 1], next = staves[idx + 1];
        const up = prev ? Math.max(s.top - il * 5, (prev.bottom + s.top) / 2) : s.top - il * 5;
        const down = next ? Math.min(s.bottom + il * 5, (s.bottom + next.top) / 2) : s.bottom + il * 5;
        return [Math.max(0, up), Math.min(P.h - 1, down)];
      });
      const hdrs = st.map((s, k) => {
        const hd = readHeader(clean, P.w, P.h, s);
        hd.detectedClef = hd.clef;
        if (st.length === 2) hd.clef = k === 0 ? 'treble' : 'bass';
        else if (!hd.clef) hd.clef = 'treble';
        return hd;
      });
      const musicStart = Math.max.apply(null, hdrs.map(hh => hh.musicStart));
      hdrs.forEach(hh => { hh.musicStart = musicStart; });
      const right = Math.min.apply(null, st.map(s => s.right));
      const bars = findBarlines(ctx, st, { x0: musicStart, x1: right + 2 });
      if (!bars.length || right - bars[bars.length - 1].x > il * 1.5) bars.push({ x: right, x0: right, x1: right, final: false, implicit: true });
      const staffEvents = st.map((s, k) => recogniseStaff(ctx, s, hdrs[k], regions[k], bars));
      const bounds = [musicStart].concat(bars.map(b => b.x));
      for (let m = 0; m + 1 < bounds.length; m++) {
        const a = bounds[m], b = bounds[m + 1];
        if (b - a < il * 1.2) continue;
        measures.push({
          system: sys.index, x0: a, x1: b, y0: st[0].top - il * 3, y1: st[st.length - 1].bottom + il * 3,
          staves: st.map((s, k) => {
            const evs = staffEvents[k].filter(e => e.x > a && e.x < b);
            assignVoices(evs, il);
            return { clef: hdrs[k].clef, staff: { top: s.top, bottom: s.bottom, left: s.left, right: s.right, interline: s.interline, lines: s.lines }, events: evs };
          })
        });
      }
      headers.push(hdrs.map(hh => ({ clef: hh.clef, detectedClef: hh.detectedClef, key: hh.key, hasTime: hh.timeBoxes.length > 0, musicStart: hh.musicStart })));
      sysOut.push({ index: sys.index, staves: st.map(s => ({ top: s.top, bottom: s.bottom, left: s.left, right: s.right })), bars: bars.map(b => b.x) });
    }
    const key = voteKey([].concat.apply([], headers.map(row => row.map(hh => hh.key))));
    return { measures, headers, systems: sysOut, key, warnings, part: part ? { name: part.name, kind: part.kind, ordinal: part.ordinal, staves: part.staves } : null };
  }

  function analysePage(gray, w, h, opts) {
    opts = opts || {};
    const P = prepare(gray, w, h, opts), staves = detectStaves(P), layout = detectLayout(P, staves);
    const out = {
      width: P.w, height: P.h, scale: P.scale, skew: P.skew, interline: P.interline,
      staves: staves.map(s => ({ top: s.top, bottom: s.bottom, left: s.left, right: s.right, lines: s.lines, interline: s.interline })),
      layout: { parts: layout.parts, consistent: layout.consistent, systems: layout.systems.map(s => ({ index: s.index, staves: s.staves, slots: s.slots })) }
    };
    if (opts.partIndex != null && staves.length) {
      const spec = opts.part ? { name: opts.part.name, kind: opts.part.kind, ordinal: opts.part.ordinal || 0, staves: opts.part.kind === 'piano' ? 2 : 1 } : null;
      out.recognition = recognise(P, staves, layout, opts.partIndex, spec);
    }
    if (opts.returnImage) out.image = P.gray;
    return out;
  }

  return {
    TARGET_INTERLINE, DUR, otsu, resize, binarise, estimateInterline, estimateInterlineProfile, estimateSkew,
    prepare, detectStaves, detectLayout, slotForPart, voteKey, recognise, analysePage, stepToDiatonic
  };
});
