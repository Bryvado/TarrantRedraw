// Small shared helpers.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

export const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of [].concat(kids)) {
    if (k == null) continue;
    n.append(typeof k === 'string' ? document.createTextNode(k) : k);
  }
  return n;
};

export const fmtInt = (n) =>
  (n == null || !Number.isFinite(n)) ? '—' : Math.round(n).toLocaleString('en-US');

export const fmtPct = (x, dp = 1) =>
  (x == null || !Number.isFinite(x)) ? '—' : (x * 100).toFixed(dp) + '%';

export const fmtSigned = (x, dp = 1) =>
  (x == null || !Number.isFinite(x)) ? '—'
    : (x >= 0 ? '+' : '−') + (Math.abs(x) * 100).toFixed(dp) + '%';

export const fmtNum = (x, dp = 3) =>
  (x == null || !Number.isFinite(x)) ? '—' : x.toFixed(dp);

/** Democratic two-party share from summed votes. Null when no votes. */
export const share = (d, r) => (d + r > 0 ? d / (d + r) : null);

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function debounceFrame(fn) {
  let pending = false;
  return (...args) => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...args); });
  };
}

/** Minimal CSV parser: handles quoted fields, CRLF, BOM. Returns array of arrays. */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = '', i = 0, quoted = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',' || c === '|') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

export function download(name, text, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
