'use strict';
/* Multi-API-key pool with round-robin rotation.
 *
 * A single OpenSea key rate-limits hard (4 rps, 429 after that), so bulk work
 * — inventory, PnL over 100 wallets, eligibility sweeps — needs several keys.
 * Settings hold both shapes:
 *   openseaKey   : legacy single value
 *   openseaKeys  : newline/comma separated list
 * Both are merged, deduped, and handed out round-robin. Callers that hit a
 * 429/401 call `penalise()` so the bad key is skipped for a cooldown window.
 */
const store = require('./store');

const cursor = new Map();      // field -> next index
const penalty = new Map();     // key string -> epoch ms until usable again

const PENALTY_MS = 60 * 1000;

function listFor(field) {
  const s = store.readSettings();
  const single = s[field] ? [String(s[field]).trim()] : [];
  const many = String(s[field + 's'] || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  return [...new Set([...single, ...many])];
}

/* Keys that are not inside their penalty window, or all of them when every
 * key is penalised (better to retry a cooling key than to fail outright). */
function usable(field) {
  const all = listFor(field);
  const now = Date.now();
  const free = all.filter((k) => (penalty.get(k) || 0) <= now);
  return free.length ? free : all;
}

function count(field) { return listFor(field).length; }

function next(field) {
  const pool = usable(field);
  if (!pool.length) return null;
  const i = (cursor.get(field) || 0) % pool.length;
  cursor.set(field, i + 1);
  return pool[i];
}

function require_(field, label) {
  const k = next(field);
  if (!k) throw new Error(`${label || field} required in Settings`);
  return k;
}

function penalise(key, ms) {
  if (!key) return;
  penalty.set(key, Date.now() + (ms || PENALTY_MS));
}

/* Status for the UI: how many keys, how many currently cooling down. */
function status(field) {
  const all = listFor(field);
  const now = Date.now();
  return {
    total: all.length,
    cooling: all.filter((k) => (penalty.get(k) || 0) > now).length,
  };
}

/* ---------- latency probe ----------
 * J-AIO shows a green/amber latency badge next to each API key. Useful signal:
 * a key that answers in 180ms is healthy, one that 401s is a typo, and one that
 * 429s is already burnt. Each provider needs its own cheap authenticated call.
 */
const PROBES = {
  openseaKey: (k) => ({
    url: 'https://api.opensea.io/api/v2/collections?limit=1',
    headers: { 'X-API-KEY': k, Accept: 'application/json' },
  }),
  etherscanKey: (k) => ({
    url: `https://api.etherscan.io/api?module=stats&action=ethprice&apikey=${encodeURIComponent(k)}`,
  }),
  heliusKey: (k) => ({
    url: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
  }),
  alchemyKey: (k) => ({
    url: `https://eth-mainnet.g.alchemy.com/v2/${encodeURIComponent(k)}`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber' }),
  }),
};

/* Keys are masked in the response — the UI only needs to tell them apart. */
function mask(k) {
  const s = String(k);
  return s.length <= 10 ? s.slice(0, 3) + '…' : s.slice(0, 5) + '…' + s.slice(-4);
}

async function probeOne(field, key) {
  const mk = PROBES[field];
  if (!mk) return { key: mask(key), state: 'unknown', ms: null, note: 'no probe for this provider' };
  const spec = mk(key);
  const { url, method, headers, body } = spec;
  const opt = { method: method || 'GET', headers, body };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...opt, signal: AbortSignal.timeout(12000) });
    const ms = Date.now() - t0;
    const body = await r.text();
    if (r.status === 401 || r.status === 403) return { key: mask(key), state: 'bad', ms, note: `auth ${r.status}` };
    if (r.status === 429) return { key: mask(key), state: 'limited', ms, note: 'rate limited' };
    if (!r.ok) return { key: mask(key), state: 'bad', ms, note: `HTTP ${r.status}` };
    // Etherscan and the JSON-RPC hosts answer 200 with an error envelope.
    if (/"status"\s*:\s*"0"/.test(body) && /Invalid API Key/i.test(body)) {
      return { key: mask(key), state: 'bad', ms, note: 'invalid API key' };
    }
    if (/"error"\s*:\s*\{/.test(body) && !/"result"/.test(body)) {
      return { key: mask(key), state: 'bad', ms, note: 'rpc error' };
    }
    return { key: mask(key), state: ms < 600 ? 'good' : 'slow', ms, note: null };
  } catch (e) {
    return { key: mask(key), state: 'dead', ms: Date.now() - t0, note: String(e.message).slice(0, 80) };
  }
}

async function probe(fields) {
  const want = fields && fields.length ? fields : Object.keys(PROBES);
  const out = {};
  await Promise.all(want.map(async (f) => {
    const all = listFor(f);
    const now = Date.now();
    const results = await Promise.all(all.map((k) => probeOne(f, k)));
    out[f] = {
      total: all.length,
      cooling: all.filter((k) => (penalty.get(k) || 0) > now).length,
      keys: results,
      best: results.filter((r) => r.ms != null && r.state === 'good').sort((a, b) => a.ms - b.ms)[0] || null,
    };
  }));
  return out;
}

module.exports = {
  next, require: require_, count, penalise, status, listFor, probe, probeOne, mask,
  FIELDS: Object.keys(PROBES),
};

