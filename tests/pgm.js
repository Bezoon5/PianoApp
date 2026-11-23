const fs = require('fs');
module.exports = function readPGM(p) {
  const b = fs.readFileSync(p); let i = 0;
  const tok = () => { while (/\s/.test(String.fromCharCode(b[i]))) i++; if (b[i] === 35) { while (b[i] !== 10) i++; return tok(); } let s = ''; while (!/\s/.test(String.fromCharCode(b[i]))) s += String.fromCharCode(b[i++]); return s; };
  if (tok() !== 'P5') throw Error('not P5');
  const w = +tok(), h = +tok(); tok(); i++;
  return { w, h, gray: new Uint8Array(b.buffer, b.byteOffset + i, w * h).slice() };
};
