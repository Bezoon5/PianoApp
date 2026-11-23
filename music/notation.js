/*
 * Piano Companion engraved notation using Verovio.
 *   PCNotation.load()                 -> loads the Verovio toolkit once (null if unavailable)
 *   PCNotation.render(el, xml)        -> renders all pages as SVG into el
 *   PCNotation.highlight(i, offset)   -> highlights measure i and the notes sounding
 *                                        `offset` quarter-beats into it
 *   PCNotation.markRange(a, b)        -> shades measures a..b (practice loop)
 * Playback is linked by measure, not by absolute time, because Verovio and the
 * app may expand repeats differently. Each MusicXML measure is one SVG
 * <g class="measure">, in document order.
 */
(function (root) {
  'use strict';
  const VEROVIO_URL = 'https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js';
  const LOAD_TIMEOUT_MS = 60000;
  const SVGNS = 'http://www.w3.org/2000/svg';
  let tk = null, loading = null, lastError = '';
  const st = { el: null, measures: [], regions: {}, bar: null, barRect: null, on: [], width: 0, xml: null, lastScroll: 0, range: [] };

  function load() {
    if (tk) return Promise.resolve(tk);
    if (loading) return loading;
    loading = new Promise(resolve => {
      let finished = false;
      const done = v => { if (finished) return; finished = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { lastError = 'timed out loading the notation engine'; done(null); }, LOAD_TIMEOUT_MS);
      const make = () => { try { tk = new root.verovio.toolkit(); done(tk); } catch (e) { lastError = e.message; done(null); } };
      const ready = () => {
        const v = root.verovio;
        if (!v || !v.module) { lastError = 'notation engine did not initialise'; return done(null); }
        if (v.module.calledRun) return make();
        const prev = v.module.onRuntimeInitialized;
        v.module.onRuntimeInitialized = function () { if (prev) try { prev(); } catch (e) { /* ignore */ } make(); };
      };
      if (root.verovio) return ready();
      const s = document.createElement('script');
      s.src = VEROVIO_URL; s.async = true;
      s.onload = ready;
      s.onerror = () => { lastError = 'could not download the notation engine (offline?)'; done(null); };
      document.head.append(s);
    }).then(v => { if (!v) loading = null; return v; });
    return loading;
  }

  function clearHighlight() {
    if (st.bar) st.bar.classList.remove('pc-bar');
    if (st.barRect && st.barRect.parentNode) st.barRect.parentNode.removeChild(st.barRect);
    st.on.forEach(n => n.classList.remove('pc-on'));
    st.bar = null; st.barRect = null; st.on = [];
  }

  /** Render MusicXML into `el`. Returns { ok, measures, error }. */
  function render(el, xml) {
    if (!tk) return { ok: false, error: lastError || 'notation engine not loaded' };
    const width = Math.max(320, el.clientWidth || 900);
    const scale = width < 700 ? 32 : 40;
    try {
      tk.setOptions({
        scale, pageWidth: Math.round((width - 24) * 100 / scale), adjustPageHeight: true, breaks: 'auto',
        header: 'auto', footer: 'none', pageMarginTop: 40, pageMarginBottom: 40, pageMarginLeft: 50, pageMarginRight: 50
      });
      if (!tk.loadData(xml)) return { ok: false, error: 'the notation engine could not read this score' };
      let html = '';
      const pages = tk.getPageCount();
      for (let p = 1; p <= pages; p++) html += tk.renderToSVG(p);
      clearHighlight();
      el.innerHTML = html;
      st.el = el; st.width = width; st.xml = xml; st.range = [];
      st.measures = Array.prototype.slice.call(el.querySelectorAll('g.measure'));
      buildRegions(tk.renderToTimemap({ includeMeasures: true }));
      return { ok: true, measures: st.measures.length, pages };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function buildRegions(timemap) {
    st.regions = {};
    const sounding = new Set();
    let cur = null;
    for (const e of timemap) {
      (e.off || []).forEach(id => sounding.delete(id));
      (e.on || []).forEach(id => sounding.add(id));
      if (e.measureOn) cur = st.regions[e.measureOn] ? null : (st.regions[e.measureOn] = { q0: e.qstamp, entries: [] });
      if (cur) cur.entries.push({ q: e.qstamp, notes: Array.from(sounding) });
    }
  }

  function highlight(measureIndex, offset) {
    const bar = st.measures[measureIndex];
    if (!bar) return;
    if (bar !== st.bar) {
      clearHighlight();
      st.bar = bar;
      bar.classList.add('pc-bar');
      try {
        const bb = bar.getBBox(), r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', bb.x - 60); r.setAttribute('y', bb.y - 60);
        r.setAttribute('width', bb.width + 120); r.setAttribute('height', bb.height + 120);
        r.setAttribute('class', 'pc-bar-bg');
        bar.insertBefore(r, bar.firstChild);
        st.barRect = r;
      } catch (e) { /* getBBox unavailable (hidden) */ }
      scrollIntoView(bar);
    }
    const reg = st.regions[bar.id];
    st.on.forEach(n => n.classList.remove('pc-on'));
    st.on = [];
    if (!reg) return;
    const q = reg.q0 + (offset || 0) + 1e-6;
    let entry = null;
    for (const e of reg.entries) { if (e.q <= q) entry = e; else break; }
    if (!entry) return;
    entry.notes.forEach(id => {
      const n = st.el.querySelector('[id="' + id + '"]');
      if (n) { n.classList.add('pc-on'); st.on.push(n); }
    });
  }

  /** v6: shade the measures of the practice loop (indices into the score's measures). */
  function markRange(a, b) {
    st.range.forEach(n => { n.classList.remove('pc-loop'); const r = n.querySelector(':scope > rect.pc-loop-bg'); if (r) r.remove(); });
    st.range = [];
    if (a == null || b == null) return;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      const m = st.measures[i];
      if (!m) continue;
      m.classList.add('pc-loop'); st.range.push(m);
      try {
        const bb = m.getBBox(), r = document.createElementNS(SVGNS, 'rect');
        r.setAttribute('x', bb.x - 30); r.setAttribute('y', bb.y - 90);
        r.setAttribute('width', bb.width + 60); r.setAttribute('height', bb.height + 180);
        r.setAttribute('class', 'pc-loop-bg');
        m.insertBefore(r, m.firstChild);
      } catch (e) { /* hidden */ }
    }
  }

  function scrollIntoView(node) {
    const box = st.el; if (!box) return;
    const r = node.getBoundingClientRect(), c = box.getBoundingClientRect();
    if (r.top >= c.top + 10 && r.bottom <= c.bottom - 10) return;
    const target = box.scrollTop + (r.top - c.top) - 30;
    if (typeof box.scrollTo === 'function') box.scrollTo({ top: Math.max(0, target), behavior: Date.now() - st.lastScroll < 400 ? 'auto' : 'smooth' });
    else box.scrollTop = Math.max(0, target);
    st.lastScroll = Date.now();
  }

  root.PCNotation = {
    URL: VEROVIO_URL, load, render, highlight, markRange, clear: clearHighlight,
    available: () => !!tk, error: () => lastError, measureCount: () => st.measures.length, width: () => st.width
  };
})(typeof self !== 'undefined' ? self : this);
