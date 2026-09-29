'use strict';
/**
 * Split a SQL script into individual statements (the Neon HTTP driver runs one
 * statement per request). Respects quoted strings, dollar-quoting and comments.
 */
function splitSql(text) {
  const src = String(text).replace(/\r/g, '');
  const out = [];
  let cur = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.substr(i, 2);
    if (two === '--') {                       // line comment
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {                       // block comment
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {             // quoted string / identifier
      const q = c;
      cur += c; i++;
      while (i < n) {
        cur += src[i];
        if (src[i] === q) {
          if (src[i + 1] === q) { cur += src[i + 1]; i += 2; continue; }  // escaped quote
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === '$') {                          // dollar quoting
      const m = /^\$([A-Za-z_]*)\$/.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        const end = src.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        cur += src.slice(i, stop); i = stop;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = ''; i++;
      continue;
    }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
module.exports = { splitSql };
