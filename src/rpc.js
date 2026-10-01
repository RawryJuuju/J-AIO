'use strict';
/* RPC pool: groups, health probe, latency, multi-broadcast + round-robin. */
const { ethers } = require('ethers');
const store = require('./store');
const chains = require('./chains');

const NAME = 'rpc';

function load() { return store.readSealed(NAME, { groups: [] }); }
function save(d) { return store.writeSealed(NAME, d); }

function addGroup(name, chainKey) {
  const d = load();
  const g = { id: 'g' + Date.now().toString(36), name, chain: chainKey, rpcs: [] };
  d.groups.push(g); save(d); return g;
}

function removeGroup(id) {
  const d = load();
  d.groups = d.groups.filter((g) => g.id !== id);
  save(d); return true;
}

async function probe(url, expectChainId) {
  const t0 = Date.now();
  try {
    const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true, batchMaxCount: 1 });
    const net = await Promise.race([
      p.getNetwork(),
      new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), 8000)),
    ]);
    const latency = Date.now() - t0;
    const id = Number(net.chainId);
    if (expectChainId && id !== Number(expectChainId)) {
      return { healthy: false, latency, chainId: id, error: `chainId ${id} != ${expectChainId}` };
    }
    return { healthy: true, latency, chainId: id };
  } catch (e) {
    return { healthy: false, latency: Date.now() - t0, error: String(e.message || e).slice(0, 120) };
  }
}

async function addRpcs(groupId, input) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const c = chains.chain(g.chain);
  const urls = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  const clean = urls.map((u) => u.trim()).filter(Boolean).filter((u) => /^(https?|wss?):\/\//i.test(u)).filter((u) => !g.rpcs.some((r) => r.url === u));
  const results = await Promise.all(clean.map((u) => probe(u, c.id)));
  clean.forEach((u, i) => {
    g.rpcs.push({ url: u, healthy: results[i].healthy, latency: results[i].latency, error: results[i].error || null, added: Date.now() });
  });
  save(d);
  return g.rpcs;
}

function removeRpc(groupId, url) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  g.rpcs = g.rpcs.filter((r) => r.url !== url);
  save(d); return true;
}

async function reprobeGroup(groupId) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const c = chains.chain(g.chain);
  const res = await Promise.all(g.rpcs.map((r) => probe(r.url, c.id)));
  g.rpcs.forEach((r, i) => { r.healthy = res[i].healthy; r.latency = res[i].latency; r.error = res[i].error || null; });
  save(d); return g.rpcs;
}

/* URLs for a chain: private broadcast RPCs first (Flashbots-style builders),
   then user's healthy RPCs (fastest), then public fallbacks. */
function privateUrls(chainKey) {
  try {
    const s = store.readSettings();
    return (s.privateRpc || {})[String(chainKey).toLowerCase()] || [];
  } catch { return []; }
}

function urlsFor(chainKey, opts = {}) {
  const c = chains.chain(chainKey);
  let user = [];
  try {
    const d = load();
    user = d.groups.filter((g) => g.chain === c.key)
      .flatMap((g) => g.rpcs)
      .filter((r) => opts.includeUnhealthy || r.healthy)
      .sort((a, b) => (a.latency || 9e9) - (b.latency || 9e9))
      .map((r) => r.url);
  } catch { /* locked — public only */ }
  const settings = store.readSettings();
  const override = (settings.publicRpcOverride || {})[c.key];
  const pub = override ? [override, ...c.rpcs] : c.rpcs;
  const seen = new Set();
  return [...privateUrls(c.key), ...user, ...pub].filter((u) => !seen.has(u) && seen.add(u));
}

/* Public endpoints only — never private builders or user RPC groups. */
function publicUrls(chainKey) {
  const c = chains.chain(chainKey);
  let settings = {};
  try { settings = store.readSettings(); } catch { /* locked */ }
  const override = (settings.publicRpcOverride || {})[c.key];
  return override ? [override, ...c.rpcs] : [...c.rpcs];
}

/* URLs for READ-only calls (Collection Manager, balance refresh, delegation
   scans). When "public RPC only" is enabled (default ON), reads never touch
   the user's private/Alchemy endpoints — saves paid quota. Transaction
   broadcast paths keep using urlsFor(). */
