'use strict';

const S = {
  locked: true, chains: [], settings: {},
  wallets: { evm: [], sol: [], btc: [] },
  wgroups: { evm: [], sol: [], btc: [] },
  accounts: [], agroups: [], proxies: [], rpcs: [],
  runs: [], page: null, ethUsd: null, usdIdr: null,
};

const PAGES = {};   // key -> {label, group, icon, render(el)}
function page(key, def) { PAGES[key] = def; }

function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'light' ? 'light' : 'night';
}
function applyTheme(t) {
  if (t !== 'light' && t !== 'night') t = 'night';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('jaio_theme', t); } catch (e) { /* private mode */ }
}

const ICON_PATHS = {
  dash: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  mint: '<path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z"/><path d="M12 21.5v-9M21 7.5l-9 5-9-5"/>',
  gas: '<path d="M4 21V5.5A2.5 2.5 0 0 1 6.5 3h4A2.5 2.5 0 0 1 13 5.5V21"/><path d="M3 21h11M4 11h9"/><path d="M13 8h3a2 2 0 0 1 2 2v6.5a2 2 0 0 0 2 2 2 2 0 0 0 2-2V11l-2.5-3"/>',
  inv: '<path d="M3 8.5 12 3.5l9 5v7L12 20.5l-9-5z"/><path d="M3 8.5 12 13.5l9-5M12 13.5v7"/>',
  floor: '<path d="M3 20V9l5-3 5 3 5-2.5 3 1.5V20z"/><path d="M8 20v-7M13 20v-8M18 20v-6"/>',
  pnl: '<path d="M3 20h18"/><path d="M4 15.5 9.5 10l4 3.5L20 6"/><path d="M20 10.5V6h-4.5"/>',
  wallets: '<rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M2.5 10.5h19"/><circle cx="17" cy="15" r="1.2"/>',
  accounts: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  x: '<path d="M4.5 4.5 19.5 19.5M19.5 4.5 4.5 19.5"/>',
  submit: '<path d="M12 16.5V4.5"/><path d="M7.5 9 12 4.5 16.5 9"/><path d="M4 16v3.5h16V16"/>',
  proxy: '<path d="M4 8h11l-3-3M20 16H9l3 3"/><circle cx="19" cy="8" r="2"/><circle cx="5" cy="16" r="2"/>',
  rpc: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/>',
  chains: '<path d="M9.5 14.5 7 17a3.5 3.5 0 0 1-5-5l2.5-2.5"/><path d="M14.5 9.5 17 7a3.5 3.5 0 0 1 5 5l-2.5 2.5"/><path d="M9 15l6-6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 7l2.6 1.5M17.2 15.5l2.6 1.5M4.2 17l2.6-1.5M17.2 8.5l2.6-1.5"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a7 7 0 0 0 9.7 9.7z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  logs: '<path d="M5 3.5h14v17H5z"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/>',
  runs: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>',
  feed: '<path d="M3 12h4l2.5-5 3 10 2.5-5H21"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12 20 3M17.5 5.5 20 8M15 8l2.5 2.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14.5 5.5 18.5 9.5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 4.5h4M9.5 11v6M14.5 11v6"/><path d="M6 7l1 12.5h10L18 7"/>',
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3 14.5 21l-4-7.5L3 9.5z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a3 3 0 0 0-3 3v6.5A2.5 2.5 0 0 0 5.5 15"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M15.8 15.8 21 21"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 4v4.8h-4.8"/>',
  funds: '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6"/><path d="M4.5 12v6c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-6"/>',
  eth: '<path d="M12 2.5 5.5 12.5 12 16l6.5-3.5z"/><path d="M12 17.6 5.5 14l6.5 7.5L18.5 14z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  tools: '<path d="M14.7 6.3a3.8 3.8 0 0 0 5 5L21 21H3l7.5-7.5"/><path d="M10.5 13.5 5 8a2.5 2.5 0 0 1 0-3.5L9 8.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.8 2.8L16.5 9.5"/>',
  link: '<path d="M9.5 14.5 7 17a3.5 3.5 0 0 1-5-5l2.5-2.5"/><path d="M14.5 9.5 17 7a3.5 3.5 0 0 1 5 5l-2.5 2.5"/><path d="M9 15l6-6"/>',
  unlink: '<path d="M9.5 14.5 7 17a3.5 3.5 0 0 1-5-5l2.5-2.5"/><path d="M14.5 9.5 17 7a3.5 3.5 0 0 1 5 5l-2.5 2.5"/><path d="M4 4l16 16"/>',
  xlogo: '<path d="M4 4l7.2 8.6L4.4 20h2.1l5.8-6.3 4.9 6.3H20l-7.4-9L19.6 4h-2.1l-5 5.5L8.4 4z"/>',
  discord: '<path d="M8.5 8.2A11 11 0 0 1 15.5 8.2"/><path d="M8.5 8.2C6 9 4.5 11 4 14.2c0 0 2 2 4 2.4l1-1.7"/><path d="M15.5 8.2c2.5.8 4 2.8 4.5 6 0 0-2 2-4 2.4l-1-1.7"/><circle cx="9.6" cy="13" r="1.1"/><circle cx="14.4" cy="13" r="1.1"/>',
  mail: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  col: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><path d="M13 17h8M17 13v8"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v18H5.5A1.5 1.5 0 0 1 4 19.5z"/><path d="M4 17.5h15"/><path d="M8 7h7"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  offer: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><path d="M8 8l6.5 6.5M14.5 14.5v-4M14.5 14.5h-4"/>',
};
function icon(name, cls) {
  const p = ICON_PATHS[name];
  if (!p) return '';
  return `<svg class="i ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

function gate(el, ok, reason) {
  const b = typeof el === 'string' ? $(el) : el;
  if (!b) return;
  if (ok) {
    b.removeAttribute('aria-disabled');
    b.removeAttribute('data-gated');
    b.title = '';
  } else {
    b.setAttribute('aria-disabled', 'true');
    b.setAttribute('data-gated', '1');
    b.title = reason || '';
  }
}

['click', 'keydown'].forEach((evt) => {
  document.addEventListener(evt, (e) => {
    const b = e.target.closest && e.target.closest('[data-gated]');
    if (!b) return;
    if (evt === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (b.title) warn(b.title);
  }, true);
});

function emptyState(o) {
  const c = o || {};
  return `<div class="empty">
    ${c.icon ? `<div class="eic">${icon(c.icon)}</div>` : ''}
    <div class="et">${esc(c.title || 'Nothing here yet')}</div>
    ${c.desc ? `<div class="ed">${esc(c.desc)}</div>` : ''}
    ${c.action ? `<button class="btn sm" onclick="${c.action.onclick}">${esc(c.action.label)}</button>` : ''}
  </div>`;
}

async function api(path, body, method) {
  const opt = { method: method || (body ? 'POST' : 'GET'), headers: { 'x-jaio-app': '1' }, credentials: 'same-origin' };
  const session = sessionStorage.getItem('jaio-session');
  if (session) opt.headers['x-jaio-session'] = session;
  if (body) { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch('/api' + path, opt);
  let d = null;
  try { d = await r.json(); } catch { d = {}; }
  if (r.status === 423) { S.locked = true; showLock('Vault locked'); throw new Error('vault locked'); }
  if (r.status === 401) { sessionStorage.removeItem('jaio-session'); throw new Error(d.error || 'session expired'); }
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const del = (p, b) => api(p, b, 'DELETE');

function toast(title, msg, kind) {
  const d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.innerHTML = `<b>${esc(title)}</b>${msg ? `<div class="msg">${esc(String(msg))}</div>` : ''}`;
  document.getElementById('toasts').appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 250); }, kind === 'fail' ? 7000 : 4000);
}
const ok = (t, m) => toast(t, m, 'ok');
const err = (t, m) => toast(t, m, 'fail');
const warn = (t, m) => toast(t, m, 'warn');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (id) => document.getElementById(id);
const q = (sel, root) => (root || document).querySelector(sel);
const qa = (sel, root) => [...(root || document).querySelectorAll(sel)];
const short = (a, n) => (a ? a.slice(0, n || 6) + '…' + a.slice(-4) : '');
const fx = (v, d) => (v == null || v === '' || isNaN(v) ? '—' : Number(v).toFixed(d == null ? 4 : d));
const ts = (t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false });
function fmtCountdown(msLeft) {
  if (msLeft == null || isNaN(msLeft)) return '—';
  if (msLeft <= 0) return 'now';
  let s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const p = (n) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${p(h)}:${p(m)}:${p(s)}`;
  if (h > 0) return `${p(h)}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}
function num(v, d) { return v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d == null ? 4 : d }); }
function idr(v) {
  if (v == null || isNaN(v)) return '—';
  const n = Number(v);
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}Rp ${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}M`;
  if (a >= 1e6) return `${sign}Rp ${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}jt`;
  if (a >= 1e3) return `${sign}Rp ${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}rb`;
  return `${sign}Rp ${Math.round(a)}`;
}
function ethIdr(eth) {
  if (eth == null || isNaN(eth) || !S.ethUsd || !S.usdIdr) return null;
  return Number(eth) * S.ethUsd * S.usdIdr;
}
function copy(t) { navigator.clipboard.writeText(t).then(() => toast('Copied', String(t).slice(0, 60))); }
function dl(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function chainOpts(sel) {
  return S.chains.filter((c) => !c.hidden || c.key === sel)
    .map((c) => `<option value="${c.key}"${c.key === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
}
function nativeSym(chainKey) {
  const c = (S.chains || []).find((x) => x.key === chainKey);
  return c && c.symbol ? c.symbol : '';
}
function explorerTx(chainKey, hash) {
  const c = S.chains.find((x) => x.key === chainKey);
  return c && c.explorer ? `${c.explorer}/tx/${hash}` : null;
}
function ago(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h';
}
function dur(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function modal(html, wide) {
  const box = $('modalBox');
  window.__modalFocus = document.activeElement;
  box.className = 'box' + (wide ? ' wide' : '');
  box.innerHTML = html;
  const heading = box.querySelector('h3');
  if (heading) heading.id = 'modalTitle';
  $('modal').classList.add('on');
  requestAnimationFrame(() => (box.querySelector('input,select,textarea,button,[href]') || box).focus());
}
function closeModal() {
  $('modal').classList.remove('on');
  if (window.__modalFocus && window.__modalFocus.isConnected) window.__modalFocus.focus();
}
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function confirmBox(title, body, onYes, yesLabel) {
  modal(`<h3>${esc(title)}</h3><div class="sm" style="color:var(--txt2);line-height:1.6">${body}</div>
  <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button>
  <button class="btn danger" id="cfYes">${esc(yesLabel || 'Confirm')}</button></div>`);
  $('cfYes').onclick = () => { closeModal(); onYes(); };
}

function confirmTyped(title, body, phrase, onYes, yesLabel) {
  modal(`<h3>${esc(title)}</h3><div class="sm" style="color:var(--txt2);line-height:1.6">${body}</div>
  <label class="f" style="margin-top:var(--s3)">Type <code>${esc(phrase)}</code> to confirm</label>
  <input id="ctIn" autocomplete="off" placeholder="${esc(phrase)}">
  <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button>
  <button class="btn danger" id="ctYes" aria-disabled="true">${esc(yesLabel || 'Confirm')}</button></div>`);
  const inp = $('ctIn'); const btn = $('ctYes');
  const ok2 = () => inp.value.trim() === phrase;
  const sync = () => btn.setAttribute('aria-disabled', String(!ok2()));
  inp.oninput = sync;
  inp.onkeydown = (e) => { if (e.key === 'Enter' && ok2()) btn.click(); };
  btn.onclick = () => { if (!ok2()) return; closeModal(); onYes(); };
  inp.focus();
}

function pillList(items, selectedSet, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'pills';
  items.forEach((it) => {
    const b = document.createElement('div');
    b.className = 'pill' + (selectedSet.has(it.id) ? ' on' : '');
    b.textContent = it.label;
    b.onclick = () => {
      if (selectedSet.has(it.id)) selectedSet.delete(it.id); else selectedSet.add(it.id);
      b.classList.toggle('on');
      if (onChange) onChange(selectedSet);
    };
    wrap.appendChild(b);
  });
  return wrap;
}

// Checkbox tree wallet picker: ALL → groups → wallets (Disperse-style)
// opts: { wallets:[{id,name,address,groupId}], groups:[{id,name,count}], onChange(sel) }
function walletTree(sel, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'wtree';
  const wallets = opts.wallets || [];
  const groups = opts.groups || [];
  const excl = opts.exclude || null; /* rendered as a disabled row (e.g. disperse source) */
  const usable = excl ? wallets.filter((w) => w.id !== excl) : wallets;
  const groupOf = (gid) => usable.filter((w) => w.groupId === gid);
  const allIds = () => new Set(usable.map((w) => w.id));
  const grpIds = (gid) => new Set(groupOf(gid).map((w) => w.id));
  const any = (ids) => [...ids].some((id) => sel.has(id));
  const all = (ids) => ids.size > 0 && [...ids].every((id) => sel.has(id));

  function refresh(ids) {
    return { checked: all(ids), indeterminate: !all(ids) && any(ids) };
  }
  function setInput(inp, ids) {
    const r = refresh(ids);
    inp.checked = r.checked;
    inp.indeterminate = r.indeterminate;
  }

  const allRow = document.createElement('label');
  allRow.className = 'wt-row wt-all';
  const allC = document.createElement('input');
  allC.type = 'checkbox';
  allRow.appendChild(allC);
  const allLbl = document.createElement('span');
  allLbl.className = 'wt-lbl'; allLbl.textContent = 'ALL';
  const allCnt = document.createElement('span');
  allCnt.className = 'wt-cnt'; allCnt.textContent = `${wallets.length}`;
  allRow.append(allLbl, allCnt);
  allC.onchange = () => { allIds().forEach((id) => { if (allC.checked) sel.add(id); else sel.delete(id); }); rerender(); };
  wrap.appendChild(allRow);

  const grpBox = document.createElement('div');
  grpBox.className = 'wt-groups';
  for (const g of groups) {
    const gRows = groupOf(g.id);
    if (!gRows.length) continue;
    const gRow = document.createElement('label');
    gRow.className = 'wt-row wt-grp';
    const gC = document.createElement('input');
    gC.type = 'checkbox'; gC.dataset.g = g.id;
    gRow.appendChild(gC);
    const exp = document.createElement('span');
    exp.className = 'wt-exp';
    const gLbl = document.createElement('span');
    gLbl.className = 'wt-lbl'; gLbl.textContent = g.name;
    const gCnt = document.createElement('span');
    gCnt.className = 'wt-cnt'; gCnt.textContent = `${gRows.length}`;
    gRow.append(exp, gLbl, gCnt);
    gC.onchange = () => { grpIds(g.id).forEach((id) => { if (gC.checked) sel.add(id); else sel.delete(id); }); rerender(); };
    exp.onclick = (e) => { e.preventDefault(); e.stopPropagation(); wBox.classList.toggle('open'); exp.classList.toggle('on'); };

    const wBox = document.createElement('div');
    wBox.className = 'wt-wallets open'; /* expanded by default */
    exp.classList.add('on');
    const exclHere = excl ? wallets.find((w) => w.id === excl && w.groupId === g.id) : null;
    if (exclHere) {
      const xRow = document.createElement('label');
      xRow.className = 'wt-row wt-wal';
      xRow.title = 'source wallet — excluded';
      const xC = document.createElement('input');
      xC.type = 'checkbox'; xC.disabled = true;
      const xLbl = document.createElement('span');
      xLbl.className = 'wt-lbl'; xLbl.textContent = exclHere.name || short(exclHere.address, 6);
      xLbl.style.opacity = '.45'; xLbl.style.textDecoration = 'line-through';
      const xAddr = document.createElement('span');
      xAddr.className = 'wt-addr'; xAddr.textContent = short(exclHere.address, 4);
      xRow.append(xC, xLbl, xAddr);
      wBox.appendChild(xRow);
    }
    for (const w of gRows) {
      const wRow = document.createElement('label');
      wRow.className = 'wt-row wt-wal';
      const wC = document.createElement('input');
      wC.type = 'checkbox'; wC.checked = sel.has(w.id); wC.dataset.w = w.id; wC.dataset.gp = g.id;
      wC.onchange = () => { if (wC.checked) sel.add(w.id); else sel.delete(w.id); rerender(); };
      const wLbl = document.createElement('span');
      wLbl.className = 'wt-lbl'; wLbl.textContent = w.name || short(w.address, 6);
      const wAddr = document.createElement('span');
      wAddr.className = 'wt-addr'; wAddr.textContent = short(w.address, 4);
      wRow.append(wC, wLbl, wAddr);
      wBox.appendChild(wRow);
    }
    grpBox.appendChild(gRow);
    grpBox.appendChild(wBox);
  }
  wrap.appendChild(grpBox);

  function rerender() {
    setInput(allC, allIds());
    for (const g of groups) {
      const gC = grpBox.querySelector(`input[data-g="${g.id}"]`);
      if (gC) setInput(gC, grpIds(g.id));
      grpBox.querySelectorAll(`input[data-w][data-gp="${g.id}"]`).forEach((inp) => { inp.checked = sel.has(inp.dataset.w); });
    }
    if (opts.onChange) opts.onChange(sel);
  }
  rerender();
  return wrap;
}

function conLine(el, e) {
  const d = document.createElement('div');
  d.className = 'l ' + (e.level || 'info');
  d.innerHTML = `<span class="t">${ts(e.t || Date.now())}</span>`
    + `<span class="w">${esc(e.wallet || e.account || '')}</span>`
    + `<span class="m">${esc(e.msg || '')}</span>`;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.appendChild(d);
  while (el.children.length > 500) el.firstChild.remove();
  if (atBottom) el.scrollTop = el.scrollHeight;
}

document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  img.hidden = true;
  const host = img.parentElement;
  if (host && !host.querySelector('.img-fallback')) {
    const fallback = document.createElement('span');
    fallback.className = 'img-fallback';
    fallback.setAttribute('aria-label', 'Image unavailable');
    fallback.innerHTML = icon('col');
    host.appendChild(fallback);
  }
}, true);

const SSE_SUBS = new Set();
function onEvent(fn) { SSE_SUBS.add(fn); return () => SSE_SUBS.delete(fn); }

function startSSE() {
  const es = new EventSource('/api/events');
  es.onopen = () => $('sseDot').className = 'dot live';
  es.onerror = () => $('sseDot').className = 'dot off';
  es.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    SSE_SUBS.forEach((f) => { try { f(e); } catch { /* ignore */ } });
  };
}

function showLock(hint) {
  $('lock').style.display = 'flex';
  $('app').classList.remove('on');
  $('lockErr').textContent = '';
  if (hint) $('lockHint').textContent = hint;
  const el = $('mpw');
  if (el) { el.value = ''; setTimeout(() => el.focus(), 30); }
}
function hideLock() {
  $('lock').style.display = 'none';
  $('app').classList.add('on');
}
function initGasCalculator() {
  const btn = $('gasCalcBtn');
  if (!btn) return;

  btn.onclick = () => {
    modal(`
      <h3>${icon('pnl')} Gas Profit Calculator</h3>
      <div class="row" style="margin-top:var(--s3)">
        <div style="flex:1"><label class="f">Mint Price ($)</label><input id="gcMint" type="number" step="any" placeholder="0" class="mono"></div>
        <div style="flex:1"><label class="f">Sell Price ($)</label><input id="gcSell" type="number" step="any" placeholder="0" class="mono"></div>
      </div>
      <div class="row" style="margin-top:var(--s2)">
        <div style="flex:1"><label class="f">OTC Price ($)</label><input id="gcOtc" type="number" step="any" placeholder="0" class="mono"></div>
        <div style="flex:1"><label class="f">Royalty Fee (%)</label><input id="gcRoy" type="number" step="any" placeholder="0" class="mono"></div>
      </div>
      <div style="margin-top:var(--s3)">
        <div class="row" style="justify-content:space-between">
          <label class="f">Gas Aggressivity (<span id="gcAggVal">50</span>%)</label>
        </div>
        <input id="gcAgg" type="range" min="0" max="100" value="50" style="width:100%">
      </div>
      <div class="grid g2" style="margin-top:var(--s4)">
        <div class="card" style="margin:0;padding:var(--s3)">
          <div class="f">Gas Budget</div>
          <div id="gcBudget" class="bignum" style="font-size:20px;color:var(--accent)">$0.00</div>
        </div>
        <div class="card" style="margin:0;padding:var(--s3)">
          <div class="f">Potential Profit</div>
          <div id="gcProfit" class="bignum" style="font-size:20px">$0.00</div>
        </div>
      </div>
      <div class="acts" style="margin-top:var(--s4)">
        <button class="btn" onclick="closeModal()">Close</button>
      </div>
    `);

    const calc = () => {
      const mintP = Number($('gcMint').value || 0);
      const sellP = Number($('gcSell').value || 0);
      const otcP = Number($('gcOtc').value || 0);
      const royP = Number($('gcRoy').value || 0);
      const aggP = Number($('gcAgg').value || 50);

      $('gcAggVal').textContent = aggP;

      const netSell = sellP * (1 - Math.min(Math.max(1 + royP, 0), 100) / 100);
      const profitBeforeGas = netSell - mintP - Math.max(0, otcP);
      const budget = (aggP / 100) * Math.max(0, profitBeforeGas);
      const potentialProfit = profitBeforeGas - budget;

      $('gcBudget').textContent = `$${num(budget, 2)}`;
      const pEl = $('gcProfit');
      pEl.textContent = `$${num(potentialProfit, 2)}`;
      pEl.className = 'bignum ' + (potentialProfit < 0 ? 'fail' : 'ok');
    };

    ['gcMint', 'gcSell', 'gcOtc', 'gcRoy', 'gcAgg'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', calc);
    });
  };
}
