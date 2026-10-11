'use strict';
const store = require('./store');
const proxies = require('./proxies');
const wallets = require('./wallets');

const NAME = 'accounts';

function load() { return store.readSealed(NAME, { groups: [] }); }
function save(d) { return store.writeSealed(NAME, d); }
function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function addGroup(name, walletGroupId) {
  const d = load();
  const g = { id: nid('ag'), name, walletGroup: walletGroupId || null, accounts: [] };
  if (walletGroupId) {
    for (const w of wallets.listSafe('evm', walletGroupId === '__all__' ? [] : [walletGroupId])) {
      g.accounts.push({
        id: nid('ac'), name: w.name, walletId: w.id, address: w.address,
        gmail: null, gmailAppPass: null, gmailSession: null,
        xToken: null, xHandle: null, xCt0: null,
        discordToken: null, discordUsername: null,
        proxyId: null, status: {},
      });
    }
  }
  d.groups.push(g); save(d); return g;
}

function fromWallets(groupId, walletGroupId) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  if (!walletGroupId) throw new Error('walletGroup required');
  const have = new Set(g.accounts.map((a) => a.walletId).filter(Boolean));
  let added = 0;
  for (const w of wallets.listSafe('evm', walletGroupId === '__all__' ? [] : [walletGroupId])) {
    if (have.has(w.id)) continue;
    g.accounts.push({
      id: nid('ac'), name: w.name, walletId: w.id, address: w.address,
      gmail: null, gmailAppPass: null, gmailSession: null,
      xToken: null, xHandle: null, xCt0: null,
      discordToken: null, discordUsername: null,
      proxyId: null, status: {},
    });
    added++;
  }
  g.walletGroup = walletGroupId;
  save(d);
  return { added, count: g.accounts.length };
}

function removeGroup(id) {
  const d = load();
  d.groups = d.groups.filter((g) => g.id !== id);
  save(d); return true;
}

function renameGroup(id, name) {
  const d = load();
  const g = d.groups.find((x) => x.id === id);
  if (!g) throw new Error('group not found');
  g.name = String(name || '').trim() || g.name;
  save(d); return { id: g.id, name: g.name };
}

function bulkRemove(accountIds) {
  const ids = new Set(accountIds || []);
  if (!ids.size) return 0;
  const d = load();
  let n = 0;
  for (const g of d.groups) {
    const before = g.accounts.length;
    g.accounts = g.accounts.filter((a) => !ids.has(a.id));
    n += before - g.accounts.length;
  }
  save(d); return n;
}

function bulkDisconnect(accountIds, which) {
  const ids = new Set(accountIds || []);
  if (!ids.size) return 0;
  const map = {
    x: ['xToken', 'xCt0'],
    discord: ['discordToken'],
    gmail: ['gmail', 'gmailAppPass', 'gmailSession'],
    all: ['xToken', 'xCt0', 'discordToken', 'gmail', 'gmailAppPass', 'gmailSession'],
  };
  const keys = map[which || 'all'] || map.all;
  const d = load();
  let n = 0;
  for (const g of d.groups) for (const a of g.accounts) {
    if (!ids.has(a.id)) continue;
    keys.forEach((k) => { a[k] = null; });
    if (which === 'x' || which === 'all') delete (a.status || {}).x;
    if (which === 'discord' || which === 'all') delete (a.status || {}).discord;
    if (which === 'gmail' || which === 'all') delete (a.status || {}).gmail;
    n++;
  }
  save(d); return n;
}

function addAccount(groupId, fields = {}) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const a = {
    id: nid('ac'), name: fields.name || `acc${g.accounts.length + 1}`,
    walletId: fields.walletId || null, address: fields.address || null,
    gmail: fields.gmail || null, gmailAppPass: fields.gmailAppPass || null, gmailSession: null,
    xToken: fields.xToken || null, xHandle: fields.xHandle || null, xCt0: fields.xCt0 || null,
    discordToken: fields.discordToken || null, discordUsername: fields.discordUsername || null,
    proxyId: fields.proxyId || null, status: {},
  };
  g.accounts.push(a); save(d); return safe(a);
}

