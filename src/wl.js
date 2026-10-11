'use strict';
const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const crypto = require('crypto');

const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const launchpads = require('./launchpads');
const eligibility = require('./eligibility');
const walletsMod = require('./wallets');

const bus = new EventEmitter();
const runs = new Map();

const CONC = 6;
const STORE = 'wl_projects';


function readBook() {
  try { return store.readSealed(STORE, { projects: [] }); } catch { return { projects: [] }; }
}
function writeBook(b) { store.writeSealed(STORE, b); return b; }

function listProjects() {
  const b = readBook();
  return (b.projects || []).map((p) => ({
    ...p,
    walletCount: new Set((p.phases || []).flatMap((ph) => (ph.wallets || []).map((w) => w.address))).size,
    mintCount: (p.phases || []).reduce((a, ph) => a + (ph.wallets || []).reduce((s, w) => s + (Number(w.cap) || 0), 0), 0),
  }));
}

function saveProject(p) {
  const b = readBook();
  b.projects = b.projects || [];
  const id = p.id || crypto.randomUUID();
  const now = Date.now();
  const i = b.projects.findIndex((x) => x.id === id);
  const row = {
    id,
    name: p.name || 'Untitled',
    slug: p.slug || null,
    address: p.address || null,
    chain: p.chain || 'ethereum',
    platform: p.platform || null,
    image: p.image || null,
    status: p.status || 'whitelist',      // whitelist | ongoing | minted | dead
    link: p.link || null,
    notes: p.notes || '',
    phases: (p.phases || []).map((ph) => ({
      id: ph.id != null ? String(ph.id) : '0',
      name: ph.name || 'Phase',
      price: ph.price != null ? String(ph.price) : '0',
      startTime: ph.startTime || null,
      endTime: ph.endTime || null,
      maxPerWallet: ph.maxPerWallet ?? null,
      wallets: (ph.wallets || []).map((w) => ({
        id: w.id, name: w.name, address: w.address, cap: Number(w.cap) || 0,
      })),
    })),
    checkedAt: p.checkedAt || now,
    createdAt: i >= 0 ? b.projects[i].createdAt : now,
    updatedAt: now,
  };
  if (i >= 0) b.projects[i] = row; else b.projects.unshift(row);
  writeBook(b);
  return row;
}

function removeProject(id) {
  const b = readBook();
  const before = (b.projects || []).length;
  b.projects = (b.projects || []).filter((p) => p.id !== id);
  writeBook(b);
  return before !== b.projects.length;
}

function updateProject(id, fields) {
  const b = readBook();
  const p = (b.projects || []).find((x) => x.id === id);
  if (!p) throw new Error('project not found');
  for (const k of ['name', 'status', 'notes', 'link', 'image', 'slug']) {
    if (fields[k] !== undefined) p[k] = fields[k];
  }
  p.updatedAt = Date.now();
  writeBook(b);
  return p;
}

function phaseWallets(projectId, phaseId) {
  const p = (readBook().projects || []).find((x) => x.id === projectId);
  if (!p) throw new Error('project not found');
  const ph = (p.phases || []).find((x) => String(x.id) === String(phaseId)) || p.phases[0];
  if (!ph) throw new Error('phase not found');
  return { project: { id: p.id, name: p.name, address: p.address, slug: p.slug, chain: p.chain }, phase: ph };
}


function emit(runId, payload) {
  const r = runs.get(runId);
  if (r) r.events.push({ t: Date.now(), ...payload });
  bus.emit('event', { runId, ...payload });
}

function cumulativeCaps(stages) {
  let run = 0;
  return stages.map((s) => {
    const cap = Number(s.maxPerWallet || 0);
    run = cap > run ? cap : run;
    return run || null;
  });
}

async function checkStagesForWallet(ctx, w) {
  const out = {};
  for (let i = 0; i < ctx.stages.length; i++) {
    const stage = ctx.stages[i];
    if (ctx.stop) break;
    try {
      const r = await eligibility.checkOne({
        info: ctx.info, stage, chainKey: ctx.chainKey,
        priceWei: ethers.parseEther(String(stage.price || '0')),
        qty: 1, gasWei: ctx.gasWei, rpcUrls: ctx.rpcUrls,
        eligMap: ctx.eligMap, eligErr: ctx.eligErr, eligLabels: ctx.eligLabels,
      }, w);
      out[String(stage.id)] = {
        verdict: r.verdict, reason: r.reason,
        cap: ctx.caps[i], minted: r.minted ?? null, balance: r.balance ?? null,
      };
    } catch (e) {
      out[String(stage.id)] = { verdict: 'unknown', reason: String(e.message).slice(0, 100), cap: ctx.caps[i] };
    }
  }
  return out;
}

const customCheckers = new Map();

function addCustomChecker(name, phases) {
  const id = 'cust_' + Date.now().toString(36);
  customCheckers.set(id, { id, name, phases, at: Date.now() });
  return { id, name, phases };
}

