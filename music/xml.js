/*
 * Minimal, dependency-free XML parser and serializer (browser + Node).
 * Enough for MusicXML: elements, attributes, text, entities, comments,
 * CDATA, processing instructions and DOCTYPE (including internal subsets).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PCXml = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' };
  function decode(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return NAMED[e] != null ? NAMED[e] : m;
    });
  }
  function encode(s, attr) {
    s = String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return attr ? s.replace(/"/g, '&quot;') : s;
  }

  function parse(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const doc = { name: '#document', attrs: {}, children: [] }, stack = [doc], n = text.length;
    const top = () => stack[stack.length - 1];
    const addText = s => { if (/\S/.test(s)) top().children.push({ text: decode(s) }); };
    let i = 0;
    while (i < n) {
      const lt = text.indexOf('<', i);
      if (lt < 0) { addText(text.slice(i)); break; }
      if (lt > i) addText(text.slice(i, lt));
      if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt + 9); top().children.push({ text: text.slice(lt + 9, e < 0 ? n : e) }); i = e < 0 ? n : e + 3; continue; }
      if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
      if (text.startsWith('<!', lt)) {
        let j = lt + 2, depth = 0, q = null;
        for (; j < n; j++) {
          const c = text[j];
          if (q) { if (c === q) q = null; }
          else if (c === '"' || c === "'") q = c;
          else if (c === '[') depth++;
          else if (c === ']') depth--;
          else if (c === '>' && depth <= 0) break;
        }
        i = j + 1; continue;
      }
      if (text[lt + 1] === '/') {
        const e = text.indexOf('>', lt);
        const name = text.slice(lt + 2, e < 0 ? n : e).trim();
        for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
        i = e < 0 ? n : e + 1; continue;
      }
      let j = lt + 1, q = null;
      for (; j < n; j++) {
        const c = text[j];
        if (q) { if (c === q) q = null; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') break;
      }
      let inner = text.slice(lt + 1, j).trim();
      const selfClose = inner.endsWith('/');
      if (selfClose) inner = inner.slice(0, -1);
      const m = /^[^\s/>]+/.exec(inner);
      if (!m) { i = j + 1; continue; }
      const el = { name: m[0], attrs: {}, children: [] };
      const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      const rest = inner.slice(m[0].length);
      let a;
      while ((a = re.exec(rest))) el.attrs[a[1]] = decode(a[2] != null ? a[2] : a[3]);
      top().children.push(el);
      if (!selfClose) stack.push(el);
      i = j + 1;
    }
    return doc;
  }

  const isEl = c => c && c.name !== undefined;
  function root(doc) { return doc.children.find(isEl) || null; }
  function child(el, name) { return el ? el.children.find(c => c.name === name) || null : null; }
  function children(el, name) { return el ? el.children.filter(c => name ? c.name === name : isEl(c)) : []; }
  function text(el) {
    if (!el) return '';
    if (el.text != null) return el.text;
    return el.children.map(text).join('').trim();
  }
  function childText(el, name) { return text(child(el, name)); }
  function find(el, path) {
    let cur = el;
    for (const p of path.split('/')) { cur = child(cur, p); if (!cur) return null; }
    return cur;
  }
  function findAll(el, name, out) {
    out = out || [];
    if (!el || !el.children) return out;
    for (const c of el.children) { if (c.name === name) out.push(c); if (c.children) findAll(c, name, out); }
    return out;
  }

  function serialize(node, indent) {
    indent = indent || '';
    if (node.name === '#document') return '<?xml version="1.0" encoding="UTF-8"?>\n' + node.children.filter(isEl).map(c => serialize(c, '')).join('\n');
    if (node.text != null) return encode(node.text);
    const attrs = Object.keys(node.attrs).map(k => ' ' + k + '="' + encode(node.attrs[k], true) + '"').join('');
    if (!node.children.length) return indent + '<' + node.name + attrs + '/>';
    if (node.children.every(c => c.text != null)) return indent + '<' + node.name + attrs + '>' + node.children.map(c => encode(c.text)).join('') + '</' + node.name + '>';
    return indent + '<' + node.name + attrs + '>\n' + node.children.map(c => c.text != null ? indent + '  ' + encode(c.text) : serialize(c, indent + '  ')).join('\n') + '\n' + indent + '</' + node.name + '>';
  }

  return { parse, serialize, root, child, children, text, childText, find, findAll, decode, encode };
});