function updateAccount(accountId, fields) {
  const d = load();
  for (const g of d.groups) {
    const a = g.accounts.find((x) => x.id === accountId);
    if (!a) continue;
    for (const k of ['name', 'gmail', 'gmailAppPass', 'xToken', 'xHandle', 'xCt0', 'discordToken', 'discordUsername', 'proxyId', 'address', 'walletId', 'solAddress', 'btcAddress']) {
      if (k in fields) a[k] = fields[k] === '' ? null : fields[k];
    }
    save(d); return safe(a);
  }
  throw new Error('account not found');
}

function bulkUpdate(accountIds, fields) {
  const d = load();
  let n = 0;
  for (const g of d.groups) for (const a of g.accounts) {
    if (!accountIds.includes(a.id)) continue;
    for (const k of Object.keys(fields)) a[k] = fields[k] === '' ? null : fields[k];
    n++;
  }
  save(d); return n;
}

function bulkConnect(groupId, text, order, ids) {
  const d = load();
  let targets;
  if (ids && ids.length) {
    const byId = new Map();
    for (const g of d.groups) for (const a of g.accounts) byId.set(a.id, a);
    targets = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!targets.length) throw new Error('no matching accounts');
  } else {
    const g = d.groups.find((x) => x.id === groupId);
    if (!g) throw new Error('group not found');
    targets = g.accounts;
  }
  const cols = order || ['gmail', 'xToken', 'discordToken'];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let n = 0;
  const touched = [];
  const which = new Set();
  lines.forEach((line, i) => {
    const a = targets[i];
    if (!a) return;
    const parts = line.split(/[,\t|:]/).map((p) => p.trim());
    cols.forEach((c, j) => {
      if (!parts[j]) return;
      a[c] = parts[j];
      if (c === 'xToken') which.add('x');
      if (c === 'discordToken') which.add('discord');
      if (c === 'gmail' || c === 'gmailAppPass') which.add('gmail');
    });
    if (a.status) { which.forEach((k) => delete a.status[k]); }
    touched.push(a.id);
    n++;
  });
  save(d);
  return { updated: n, ids: touched, which: [...which] };
}

function assignProxies(groupId, proxyGroupId) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const pd = proxies.load();
  const pg = pd.groups.find((x) => x.id === proxyGroupId);
  if (!pg || !pg.proxies.length) throw new Error('proxy group empty');
  g.accounts.forEach((a, i) => { a.proxyId = pg.proxies[i % pg.proxies.length].id; });
  save(d); return g.accounts.length;
}

function removeAccount(accountId) {
  const d = load();
  for (const g of d.groups) {
    const i = g.accounts.findIndex((x) => x.id === accountId);
    if (i >= 0) { g.accounts.splice(i, 1); save(d); return true; }
  }
  return false;
}

function safe(a) {
  return {
    id: a.id, name: a.name, address: a.address, walletId: a.walletId,
    solAddress: a.solAddress || null, btcAddress: a.btcAddress || null,
    gmail: a.gmail, hasGmailPass: !!a.gmailAppPass, hasGmailSession: !!a.gmailSession,
    xHandle: a.xHandle, hasXToken: !!a.xToken,
    discordUsername: a.discordUsername, hasDiscordToken: !!a.discordToken,
    proxyId: a.proxyId, status: a.status || {},
  };
}

function groups() {
  const d = load();
  return d.groups.map((g) => ({ id: g.id, name: g.name, walletGroup: g.walletGroup, count: g.accounts.length }));
}

function listSafe(groupIds) {
  const d = load();
  const sel = groupIds && groupIds.length ? d.groups.filter((g) => groupIds.includes(g.id)) : d.groups;
  return sel.flatMap((g) => g.accounts.map((a) => ({ ...safe(a), group: g.id, groupName: g.name })));
}

