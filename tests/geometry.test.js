const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../omr/geometry.js');
const E = require('../omr/engine.js');
const readPGM = require('./pgm.js');
test('homography maps the four control points exactly', () => {
  const src = [[0, 0], [100, 0], [100, 50], [0, 50]], dst = [[10, 5], [120, 0], [110, 70], [0, 60]], H = G.homography(src, dst);
  src.forEach((p, i) => {
    const d = H[6] * p[0] + H[7] * p[1] + H[8];
    assert.ok(Math.abs((H[0] * p[0] + H[1] * p[1] + H[2]) / d - dst[i][0]) < 1e-6);
    assert.ok(Math.abs((H[3] * p[0] + H[4] * p[1] + H[5]) / d - dst[i][1]) < 1e-6);
  });
});
test('perspective-distorted photo: page detected, corrected and re-analysed', () => {
  const im = readPGM(__dirname + '/fixtures/happy-birthday.pgm'), W = 480, Hh = 500, out = new Uint8Array(W * Hh).fill(90);
  const quad = [[30, 20], [420, 5], [440, 480], [10, 470]];
  const Hi = G.homography(quad, [[0, 0], [im.w - 1, 0], [im.w - 1, im.h - 1], [0, im.h - 1]]);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const d = Hi[6] * x + Hi[7] * y + 1, sx = (Hi[0] * x + Hi[1] * y + Hi[2]) / d, sy = (Hi[3] * x + Hi[4] * y + Hi[5]) / d;
    if (sx >= 0 && sy >= 0 && sx < im.w - 1 && sy < im.h - 1) out[y * W + x] = im.gray[Math.round(sy) * im.w + Math.round(sx)];
  }
  const ac = G.autoCorners(out, W, Hh);
  assert.equal(ac.detected, true);
  ac.corners.forEach((c, i) => assert.ok(Math.hypot(c[0] - quad[i][0], c[1] - quad[i][1]) < 12));
  const r = G.warp(out, W, Hh, ac.corners), a = E.analysePage(r.gray, r.w, r.h, { partIndex: 0 });
  assert.equal(a.staves.length, 6);
  assert.equal(a.recognition.measures.length, 9);
});
test('deskew recovers a 2° rotated page', () => {
  const im = readPGM(__dirname + '/fixtures/happy-birthday.pgm'), w = im.w, h = im.h, a = 2 * Math.PI / 180, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - w / 2, dy = y - h / 2, sx = Math.round(Math.cos(a) * dx + Math.sin(a) * dy + w / 2), sy = Math.round(-Math.sin(a) * dx + Math.cos(a) * dy + h / 2);
    out[y * w + x] = sx >= 0 && sy >= 0 && sx < w && sy < h ? im.gray[sy * w + sx] : 255;
  }
  const r = E.analysePage(out, w, h, {});
  assert.ok(Math.abs(Math.abs(r.skew) - 2) <= 0.5);
  assert.equal(r.staves.length, 6);
});
