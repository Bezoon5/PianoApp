/* Piano Companion page geometry: page detection, perspective correction, rotation, quality. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OMRGeometry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const n = 8, M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c] || 1e-12;
      for (let k = c; k <= n; k++) M[c][k] /= d;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const h = M.map(r => r[n]);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function warp(gray, w, h, corners, maxSide) {
    maxSide = maxSide || 2600;
    const [tl, tr, br, bl] = corners;
    let ow = Math.max(dist(tl, tr), dist(bl, br)), oh = Math.max(dist(tl, bl), dist(tr, br));
    const s = Math.min(1, maxSide / Math.max(ow, oh));
    ow = Math.max(8, Math.round(ow * s)); oh = Math.max(8, Math.round(oh * s));
    const H = homography([[0, 0], [ow - 1, 0], [ow - 1, oh - 1], [0, oh - 1]], [tl, tr, br, bl]);
    const out = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const d = H[6] * x + H[7] * y + H[8];
      const sx = (H[0] * x + H[1] * y + H[2]) / d, sy = (H[3] * x + H[4] * y + H[5]) / d;
      if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) { out[y * ow + x] = 255; continue; }
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
      out[y * ow + x] = (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) + (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
    }
    return { gray: out, w: ow, h: oh };
  }
  function isIdentity(corners, w, h) {
    const ref = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
    return corners.every((c, i) => Math.abs(c[0] - ref[i][0]) < 1.5 && Math.abs(c[1] - ref[i][1]) < 1.5);
  }
  function autoCorners(gray, w, h) {
    const full = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]];
    const s = Math.min(1, 360 / Math.max(w, h)), sw = Math.max(4, Math.round(w * s)), sh = Math.max(4, Math.round(h * s));
    const small = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] = gray[Math.min(h - 1, Math.floor(y / s)) * w + Math.min(w - 1, Math.floor(x / s))];
    const hist = new Float64Array(256);
    for (let i = 0; i < small.length; i++) hist[small[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = small.length - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, bt = wB * wF * (mB - mF) * (mB - mF);
      if (bt > best) { best = bt; thr = t; }
    }
    const bright = new Uint8Array(sw * sh);
    let frac = 0;
    for (let i = 0; i < small.length; i++) { bright[i] = small[i] > thr ? 1 : 0; frac += bright[i]; }
    if (frac / bright.length > 0.93) return { corners: full, detected: false };
    const closed = new Uint8Array(sw * sh), r = 3;
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let n = 0, t = 0;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= sh || xx >= sw) continue;
        t++; n += bright[yy * sw + xx];
      }
      closed[y * sw + x] = n / t > 0.35 ? 1 : 0;
    }
    const lab = new Int32Array(sw * sh), stack = [];
    let bestId = 0, bestN = 0, idc = 0;
    for (let i = 0; i < closed.length; i++) {
      if (!closed[i] || lab[i]) continue;
      idc++; let n = 0; stack.push(i); lab[i] = idc;
      while (stack.length) {
        const k = stack.pop(); n++;
        const x = k % sw, y = (k / sw) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
          const j = yy * sw + xx; if (closed[j] && !lab[j]) { lab[j] = idc; stack.push(j); }
        }
      }
      if (n > bestN) { bestN = n; bestId = idc; }
    }
    if (bestN < sw * sh * 0.15) return { corners: full, detected: false };
    let tl, tr, br, bl, vtl = Infinity, vtr = -Infinity, vbr = -Infinity, vbl = Infinity;
    for (let k = 0; k < lab.length; k++) {
      if (lab[k] !== bestId) continue;
      const x = k % sw, y = (k / sw) | 0;
      if (x + y < vtl) { vtl = x + y; tl = [x, y]; }
      if (x - y > vtr) { vtr = x - y; tr = [x, y]; }
      if (x + y > vbr) { vbr = x + y; br = [x, y]; }
      if (x - y < vbl) { vbl = x - y; bl = [x, y]; }
    }
    // A table or background is smooth; shadowed paper still has staff lines and text.
    // If the area outside the detected page is about as busy as the page, the "edge"
    // is a shadow, so keep the whole image rather than cutting music off.
    let inE = 0, inN = 0, outE = 0, outN = 0;
    const edge = 12;
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < sw - 1; x++) {
      const k = y * sw + x, g = Math.abs(small[k + 1] - small[k - 1]) + Math.abs(small[k + sw] - small[k - sw]);
      const e = g > edge * 2 ? 1 : 0;
      if (lab[k] === bestId) { inE += e; inN++; } else { outE += e; outN++; }
    }
    if (outN > sw * sh * 0.03 && outE / outN > 0.5 * (inE / Math.max(1, inN))) return { corners: full, detected: false, shadow: true };
    const up = p => [Math.min(w - 1, p[0] / s), Math.min(h - 1, p[1] / s)];
    return { corners: [up(tl), up(tr), up(br), up(bl)], detected: true };
  }
  function rotate90(gray, w, h, clockwise) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      if (clockwise) out[x * h + (h - 1 - y)] = v; else out[(w - 1 - x) * h + y] = v;
    }
    return { gray: out, w: h, h: w };
  }
  function quality(gray, w, h) {
    let sum = 0, sum2 = 0, n = 0, lap = 0;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const v = gray[y * w + x]; sum += v; sum2 += v * v; n++;
      const l = 4 * v - gray[y * w + x - 1] - gray[y * w + x + 1] - gray[(y - 1) * w + x] - gray[(y + 1) * w + x];
      lap += l * l;
    }
    const mean = sum / n;
    return { width: w, height: h, mean, contrast: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), sharpness: lap / n };
  }
  return { homography, warp, autoCorners, rotate90, quality, isIdentity };
});
