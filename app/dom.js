// Tiny DOM builder. Everything is created with createElement/textContent — there is NO innerHTML anywhere
// in the app, so API data (names, venue names, explanations) can never be interpreted as markup.
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = String(v);   // CSSOM, not an inline attribute: allowed under a strict CSP
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const mount = (el, ...kids) => {
  clear(el);
  const add = (k) => { if (k == null || k === false) return; if (Array.isArray(k)) k.forEach(add); else el.append(k instanceof Node ? k : document.createTextNode(String(k))); };
  kids.forEach(add);
  return el;
};

let seq = 0;
// Labelled form control: <label for> + control, optional hint; returns {row, input}
export function field(label, input, hint) {
  const id = input.id || `f${++seq}`; input.id = id;
  const hintEl = hint ? h('div', { class: 'hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return { row: h('div', { class: 'field' }, h('label', { for: id }, label), input, hintEl), input };
}
export const badge = (text, kind = '') => h('span', { class: `badge ${kind}` }, text);
export function announce(msg) { const el = document.getElementById('status'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 20); } }