function listCustomCheckers() {
  return [...customCheckers.values()];
}
async function startCheck(opts) {
  const info = await launchpads.resolve(opts.input, opts.chain);
  const chainKey = opts.chain || info.chain;
  const c = chainsMod.chain(chainKey);

  let stages = (info.stages || []).filter((s) => !s.isPublic);
  if (!stages.length) stages = info.stages || [];
  if (!stages.length) throw new Error('No mint phases found for this collection');
  const caps = cumulativeCaps(stages);

  const list = (opts.walletIds && opts.walletIds.length)
    ? opts.walletIds.map((id) => walletsMod.getWallet('evm', id)).filter(Boolean)
    : (() => {
        const d = walletsMod.load('evm');
        const sel = opts.groupIds && opts.groupIds.length ? d.groups.filter((g) => opts.groupIds.includes(g.id)) : d.groups;
        return sel.flatMap((g) => g.wallets);
      })();
  if (!list.length) throw new Error('no wallets selected');

  let gasWei = 0n;
  try {
    const fee = await walletsMod.feeData(chainKey);
    gasWei = (fee.maxFeePerGas || 0n) * BigInt(opts.gasLimit || 250000) * 2n;
  } catch { gasWei = ethers.parseEther('0.002'); }

  const runId = crypto.randomUUID().slice(0, 8);
  const state = {
    id: runId, status: 'running', stop: false,
    chain: c.key, platform: info.platform, address: info.address, slug: info.slug || null,
    name: info.name || info.slug || info.address,
    stages: stages.map((s, i) => ({
      id: String(s.id), name: s.name, price: String(s.price || '0'),
      startTime: s.startTime || null, endTime: s.endTime || null, cap: caps[i],
      isPublic: false,
    })),
    rows: [], total: list.length, done: 0,
    events: [], startedAt: Date.now(),
  };
  runs.set(runId, state);

  const ctx = {
    info, stages, caps, chainKey, gasWei,
    rpcUrls: opts.rpcs || rpc.urlsFor(chainKey),
    get stop() { return state.stop; },
  };

  (async () => {
    if (info.platform === 'opensea' && info.slug) {
      emit(runId, { level: 'info', msg: `OpenSea eligibility (SIWE) — ${list.length} wallets, 2 at a time…` });
      try {
        const osE = await eligibility.fetchOsEligibility(info, list);
        ctx.eligMap = osE.map; ctx.eligErr = osE.err; ctx.eligLabels = osE.labels;
        const okN = Object.keys(osE.map).length;
        emit(runId, { level: okN ? 'ok' : 'warn', msg: `OpenSea eligibility ready for ${okN}/${list.length} wallets` });
      } catch (e) {
        emit(runId, { level: 'warn', msg: `OpenSea eligibility unavailable (${String(e.message).slice(0, 80)}) — falling back to heuristics` });
      }
    }
    emit(runId, { level: 'info', msg: `checking ${list.length} wallets across ${stages.length} stage(s)` });
    let i = 0;
    const workers = new Array(Math.min(CONC, list.length)).fill(0).map(async () => {
      for (;;) {
        if (state.stop) return;
        const idx = i++;
        if (idx >= list.length) return;
        const w = list[idx];
        emit(runId, { level: 'info', wallet: w.name, msg: 'checking' });
        const cells = await checkStagesForWallet(ctx, w);
        const any = Object.values(cells).some((x) => x.verdict === 'eligible');
        state.rows.push({ id: w.id, name: w.name, address: w.address, cells, eligible: any });
        state.done++;
        emit(runId, {
          level: any ? 'ok' : 'info', wallet: w.name,
          msg: any ? 'eligible' : 'not eligible',
          progress: `${state.done}/${state.total}`,
        });
      }
    });
    await Promise.all(workers);
    state.rows.sort((a, b) => list.findIndex((x) => x.id === a.id) - list.findIndex((x) => x.id === b.id));
    state.status = state.stop ? 'stopped' : 'done';
    state.finishedAt = Date.now();
    const n = state.rows.filter((r) => r.eligible).length;
    emit(runId, { level: n ? 'ok' : 'warn', msg: `${n}/${state.total} eligible`, done: true });
    store.appendLog('wl-checks.log', `${state.name} ${state.chain} ${n}/${state.total} eligible`);
  })();

  return { runId, stages: state.stages, total: state.total, name: state.name, address: state.address, slug: state.slug };
}

function stopCheck(runId) {
  const r = runs.get(runId);
  if (!r) return false;
  r.stop = true;
  r.status = 'stopped';
  return true;
}

function statusCheck(runId) {
  const r = runs.get(runId);
  if (!r) return null;
  return {
    id: r.id, status: r.status, name: r.name, chain: r.chain, platform: r.platform,
    address: r.address, slug: r.slug, stages: r.stages,
    rows: r.rows, done: r.done, total: r.total,
    eligible: r.rows.filter((x) => x.eligible).length,
    startedAt: r.startedAt, finishedAt: r.finishedAt || null,
  };
}

function listChecks() {
  return [...runs.values()].map((r) => ({
    id: r.id, status: r.status, name: r.name, done: r.done, total: r.total,
    eligible: r.rows.filter((x) => x.eligible).length, startedAt: r.startedAt,
  }));
}

function saveCheck(runId, extra = {}) {
  const r = runs.get(runId);
  if (!r) throw new Error('run not found');
  const phases = r.stages.map((s) => ({
    id: s.id, name: s.name, price: s.price,
    startTime: s.startTime, endTime: s.endTime, maxPerWallet: s.cap,
    wallets: r.rows
      .filter((row) => row.cells[s.id] && row.cells[s.id].verdict === 'eligible')
      .map((row) => ({ id: row.id, name: row.name, address: row.address, cap: s.cap || 1 })),
  })).filter((p) => p.wallets.length);
  return saveProject({
    name: extra.name || r.name,
    slug: r.slug, address: r.address, chain: r.chain, platform: r.platform,
    status: extra.status || 'whitelist', link: extra.link || null,
    image: extra.image || null, notes: extra.notes || '',
    phases, checkedAt: Date.now(),
  });
}

module.exports = {
  bus,
  startCheck, stopCheck, statusCheck, listChecks, saveCheck,
  listProjects, saveProject, removeProject, updateProject, phaseWallets,
  cumulativeCaps,
};
