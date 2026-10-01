'use strict';
/* Shared FX rates: ETH→USD and USD→IDR.
 *
 * Three modules were each hitting Coinbase on their own for ETH-USD, so a
 * single PnL run could fire the same request a dozen times and still show a
 * different number per panel. One cache, one source of truth, and IDR comes
 * along for free — every cost the operator sees is in the currency they
 * actually pay in.
 *
 * Rates are cached for TTL_MS. A failed refresh keeps the last good value
 * rather than blanking the UI, and a persisted copy in settings survives
 * restarts so an offline boot still shows something sane.
 */
const store = require('./store');

const TTL_MS = 5 * 60 * 1000;

let cache = { ethUsd: null, usdIdr: null, at: 0 };

async function fetchJson(url) {
  const { fetch } = require('undici');
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* Persisted fallbacks. Settings are readable while locked for plain keys, so
 * this works even before unlock. */
function seed() {
  if (cache.ethUsd != null) return;
  let s = {};
  try { s = store.readSettings(); } catch { s = {}; }
  cache.ethUsd = Number(s.ethUsd) || null;
  cache.usdIdr = Number(s.usdIdr) || null;
}

function persist() {
  /* Writing settings needs the vault open; skip silently when locked. */
  if (store.isLocked && store.isLocked()) return;
  try {
    const cur = store.readSettings();
    store.writeSettings({ ...cur, ethUsd: cache.ethUsd, usdIdr: cache.usdIdr });
  } catch { /* locked mid-write or read-only fs */ }
}

/* Rates, refreshed at most once per TTL. Never throws. */
async function rates(force) {
  seed();
  if (!force && Date.now() - cache.at < TTL_MS && cache.ethUsd != null) return { ...cache };

  const [eth, idr] = await Promise.allSettled([
    fetchJson('https://api.coinbase.com/v2/prices/ETH-USD/spot'),
    fetchJson('https://api.coinbase.com/v2/prices/USD-IDR/spot'),
  ]);
  let changed = false;
  if (eth.status === 'fulfilled' && eth.value?.data?.amount) {
    cache.ethUsd = Number(eth.value.data.amount); changed = true;
  }
  if (idr.status === 'fulfilled' && idr.value?.data?.amount) {
    cache.usdIdr = Number(idr.value.data.amount); changed = true;
  }
  if (changed) { cache.at = Date.now(); persist(); }
  return { ...cache };
}

/* Convenience: ETH amount -> { usd, idr }. Nulls propagate so the UI can show
 * an em dash instead of a fake zero. */
function convert(eth, r) {
  const n = Number(eth);
  if (!isFinite(n)) return { usd: null, idr: null };
  const usd = r.ethUsd != null ? n * r.ethUsd : null;
  const idr = usd != null && r.usdIdr != null ? usd * r.usdIdr : null;
  return { usd, idr };
}

async function ethUsd() { return (await rates()).ethUsd; }

module.exports = { rates, convert, ethUsd, TTL_MS };
