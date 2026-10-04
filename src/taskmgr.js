'use strict';
/* Task Manager backend — unifies runs across Mint, Social, and Sniper. */

const mint = require('./mint');
const sniper = require('./sniper');

function listAllTasks() {
  const mintRuns = mint.list().map((r) => ({ ...r, kind: 'evm-mint' }));
  const snipers = sniper.listSnipers().map((s) => ({ ...s, kind: 'sniper' }));
  return [...mintRuns, ...snipers];
}

function stopTask(id, kind) {
  if (kind === 'evm-mint') return mint.stop(id);
  if (kind === 'sniper') return sniper.stopSniper(id);
  return false;
}

module.exports = { listAllTasks, stopTask };
