'use strict';

async function stopRun(id, isSol) {
  try {
    await api(isSol ? '/sol/stop' : '/mint/stop', { runId: id });
    warn('Stopped', id);
  } catch (e) { err('Stop failed', e.message); }
}

const NAV_ORDER = ['Overview', 'Minting', 'NFT', 'Wallets', 'Identity', 'Infra'];
const PAGE_ORDER = ['home', 'quick', 'mint', 'tasks', 'nftview', 'sniper', 'wlcheck', 'projects', 'floorwar', 'wallets', 'deleg', 'accounts', 'xmod', 'btc', 'proxies', 'rpc', 'chains', 'settings', 'gas', 'logs'];

function renderNav() {
  const nav = $('nav');
  const groups = {};
  const hidden = new Set(['eligible', 'nftinv', 'pnl']);
  Object.entries(PAGES).filter(([k]) => !hidden.has(k)).forEach(([k, p]) => {
    (groups[p.group] = groups[p.group] || []).push([k, p]);
  });
  const item = ([k, p]) => `<button data-p="${k}" title="${esc(p.label)}"><span class="ic">${icon(p.icon)}</span>${esc(p.label)}</button>`;
  nav.innerHTML = NAV_ORDER.filter((g) => groups[g]).map((g) => {
    const items = groups[g].slice().sort(([ak], [bk]) => PAGE_ORDER.indexOf(ak) - PAGE_ORDER.indexOf(bk));
    const redundant = items.length === 1 && (items[0][1].label === g || g === 'Overview');
    return (redundant ? '' : `<div class="grp">${esc(g)}</div>`) + items.map(item).join('');
  }).join('');
  qa('nav button').forEach((b) => { b.onclick = () => { go(b.dataset.p); closeNav(); }; });
}

function closeNav() {
  $('nav').classList.remove('open');
  $('navScrim').classList.remove('on');
  $('navToggle').setAttribute('aria-expanded', 'false');
}
$('navToggle').onclick = () => {
  const open = $('nav').classList.toggle('open');
  $('navScrim').classList.toggle('on', open);
  $('navToggle').setAttribute('aria-expanded', String(open));
};
$('navScrim').onclick = closeNav;

const PAGE_ELS = {};

function hidePage(el) {
  const h = el._hide || el._cleanup;
  if (h) { try { h(); } catch { /* */ } }
}
function showPage(el) {
  if (el._show) { try { el._show(); } catch { /* */ } }
}

function go(key) {
  if (!PAGES[key]) return;
  const main = $('main');
  const prevKey = S.page;
  if (prevKey && prevKey !== key && PAGE_ELS[prevKey]) {
    hidePage(PAGE_ELS[prevKey]);
    PAGE_ELS[prevKey].style.display = 'none';
  }
  S.page = key;
  qa('nav button').forEach((b) => b.classList.toggle('on', b.dataset.p === key));
  let el = PAGE_ELS[key];
  if (!el) {
    el = document.createElement('div');
    el.className = 'page on';
    main.appendChild(el);
    try { PAGES[key].render(el); } catch (e) { el.innerHTML = `<div class="failbox">Render error: ${esc(e.message)}</div>`; }
    PAGE_ELS[key] = el;
  } else {
    el.style.display = '';
    showPage(el);
  }
  main.classList.toggle('has-selbar', !!el.querySelector('.selbar:not(.hide)'));
  location.hash = key;
}

async function loadAll() {
  const [st, we, ws, wb, ac, px, rp] = await Promise.all([
    api('/state'), api('/wallets?kind=evm'), api('/wallets?kind=sol'), api('/wallets?kind=btc'),
    api('/accounts'), api('/proxies'), api('/rpc'),
  ]);
  S.chains = st.chains; S.settings = st.settings;
  S.wallets.evm = we.wallets; S.wgroups.evm = we.groups;
  S.wallets.sol = ws.wallets; S.wgroups.sol = ws.groups;
  S.wallets.btc = wb.wallets; S.wgroups.btc = wb.groups;
  S.accounts = ac.accounts; S.agroups = ac.groups;
  S.proxies = px; S.rpcs = rp;
}