function getAccount(id) {
  const d = load();
  for (const g of d.groups) {
    const a = g.accounts.find((x) => x.id === id);
    if (a) return { ...a, group: g.id, groupName: g.name };
  }
  return null;
}

function setStatus(accountId, key, val) {
  const d = load();
  for (const g of d.groups) {
    const a = g.accounts.find((x) => x.id === accountId);
    if (a) { a.status = a.status || {}; a.status[key] = val; save(d); return; }
  }
}


function classifyDiscord(httpStatus, body) {
  let code = 0; let msg = '';
  try { const j = JSON.parse(body); code = Number(j.code) || 0; msg = j.message || ''; } catch { msg = String(body || '').slice(0, 120); }
  const low = `${msg} ${body || ''}`.toLowerCase();
  if (low.includes('disabled') || low.includes('account has been disabled')) return { state: 'suspended', error: msg || 'account disabled' };
  if (low.includes('terminated') || low.includes('banned')) return { state: 'suspended', error: msg || 'account terminated' };
  if (code === 40002 || low.includes('verify your account') || low.includes('quarantined')) return { state: 'locked', error: msg || 'account locked, needs verification' };
  if (httpStatus === 401) return { state: 'bad_token', error: msg || 'invalid token' };
  if (httpStatus === 429) return { state: 'rate_limit', error: msg || 'rate limited' };
  return { state: 'error', error: `HTTP ${httpStatus} ${msg}`.slice(0, 120) };
}

