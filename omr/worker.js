/* Piano Companion OMR worker: keeps heavy recognition off the UI thread. */
importScripts('engine.js', 'geometry.js');
self.onmessage = function (ev) {
  const msg = ev.data;
  try {
    if (msg.cmd !== 'analyse') return;
    let gray = new Uint8Array(msg.gray), w = msg.w, h = msg.h;
    if (msg.corners && !OMRGeometry.isIdentity(msg.corners, w, h)) { const r = OMRGeometry.warp(gray, w, h, msg.corners); gray = r.gray; w = r.w; h = r.h; }
    const res = OMREngine.analysePage(gray, w, h, { partIndex: msg.partIndex, part: msg.part, returnImage: true });
    const img = res.image; delete res.image; res.imageBuffer = img.buffer;
    self.postMessage({ id: msg.id, result: res }, [img.buffer]);
  } catch (err) {
    self.postMessage({ id: msg.id, error: String((err && err.stack) || err) });
  }
};
