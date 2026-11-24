/*
 * Piano Companion OMR review workflow
 *   1. Pages: capture/import, crop, perspective, rotation
 *   2. Layout: systems, instruments, part selection, OCR metadata
 *   3. Review: side by side, uncertain measures, correction, validation
 *   4. Save: MusicXML + playable practice piece
 * Notes are read either on this device (omr/engine.js) or by a homr server
 * (omr/homr.js, server/), chosen in step 2.
 */
(function () {
  'use strict';
  const M = window.OMRModel, G = window.OMRGeometry, H = window.OMRHomr;
  const $ = id => document.getElementById(id);
  const DUR_LABEL = { whole: 'Whole', half: 'Half', quarter: 'Quarter', eighth: 'Eighth', '16th': '16th', '32nd': '32nd' };
  const PAGE_TIMEOUT_MS = 90000;

  const state = {
    pages: [], current: 0, step: 1, parts: [], partIndex: 0, partChosen: false,
    score: null, sel: null, addMode: false, addBase: 'quarter', view: 'split',
    history: [], stream: null, reviewPage: 0, meta: { title: '', composer: '', tempo: 90 }, ocrBusy: false, ocrRun: 0, saving: false
  };

  /* ------------------------- AI recognition settings ----------------------- */
  const store = {
    get: k => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* private mode */ } }
  };
  // Built-in recognition server (server/, deployed on Google Cloud Run). Settings can override it;
  // tests set window.PC_DEFAULT_HOMR_URL = '' so they never call the real server.
  const DEFAULT_HOMR_URL = typeof window.PC_DEFAULT_HOMR_URL === 'string' ? window.PC_DEFAULT_HOMR_URL : 'https://piano-recogniser-4nnhn44cva-ew.a.run.app';
  function homrConfig() { return { url: H ? H.normaliseUrl(store.get('pc-homr-url') || DEFAULT_HOMR_URL) : '', key: store.get('pc-homr-key') }; }
  /** 'homr' when a server is configured (unless the user picked the device), else 'device'. */
  function engine() {
    if (!H || !homrConfig().url) return 'device';
    return store.get('pc-omr-engine') === 'device' ? 'device' : 'homr';
  }
  function canRecognise() { return engine() === 'homr' ? state.pages.length > 0 : state.parts.length > 0; }

  /* -------------------------------- Worker -------------------------------- */
  let worker = null, reqId = 0;
  const pending = {};
  function killWorker(reason) {
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } }
    worker = false;
    Object.keys(pending).forEach(k => { const p = pending[k]; delete pending[k]; clearTimeout(p.timer); p.reject(new Error(reason)); });
  }
  function getWorker() {
    if (worker !== null) return worker;
    try {
      worker = new Worker('omr/worker.js');
      worker.onmessage = ev => {
        const m = ev.data, p = pending[m.id];
        if (!p) return;
        delete pending[m.id]; clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      };
      worker.onerror = e => { if (e && e.preventDefault) e.preventDefault(); killWorker('Recognition worker failed to load'); };
    } catch (e) { worker = false; }
    return worker;
  }
  function analyseMain(page, partIndex, part) {
    return new Promise((resolve, reject) => setTimeout(() => {
      try {
        let g = page.gray, w2 = page.w, h2 = page.h;
        if (!G.isIdentity(page.corners, w2, h2)) { const r = G.warp(g, w2, h2, page.corners); g = r.gray; w2 = r.w; h2 = r.h; }
        resolve(window.OMREngine.analysePage(g, w2, h2, { partIndex, part, returnImage: true }));
      } catch (e) { reject(e); }
    }, 30));
  }
  function analyse(page, partIndex, part) {
    const w = getWorker();
    if (!w) return analyseMain(page, partIndex, part);
    return new Promise((resolve, reject) => {
      const id = ++reqId, copy = page.gray.slice();
      const timer = setTimeout(() => killWorker('Recognition timed out'), PAGE_TIMEOUT_MS);
      pending[id] = { resolve, reject, timer };
      w.postMessage({ cmd: 'analyse', id, gray: copy.buffer, w: page.w, h: page.h, corners: page.corners, partIndex, part }, [copy.buffer]);
    }).then(r => { r.image = new Uint8Array(r.imageBuffer); delete r.imageBuffer; return r; })
      .catch(err => {
        if (/worker|timed out/i.test(err.message)) { status('Background recognition unavailable (' + err.message + '); continuing on the main thread.'); return analyseMain(page, partIndex, part); }
        throw err;
      });
  }
  function partSpec() { const p = state.parts[state.partIndex]; return p ? { name: p.name, kind: p.kind, ordinal: p.ordinal || 0 } : null; }

  /* ----------------------------- Page loading ----------------------------- */
  function grayFromCanvas(cv) {
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data, g = new Uint8Array(cv.width * cv.height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) { const a = d[i + 3] / 255; g[j] = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a)); }
    return g;
  }
  function canvasFromGray(g, w, h) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'), im = ctx.createImageData(w, h);
    for (let j = 0, i = 0; j < g.length; j++, i += 4) { im.data[i] = im.data[i + 1] = im.data[i + 2] = g[j]; im.data[i + 3] = 255; }
    ctx.putImageData(im, 0, 0);
    return cv;
  }
  async function addImageSource(src, name, source) {
    const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight, s = Math.min(1, 3200 / Math.max(sw, sh));
    const cv = document.createElement('canvas'); cv.width = Math.round(sw * s); cv.height = Math.round(sh * s);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    const gray = grayFromCanvas(cv);
    const full = [[0, 0], [cv.width - 1, 0], [cv.width - 1, cv.height - 1], [0, cv.height - 1]];
    const auto = source === 'pdf' ? { corners: full, detected: false } : G.autoCorners(gray, cv.width, cv.height);
    state.pages.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, source, gray, w: cv.width, h: cv.height, corners: auto.corners, autoDetected: auto.detected, shadow: !!auto.shadow, canvas: canvasFromGray(gray, cv.width, cv.height), q: G.quality(gray, cv.width, cv.height) });
    state.current = state.pages.length - 1;
    renderPages();
  }
  async function loadFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try { await addImageSource(await createImageBitmap(f), f.name, 'photo'); }
      catch (e) { status('Could not read ' + f.name + ': ' + e.message); }
    }
  }
  async function loadPdf(file) {
    status('Loading PDF renderer…');
    try {
      const pdfjs = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        status('Rendering PDF page ' + n + ' of ' + pdf.numPages + '…');
        const pg = await pdf.getPage(n), v1 = pg.getViewport({ scale: 1 }), v = pg.getViewport({ scale: Math.min(4, 2200 / v1.width) });
        const cv = document.createElement('canvas'); cv.width = v.width; cv.height = v.height;
        const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
        await pg.render({ canvasContext: ctx, viewport: v }).promise;
        await addImageSource(cv, file.name + ' · page ' + n, 'pdf');
        cv.width = cv.height = 0; pg.cleanup();
      }
      status(pdf.numPages + ' PDF page(s) added.');
    } catch (e) { status('PDF import failed: ' + e.message); }
  }

  /* -------------------------------- Camera -------------------------------- */
  async function startCamera() {
    $('omrCamera').hidden = false;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3000 }, height: { ideal: 4000 } }, audio: false });
      $('omrVideo').srcObject = state.stream;
      await $('omrVideo').play();
      $('omrCamHint').textContent = 'Hold the phone parallel to the page, fill the guide and use even light.';
    } catch (e) { $('omrCamHint').textContent = 'Camera unavailable: ' + e.message + ' (camera access requires HTTPS).'; }
  }
  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null; $('omrCamera').hidden = true;
  }
  async function capture() {
    if (!$('omrVideo').videoWidth) return;
    const name = 'Camera page ' + (state.pages.length + 1);
    // A still photo is usually much sharper than a frame of the live preview.
    const track = state.stream && state.stream.getVideoTracks()[0];
    if (track && typeof ImageCapture !== 'undefined') {
      try {
        const blob = await new ImageCapture(track).takePhoto();
        await addImageSource(await createImageBitmap(blob), name, 'camera');
        $('omrCamHint').textContent = 'Captured page ' + state.pages.length + '. Capture another or press Done.';
        return;
      } catch (e) { /* fall back to the preview frame */ }
    }
    await addImageSource($('omrVideo'), name, 'camera');
    $('omrCamHint').textContent = 'Captured page ' + state.pages.length + '. Capture another or press Done.';
  }

  /* ---------------------------- Step 1: pages ----------------------------- */
  function status(t) { $('omrStatus').textContent = t; const r = $('omrReviewStatus'); if (state.step === 3 && r) r.textContent = t; }
  function renderPages() {
    const list = $('omrPageList');
    list.replaceChildren();
    state.pages.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'opage' + (i === state.current ? ' on' : '');
      const th = document.createElement('canvas'), s = 90 / p.w;
      th.width = 90; th.height = Math.round(p.h * s);
      th.getContext('2d').drawImage(p.canvas, 0, 0, th.width, th.height);
      const lab = document.createElement('span'); lab.textContent = (i + 1) + '. ' + p.name;
      b.append(th, lab);
      b.onclick = () => { state.current = i; renderPages(); };
      list.append(b);
    });
    $('omrNext1').disabled = !state.pages.length;
    $('omrEmpty').hidden = !!state.pages.length;
    drawCrop();
    const p = state.pages[state.current];
    if (p) {
      const tips = [];
      if (Math.max(p.w, p.h) < 1000) tips.push('Low resolution (' + p.w + '×' + p.h + '). Recognition works best above ~1500 px; small screenshots need careful review.');
      if (p.q.contrast < 35) tips.push('Low contrast: use brighter, even light.');
      if (p.q.sharpness < 40 && Math.max(p.w, p.h) > 1000) tips.push('Image may be blurred: hold steady or move closer.');
      if (p.autoDetected) tips.push('Page edges detected automatically. Drag the corners to adjust.');
      if (p.shadow) tips.push('Uneven lighting or a shadow: the whole photo is kept. Drag the corners if you want to crop.');
      $('omrQuality').textContent = tips.join(' ') || 'Page looks good. Drag the corners if the crop needs adjusting.';
    } else $('omrQuality').textContent = '';
  }

  let drag = null;
  function cropGeom() {
    const p = state.pages[state.current], cv = $('omrCrop');
    if (!p) return null;
    const wrap = cv.parentElement, W = wrap.clientWidth - 4, H = Math.max(260, wrap.clientHeight - 4), k = Math.min(W / p.w, H / p.h);
    return { p, cv, k, ox: (W - p.w * k) / 2 + 2, oy: 2 };
  }
  function drawCrop() {
    const g = cropGeom(), cv = $('omrCrop');
    if (!g) { cv.width = 1; cv.height = 1; return; }
    const { p, k, ox, oy } = g, d = window.devicePixelRatio || 1, wrap = cv.parentElement;
    cv.width = wrap.clientWidth * d; cv.height = Math.max(260, wrap.clientHeight) * d;
    cv.style.width = wrap.clientWidth + 'px'; cv.style.height = Math.max(260, wrap.clientHeight) + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.fillStyle = '#0b1626'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(p.canvas, ox, oy, p.w * k, p.h * k);
    const pts = p.corners.map(c => [ox + c[0] * k, oy + c[1] * k]);
    ctx.fillStyle = 'rgba(3,10,20,.45)';
    ctx.beginPath(); ctx.rect(ox, oy, p.w * k, p.h * k);
    ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 3; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath(); ctx.fill('evenodd');
    ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.beginPath();
    pts.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])); ctx.closePath(); ctx.stroke();
    pts.forEach(q => { ctx.beginPath(); ctx.arc(q[0], q[1], 11, 0, 7); ctx.fillStyle = 'rgba(56,189,248,.35)'; ctx.fill(); ctx.stroke(); });
  }
  function cropPointer(ev, phase) {
    const g = cropGeom(); if (!g) return;
    const r = g.cv.getBoundingClientRect(), px = (ev.clientX - r.left - g.ox) / g.k, py = (ev.clientY - r.top - g.oy) / g.k;
    if (phase === 'down') {
      let best = -1, bd = 30 / g.k;
      g.p.corners.forEach((c, i) => { const d = Math.hypot(c[0] - px, c[1] - py); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { drag = best; g.cv.setPointerCapture(ev.pointerId); }
    } else if (phase === 'move' && drag != null) {
      g.p.corners[drag] = [Math.max(0, Math.min(g.p.w - 1, px)), Math.max(0, Math.min(g.p.h - 1, py))];
      g.p.layout = null; drawCrop();
    } else if (phase === 'up') drag = null;
  }
  function rotatePage(cw) {
    const p = state.pages[state.current]; if (!p) return;
    const r = G.rotate90(p.gray, p.w, p.h, cw);
    Object.assign(p, { gray: r.gray, w: r.w, h: r.h, canvas: canvasFromGray(r.gray, r.w, r.h), corners: [[0, 0], [r.w - 1, 0], [r.w - 1, r.h - 1], [0, r.h - 1]], layout: null });
    renderPages();
  }

  /* ---------------------------- Step 2: layout ---------------------------- */
  async function runLayout() {
    goStep(2);
    $('omrLayoutInfo').textContent = 'Detecting staves, systems and instruments…';
    $('omrNext2').disabled = true;
    for (let i = 0; i < state.pages.length; i++) {
      const p = state.pages[i];
      if (p.layout && !p.layout.error) continue;
      $('omrLayoutInfo').textContent = 'Analysing page ' + (i + 1) + ' of ' + state.pages.length + '…';
      try { p.layout = await analyse(p, null, null); p.prepCanvas = canvasFromGray(p.layout.image, p.layout.width, p.layout.height); delete p.layout.image; }
      catch (e) { p.layout = { error: e.message, staves: [], layout: { parts: [], systems: [] } }; }
    }
    const first = state.pages.find(p => p.layout && p.layout.layout.parts.length);
    state.parts = first ? first.layout.layout.parts.map(x => Object.assign({}, x)) : [];
    state.partChosen = false;
    state.partIndex = Math.max(0, state.parts.findIndex(x => x.kind === 'piano'));
    renderLayout();
    $('omrNext2').disabled = !canRecognise();
    runOcr(first);
  }
  function renderLayout() {
    const info = [];
    state.pages.forEach((p, i) => {
      const L = p.layout;
      if (!L || L.error) { info.push('Page ' + (i + 1) + ': analysis failed' + (L && L.error ? ' (' + L.error.split('\n')[0] + ')' : '')); return; }
      info.push('Page ' + (i + 1) + ': ' + L.staves.length + ' staves in ' + L.layout.systems.length + ' systems' + (L.skew ? ', deskewed ' + L.skew.toFixed(2) + '°' : '') + '.');
    });
    if (engine() === 'homr') info.unshift('AI recognition reads the layout itself and picks the piano part unless you choose another below. Quick on-device check:');
    if (!state.parts.length) info.push(engine() === 'homr' ? 'The quick on-device check found no staves, but AI recognition may still read this page.' : 'No five-line staves were found. Check the crop, rotation and image quality, or set up AI recognition in Settings.');
    renderEngines();
    $('omrLayoutInfo').textContent = info.join(' ');
    const box = $('omrParts'); box.replaceChildren();
    state.parts.forEach((pt, i) => {
      const l = document.createElement('label'); l.className = 'opart';
      const r = document.createElement('input'); r.type = 'radio'; r.name = 'omrPart'; r.checked = i === state.partIndex;
      r.onchange = () => { state.partIndex = i; state.partChosen = true; drawLayout(); };
      const t = document.createElement('span');
      t.textContent = pt.name + (pt.kind === 'piano' ? ' · grand staff (treble + bass)' : ' · single staff') + (pt.label ? ' · label “' + pt.label + '”' : '');
      l.append(r, t); box.append(l);
    });
    $('omrTitle').value = state.meta.title; $('omrComposer').value = state.meta.composer; $('omrTempo').value = state.meta.tempo;
    drawLayout();
  }
  function renderEngines() {
    const cfg = homrConfig(), eng = engine();
    document.querySelectorAll('input[name="omrEngine"]').forEach(r => {
      r.checked = r.value === eng;
      if (r.value === 'homr') r.disabled = !cfg.url;
    });
    $('omrEngineHint').textContent = cfg.url ? 'Sends each page to ' + cfg.url.replace(/^https?:\/\//, '') + '. About 30 s–2 min per page.' : 'Not set up: add a server address in Settings → Photo recognition.';
    $('omrNext2').textContent = eng === 'homr' ? 'Recognise with AI →' : 'Recognise notes →';
  }
  const SLOT_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#4ade80'];
  function drawLayout() {
    const p = state.pages.find(q => q.layout && q.prepCanvas && !q.layout.error), cv = $('omrLayoutCanvas');
    if (!p) return;
    const L = p.layout, W = cv.parentElement.clientWidth - 4, k = W / L.width, d = window.devicePixelRatio || 1;
    cv.width = W * d; cv.height = L.height * k * d; cv.style.width = W + 'px'; cv.style.height = L.height * k + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(d * k, 0, 0, d * k, 0, 0);
    ctx.drawImage(p.prepCanvas, 0, 0);
    if (engine() === 'homr') return; // the on-device boxes would only confuse; AI reads the layout itself
    const chosen = state.parts[state.partIndex] || {};
    L.layout.systems.forEach(sys => {
      const ord = {};
      sys.slots.forEach((slot, si) => {
        const o = ord[slot.kind] = (ord[slot.kind] == null ? 0 : ord[slot.kind] + 1);
        const st = slot.staves.map(i => L.staves[i]), top = st[0].top - L.interline, bottom = st[st.length - 1].bottom + L.interline;
        const sel = slot.kind === chosen.kind && o === (chosen.ordinal || 0);
        ctx.fillStyle = sel ? 'rgba(56,189,248,.16)' : 'rgba(245,158,11,.10)';
        ctx.fillRect(st[0].left, top, st[0].right - st[0].left, bottom - top);
        ctx.strokeStyle = sel ? '#0284c7' : SLOT_COLORS[si % 4]; ctx.lineWidth = 3.6 / k;
        ctx.strokeRect(st[0].left, top, st[0].right - st[0].left, bottom - top);
        ctx.fillStyle = sel ? '#0369a1' : '#b45309'; ctx.font = (14 / k) + 'px system-ui';
        const named = state.parts.find(pp => pp.kind === slot.kind && (pp.ordinal || 0) === o);
        ctx.fillText(named ? named.name : slot.kind, st[0].left + 4 / k, top - 4 / k);
      });
    });
  }
  async function runOcr(page) {
    if (!page || !page.prepCanvas) return;
    if (!window.Tesseract) { $('omrOcrStatus').textContent = 'OCR library unavailable: enter title and tempo manually.'; return; }
    if (state.ocrBusy) return;
    state.ocrBusy = true;
    const run = ++state.ocrRun;
    $('omrOcrStatus').textContent = 'Reading title, tempo and instrument labels (OCR)…';
    let worker = null;
    try {
      const L = page.layout, cv = page.prepCanvas;
      worker = await Tesseract.createWorker('eng');
      const firstTop = L.staves.length ? L.staves[0].top : cv.height * 0.2;
      const titleCv = document.createElement('canvas'); titleCv.width = cv.width; titleCv.height = Math.max(40, Math.round(firstTop - L.interline * 1.5));
      titleCv.getContext('2d').drawImage(cv, 0, 0);
      const t = await worker.recognize(titleCv);
      if (run !== state.ocrRun) return;
      const lines = (t.data.lines || []).map(l => ({ text: l.text.trim(), h: l.bbox.y1 - l.bbox.y0, conf: l.confidence, y: l.bbox.y0 })).filter(l => l.text.length > 2 && l.conf > 40);
      const tempo = (t.data.text || '').match(/=\s*(\d{2,3})/);
      if (tempo && !state.meta.tempoEdited) { state.meta.tempo = Math.max(30, Math.min(220, +tempo[1])); $('omrTempo').value = state.meta.tempo; }
      const titleLine = lines.filter(l => !/arr\.|arranged|copyright|©|from\s|^\s*[♩=]/i.test(l.text)).sort((a, b) => b.h - a.h)[0];
      if (titleLine && !state.meta.titleEdited) { state.meta.title = titleLine.text.replace(/[|_]+/g, '').trim(); $('omrTitle').value = state.meta.title; }
      const comp = lines.find(l => l !== titleLine && /arr\.|arranged|by\s|composed/i.test(l.text));
      if (comp && !state.meta.composerEdited) { state.meta.composer = comp.text; $('omrComposer').value = comp.text; }
      const sys = L.layout.systems[0];
      if (sys) {
        const ord = {};
        for (let si = 0; si < sys.slots.length; si++) {
          const slot = sys.slots[si], o = ord[slot.kind] = (ord[slot.kind] == null ? 0 : ord[slot.kind] + 1);
          const part = state.parts.find(pp => pp.kind === slot.kind && (pp.ordinal || 0) === o);
          const st = slot.staves.map(i => L.staves[i]), x1 = Math.max(10, st[0].left - L.interline * 0.8);
          const c = document.createElement('canvas'); c.width = Math.round(x1); c.height = Math.round(st[st.length - 1].bottom - st[0].top + L.interline * 4);
          c.getContext('2d').drawImage(cv, 0, Math.round(st[0].top - L.interline * 2), c.width, c.height, 0, 0, c.width, c.height);
          const r = await worker.recognize(c);
          if (run !== state.ocrRun) return;
          const label = (r.data.text || '').replace(/\s+/g, ' ').trim();
          if (label && part) {
            part.label = label;
            if (/pian|pno/i.test(label)) part.name = 'Piano';
            else if (/clar|cl\b/i.test(label)) part.name = 'B♭ Clarinet';
            else if (/flute|fl\b/i.test(label)) part.name = 'Flute';
            else if (/viol|vln/i.test(label)) part.name = 'Violin';
            else if (/voice|sop|alto|ten/i.test(label)) part.name = 'Voice';
          }
        }
        if (!state.partChosen) { const pi = state.parts.findIndex(x => x.name === 'Piano'); if (pi >= 0) state.partIndex = pi; }
      }
      $('omrOcrStatus').textContent = 'OCR complete. Check the title, tempo and part names.';
      if (state.step === 2) renderLayout();
    } catch (e) { $('omrOcrStatus').textContent = 'OCR could not run (' + e.message + '). Enter details manually.'; }
    finally { if (worker) worker.terminate().catch(() => {}); state.ocrBusy = false; }
  }

  /* ---------------------------- Step 3: review ---------------------------- */
  async function runRecognition() {
    state.meta.title = $('omrTitle').value.trim();
    state.meta.composer = $('omrComposer').value.trim();
    state.meta.tempo = Math.max(30, Math.min(220, +$('omrTempo').value || 90));
    state.ocrRun++;
    if (engine() === 'homr') return runHomr();
    return runDeviceRecognition();
  }

  /** Warp the page to the chosen corners and encode it for the server. */
  function pageBlob(p) {
    let g = p.gray, w = p.w, h = p.h;
    if (!G.isIdentity(p.corners, w, h)) { const r = G.warp(g, w, h, p.corners); g = r.gray; w = r.w; h = r.h; }
    const cv = canvasFromGray(g, w, h);
    p.sentCanvas = cv;
    return new Promise((resolve, reject) => cv.toBlob(b => b ? resolve(b) : reject(new Error('could not prepare the page image')), 'image/jpeg', 0.92));
  }
  function cancelHomr() { if (state.homrAbort) { state.homrAbort.abort(); state.homrAbort = null; } }

  async function runHomr() {
    goStep(3);
    $('omrNext2').disabled = true;
    cancelHomr();
    // The quick on-device layout guess is unreliable on photos: only use a part the user picked.
    const ctl = state.homrAbort = new AbortController(), cfg = homrConfig(), spec = state.partChosen ? partSpec() : null;
    const results = [], failures = [];
    const say = t => { if (!ctl.signal.aborted) $('omrReviewStatus').textContent = t; };
    let timer = null;
    const ticking = (label) => { const t0 = Date.now(); clearInterval(timer); say(label); timer = setInterval(() => say(label + ' ' + Math.round((Date.now() - t0) / 1000) + ' s'), 1000); };
    try {
      ticking('Connecting to the recognition server (a sleeping free server can take a minute or two to wake up)…');
      try { await H.health(cfg.url, cfg.key, { signal: ctl.signal }); }
      catch (e) { if (ctl.signal.aborted) return; clearInterval(timer); return fallBack('AI recognition is unavailable (' + e.message + ').'); }
      for (let i = 0; i < state.pages.length; i++) {
        if (ctl.signal.aborted) return;
        const p = state.pages[i];
        ticking('Recognising page ' + (i + 1) + ' of ' + state.pages.length + ' with AI…');
        try {
          const blob = await pageBlob(p);
          const r = await H.recognisePage(blob, { url: cfg.url, key: cfg.key, tempo: state.meta.tempoEdited ? state.meta.tempo : null, signal: ctl.signal });
          results.push({ xml: r.xml, pageIndex: i, seconds: r.seconds });
        } catch (e) {
          if (ctl.signal.aborted) return;
          failures.push({ page: i, message: e.message, network: !e.status });
          if (!e.status) break; // the server went away; no point trying more pages
        }
      }
    } finally { clearInterval(timer); if (state.homrAbort === ctl) state.homrAbort = null; }
    if (ctl.signal.aborted) return;
    $('omrNext2').disabled = false;
    if (!results.length) return fallBack('AI recognition could not read ' + (state.pages.length > 1 ? 'these pages' : 'this page') + ' (' + (failures[0] ? failures[0].message : 'no result') + ').');
    state.score = H.toScore(results, { title: state.meta.title, composer: state.meta.composer, tempo: state.meta.tempo, tempoEdited: !!state.meta.tempoEdited, spec });
    state.pageMap = state.score.pageMap;
    afterRecognition(failures.map(f => 'Page ' + (f.page + 1) + ' failed: ' + f.message), 'AI recognition: ');
  }
  /** Server unreachable or nothing recognised: say so, then use the on-device recogniser if it can. */
  function fallBack(reason) {
    if (state.parts.length) {
      runDeviceRecognition(reason + ' Using the basic on-device recogniser instead.');
    } else {
      goStep(2);
      $('omrNext2').disabled = !canRecognise();
      $('omrLayoutInfo').textContent = reason + ' The on-device recogniser could not find staves either. Check the server in Settings, or retake the photo.';
    }
  }

  async function runDeviceRecognition(prefix) {
    if (!state.meta.title) state.meta.title = 'Recognised score';
    goStep(3);
    $('omrNext2').disabled = true;
    const spec = partSpec(), results = [];
    for (let i = 0; i < state.pages.length; i++) {
      const p = state.pages[i];
      $('omrReviewStatus').textContent = 'Recognising page ' + (i + 1) + ' of ' + state.pages.length + '…';
      try {
        const r = await analyse(p, state.partIndex, spec);
        p.result = r; p.prepCanvas = canvasFromGray(r.image, r.width, r.height); delete r.image;
        r.pageIndex = i; results.push(r);
      } catch (e) { results.push({ width: p.w, height: p.h, recognition: null, error: e.message, pageIndex: i }); }
    }
    $('omrNext2').disabled = false;
    const ok = results.filter(r => r.recognition);
    state.score = M.buildScore(ok, { title: state.meta.title, composer: state.meta.composer, tempo: state.meta.tempo });
    state.score.engine = 'device';
    if (spec && state.score.part) state.score.part.name = spec.name;
    state.pageMap = ok.map(r => r.pageIndex);
    afterRecognition(results.filter(r => r.error).map(r => 'Page ' + (r.pageIndex + 1) + ' failed: ' + r.error.split('\n')[0]), prefix ? prefix + ' ' : '');
  }
  function afterRecognition(pageErrors, prefix) {
    state.history = []; state.sel = null; state.reviewPage = 0;
    $('omrUndo').disabled = true;
    fillReviewControls();
    validateAndRender();
    const s = M.summary(state.score), notes = [];
    if (s.measures) notes.push(prefix + s.measures + ' measures recognised.' + (s.invalid + s.uncertain ? ' Start with the red and amber measures.' : ' Every measure adds up; play it through to check.'));
    else notes.push(prefix + 'No measures were recognised. Go back and check the crop or choose another part.');
    pageErrors.forEach(t => notes.push(t));
    state.score.warnings.forEach(w => notes.push('Page ' + ((w.photoPage != null ? w.photoPage : state.pageMap[w.page]) + 1) + ' · ' + w.message));
    $('omrReviewStatus').textContent = notes.join(' ');
    if (s.invalid + s.uncertain) nextIssue(null, true);
  }
  function fillReviewControls() {
    const ks = $('omrKey'); ks.replaceChildren();
    for (let k = -7; k <= 7; k++) { const o = document.createElement('option'); o.value = k; o.textContent = (k > 0 ? k + '♯ · ' : k < 0 ? (-k) + '♭ · ' : '') + M.KEY_NAMES[k]; ks.append(o); }
    ks.value = state.score.key;
    const ts = $('omrTime'); ts.replaceChildren();
    M.TIME_CHOICES.forEach(t => { const o = document.createElement('option'); o.value = t.join('/'); o.textContent = t.join('/'); ts.append(o); });
    if (!M.TIME_CHOICES.some(t => t.join('/') === state.score.time.join('/'))) { const o = document.createElement('option'); o.value = o.textContent = state.score.time.join('/'); ts.append(o); }
    ts.value = state.score.time.join('/');
    $('omrReviewTitle').value = state.score.title;
  }
  function snapshot() {
    state.history.push(JSON.stringify({ measures: state.score.measures, key: state.score.key, time: state.score.time }));
    if (state.history.length > 60) state.history.shift();
    $('omrUndo').disabled = false;
  }
  function undo() {
    const s = state.history.pop(); if (!s) return;
    Object.assign(state.score, JSON.parse(s));
    $('omrUndo').disabled = !state.history.length;
    $('omrKey').value = state.score.key; $('omrTime').value = state.score.time.join('/');
    if (state.sel && !M.findEvent(state.score, state.sel.eventId)) state.sel = null;
    validateAndRender();
  }
  function edit(fn) { snapshot(); fn(); validateAndRender(); }

  function pageMeasures() { return state.score.measures.filter(m => m.page === state.reviewPage); }
  function selected() {
    if (!state.sel) return null;
    const f = M.findEvent(state.score, state.sel.eventId);
    if (!f) return null;
    f.note = f.event.notes.find(n => n.id === state.sel.noteId) || f.event.notes[0] || null;
    return f;
  }
  function measureNumber(m) { return state.score.measures.indexOf(m) + (state.score.measures[0] && state.score.measures[0].pickup ? 0 : 1); }

  function validateAndRender() {
    const s = M.validate(state.score);
    state.score.measures.forEach(m => M.resolveMeasure(state.score, m));
    const box = $('omrIssues'); box.replaceChildren();
    const chip = (cls, txt, filter) => { const b = document.createElement('button'); b.className = 'ochip ' + cls; b.textContent = txt; b.onclick = () => nextIssue(filter); box.append(b); };
    chip('bad', '✖ ' + s.invalid + ' do not add up', 'invalid');
    chip('warn', '⚠ ' + s.uncertain + ' to check', 'uncertain');
    chip('good', '✓ ' + (s.ok + s.verified) + ' OK', null);
    $('omrSave').disabled = !s.measures || state.saving;
    $('omrSaveHint').textContent = s.invalid ? s.invalid + ' measure(s) still do not add up. You can save now, but playback timing may drift there.' : 'All measures add up or are accepted. Ready to save.';
    const pages = state.score.pages.length;
    $('omrPageNav').hidden = pages < 2;
    $('omrPageLabel').textContent = 'Page ' + (state.reviewPage + 1) + ' of ' + Math.max(1, pages);
    renderPanes();
    renderEditor();
  }

  /* Rendering ---------------------------------------------------------------- */
  function setupCanvas(cv) {
    const pg = state.score.pages[state.reviewPage], W = Math.max(200, cv.parentElement.clientWidth - 6), k = W / pg.width, H = pg.height * k, d = window.devicePixelRatio || 1;
    cv.width = Math.round(W * d); cv.height = Math.round(H * d); cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(d * k, 0, 0, d * k, 0, 0);
    return { ctx, k, pg };
  }
  const STATUS_FILL = { invalid: 'rgba(239,68,68,.14)', uncertain: 'rgba(245,158,11,.14)', ok: 'rgba(0,0,0,0)', verified: 'rgba(34,197,94,.10)' };
  const STATUS_LINE = { invalid: '#dc2626', uncertain: '#d97706', ok: '#94a3b8', verified: '#16a34a' };
  const confColor = c => c >= 0.85 ? '#16a34a' : c >= 0.6 ? '#d97706' : '#dc2626';

  function renderPanes() {
    if (!state.score || !state.score.pages.length) return;
    $('omrPanes').dataset.view = state.view;
    drawOriginal(); drawRecognised();
  }
  function drawOriginal() {
    const cv = $('omrOrig'); if (cv.parentElement.offsetParent === null) return;
    if (state.score.engine === 'homr') {
      // homr gives notes, not positions on the photo: show the photo as sent.
      const page = state.pages[state.pageMap[state.reviewPage]], img = page && (page.sentCanvas || page.canvas);
      const W = Math.max(200, cv.parentElement.clientWidth - 6), Ht = img ? img.height * W / img.width : 300, d = window.devicePixelRatio || 1;
      cv.width = Math.round(W * d); cv.height = Math.round(Ht * d); cv.style.width = W + 'px'; cv.style.height = Ht + 'px';
      const c2 = cv.getContext('2d'); c2.setTransform(d, 0, 0, d, 0, 0);
      if (img) c2.drawImage(img, 0, 0, W, Ht);
      return;
    }
    const { ctx, k } = setupCanvas(cv);
    const page = state.pages[state.pageMap[state.reviewPage]];
    if (page && page.prepCanvas) ctx.drawImage(page.prepCanvas, 0, 0);
    const il = state.score.pages[state.reviewPage].interline, sel = selected();
    pageMeasures().forEach(m => {
      ctx.fillStyle = STATUS_FILL[m.status]; ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      if (m.status !== 'ok') { ctx.strokeStyle = STATUS_LINE[m.status]; ctx.lineWidth = 2 / k; ctx.strokeRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0); }
      m.staves.forEach(st => st.events.forEach(e => {
        const isSel = sel && sel.event.id === e.id;
        if (e.type === 'rest' && e.restBox) {
          ctx.strokeStyle = isSel ? '#2563eb' : confColor(e.verified ? 1 : e.conf); ctx.lineWidth = (isSel ? 3 : 1.6) / k;
          ctx.strokeRect(e.restBox.x0 - 2, e.restBox.y0 - 2, e.restBox.x1 - e.restBox.x0 + 4, e.restBox.y1 - e.restBox.y0 + 4);
        }
        e.notes.forEach(n => {
          if (n.y == null) return;
          ctx.strokeStyle = isSel ? '#2563eb' : confColor(e.verified ? 1 : Math.min(e.conf, n.conf)); ctx.lineWidth = (isSel ? 3 : 1.8) / k;
          ctx.beginPath(); ctx.ellipse(n.x, n.y, il * 0.85, il * 0.65, 0, 0, 7); ctx.stroke();
        });
      }));
    });
  }
  const staffY = (st, d) => st.staff.bottom - (d - M.clefBase(st.clef)) * st.staff.interline / 2;
  const fmt = v => Math.round(v * 100) / 100;
  function drawRecognised() {
    const cv = $('omrRec'); if (cv.parentElement.offsetParent === null) return;
    const { ctx, k, pg } = setupCanvas(cv);
    ctx.fillStyle = '#fffdf8'; ctx.fillRect(0, 0, pg.width, pg.height);
    const sel = selected(), ms = pageMeasures(), firstOfSystem = {};
    ms.forEach(m => { if (!firstOfSystem[m.system] || m.x0 < firstOfSystem[m.system].x0) firstOfSystem[m.system] = m; });
    const firstOfPage = ms[0];
    ms.forEach(m => {
      const il = m.staves[0].staff.interline;
      ctx.fillStyle = STATUS_FILL[m.status]; ctx.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0);
      if (m.status === 'invalid' || m.status === 'uncertain') { ctx.strokeStyle = STATUS_LINE[m.status]; ctx.lineWidth = 2 / k; ctx.strokeRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0); }
      ctx.fillStyle = '#475569'; ctx.font = (il * 0.9) + 'px system-ui'; ctx.fillText(String(measureNumber(m)), m.x0 + 2, m.staves[0].staff.top - il * 0.8);
      const bad = m.details.filter(d => !d.ok);
      if (bad.length && (m.status === 'invalid' || m.accepted)) {
        ctx.fillStyle = m.accepted ? '#15803d' : '#b91c1c'; ctx.font = 'bold ' + (il * 0.85) + 'px system-ui';
        ctx.fillText((m.accepted ? '✓ ' : '') + bad.map(d => fmt(d.total) + '/' + fmt(d.expected)).join(' · '), m.x0 + il * 1.4, m.staves[0].staff.top - il * 0.8);
      }
      const head = firstOfSystem[m.system] === m;
      m.staves.forEach(st => {
        const S = st.staff, left = head ? S.left : m.x0;
        ctx.strokeStyle = '#1e293b'; ctx.lineWidth = Math.max(1, il * 0.09);
        S.lines.forEach(y => { ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(m.x1, y); ctx.stroke(); });
        ctx.lineWidth = Math.max(1.2, il * 0.12);
        ctx.beginPath(); ctx.moveTo(m.x1, S.top); ctx.lineTo(m.x1, S.bottom); ctx.stroke();
        if (head) drawHeader(ctx, st, S.left + il * 0.4, m === firstOfPage && state.reviewPage === 0);
        st.events.forEach(e => drawEvent(ctx, st, e, sel && sel.event.id === e.id ? sel : null));
      });
    });
  }
  function drawHeader(ctx, st, x, withTime) {
    const S = st.staff, il = S.interline, key = state.score.key, n = Math.abs(key);
    ctx.fillStyle = '#0f172a'; ctx.strokeStyle = '#0f172a';
    window.PCDraw.clef(ctx, st.clef, x, S.top, il);
    const sharpPos = st.clef === 'bass' ? [6, 3, 7, 4, 1, 5, 2] : [8, 5, 9, 6, 3, 7, 4];
    const flatPos = st.clef === 'bass' ? [2, 5, 1, 4, 0, 3, -1] : [4, 7, 3, 6, 2, 5, 1];
    ctx.font = (il * 1.9) + 'px serif';
    for (let i = 0; i < n; i++) ctx.fillText(key > 0 ? '♯' : '♭', x + il * (2.6 + i * 0.8), S.bottom - (key > 0 ? sharpPos[i] : flatPos[i]) * il / 2 + il * 0.5);
    if (withTime) {
      ctx.font = 'bold ' + (il * 2.1) + 'px Georgia, serif';
      const tx = x + il * (2.9 + n * 0.8);
      ctx.fillText(String(state.score.time[0]), tx, S.top + il * 1.75);
      ctx.fillText(String(state.score.time[1]), tx, S.top + il * 3.75);
    }
  }
  function drawEvent(ctx, st, e, sel) {
    const S = st.staff, il = S.interline, x = e.x, color = sel ? '#2563eb' : (e.added ? '#7c3aed' : '#0f172a');
    ctx.fillStyle = color; ctx.strokeStyle = color;
    if (e.type === 'rest') { drawRest(ctx, S, e, x); return; }
    if (!e.notes.length) return;
    const ys = e.notes.map(n => staffY(st, n.diatonic));
    const midStep = e.notes.reduce((a, n) => a + (n.diatonic - M.clefBase(st.clef)), 0) / e.notes.length;
    const up = e.stemDir ? e.stemDir === 'up' : midStep < 4, open = e.base === 'whole' || e.base === 'half';
    e.notes.forEach(n => {
      const y = staffY(st, n.diatonic), step = n.diatonic - M.clefBase(st.clef);
      ctx.lineWidth = Math.max(1, il * 0.1);
      for (let s = -2; s >= step; s -= 2) { const yy = S.bottom - s * il / 2; ctx.beginPath(); ctx.moveTo(x - il * 0.95, yy); ctx.lineTo(x + il * 0.95, yy); ctx.stroke(); }
      for (let s = 10; s <= step; s += 2) { const yy = S.bottom - s * il / 2; ctx.beginPath(); ctx.moveTo(x - il * 0.95, yy); ctx.lineTo(x + il * 0.95, yy); ctx.stroke(); }
      ctx.beginPath(); ctx.ellipse(x, y, il * 0.62, il * 0.45, -0.35, 0, 7);
      if (open) { ctx.lineWidth = il * 0.16; ctx.stroke(); } else ctx.fill();
      if (sel && sel.note && sel.note.id === n.id) { ctx.save(); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = il * 0.14; ctx.beginPath(); ctx.ellipse(x, y, il * 1.05, il * 0.85, 0, 0, 7); ctx.stroke(); ctx.restore(); }
      if (n.accidental != null) { ctx.font = (il * 1.7) + 'px serif'; ctx.fillText({ '1': '♯', '-1': '♭', '0': '♮', '2': '𝄪', '-2': '𝄫' }[n.accidental], x - il * 1.75, y + il * 0.55); }
      if (e.dots) { ctx.beginPath(); ctx.arc(x + il * 1.0, y - (step % 2 === 0 ? il * 0.5 : 0), il * 0.16, 0, 7); ctx.fill(); }
    });
    if (e.base !== 'whole') {
      const yTop = Math.min.apply(null, ys), yBot = Math.max.apply(null, ys), sx = up ? x + il * 0.58 : x - il * 0.58;
      const y0 = up ? yBot : yTop, y1 = up ? yTop - il * 3.3 : yBot + il * 3.3;
      ctx.lineWidth = Math.max(1, il * 0.11);
      ctx.beginPath(); ctx.moveTo(sx, y0); ctx.lineTo(sx, y1); ctx.stroke();
      const flags = { eighth: 1, '16th': 2, '32nd': 3 }[e.base] || 0;
      for (let f = 0; f < flags; f++) {
        const fy = y1 + (up ? 1 : -1) * f * il * 0.75;
        ctx.lineWidth = il * 0.28;
        ctx.beginPath(); ctx.moveTo(sx, fy); ctx.lineTo(sx + il * 0.9, fy + (up ? 1 : -1) * il); ctx.stroke();
      }
    }
  }
  function drawRest(ctx, S, e, x) {
    const il = S.interline, mid = S.lines[2];
    ctx.lineWidth = il * 0.2;
    if (e.base === 'whole') ctx.fillRect(x - il * 0.6, S.lines[1], il * 1.2, il * 0.5);
    else if (e.base === 'half') ctx.fillRect(x - il * 0.6, S.lines[2] - il * 0.5, il * 1.2, il * 0.5);
    else if (e.base === 'quarter') { ctx.beginPath(); ctx.moveTo(x - il * 0.3, mid - il * 1.4); ctx.lineTo(x + il * 0.35, mid - il * 0.6); ctx.lineTo(x - il * 0.25, mid + il * 0.1); ctx.lineTo(x + il * 0.35, mid + il * 0.8); ctx.quadraticCurveTo(x - il * 0.5, mid + il * 0.5, x, mid + il * 1.4); ctx.stroke(); }
    else {
      const n = { eighth: 1, '16th': 2, '32nd': 3 }[e.base] || 1;
      ctx.lineWidth = il * 0.14;
      ctx.beginPath(); ctx.moveTo(x + il * 0.4, mid - il * 0.9); ctx.lineTo(x - il * 0.1, mid + il); ctx.stroke();
      for (let i = 0; i < n; i++) { ctx.beginPath(); ctx.arc(x - il * 0.15 - i * il * 0.1, mid - il * 0.75 + i * il * 0.7, il * 0.2, 0, 7); ctx.fill(); }
    }
    if (e.dots) { ctx.beginPath(); ctx.arc(x + il * 0.9, mid - il * 0.5, il * 0.15, 0, 7); ctx.fill(); }
  }

  /* Hit testing -------------------------------------------------------------- */
  function pagePoint(cv, ev) {
    const r = cv.getBoundingClientRect(), k = r.width / state.score.pages[state.reviewPage].width;
    return [(ev.clientX - r.left) / k, (ev.clientY - r.top) / k];
  }
  function hit(x, y) {
    let best = null, bd = Infinity;
    pageMeasures().forEach(m => m.staves.forEach(st => {
      const il = st.staff.interline;
      st.events.forEach(e => {
        if (e.type === 'rest') {
          const d = Math.hypot((x - e.x) / 1.2, (y - (e.y != null ? e.y : st.staff.lines[2])) / 2.2);
          if (d < il * 1.3 && d < bd) { bd = d; best = { e, n: null }; }
        } else e.notes.forEach(n => { const d = Math.hypot(x - e.x, y - staffY(st, n.diatonic)); if (d < il * 1.1 && d < bd) { bd = d; best = { e, n }; } });
      });
    }));
    return best;
  }
  /** Only accept taps inside a measure and within 4 ledger lines of a staff. */
  function placeAt(x, y) {
    const m = pageMeasures().find(mm => x >= mm.x0 && x <= mm.x1 && y >= mm.y0 && y <= mm.y1);
    if (!m) return null;
    let best = null, bd = Infinity;
    m.staves.forEach((st, k) => { const d = Math.abs(y - (st.staff.top + st.staff.bottom) / 2); if (d < bd) { bd = d; best = { st, k }; } });
    const S = best.st.staff, step = Math.round((S.bottom - y) / (S.interline / 2));
    if (step < -8 || step > 16) return null;
    return { m, st: best.st, k: best.k, diatonic: M.clefBase(best.st.clef) + step };
  }
  function onPaneClick(ev) {
    if (!state.score) return;
    if (state.score.engine === 'homr' && ev.currentTarget.id === 'omrOrig') { $('omrSelInfo').textContent = 'Tap notes in the Recognised view to edit them.'; return; }
    const [x, y] = pagePoint(ev.currentTarget, ev);
    if (state.addMode) {
      const p = placeAt(x, y);
      if (!p) { $('omrSelInfo').textContent = 'Tap on or near a staff inside a measure to add a note.'; return; }
      edit(() => {
        p.m.accepted = false;
        const near = p.st.events.find(e => e.type === 'note' && Math.abs(e.x - x) < p.st.staff.interline * 0.7);
        if (near && !near.notes.some(n => n.diatonic === p.diatonic)) {
          const n = M.newNote(p.diatonic, near.x, null); near.notes.push(n); near.verified = true;
          state.sel = { eventId: near.id, noteId: n.id };
        } else if (!near) {
          const e = M.newEvent('note', state.addBase, x, 1), n = M.newNote(p.diatonic, x, null);
          e.notes.push(n); p.st.events.push(e); p.st.events.sort((a, b) => a.x - b.x);
          state.sel = { eventId: e.id, noteId: n.id };
        }
      });
      return;
    }
    const h = hit(x, y);
    state.sel = h ? { eventId: h.e.id, noteId: h.n ? h.n.id : null } : null;
    renderPanes(); renderEditor();
  }

  /* Editor ------------------------------------------------------------------- */
  function renderEditor() {
    const f = selected();
    $('omrEditor').classList.toggle('empty', !f);
    if (!f) { $('omrSelInfo').textContent = state.addMode ? 'Add mode: tap the recognised score where the note belongs.' : (state.score && state.score.engine === 'homr' ? 'Tap a note or rest in the Recognised view to edit it.' : 'Tap a note or rest on either view to edit it.') + ' Red/amber measures need attention.'; return; }
    const e = f.event, pitch = e.type === 'rest' ? 'Rest' : e.notes.map(n => (n === f.note ? '▸' : '') + (n.name || M.diatonicName(n.diatonic))).join(' + ');
    const d = f.measure.details.filter(x => x.staff === f.staffIndex);
    $('omrSelInfo').textContent = 'Measure ' + measureNumber(f.measure) + (f.measure.accepted ? ' (accepted)' : '') + ' · ' + (f.staff.clef === 'bass' ? 'bass (left hand)' : 'treble (right hand)') + ' · ' + pitch + ' · ' + DUR_LABEL[e.base] + (e.dots ? ' dotted' : '') + ' · voice ' + (e.voice || 1) + ' · confidence ' + Math.round((e.verified ? 1 : e.conf) * 100) + '% · beats ' + d.map(x => fmt(x.total) + '/' + fmt(x.expected) + (x.ok ? ' ✓' : ' ✖')).join(', ');
    document.querySelectorAll('[data-dur]').forEach(b => b.classList.toggle('on', b.dataset.dur === e.base));
    $('omrDot').classList.toggle('on', !!e.dots);
    document.querySelectorAll('[data-acc]').forEach(b => b.classList.toggle('on', !!f.note && String(f.note.accidental) === b.dataset.acc));
    $('omrToRest').textContent = e.type === 'rest' ? 'Make note' : 'Make rest';
    $('omrAccept').textContent = f.measure.accepted ? '↺ Un-accept measure' : '✓ Measure correct';
  }
  function withSel(fn) {
    const f = selected(); if (!f) return;
    edit(() => { fn(f); f.event.verified = true; f.measure.accepted = false; });
  }
  function bindEditor() {
    $('omrUp').onclick = () => withSel(f => { if (f.note) f.note.diatonic++; });
    $('omrDown').onclick = () => withSel(f => { if (f.note) f.note.diatonic--; });
    document.querySelectorAll('[data-acc]').forEach(b => b.onclick = () => withSel(f => { if (f.note) f.note.accidental = b.dataset.acc === 'null' ? null : +b.dataset.acc; }));
    document.querySelectorAll('[data-dur]').forEach(b => b.onclick = () => {
      state.addBase = b.dataset.dur;
      if (selected()) withSel(f => { f.event.base = b.dataset.dur; }); else renderEditor();
    });
    $('omrDot').onclick = () => withSel(f => { f.event.dots = f.event.dots ? 0 : 1; });
    $('omrChord').onclick = () => withSel(f => {
      if (f.event.type !== 'note') return;
      const n = M.newNote(Math.max.apply(null, f.event.notes.map(q => q.diatonic)) + 2, f.event.x, null);
      f.event.notes.push(n); state.sel.noteId = n.id;
    });
    $('omrToRest').onclick = () => withSel(f => {
      if (f.event.type === 'rest') { f.event.type = 'note'; f.event.notes = [M.newNote(M.clefBase(f.staff.clef) + 4, f.event.x, null)]; state.sel.noteId = f.event.notes[0].id; }
      else { f.event.type = 'rest'; f.event.notes = []; f.event.y = f.staff.staff.lines[2]; state.sel.noteId = null; }
    });
    $('omrVoice').onclick = () => withSel(f => { f.event.voice = (f.event.voice || 1) === 1 ? 2 : 1; });
    $('omrDelete').onclick = () => {
      const f = selected(); if (!f) return;
      edit(() => {
        f.measure.accepted = false;
        if (f.note && f.event.notes.length > 1) { f.event.notes = f.event.notes.filter(n => n !== f.note); state.sel.noteId = f.event.notes[0].id; }
        else { f.staff.events.splice(f.index, 1); state.sel = null; }
      });
    };
    $('omrAccept').onclick = () => {
      const f = selected(); if (!f) return;
      const m = f.measure, accept = !m.accepted;
      edit(() => { m.accepted = accept; if (accept) m.staves.forEach(st => st.events.forEach(e => { e.verified = true; })); });
      if (accept) nextIssue();
    };
    $('omrFill').onclick = () => { const f = selected(); if (f) edit(() => { f.measure.accepted = false; M.fillWithRests(state.score, f.measure, f.staffIndex); }); };
    $('omrAdd').onclick = () => { state.addMode = !state.addMode; $('omrAdd').classList.toggle('on', state.addMode); renderEditor(); };
    $('omrUndo').onclick = undo;
    $('omrNextIssue').onclick = () => nextIssue();
    $('omrKey').onchange = e => edit(() => { state.score.key = +e.target.value; });
    $('omrTime').onchange = e => edit(() => { state.score.time = e.target.value.split('/').map(Number); });
    $('omrReviewTitle').oninput = e => { state.score.title = e.target.value; };
    document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
      state.view = b.dataset.view;
      document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
      renderPanes();
    });
    $('omrPrevPage').onclick = () => { if (state.reviewPage > 0) { state.reviewPage--; state.sel = null; validateAndRender(); } };
    $('omrNextPage').onclick = () => { if (state.reviewPage < state.score.pages.length - 1) { state.reviewPage++; state.sel = null; validateAndRender(); } };
    $('omrPlayMeasure').onclick = playMeasure;
    $('omrExport').onclick = () => window.PCApp.download(M.toMusicXML(state.score), (state.score.title || 'score') + '.musicxml', 'application/vnd.recordare.musicxml+xml');
    $('omrSave').onclick = save;
    ['omrOrig', 'omrRec'].forEach(idn => $(idn).addEventListener('click', onPaneClick));
    const a = $('omrOrigWrap'), b = $('omrRecWrap');
    let lock = false;
    const sync = (src, dst) => () => { if (lock) return; lock = true; dst.scrollTop = src.scrollTop * (dst.scrollHeight / Math.max(1, src.scrollHeight)); requestAnimationFrame(() => { lock = false; }); };
    a.addEventListener('scroll', sync(a, b)); b.addEventListener('scroll', sync(b, a));
    document.addEventListener('keydown', ev => {
      if (state.step !== 3 || !$('omr').classList.contains('active') || /INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
      const keys = { ArrowUp: 'omrUp', ArrowDown: 'omrDown', Delete: 'omrDelete', Backspace: 'omrDelete', '.': 'omrDot', n: 'omrNextIssue', a: 'omrAccept' };
      const durKeys = { 1: 'whole', 2: 'half', 3: 'quarter', 4: 'eighth', 5: '16th' };
      if (keys[ev.key]) { ev.preventDefault(); $(keys[ev.key]).click(); }
      else if (durKeys[ev.key]) { const btn = document.querySelector('[data-dur="' + durKeys[ev.key] + '"]'); if (btn) btn.click(); }
      else if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') { ev.preventDefault(); undo(); }
      else if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { ev.preventDefault(); stepSelection(ev.key === 'ArrowRight' ? 1 : -1); }
    });
  }
  function stepSelection(dir) {
    const all = [];
    state.score.measures.forEach(m => m.staves.forEach(st => st.events.slice().sort((a, b) => a.x - b.x).forEach(e => all.push({ m, e }))));
    if (!all.length) return;
    const i = state.sel ? all.findIndex(o => o.e.id === state.sel.eventId) : -1;
    const n = all[Math.max(0, Math.min(all.length - 1, i + dir))];
    state.sel = { eventId: n.e.id, noteId: n.e.notes[0] ? n.e.notes[0].id : null };
    focusMeasure(n.m);
  }
  function nextIssue(filter, quiet) {
    const ms = state.score.measures; if (!ms.length) return;
    const cur = selected(), start = cur ? ms.indexOf(cur.measure) : -1, wanted = filter ? [filter] : ['invalid', 'uncertain'];
    let found = null;
    for (const w of wanted) {
      for (let i = 1; i <= ms.length && !found; i++) { const m = ms[(start + i + ms.length) % ms.length]; if (m.status === w) found = m; }
      if (found) break;
    }
    if (!found) { if (!quiet) $('omrReviewStatus').textContent = 'No more measures need attention.'; return; }
    let ev = null;
    found.staves.forEach(st => st.events.forEach(e => { if (!ev || (e.verified ? 1 : e.conf) < (ev.verified ? 1 : ev.conf)) ev = e; }));
    state.sel = ev ? { eventId: ev.id, noteId: ev.notes[0] ? ev.notes[0].id : null } : null;
    focusMeasure(found);
  }
  function focusMeasure(m) {
    if (m.page !== state.reviewPage) state.reviewPage = m.page;
    validateAndRender();
    ['omrOrigWrap', 'omrRecWrap'].forEach(idn => {
      const wrap = $(idn), cv = wrap.querySelector('canvas');
      if (!cv.clientHeight) return;
      wrap.scrollTop = Math.max(0, m.y0 * (cv.clientHeight / state.score.pages[state.reviewPage].height) - 40);
    });
  }

  /* Audition and save -------------------------------------------------------- */
  async function playMeasure() {
    const f = selected(), m = f ? f.measure : pageMeasures()[0];
    if (!m) return;
    try { await window.PCApp.audio(); } catch (e) { status('Audio library unavailable.'); return; }
    const tmp = { title: '', time: state.score.time, key: state.score.key, tempo: state.score.tempo, measures: [JSON.parse(JSON.stringify(m))], pages: [] };
    tmp.measures[0].accepted = false;
    M.validate(tmp);
    const song = M.toSong(tmp), spb = 60 / state.score.tempo, now = Tone.now() + 0.05, inst = window.PCApp.instrument();
    inst.releaseAll();
    song.notes.forEach(n => inst.triggerAttackRelease(Tone.Frequency(n.midi, 'midi').toNote(), n.durationBeats * spb, now + n.startBeat * spb, 0.7));
  }
  async function save() {
    if (state.saving) return;
    state.score.title = $('omrReviewTitle').value.trim() || state.score.title;
    const song = M.toSong(state.score, { id: 'omr-' + Date.now().toString(36) });
    if (!song.notes.length) { $('omrSaveHint').textContent = 'Nothing playable yet: add or correct notes first.'; return; }
    song.score = JSON.parse(JSON.stringify(state.score));
    state.saving = true; $('omrSave').disabled = true; $('omrSaveHint').textContent = 'Saving…';
    try {
      await window.PCApp.saveSong(song);
      stopCamera();
      window.PCApp.openSong(song);
    } catch (e) {
      $('omrSaveHint').textContent = 'Could not save to this device (' + e.message + '). Your review is still here: export MusicXML to keep a copy, or free up storage and try again.';
    } finally { state.saving = false; $('omrSave').disabled = false; }
  }

  /* Navigation ------------------------------------------------------------------ */
  function goStep(n) {
    state.step = n;
    document.querySelectorAll('.ostep').forEach(s => { s.hidden = +s.dataset.step !== n; });
    document.querySelectorAll('.osteps li').forEach(li => { li.classList.toggle('on', +li.dataset.step === n); li.classList.toggle('done', +li.dataset.step < n); });
    if (n === 1) requestAnimationFrame(drawCrop);
    if (n === 2) requestAnimationFrame(drawLayout);
    if (n === 3) requestAnimationFrame(renderPanes);
  }
  function open(source) {
    window.PCApp.nav('omr');
    goStep(1); renderPages();
    if (source === 'camera') startCamera();
    else if (source === 'photos') $('omrPhotoIn').click();
    else if (source === 'pdf') $('omrPdfIn').click();
  }
  function reset() {
    stopCamera();
    cancelHomr();
    state.ocrRun++;
    Object.assign(state, { pages: [], current: 0, parts: [], partIndex: 0, partChosen: false, score: null, sel: null, history: [], meta: { title: '', composer: '', tempo: 90 } });
    renderPages(); goStep(1);
  }

  function init() {
    $('omrPhotoIn').onchange = e => { loadFiles([...e.target.files]); e.target.value = ''; };
    $('omrPdfIn').onchange = e => { if (e.target.files[0]) loadPdf(e.target.files[0]); e.target.value = ''; };
    $('omrAddCamera').onclick = startCamera;
    $('omrAddPhotos').onclick = () => $('omrPhotoIn').click();
    $('omrAddPdf').onclick = () => $('omrPdfIn').click();
    $('omrCapture').onclick = capture;
    $('omrCamDone').onclick = stopCamera;
    $('omrNativeCam').onclick = () => $('omrCameraIn').click();
    $('omrCameraIn').onchange = e => { const files = [...e.target.files]; e.target.value = ''; if (files.length) { stopCamera(); loadFiles(files); } };
    document.querySelectorAll('input[name="omrEngine"]').forEach(r => r.onchange = () => {
      store.set('pc-omr-engine', r.value); renderEngines(); renderLayout();
      $('omrNext2').disabled = !canRecognise();
    });
    bindSettings();
    $('omrAuto').onclick = () => { const p = state.pages[state.current]; if (!p) return; const a = G.autoCorners(p.gray, p.w, p.h); p.corners = a.corners; p.autoDetected = a.detected; p.shadow = !!a.shadow; p.layout = null; renderPages(); };
    $('omrFull').onclick = () => { const p = state.pages[state.current]; if (!p) return; p.corners = [[0, 0], [p.w - 1, 0], [p.w - 1, p.h - 1], [0, p.h - 1]]; p.layout = null; drawCrop(); };
    $('omrRotL').onclick = () => rotatePage(false);
    $('omrRotR').onclick = () => rotatePage(true);
    $('omrRemove').onclick = () => { state.pages.splice(state.current, 1); state.current = Math.max(0, Math.min(state.current, state.pages.length - 1)); renderPages(); };
    $('omrMoveUp').onclick = () => { const i = state.current; if (i > 0) { [state.pages[i - 1], state.pages[i]] = [state.pages[i], state.pages[i - 1]]; state.current--; renderPages(); } };
    const cv = $('omrCrop');
    cv.addEventListener('pointerdown', e => cropPointer(e, 'down'));
    cv.addEventListener('pointermove', e => cropPointer(e, 'move'));
    cv.addEventListener('pointerup', e => cropPointer(e, 'up'));
    cv.addEventListener('pointercancel', e => cropPointer(e, 'up'));
    $('omrNext1').onclick = runLayout;
    $('omrBack2').onclick = () => goStep(1);
    $('omrNext2').onclick = runRecognition;
    $('omrBack3').onclick = () => { cancelHomr(); goStep(2); $('omrNext2').disabled = !canRecognise(); renderEngines(); };
    $('omrTitle').oninput = e => { state.meta.title = e.target.value; state.meta.titleEdited = true; };
    $('omrComposer').oninput = e => { state.meta.composer = e.target.value; state.meta.composerEdited = true; };
    $('omrTempo').oninput = e => { state.meta.tempo = +e.target.value; state.meta.tempoEdited = true; };
    $('omrRerunOcr').onclick = () => runOcr(state.pages.find(p => p.layout && p.layout.staves && p.layout.staves.length));
    $('omrClose').onclick = () => { stopCamera(); cancelHomr(); window.PCApp.nav('library'); };
    $('omrReset').onclick = reset;
    document.querySelectorAll('.osteps li').forEach(li => li.onclick = () => {
      const n = +li.dataset.step;
      if (n === 1 || (n === 2 && state.parts.length) || (n === 3 && state.score)) goStep(n);
    });
    bindEditor();
    window.addEventListener('resize', () => { if (state.step === 1) drawCrop(); if (state.step === 2) drawLayout(); if (state.step === 3 && state.score) renderPanes(); });
  }

  /* Settings → Photo recognition */
  function bindSettings() {
    const url = $('homrUrl'), key = $('homrKey'), st = $('homrStatus');
    if (!url) return;
    if (!H) { st.textContent = 'omr/homr.js did not load: upload the whole omr/ folder.'; return; }
    url.value = store.get('pc-homr-url') || DEFAULT_HOMR_URL; key.value = store.get('pc-homr-key');
    if (DEFAULT_HOMR_URL) url.placeholder = DEFAULT_HOMR_URL;
    const describe = () => {
      const u = homrConfig().url;
      st.textContent = !u ? 'Not set: photos use the basic on-device recogniser.'
        : u === H.normaliseUrl(DEFAULT_HOMR_URL) ? 'Using the built-in recognition server. Press Test connection to check it.'
        : 'Photos will be read by ' + u + '. Press Test connection to check it. Clear the box to go back to the built-in server.';
    };
    describe();
    url.onchange = () => {
      const n = H.normaliseUrl(url.value), builtIn = !n || n === H.normaliseUrl(DEFAULT_HOMR_URL);
      store.set('pc-homr-url', builtIn ? '' : n); url.value = n || DEFAULT_HOMR_URL;
      if (n) store.set('pc-omr-engine', 'homr');
      describe(); if (state.step === 2) { renderEngines(); $('omrNext2').disabled = !canRecognise(); } };
    key.onchange = () => { store.set('pc-homr-key', key.value.trim()); };
    $('homrTest').onclick = async () => {
      url.onchange(); key.onchange();
      const cfg = homrConfig();
      if (!cfg.url) { st.textContent = 'Enter the server address first.'; return; }
      $('homrTest').disabled = true; st.textContent = 'Contacting ' + cfg.url + '… (a sleeping server can take a minute or two)';
      try {
        const h = await H.health(cfg.url, cfg.key);
        st.textContent = '✓ Connected: homr ' + h.version + (h.busy ? ' · busy with ' + h.busy + ' page(s)' : ' · ready') + (h.needsKey && !cfg.key ? ' · this server needs a key' : '') + '.';
      } catch (e) { st.textContent = '✖ ' + e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.'; }
      finally { $('homrTest').disabled = false; }
    };
  }

  window.PCOMR = { open, reset, state, _analyse: analyse, _engine: engine };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