async function tickGas() {
  try {
    const chain = ($('hChain') && $('hChain').value) || 'ethereum';
    const g = await api('/gas', { chain, gasLimit: 200000, nftCount: 1, pricePerNft: 0 });
    $('hGwei').textContent = fx(g.currentGwei, 2);
    if (g.ethUsd) { S.ethUsd = g.ethUsd; $('hEth').textContent = '$' + num(g.ethUsd, 0); }
    if (g.usdIdr) S.usdIdr = g.usdIdr;
  } catch { /* locked or offline */ }
}

function initGasChain() {
  const hc = $('hChain');
  if (!hc || !S.chains.length) return;
  hc.innerHTML = S.chains.filter((c) => !c.hidden || c.key === 'ethereum')
    .map((c) => `<option value="${c.key}">${esc(c.symbol === 'ETH' ? c.name : c.symbol)}</option>`).join('');
  const saved = localStorage.getItem('jaio-hchain');
  if (saved && [...hc.options].some((o) => o.value === saved)) hc.value = saved;
  hc.onchange = () => { localStorage.setItem('jaio-hchain', hc.value); tickGas(); };
}

function tickClock() {
  const el = $('hClock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
}

async function boot() {
  let st;
  try { st = await api('/state'); } catch (e) { $('lockHint').textContent = 'Server unreachable'; return; }
  S.locked = st.locked;
  $('lockHint').innerHTML = st.initialized
    ? 'Enter your master password to decrypt the vault.'
    : 'First run. Choose a master password (min 8 chars).<br>It encrypts all keys and tokens with AES-256-GCM.<br><b>There is no recovery if you lose it.</b>';
  if (!st.locked) { await afterUnlock(); }
}

async function afterUnlock() {
  hideLock();
  await loadAll();
  renderNav();
  initGasChain();
  startSSE();
  tickGas();
  setInterval(tickGas, 30000);
  tickClock();
  setInterval(tickClock, 1000);
  const h = location.hash.replace('#', '');
  go(PAGES[h] ? h : 'home');
}

$('unlockBtn').onclick = async () => {
  const pw = $('mpw').value;
  if (!pw) { $('lockErr').textContent = 'Enter your master password.'; $('mpw').focus(); return; }
  const b = $('unlockBtn');
  $('lockErr').textContent = '';
  b.disabled = true; b.innerHTML = '<span class="spin"></span> Unlocking';
  try {
    const unlockResult = await api('/unlock', { password: pw });
    if (unlockResult.sessionToken) sessionStorage.setItem('jaio-session', unlockResult.sessionToken);
    $('mpw').value = '';
    await afterUnlock();
    ok('Vault unlocked');
  } catch (e) {
    $('lockErr').textContent = e.message;
    $('mpw').select();
  } finally { b.disabled = false; b.textContent = 'Unlock'; }
};
$('mpw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('unlockBtn').click(); });

$('eyeBtn').onclick = () => {
  const i = $('mpw'), on = i.type === 'password';
  i.type = on ? 'text' : 'password';
  $('eyeBtn').setAttribute('aria-label', on ? 'Hide password' : 'Show password');
  $('eyeBtn').title = on ? 'Hide password' : 'Show password';
  i.focus();
};

$('lockBtn').onclick = async () => {
  const b = $('lockBtn');
  b.disabled = true;
  try {
    await api('/lock', {});
    sessionStorage.removeItem('jaio-session');
    S.locked = true;
    showLock('Locked. Enter password to unlock.');
  } catch (e) { err('Lock failed', e.message); }
  finally { b.disabled = false; }
};

$('panicBtn').onclick = () => confirmBox('Stop all runs?',
  'Every active mint and X run will be halted. Transactions already broadcast cannot be recalled.',
  async () => {
    try { const r = await api('/mint/stop-all', {}); warn('Stopped', `${r.stopped} run(s)`); }
    catch (e) { err('Failed', e.message); }
  }, 'Stop everything');

window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (h && PAGES[h] && h !== S.page) go(h);
});

boot();