async function testDiscord(accountId) {
  const { fetch } = require('undici');
  const a = getAccount(accountId);
  if (!a || !a.discordToken) return { ok: false, state: 'no_token', error: 'no token' };
  const tok = String(a.discordToken).replace(/[^\x21-\x7e]/g, '');
  if (!tok) return { ok: false, state: 'bad_token', error: 'token has no valid characters' };
  const at = Date.now();
  try {
    const r = await fetch('https://discord.com/api/v9/users/@me', {
      headers: { Authorization: tok, 'User-Agent': 'Mozilla/5.0' },
      dispatcher: proxies.agentFor(a.proxyId), signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    if (!r.ok) {
      const st = { ok: false, at, ...classifyDiscord(r.status, body) };
      setStatus(accountId, 'discord', st); return st;
    }
    const j = JSON.parse(body);
    const handle = j.username + (j.discriminator && j.discriminator !== '0' ? `#${j.discriminator}` : '');
    const st = {
      ok: true, at, state: 'ok', username: handle, id: j.id,
      email: j.email || null, verified: !!j.verified, mfa: !!j.mfa_enabled,
    };
    updateAccount(accountId, { discordUsername: handle });
    setStatus(accountId, 'discord', st);
    return st;
  } catch (e) {
    const st = { ok: false, at, state: 'error', error: String(e.message).slice(0, 80) };
    setStatus(accountId, 'discord', st); return st;
  }
}

function classifyX(httpStatus, body) {
  let codes = [];
  let msg = '';
  try {
    const j = JSON.parse(body);
    const errs = j.errors || [];
    codes = errs.map((e) => Number(e.code)).filter((n) => !Number.isNaN(n));
    msg = errs.map((e) => e.message).join('; ');
  } catch { msg = String(body || '').slice(0, 120); }
  const low = `${msg} ${body || ''}`.toLowerCase();
  const has = (...c) => c.some((x) => codes.includes(x));

  if (has(63, 64) || low.includes('suspended')) {
    return { state: 'suspended', error: msg || 'account suspended' };
  }
  if (has(326) || low.includes('temporarily locked') || low.includes('account is locked')) {
    return { state: 'locked', error: msg || 'account locked (needs manual unlock)' };
  }
  if (has(32, 89, 215) || httpStatus === 401) {
    return { state: 'bad_token', error: msg || 'invalid or expired auth_token' };
  }
  if (has(88) || httpStatus === 429) {
    return { state: 'rate_limit', error: msg || 'rate limited, retry later' };
  }
  return { state: 'error', error: `HTTP ${httpStatus} ${msg}`.slice(0, 120) };
}

const X_VIEWER_URL = 'https://api.x.com/graphql/HC-1ZetsBT1HKVUOvnLE8Q/Viewer';

async function testX(accountId) {
  const { fetch } = require('undici');
  const a = getAccount(accountId);
  if (!a || !a.xToken) return { ok: false, state: 'no_token', error: 'no token' };
  const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const tok = String(a.xToken).replace(/[^A-Za-z0-9._~%-]/g, '');
  if (!tok) return { ok: false, state: 'bad_token', error: 'token has no valid characters' };
  const ct0 = /^[a-f0-9]{8,64}$/i.test(String(a.xCt0 || '')) ? a.xCt0 : require('crypto').randomBytes(16).toString('hex');
  const at = Date.now();
  try {
    const r = await fetch(X_VIEWER_URL, {
      headers: {
        authorization: `Bearer ${BEARER}`,
        cookie: `auth_token=${tok}; ct0=${ct0}`,
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      },
      dispatcher: proxies.agentFor(a.proxyId), signal: AbortSignal.timeout(15000),
    });
    const body = await r.text();
    if (!r.ok) {
      const c = classifyX(r.status, body);
      const st = { ok: false, at, ...c };
      setStatus(accountId, 'x', st);
      return st;
    }
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const viewer = j?.data?.viewer || {};
    const res = viewer.user_results?.result;
    const lg = res?.legacy;
    if (!lg || !lg.screen_name) {
      const c = classifyX(r.status, body);
      const st = { ok: false, at, ...(c.state === 'error' ? { state: 'bad_token', error: c.error || 'session not authenticated' } : c) };
      setStatus(accountId, 'x', st); return st;
    }
    if (res.__typename === 'UserUnavailable' || lg.suspended) {
      const st = { ok: false, at, state: 'suspended', error: 'account suspended', handle: lg.screen_name };
      updateAccount(accountId, { xHandle: lg.screen_name, xCt0: ct0 });
      setStatus(accountId, 'x', st); return st;
    }
    const st = {
      ok: true, at, state: 'ok',
      handle: lg.screen_name, name: lg.name,
      id: String(res.rest_id || '') || null,
      followers: lg.followers_count, following: lg.friends_count,
      tweets: lg.statuses_count,
      verified: !!(res.is_blue_verified || lg.verified),
      protected: !!lg.protected, created: lg.created_at || null,
    };
    updateAccount(accountId, { xHandle: lg.screen_name, xCt0: ct0 });
    setStatus(accountId, 'x', st);
    return st;
  } catch (e) {
    const st = { ok: false, at, state: 'error', error: String(e.message).slice(0, 80) };
    setStatus(accountId, 'x', st); return st;
  }
}

async function testGmailImap(accountId) {
  const net = require('tls');
  const a = getAccount(accountId);
  if (!a || !a.gmail || !a.gmailAppPass) return { ok: false, state: 'no_token', error: 'need gmail + app password' };
  const at = Date.now();
  const clean = (s) => String(s).replace(/[\r\n\0"\\]/g, '');
  const user = clean(a.gmail);
  const pass = clean(a.gmailAppPass).replace(/\s/g, '');
  if (!user || !pass) return { ok: false, state: 'bad_token', error: 'credential contains illegal characters' };
  return new Promise((resolve) => {
    const sock = net.connect({ host: 'imap.gmail.com', port: 993, servername: 'imap.gmail.com' }, () => {
      sock.write(`a1 LOGIN "${user}" "${pass}"\r\n`);
    });
    let buf = '';
    const done = (st) => { try { sock.destroy(); } catch {} setStatus(accountId, 'gmail', { at, ...st }); resolve({ at, ...st }); };
    sock.setTimeout(15000, () => done({ ok: false, state: 'error', error: 'timeout' }));
    sock.on('data', (c) => {
      buf += c.toString();
      if (buf.includes('a1 OK')) done({ ok: true, state: 'ok', via: 'imap' });
      else if (/a1 (NO|BAD)/.test(buf)) {
        const low = buf.toLowerCase();
        const state = low.includes('disabled') || low.includes('suspend') ? 'suspended'
          : low.includes('web login required') || low.includes('unusual') ? 'locked' : 'bad_token';
        done({ ok: false, state, error: state === 'locked' ? 'web login required (locked)' : 'auth rejected' });
      }
    });
    sock.on('error', (e) => done({ ok: false, state: 'error', error: String(e.message).slice(0, 80) }));
  });
}

async function testGroup(groupId, which) {
  return runProbes(listSafe(groupId ? [groupId] : null), which);
}

async function testAccounts(ids, which) {
  const want = new Set(ids || []);
  return runProbes(listSafe(null).filter((a) => want.has(a.id)), which);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runProbes(accs, which) {
  const out = [];
  const anyDirect = accs.some((a) => !a.proxyId);
  const CONC = anyDirect ? 2 : 6;
  for (let i = 0; i < accs.length; i += CONC) {
    const batch = accs.slice(i, i + CONC);
    await Promise.all(batch.map(async (a, k) => {
      if (anyDirect && k) await sleep(400 * k + Math.random() * 300);
      const row = { id: a.id, name: a.name };
      if (which === 'discord' || which === 'all') row.discord = await testDiscord(a.id);
      if (which === 'x' || which === 'all') row.x = await testX(a.id);
      if (which === 'gmail' || which === 'all') row.gmail = await testGmailImap(a.id);
      if (which !== 'all') {
        const r = row[which] || {};
        row.ok = !!r.ok;
        row.state = r.state || (r.ok ? 'ok' : 'error');
        if (r.error) row.error = r.error;
        if (r.handle) row.handle = r.handle;
        if (r.followers != null) row.followers = r.followers;
        if (r.username) row.username = r.username;
      } else {
        row.ok = ['discord', 'x', 'gmail'].every((k) => !row[k] || row[k].ok);
      }
      out.push(row);
    }));
  }
  return out;
}


function tokenValues(account) {
  const rand = (n) => Math.random().toString(36).slice(2, 2 + n);
  return {
    '{wallet}': account.address || '',
    '{self}': account.address || '',
    '{gmail}': account.gmail || '',
    '{email}': account.gmail || '',
    '{xhandle}': account.xHandle || '',
    '{@xhandle}': account.xHandle ? '@' + account.xHandle : '',
    '{discord}': account.discordUsername || '',
    '{@discord}': account.discordUsername ? '@' + account.discordUsername : '',
    '{xtweet}': account.xHandle ? `https://x.com/${account.xHandle}/status/1${Math.floor(Math.random() * 9e17)}` : '',
    '{rand}': rand(8),
  };
}

function expand(text, account) {
  if (typeof text !== 'string') return text;
  const settings = store.readSettings();
  const templates = settings.customTemplates || {};
  let out = text;
  out = out.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => {
    if (templates[k] && Array.isArray(templates[k]) && templates[k].length) {
      return templates[k][Math.floor(Math.random() * templates[k].length)];
    }
    return m;
  });
  const vals = tokenValues(account);
  for (const [k, v] of Object.entries(vals)) out = out.split(k).join(v);
  return out;
}

function getAccountSafe(accountId) {
  const a = getAccount(accountId);
  return a ? safe(a) : null;
}

module.exports = {
  load, save, addGroup, fromWallets, removeGroup, renameGroup, addAccount, updateAccount,
  bulkUpdate, bulkConnect, bulkRemove, bulkDisconnect,
  assignProxies, removeAccount, groups, listSafe, getAccount, getAccountSafe, safe, setStatus,
  testDiscord, testX, testGmailImap, testGroup, testAccounts, expand, tokenValues,
  classifyX, classifyDiscord,
};