function readUrls(chainKey) {
  let s = {};
  try { s = store.readSettings(); } catch { /* locked */ }
  if (s.publicRpcOnly !== false) return publicUrls(chainKey);
  return urlsFor(chainKey);
}

const providerCache = new Map();
function provider(url, chainId) {
  const k = url + '|' + chainId;
  if (!providerCache.has(k)) {
    providerCache.set(k, new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true, batchMaxCount: 1 }));
  }
  return providerCache.get(k);
}

function providersFor(chainKey, urls) {
  const c = chains.chain(chainKey);
  return (urls && urls.length ? urls : urlsFor(chainKey)).map((u) => provider(u, c.id));
}

/* First provider that answers a read. */
async function readAny(chainKey, fn, urls) {
  const ps = providersFor(chainKey, urls);
  let lastErr;
  for (const p of ps) {
    try { return await fn(p); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

/* Race all providers, first success wins. */
async function readRace(chainKey, fn, urls) {
  const ps = providersFor(chainKey, urls);
  if (!ps.length) throw new Error('no RPC');
  return new Promise((resolve, reject) => {
    let fails = 0, done = false;
    ps.forEach((p) => {
      Promise.resolve(fn(p)).then((v) => { if (!done) { done = true; resolve(v); } })
        .catch((e) => { if (++fails === ps.length && !done) reject(e); });
    });
  });
}

/* Multi-RPC broadcast: send raw tx to every URL in parallel, first accept wins.
 * On total failure, surface the most informative error rather than whichever
 * RPC happened to fail first — a dead endpoint returning "missing response for
 * request" otherwise masks the real reason (nonce too low, insufficient funds,
 * already known, reverted). */
const TRANSPORT_NOISE = /missing response|timeout|fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|socket hang up|502|503|504|429/i;

function bestBroadcastError(errors) {
  if (!errors.length) return 'broadcast failed';
  const real = errors.find((e) => !TRANSPORT_NOISE.test(e));
  return real || errors[0];
}

async function broadcast(chainKey, rawTx, urls) {
  const all = [...privateUrls(chainKey), ...(urls && urls.length ? urls : urlsFor(chainKey))]
    .filter((u, i, a) => a.indexOf(u) === i);
  const ps = providersFor(chainKey, all);
  if (!ps.length) throw new Error('no RPC');
  const errors = [];
  return new Promise((resolve, reject) => {
    let settled = false, pending = ps.length;
    ps.forEach((p) => {
      p.send('eth_sendRawTransaction', [rawTx])
        .then((hash) => {
          if (!settled) { settled = true; resolve({ hash, rpc: p._getConnection().url }); }
        })
        .catch((e) => {
          const detail = e?.info?.error?.message || e?.error?.message || e.shortMessage || e.message || String(e);
          errors.push(String(detail).slice(0, 200));
        })
        .finally(() => {
          if (--pending === 0 && !settled) reject(new Error(bestBroadcastError(errors)));
        });
    });
  });
}

/* Safe view for UI. */
function listSafe() {
  const d = load();
  return d.groups.map((g) => ({
    id: g.id, name: g.name, chain: g.chain,
    count: g.rpcs.length, healthy: g.rpcs.filter((r) => r.healthy).length,
    rpcs: g.rpcs.map((r) => ({ url: r.url, healthy: r.healthy, latency: r.latency, error: r.error })),
  }));
}

/* Seed one group per chain from the built-in public RPC lists. */
async function seedDefaults() {
  const d = load();
  let created = 0, added = 0;
  for (const c of chains.list()) {
    if (!c.rpcs || !c.rpcs.length) continue;
    let g = d.groups.find((x) => x.chain === c.key && x.name === `${c.name} public`);
    if (!g) {
      g = { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: `${c.name} public`, chain: c.key, rpcs: [] };
      d.groups.push(g); created++;
    }
    for (const u of c.rpcs) {
      if (!g.rpcs.some((r) => r.url === u)) { g.rpcs.push({ url: u, healthy: null, latency: null, error: null, added: Date.now() }); added++; }
    }
  }
  save(d);
  return { created, added, groups: listSafe() };
}

module.exports = {
  load, save, addGroup, removeGroup, addRpcs, removeRpc, reprobeGroup, probeGroup: reprobeGroup, probe,
  urlsFor, provider, providersFor, readAny, readRace, broadcast, listSafe, seedDefaults,
  privateUrls, publicUrls, readUrls,
};
