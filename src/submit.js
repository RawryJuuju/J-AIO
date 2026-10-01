'use strict';
/* Custom wallet submit module — arbitrary POST/GET form submits per account,
 * template tokens, captcha solving (2captcha: reCAPTCHA v2/v3, hCaptcha, Turnstile),
 * SIWE message signing, per-account proxy, jittered concurrency. */
const { ethers } = require('ethers');
const store = require('./store');
const accounts = require('./accounts');
const proxies = require('./proxies');
const wallets = require('./wallets');

const bus = new (require('events').EventEmitter)();
bus.setMaxListeners(0);
const runs = new Map();
const templatesName = 'submit_templates';

function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function emit(runId, ev) {
  const r = runs.get(runId);
  if (r) { r.events.push({ t: Date.now(), ...ev }); if (r.events.length > 2500) r.events.shift(); }
  bus.emit('event', { runId, t: Date.now(), ...ev });
}

/* ---------------- templates CRUD ---------------- */

/* Templates hold request headers, cookies, and bearer tokens for WL sites,
 * so they live in the sealed store, not plaintext JSON. */
function listTemplates() { return store.readSealed(templatesName, { items: [] }).items; }
function saveTemplate(t) {
  const d = store.readSealed(templatesName, { items: [] });
  if (t.id) {
    const i = d.items.findIndex((x) => x.id === t.id);
    if (i >= 0) d.items[i] = { ...d.items[i], ...t };
    else d.items.push({ ...t });
  } else d.items.push({ ...t, id: nid('tpl') });
  store.writeSealed(templatesName, d);
  return d.items;
}
function deleteTemplate(id) {
  const d = store.readSealed(templatesName, { items: [] });
  d.items = d.items.filter((x) => x.id !== id);
  store.writeSealed(templatesName, d);
  return d.items;
}

/* ---------------- captcha (Zyper: 2captcha / CapMonster / CapSolver / AntiCaptcha) ---------------- */

const CAP_PROVIDERS = {
  '2captcha':    { key: 'twoCaptchaKey',   base: 'https://api.2captcha.com' },
  capmonster:    { key: 'capMonsterKey',   base: 'https://api.capmonster.cloud' },
  capsolver:     { key: 'capsolverKey',    base: 'https://api.capsolver.com' },
  anticaptcha:   { key: 'antiCaptchaKey',  base: 'https://api.anti-captcha.com' },
};
const CAP_ALIAS = { '2cap': '2captcha', cap: 'capmonster', 'anti-captcha': 'anticaptcha' };

function capKey(provider) {
  const p = CAP_PROVIDERS[String(provider || '2captcha').toLowerCase()] || CAP_PROVIDERS['2captcha'];
  return (store.readSettings()[p.key]) || null;
}
function capProviderName(provider) {
  const p = CAP_ALIAS[String(provider || '').toLowerCase()];
  return p || String(provider || '2captcha').toLowerCase();
}

