'use strict';
/* Rolling activity feed for the home dashboard.
 * Sealed because it holds wallet addresses. Capped so it can never grow
 * unbounded inside the vault blob. */
const store = require('./store');

const NAME = 'activity';
const CAP = 300;

function read() {
  try { return store.readSealed(NAME, { items: [] }); } catch { return { items: [] }; }
}

function add(entry) {
  if (store.isLocked()) return null;
  const d = read();
  const row = { t: Date.now(), ...entry };
  d.items = [row, ...(d.items || [])].slice(0, CAP);
  try { store.writeSealed(NAME, d); } catch { /* locked mid-write */ }
  return row;
}

function list(n) {
  const items = read().items || [];
  return items.slice(0, Math.max(1, Math.min(CAP, Number(n) || 50)));
}

function counts() {
  const items = read().items || [];
  return {
    minted: items.filter((x) => x.kind === 'mint' && x.ok).length,
    failed: items.filter((x) => x.kind === 'mint' && !x.ok).length,
  };
}

function clear() {
  if (store.isLocked()) return false;
  store.writeSealed(NAME, { items: [] });
  return true;
}

module.exports = { add, list, counts, clear };
