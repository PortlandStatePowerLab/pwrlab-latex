// Small DOM + API helpers shared by all views.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export class ApiError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(path, opts);
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  else data = await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/me')) location.hash = '#/login';
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  }
  return data;
}

export function toast(msg, kind = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts' }); document.body.append(box); }
  const t = h('div', { class: `toast toast-${kind}` }, msg);
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

/** Open a modal. `build(close)` returns the body content. Resolves with the value passed to close(). */
export function modal(title, build, { wide = false, tall = false } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const close = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      prevFocus?.focus?.();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(undefined); };
    const box = h('div', { class: 'modal' + (wide ? ' modal-wide' : '') + (tall ? ' modal-tall' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(undefined) }, '✕')),
      h('div', { class: 'modal-body' }, build(close)));
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(undefined); } }, box);
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => box.querySelector('input,select,textarea,button.primary')?.focus(), 20);
  });
}

export function prompt(title, { label = '', value = '', placeholder = '', okText = 'OK', hint = '' } = {}) {
  return modal(title, (close) => {
    const input = h('input', { type: 'text', value, placeholder });
    const form = h('form', { onsubmit: (e) => { e.preventDefault(); close(input.value.trim()); } },
      label && h('label', {}, label), input, hint && h('p', { class: 'hint' }, hint),
      h('div', { class: 'modal-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(undefined) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, okText)));
    setTimeout(() => { input.focus(); const dot = value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 ? dot : value.length); }, 30);
    return form;
  });
}

export function confirmBox(title, message, { okText = 'Confirm', danger = false } = {}) {
  return modal(title, (close) => h('div', {},
    h('p', {}, message),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => close(true) }, okText)))).then((v) => !!v);
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr} hour${hr > 1 ? 's' : ''} ago`;
  const d = Math.round(hr / 24); if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

export function avatar(user, title) {
  return h('span', { class: 'avatar', style: { background: user.color || '#6b7280' }, title: title || user.name }, initials(user.name || '?'));
}

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Simple dropdown menu anchored to an element. items: [{label, onClick, danger, disabled} | 'sep'] */
export function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => it === 'sep'
    ? h('div', { class: 'menu-sep' })
    : h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: it.disabled, onclick: (e) => { e.stopPropagation(); m.remove(); it.onClick(); } }, it.label)));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - mw - 8)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? r.top - mh - 4 : r.bottom + 4) + 'px';
  const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true));
  m.querySelector('button')?.focus();
  return m;
}