async function solveCaptcha(cfg, emitFn) {
  const provider = capProviderName(cfg.captchaProvider);
  const conf = CAP_PROVIDERS[provider] || CAP_PROVIDERS['2captcha'];
  const key = capKey(provider);
  if (!key) throw new Error(`${conf.key} required in Settings (captcha provider ${provider})`);
  const { fetch } = require('undici');
  const typeMap = {
    recaptcha_v2: { type: 'RecaptchaV2TaskProxyless', extra: { websiteURL: cfg.pageUrl, websiteKey: cfg.siteKey, isInvisible: !!cfg.invisible } },
    recaptcha_v3: { type: 'RecaptchaV3TaskProxyless', extra: { websiteURL: cfg.pageUrl, websiteKey: cfg.siteKey, minScore: cfg.minScore || 0.7, pageAction: cfg.action || 'verify' } },
    hcaptcha: { type: 'HCaptchaTaskProxyless', extra: { websiteURL: cfg.pageUrl, websiteKey: cfg.siteKey } },
    turnstile: { type: 'TurnstileTaskProxyless', extra: { websiteURL: cfg.pageUrl, websiteKey: cfg.siteKey, ...(cfg.captchaAction ? { action: cfg.captchaAction } : {}) } },
  };
  const spec = typeMap[cfg.captchaType];
  if (!spec) throw new Error(`unsupported captcha type: ${cfg.captchaType}`);

  const create = await fetch(`${conf.base}/createTask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientKey: key, task: { type: spec.type, ...spec.extra } }),
    signal: AbortSignal.timeout(20000),
  });
  const cj = await create.json();
  if (cj.errorId) throw new Error(`${provider} create: ${cj.errorDescription || cj.errorCode}`);
  const taskId = cj.taskId;
  if (emitFn) emitFn(`captcha task ${taskId} created (${provider})`);

  const deadline = Date.now() + 180000;
  await new Promise((r) => setTimeout(r, 8000));
  while (Date.now() < deadline) {
    const res = await fetch(`${conf.base}/getTaskResult`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientKey: key, taskId }), signal: AbortSignal.timeout(20000),
    });
    const j = await res.json();
    if (j.errorId) throw new Error(`${provider} result: ${j.errorDescription || j.errorCode}`);
    if (j.status === 'ready') {
      return j.solution.gRecaptchaResponse || j.solution.token || j.solution.text;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('captcha solve timeout');
}

/* ---------------- SIWE ---------------- */

function siweMessage(opts) {
  const nonce = opts.nonce || require('crypto').randomBytes(8).toString('hex');
  const issued = new Date().toISOString();
  return {
    nonce,
    message: `${opts.domain} wants you to sign in with your Ethereum account:\n${opts.address}\n\n${opts.statement || 'Sign in'}\n\nURI: ${opts.uri}\nVersion: 1\nChain ID: ${opts.chainId || 1}\nNonce: ${nonce}\nIssued At: ${issued}`,
  };
}

async function signFor(account, text, mode) {
  if (!account.walletId) throw new Error(`account ${account.name} has no wallet bound`);
  const w = wallets.getWallet('evm', account.walletId);
  if (!w) throw new Error('wallet not found');
  const signer = new ethers.Wallet(w.pk);
  if (mode === 'siwe') {
    const { message, nonce } = siweMessage({ domain: text.domain, address: w.address, uri: text.uri, statement: text.statement, chainId: text.chainId, nonce: text.nonce });
    return { signature: await signer.signMessage(message), message, nonce, address: w.address };
  }
  return { signature: await signer.signMessage(text), message: text, address: w.address };
}

/* ---------------- request builder ---------------- */

function deepExpand(obj, account, extra) {
  if (typeof obj === 'string') {
    let s = accounts.expand(obj, account);
    for (const [k, v] of Object.entries(extra || {})) s = s.split(`{${k}}`).join(String(v));
    return s;
  }
  if (Array.isArray(obj)) return obj.map((x) => deepExpand(x, account, extra));
  if (obj && typeof obj === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(obj)) o[deepExpand(k, account, extra)] = deepExpand(v, account, extra);
    return o;
  }
  return obj;
}

async function submitOne(cfg, account, emitFn) {
  const { fetch } = require('undici');
  const extra = {};

  // pre-step: fetch a nonce from the site
  if (cfg.nonceUrl) {
    const nr = await fetch(deepExpand(cfg.nonceUrl, account, extra), {
      headers: deepExpand(cfg.headers || {}, account, extra),
      dispatcher: proxies.agentFor(account.proxyId), signal: AbortSignal.timeout(20000),
    });
    const nt = await nr.text();
    let nonce = null;
    try { const nj = JSON.parse(nt); nonce = cfg.noncePath ? cfg.noncePath.split('.').reduce((a, k) => a?.[k], nj) : (nj.nonce || nj.data?.nonce); }
    catch { nonce = nt.trim().slice(0, 120); }
    if (nonce) { extra.nonce = nonce; if (emitFn) emitFn(`nonce ${String(nonce).slice(0, 24)}`); }
  }

  if (cfg.captchaType && cfg.captchaType !== 'none') {
    extra.captcha = await solveCaptcha({ ...cfg, pageUrl: deepExpand(cfg.pageUrl || cfg.url, account, extra) }, emitFn);
    if (emitFn) emitFn(`captcha solved (${String(extra.captcha).length} chars)`);
  }

  if (cfg.signMode && cfg.signMode !== 'none') {
    const payload = cfg.signMode === 'siwe'
      ? { domain: deepExpand(cfg.siweDomain || new URL(cfg.url).hostname, account, extra), uri: deepExpand(cfg.siweUri || cfg.url, account, extra), statement: deepExpand(cfg.siweStatement || '', account, extra), chainId: cfg.siweChainId || 1, nonce: extra.nonce }
      : deepExpand(cfg.signText || '{wallet}', account, extra);
    const s = await signFor(account, payload, cfg.signMode);
    extra.signature = s.signature;
    extra.message = s.message;
    extra.nonce = s.nonce || extra.nonce;
    if (emitFn) emitFn(`signed ${s.signature.slice(0, 14)}…`);
  }

  const url = deepExpand(cfg.url, account, extra);
  const method = (cfg.method || 'POST').toUpperCase();
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', ...deepExpand(cfg.headers || {}, account, extra) };
  let body;
  if (method !== 'GET') {
    if (cfg.bodyType === 'form') {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(deepExpand(cfg.body || {}, account, extra))) p.append(k, String(v));
      body = p.toString();
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
    } else if (cfg.bodyType === 'raw') {
      body = deepExpand(cfg.bodyRaw || '', account, extra);
      headers['content-type'] = headers['content-type'] || 'text/plain';
    } else {
      body = JSON.stringify(deepExpand(cfg.body || {}, account, extra));
      headers['content-type'] = headers['content-type'] || 'application/json';
    }
  }

  const r = await fetch(url, {
    method, headers, body,
    dispatcher: proxies.agentFor(account.proxyId),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs || 30000)),
    redirect: 'follow',
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { /* html */ }

  let ok = r.ok;
  if (cfg.successRegex) ok = new RegExp(cfg.successRegex, 'i').test(text);
  if (cfg.failRegex && new RegExp(cfg.failRegex, 'i').test(text)) ok = false;

  return { ok, status: r.status, body: text.slice(0, 400), data, wallet: account.address };
}

/* ---------------- batch run ---------------- */

async function start(cfg) {
  const runId = nid('sub');
  const accs = (cfg.accountIds && cfg.accountIds.length
    ? cfg.accountIds.map((id) => accounts.getAccount(id))
    : accounts.listSafe([cfg.accountGroup]).map((a) => accounts.getAccount(a.id))
  ).filter(Boolean);
  if (!accs.length) throw new Error('no accounts selected');
  const state = { id: runId, cfg: { ...cfg, headers: undefined }, status: 'running', started: Date.now(), events: [], results: [], stopped: false, counts: { total: accs.length, ok: 0, fail: 0 } };
  runs.set(runId, state);

  (async () => {
    const conc = Math.max(1, Number(cfg.concurrency || 3));
    const minD = Number(cfg.minDelayMs || 0);
    const maxD = Number(cfg.maxDelayMs || minD);
    emit(runId, { level: 'info', msg: `submit ${cfg.name || cfg.url} · ${accs.length} accounts · conc ${conc}${cfg.captchaType && cfg.captchaType !== 'none' ? ` · captcha ${cfg.captchaType}` : ''}` });

    const one = async (acc) => {
      if (state.stopped) return;
      const retries = Number(cfg.maxRetries || 1);
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await submitOne(cfg, acc, (m) => emit(runId, { level: 'info', account: acc.name, msg: m }));
          if (res.ok) {
            state.counts.ok++;
            state.results.push({ account: acc.name, ...res });
            emit(runId, { level: 'ok', account: acc.name, msg: `HTTP ${res.status} ${res.body.slice(0, 80)}` });
            return;
          }
          if (attempt === retries) {
            state.counts.fail++;
            state.results.push({ account: acc.name, ...res });
            emit(runId, { level: 'fail', account: acc.name, msg: `HTTP ${res.status} ${res.body.slice(0, 100)}` });
          } else {
            emit(runId, { level: 'warn', account: acc.name, msg: `attempt ${attempt} failed (HTTP ${res.status}) retrying` });
            await new Promise((r) => setTimeout(r, 2000 * attempt));
          }
        } catch (e) {
          if (attempt === retries) {
            state.counts.fail++;
            const msg = String(e.message || e).slice(0, 180);
            state.results.push({ account: acc.name, ok: false, error: msg });
            emit(runId, { level: 'fail', account: acc.name, msg });
          } else await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    };

    for (let i = 0; i < accs.length; i += conc) {
      if (state.stopped) break;
      await Promise.all(accs.slice(i, i + conc).map(one));
      if (maxD > 0 && i + conc < accs.length) {
        await new Promise((r) => setTimeout(r, minD + Math.random() * Math.max(0, maxD - minD)));
      }
    }
    state.status = state.stopped ? 'stopped' : 'done';
    emit(runId, { level: 'info', msg: `done · ok ${state.counts.ok} fail ${state.counts.fail}` });
    store.appendLog('submit-runs.log', `${runId} ${cfg.name || cfg.url} ok=${state.counts.ok} fail=${state.counts.fail}`);
  })();

  return { runId };
}

function stop(id) { const r = runs.get(id); if (!r) return false; r.stopped = true; r.status = 'stopped'; emit(id, { level: 'warn', msg: 'STOPPED' }); return true; }
function status(id) { const r = runs.get(id); return r ? { id, status: r.status, counts: r.counts, results: r.results.slice(-300) } : null; }
function list() { return [...runs.values()].map((r) => ({ id: r.id, name: r.cfg.name || r.cfg.url, status: r.status, counts: r.counts, started: r.started })); }
function events(id, since) { const r = runs.get(id); return r ? r.events.filter((e) => !since || e.t > since) : []; }

module.exports = { start, stop, status, list, events, bus, submitOne, solveCaptcha, listTemplates, saveTemplate, deleteTemplate, siweMessage, signFor };
