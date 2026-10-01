'use strict';
/* Task Manager backend — unifies runs across Mint, Solana, Social, and Sniper. */

const mint = require('./mint');
const solmint = require('./solmint');
const sniper = require('./sniper');

function listAllTasks() {
  const mintRuns = mint.list().map((r) => ({ ...r, kind: 'evm-mint' }));
  const solRuns = solmint.list().map((r) => ({ ...r, kind: 'sol-mint' }));
  const snipers = sniper.listSnipers().map((s) => ({ ...s, kind: 'sniper' }));
  return [...mintRuns, ...solRuns, ...snipers];
}

function stopTask(id, kind) {
  if (kind === 'evm-mint') return mint.stop(id);
  if (kind === 'sol-mint') return solmint.stop(id);
  if (kind === 'sniper') return sniper.stopSniper(id);
  return false;
}

module.exports = { listAllTasks, stopTask };
