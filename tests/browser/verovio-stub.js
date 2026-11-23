// Browser stand-in for verovio-toolkit-wasm.js: same API, rendering done by real Verovio (server.py).
window.verovio = { module: { calledRun: true }, toolkit: function () {
  let data = null, opts = {};
  this.setOptions = o => { opts = o; };
  this.loadData = xml => { const x = new XMLHttpRequest(); x.open('POST', '/__verovio', false); x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify({ xml, opts })); data = x.status === 200 ? JSON.parse(x.responseText) : { ok: false }; return data.ok; };
  this.getPageCount = () => data.pages.length;
  this.renderToSVG = p => data.pages[p - 1];
  this.renderToTimemap = () => data.timemap;
} };
