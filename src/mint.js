'use strict';
const { ethers } = require('ethers');
const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const wallets = require('./wallets');
const abiMod = require('./abi');
const launchpads = require('./launchpads');
const proxies = require('./proxies');
const eligibility = require('./eligibility');
const activity = require('./activity');
const fxrate = require('./fxrate');

const bus = new (require('events').EventEmitter)();
bus.setMaxListeners(0);

const runs = new Map();   // runId -> state

function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const SINGLE_TOPIC = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
function tokenIdFromReceipt(rec) {
  try {
    for (const l of rec.logs || []) {
      if (l.topics?.[0] === TRANSFER_TOPIC && l.topics.length === 4) {
        if (/^0x0+$/.test(l.topics[1])) return BigInt(l.topics[3]).toString();
      }
      if (l.topics?.[0] === SINGLE_TOPIC && /^0x0+$/.test(l.topics[2] || '')) {
        const [id] = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256'], l.data);
        return id.toString();
      }
    }
  } catch { /* unparseable log */ }
  return null;
}

function walletNameFor(state, address) {
  const lc = String(address || '').toLowerCase();
  const w = (state.walletList || []).find((x) => x.address.toLowerCase() === lc);
  return w ? w.name : null;
}

function emit(runId, ev) {
  const r = runs.get(runId);
  if (r) { r.events.push({ t: Date.now(), ...ev }); if (r.events.length > 4000) r.events.shift(); }
  bus.emit('event', { runId, t: Date.now(), ...ev });
}


const STOP_ALL = 'stop-all';
const SKIP = 'skip';
const RETRY = 'retry';

function classify(err) {
  const m = String(err?.shortMessage || err?.message || err || '').toLowerCase();
  if (/insufficient funds|insufficient balance|gas \* price \+ value/.test(m)) return { action: SKIP, reason: 'insufficient funds' };
  if (/already minted|exceeds max|max per wallet|limit reached|already claimed|duplicate/.test(m)) return { action: SKIP, reason: 'wallet limit reached' };
  if (/allowlist|whitelist|0x06fb10a9|not allowlisted|not whitelisted/.test(m)) return { action: SKIP, reason: 'not on allowlist' };
  if (/0x2004dcb2|throttl/.test(m)) return { action: SKIP, reason: 'throttled' };
  if (/sold out|max supply|exceeds supply|supply reached|minted out|0xc30436e9|0xe12d2314/.test(m)) return { action: STOP_ALL, reason: 'sold out' };
  if (/wrong price|incorrect price|insufficient payment|invalid price|value mismatch/.test(m)) return { action: STOP_ALL, reason: 'price mismatch' };
  if (/not started|not live|sale not active|paused|closed/.test(m)) return { action: RETRY, reason: 'not open yet' };
  if (/nonce too low|already known|replacement/.test(m)) return { action: SKIP, reason: 'nonce/dup' };
  if (/timeout|econnreset|socket|fetch failed|502|503|429/.test(m)) return { action: RETRY, reason: 'rpc flaky' };
  if (/execution reverted/.test(m)) return { action: SKIP, reason: 'reverted' };
  return { action: SKIP, reason: String(err?.shortMessage || err?.message || err).slice(0, 140) };
}


const GAS_PRESETS = {
  safe:  { tipMul: 1.5, feeMul: 2.5, minTipGwei: 0.05 },
  fast:  { tipMul: 3,   feeMul: 3,   minTipGwei: 0.5 },
  gacor: { tipMul: 6,   feeMul: 4,   minTipGwei: 2 },
};

async function resolveGas(chainKey, cfg) {
  const preset = GAS_PRESETS[cfg.gasPreset] || null;
  const auto = await wallets.feeData(chainKey, {
    tipMultiplier: cfg.tipMultiplier || (preset ? preset.tipMul : null),
  });

  let maxFee = cfg.maxFee ? ethers.parseUnits(String(cfg.maxFee), 'gwei') : auto.maxFeePerGas;
  let tip = cfg.priorityFee ? ethers.parseUnits(String(cfg.priorityFee), 'gwei') : auto.maxPriorityFeePerGas;

  if (preset) {
    const minTip = ethers.parseUnits(String(preset.minTipGwei), 'gwei');
    if (!cfg.priorityFee && tip < minTip) tip = minTip;
    if (!cfg.maxFee) {
      const base = auto.gasPrice ?? (auto.maxFeePerGas / 2n);
      const want = (base * BigInt(Math.round(preset.feeMul * 100))) / 100n + tip;
      if (maxFee < want) maxFee = want;
    }
  }

  if (maxFee < tip) maxFee = tip;

  const g = {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: tip,
    gasLimit: cfg.gasLimit ? BigInt(cfg.gasLimit) : null,
    preset: cfg.gasPreset || null,
  };
  return g;
}

async function fcfsHammer({ cfg, state, runId, emit, walletList, nonces, balances, gas, urls, c, signedList }) {
  const mintVal = ethers.parseEther(String(cfg.pricePerNft || '0')) * BigInt(cfg.amount || 1);
  const minRequired = mintVal + (gas.gasLimit * gas.maxFeePerGas * 11n / 10n);
  const want = walletList.filter((w) => balances[w.address] != null && balances[w.address] >= minRequired && nonces[w.address] != null);
  const failed = new Set();
  const deadline = Date.now() + 90000;
  const GQL_CHUNK = 250, V2_CONC = 10;
  const v2Available = !!(store.readSettings().openseaKey);

  let contract = null, sess = null;
  let gqlDisabled = cfg.osPath === 'v2';
  if (!gqlDisabled) {
    try {
      contract = cfg.address || await launchpads.openseaDropContract(cfg.slug);
      const keyWallet = walletList.find((w) => w.pk);
      if (keyWallet) sess = await eligibility.osSessionCached(keyWallet.pk);
      if (!contract || !sess) gqlDisabled = true;
    } catch (e) {
      gqlDisabled = true;
      emit(runId, { level: 'warn', msg: `FCFS gql unavailable (${String(e.message || '').slice(0, 90)})${v2Available ? ' — v2 API only' : ''}` });
    }
  }
  if (gqlDisabled && !v2Available) {
    emit(runId, { level: 'error', msg: 'No calldata source: add an OpenSea API key (Settings) or keep FCFS path on Auto (gql)' });
    return;
  }
  if (!v2Available) emit(runId, { level: 'info', msg: 'FCFS: no OpenSea API key set — calldata via gql internal only' });

  const signOne = async (w, call) => {
    assertValueOk(cfg, call.value);
    const signer = new ethers.Wallet(w.pk);
    const tx = {
      chainId: c.id, to: call.to, data: call.data, value: call.value,
      nonce: nonces[w.address], gasLimit: gas.gasLimit,
      maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas, type: 2,
    };
    signedList.push({ w, raw: await signer.signTransaction(tx), value: call.value, call, nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
  };

  const classifyWalletErr = (w, msg) => {
    if (/sold out|max supply/i.test(msg)) {
      state.stopped = true;
      emit(runId, { level: 'error', msg: `OpenSea says sold out: ${msg.slice(0, 120)}` });
      return 'stop';
    }
    if (/limit|allowlist|whitelist|insufficient|ineligible/i.test(msg)) {
      failed.add(w.address);
      state.counts.skipped++;
      state.results.push({ ok: false, address: w.address, error: msg.slice(0, 120) });
      emit(runId, { level: 'fail', wallet: w.name, msg: msg.slice(0, 120) });
      return 'skip';
    }
    return 'retry';
  };

  const signedSet = () => new Set(signedList.map((s) => s.w.address));
  let gqlWins = 0, v2Wins = 0;
  let lastGuardCheck = 0;
  // grace for the pre-gate window: lead + chain offset — without it the guard
  // aborts "not open yet" a few seconds before the gate (DUNLAPS 2026-08-29)
  const liveGraceS = Math.ceil((Number(cfg.fcfsLeadMs || 1500) + Math.abs(Number(cfg._offsetMs || 0))) / 1000) + 1;

  while (!state.stopped && signedList.length + failed.size < want.length && Date.now() < deadline) {
    if (cfg.stageId && Date.now() - lastGuardCheck > 10000) {
      lastGuardCheck = Date.now();
      try { await verifyDropStage(cfg, 'live', emit, runId, null, liveGraceS); }
      catch (e) {
        state.stopped = true;
        state.status = 'aborted';
        emit(runId, { level: 'error', msg: String(e.message || e) });
        return;
      }
    }
    const missing = want.filter((w) => !failed.has(w.address) && !signedSet().has(w.address));

    if (!gqlDisabled && sess && contract && missing.length) {
      for (let i = 0; i < missing.length && !state.stopped; i += GQL_CHUNK) {
        const chunk = missing.slice(i, i + GQL_CHUNK);
        try {
          const res = await launchpads.openseaMintDataGqlBatch(cfg.chain, contract, chunk, cfg.amount || 1, sess);
          for (const w of chunk) {
            if (state.stopped || signedSet().has(w.address) || failed.has(w.address)) continue;
            const r = res[w.address];
            if (r && !r.error) {
              try { await signOne(w, r); gqlWins++; }
              catch (e) { classifyWalletErr(w, String(e.message || '')); }
            } else if (r && r.error) {
              classifyWalletErr(w, r.error);
            }
          }
        } catch (e) {
          const m = String(e.message || '');
          if (/GQL_QUERY_ERROR|GQL_AUTH/.test(m)) {
            gqlDisabled = true;
            emit(runId, { level: 'warn', msg: `FCFS gql disabled (${m.slice(0, 100)}) — v2 fallback` });
            break;
          }
        }
      }
    }

    const stillMissing = v2Available ? want.filter((w) => !failed.has(w.address) && !signedSet().has(w.address)) : [];
    for (let i = 0; i < stillMissing.length && !state.stopped; i += V2_CONC) {
      await Promise.all(stillMissing.slice(i, i + V2_CONC).map(async (w) => {
        try {
          const call = await buildCall(cfg, w, {});
          await signOne(w, call);
          v2Wins++;
        } catch (e) { classifyWalletErr(w, String(e.message || '')); }
      }));
    }

    const left = want.filter((w) => !failed.has(w.address) && !signedSet().has(w.address)).length;
    if (left > 0 && !state.stopped) await new Promise((r) => setTimeout(r, 200));
  }

  if (gqlWins || v2Wins) emit(runId, { level: 'info', msg: `calldata fetched: ${gqlWins} via gql batch · ${v2Wins} via v2 API` });
}


async function buildCall(cfg, account, ctx) {
  const value = ethers.parseEther(String(cfg.pricePerNft || '0')) * BigInt(cfg.amount || 1);
  if (cfg.method === 'opensea-api') {
    const px = cfg.proxyGroup ? proxies.pickFromGroup(cfg.proxyGroup) : null;
    const dispatcher = px ? proxies.agentFor(px.id) : undefined;
    const d = await launchpads.openseaMintData(cfg.chain, cfg.slug, cfg.stageId, account.address, cfg.amount || 1, dispatcher);
    assertValueOk(cfg, d.value);
    return { to: d.to, data: d.data, value: d.value ?? value };
  }
  if (cfg.method === 'hex') {
    if (!cfg.hex || !/^0x[0-9a-fA-F]*$/.test(cfg.hex)) throw new Error('invalid hex');
    let data = cfg.hex;
    if (cfg.hexSelfPad) data = data.replace(new RegExp(cfg.hexSelfPad.replace(/^0x/, ''), 'gi'), account.address.slice(2).toLowerCase());
    return { to: cfg.address, data, value };
  }
  if (cfg.method === 'seadrop-snipe') {
    const nftContract = cfg.address;
    if (!nftContract) throw new Error('NFT contract address required');
    const feeRecipient = cfg.feeRecipient || '0x0000a26b00c1f0df003000390027140000faa719';
    const minterIfNotPayer = '0x0000000000000000000000000000000000000000';
    const qty = BigInt(cfg.amount || 1);
    const seadropAddr = cfg.seadropContract || '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
    // mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)
    const selector = '161ac21f';
    const nftPad = nftContract.toLowerCase().slice(2).padStart(64, '0');
    const feePad = feeRecipient.toLowerCase().slice(2).padStart(64, '0');
    const minterPad = minterIfNotPayer.toLowerCase().slice(2).padStart(64, '0');
    const qtyPad = qty.toString(16).padStart(64, '0');
    const data = `0x${selector}${nftPad}${feePad}${minterPad}${qtyPad}`;
    return { to: seadropAddr, data, value };
  }
  let abi = cfg.abi;
  if (!abi) {
    try {
      abi = (await abiMod.resolveAbi(cfg.chain, cfg.address)).abi;
    } catch (e) {
      if (!cfg.function) throw e;
      const minimal = [`function ${cfg.function}`];
      try { new ethers.Interface(minimal); } catch {
        throw new Error(`no ABI found (${String(e.message).slice(0, 60)}) — enter the full signature, e.g. mint(uint256)`);
      }
      abi = minimal;
    }
  }
  const data = abiMod.encodeCall(abi, cfg.function, cfg.params || [], { address: account.address, amount: cfg.amount || 1, ...ctx });
  return { to: cfg.address, data, value };
}

const GUARD_SKEW_S = 2; // tolerate 2s API/chain clock skew

function expectedValueWei(cfg) {
  return ethers.parseEther(String(cfg.pricePerNft ?? '0')) * BigInt(cfg.amount || 1);
}

function assertValueOk(cfg, valueWei) {
  const v = BigInt(valueWei ?? 0);
  const exp = expectedValueWei(cfg);
  if (v > exp) {
    throw new Error(`VALUE GUARD: mint costs ${ethers.formatEther(v)} ETH but task allows ${ethers.formatEther(exp)} ETH — phase/price changed. Cancelled, nothing signed.`);
  }
}

async function verifyDropStage(cfg, mode, emit, runId, refStartTs, graceS = 0) {
  if (cfg.method !== 'opensea-api' || !cfg.slug || !cfg.stageId) return null;
  let snap;
  try { snap = await launchpads.openseaDropStages(cfg.slug); }
  catch (e) {
    if (emit) emit(runId, { level: 'warn', msg: `stage guard: drops API unreachable (${String(e.message || '').slice(0, 80)}) — relying on value guard` });
    return null;
  }
  const st = snap.stages.find((s) => s.id === String(cfg.stageId)) || null;
  if (!st) throw new Error(`STAGE GUARD: stage ${cfg.stageId} no longer exists on "${cfg.slug}" — creator removed it. Run cancelled.`);
  const now = Math.floor(Date.now() / 1000);
  if (st.priceWei != null && st.priceWei !== ethers.parseEther(String(cfg.pricePerNft ?? '0'))) {
    throw new Error(`STAGE GUARD: price of "${st.label}" changed ${ethers.formatEther(ethers.parseEther(String(cfg.pricePerNft ?? '0')))} → ${ethers.formatEther(st.priceWei)} ETH by creator. Run cancelled.`);
  }
  if (mode === 'schedule') {
    if (st.endTime && now > st.endTime + GUARD_SKEW_S) {
      throw new Error(`STAGE GUARD: stage "${st.label}" already ENDED${snap.activeStageLabel ? ` — drop now on "${snap.activeStageLabel}"` : ''}. Run cancelled.`);
    }
    if (refStartTs && st.startTime && Math.abs(st.startTime - Number(refStartTs)) > 2) {
      return { movedStart: st.startTime };
    }
    return null;
  }
  if (st.startTime && now < st.startTime - GUARD_SKEW_S - graceS) {
    throw new Error(`STAGE GUARD: stage "${st.label}" not open yet (opens ${new Date(st.startTime * 1000).toISOString()}). Run cancelled — start it closer to the gate.`);
  }
  if (st.endTime && now > st.endTime + GUARD_SKEW_S) {
    throw new Error(`STAGE GUARD: stage "${st.label}" ENDED ${now - st.endTime}s ago${snap.activeStageLabel ? ` — drop now on "${snap.activeStageLabel}"` : ''}. Run cancelled (would mint the wrong phase).`);
  }
  if (st.startTime && now >= st.startTime + 15 && snap.activeStageId && snap.activeStageId !== st.id) {
    throw new Error(`STAGE GUARD: drop moved to another phase ("${snap.activeStageLabel || snap.activeStageId}") — task stage is "${st.label}". Run cancelled.`);
  }
  return null;
}


const FLASHBOTS_RELAYS = {
  1: ['https://relay.flashbots.net', 'https://rpc.beaverbuild.org', 'https://rsync-builder.xyz', 'https://api.securerpc.com/v1', 'https://builder0x69.io', 'https://rpc.titanbuilder.xyz'],
  11155111: ['https://relay-sepolia.flashbots.net'],
};

async function flashbotsSend(chainKey, signedTxs, opts = {}) {
  const c = chainsMod.chain(chainKey);
  const relays = FLASHBOTS_RELAYS[c.id];
  if (!relays) throw new Error(`Flashbots not available on ${c.name}`);
  const { fetch } = require('undici');
  const authKey = opts.authKey || ethers.Wallet.createRandom().privateKey;
  const authWallet = new ethers.Wallet(authKey);
  const targetBlock = opts.targetBlock ?? (await rpc.readRace(chainKey, (p) => p.getBlockNumber())) + 1;

  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendBundle',
    params: [{
      txs: signedTxs, blockNumber: '0x' + targetBlock.toString(16),
      ...(opts.revertingTxHashes ? { revertingTxHashes: opts.revertingTxHashes } : {}),
    }],
  });
  const sig = `${authWallet.address}:${await authWallet.signMessage(ethers.id(payload))}`;
  const results = await Promise.allSettled(relays.map(async (relay) => {
    const r = await fetch(relay, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Flashbots-Signature': sig },
      body: payload, signal: AbortSignal.timeout(12000),
    });
    const t = await r.text();
    return { relay, status: r.status, body: t.slice(0, 200) };
  }));
  const accepted = results.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
  return {
    targetBlock, relays: relays.length, accepted: accepted.length,
    detail: results.map((r) => (r.status === 'fulfilled' ? r.value : { error: String(r.reason).slice(0, 120) })),
  };
}

async function flashbotsPrivate(chainKey, signedTx, opts = {}) {
  const c = chainsMod.chain(chainKey);
  if (!FLASHBOTS_RELAYS[c.id]) throw new Error(`Flashbots not on ${c.name}`);
  const { fetch } = require('undici');
  const authWallet = new ethers.Wallet(opts.authKey || ethers.Wallet.createRandom().privateKey);
  const payload = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendPrivateTransaction',
    params: [{ tx: signedTx, preferences: { fast: true } }],
  });
  const sig = `${authWallet.address}:${await authWallet.signMessage(ethers.id(payload))}`;
  const r = await fetch('https://relay.flashbots.net', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Flashbots-Signature': sig },
    body: payload, signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error.message || 'flashbots error');
  return { hash: j.result };
}


async function simulateOne(cfg, account, call, gas) {
  const c = chainsMod.chain(cfg.chain);
  try {
    const res = await rpc.readRace(cfg.chain, (p) => p.call({
      from: account.address, to: call.to, data: call.data, value: call.value,
    }), cfg.rpcs);
    let gasEst = null;
    try {
      gasEst = await rpc.readRace(cfg.chain, (p) => p.estimateGas({
        from: account.address, to: call.to, data: call.data, value: call.value,
      }), cfg.rpcs);
    } catch { /* estimate can fail while call passes */ }
    return { ok: true, address: account.address, returned: String(res).slice(0, 66), gasEstimate: gasEst ? gasEst.toString() : null, chainId: c.id };
  } catch (e) {
    const cl = classify(e);
    return { ok: false, address: account.address, error: cl.reason, action: cl.action, raw: String(e.shortMessage || e.message).slice(0, 180) };
  }
}


const PREP_WINDOW_MS = 90000;

function preciseSleep(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function chainClockOffset(chainKey, urls) {
  const ps = rpc.providersFor(chainKey, urls).slice(0, 3);
  const samples = [];
  await Promise.all(ps.map(async (p) => {
    try {
      const t0 = Date.now();
      const b = await p.getBlock('latest');
      const t1 = Date.now();
      if (b) samples.push(b.timestamp * 1000 - (t0 + t1) / 2);
    } catch { /* sample lost */ }
  }));
  if (!samples.length) return null;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

async function measureBlockMs(chainKey, urls, sampleMs = 4000) {
  try {
    const p = rpc.providersFor(chainKey, urls)[0];
    const n1 = await p.getBlockNumber();
    const t1 = Date.now();
    await new Promise((r) => setTimeout(r, sampleMs));
    const n2 = await p.getBlockNumber();
    const t2 = Date.now();
    if (n2 > n1) return (t2 - t1) / (n2 - n1);
  } catch { /* unmeasurable */ }
  return null;
}

async function rawGateCall(url, tx, ts) {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [
      { from: tx.from, to: tx.to, data: tx.data, value: '0x' + (tx.value || 0n).toString(16) },
      'latest',
      ...(ts != null ? [null, { time: '0x' + BigInt(ts).toString(16) }] : []),
    ],
  };
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const j = await r.json();
  if (j.result != null) return 'pass';
  const msg = String(j.error?.message || '');
  if (/cannot unmarshal|unknown field|invalid argument|too many arguments|not supported|blockoverride/i.test(msg)) return 'unsupported';
  return 'revert';
}

async function gateCallAtTime(cfg, tx, ts, urls) {
  const list = (urls && urls.length ? urls : rpc.urlsFor(cfg.chain)).slice(0, 3);
  const results = await Promise.all(list.map((u) => rawGateCall(u, tx, ts).catch(() => 'flaky')));
  if (results.includes('pass')) return true;
  if (results.every((x) => x === 'unsupported')) return null;
  if (results.every((x) => x === 'flaky')) return null;
  return false;
}

async function probeGateStart(cfg, tx, hintTs, urls) {
  const nowS = Math.floor(Date.now() / 1000);
  if (await gateCallAtTime(cfg, tx, nowS, urls)) return { openNow: true };
  const hint = Number(hintTs) || nowS + 3600;
  let lo, hi;
  if (hint > nowS && (await gateCallAtTime(cfg, tx, hint, urls)) === true) {
    lo = nowS; hi = hint;                       // API ts passes → boundary is earlier
  } else {
    lo = Math.max(hint, nowS); hi = lo + 96 * 3600;
    if ((await gateCallAtTime(cfg, tx, hi, urls)) !== true) return null; // never opens in 96h
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await gateCallAtTime(cfg, tx, mid, urls)) === true) hi = mid; else lo = mid;
  }
  return { startTs: hi };
}


async function start(cfg) {
  const runId = nid('run');
  const walletList = (cfg.walletIds || []).map((id) => wallets.getWallet('evm', id)).filter(Boolean);
  if (!walletList.length) throw new Error('no wallets selected');
  const c = chainsMod.chain(cfg.chain);
  const state = {
    id: runId, cfg: { ...cfg, abi: undefined }, status: 'starting', mode: cfg.mode || 'execute',
    started: Date.now(), events: [], results: [], stopped: false,
    walletList: walletList.map((w) => ({ id: w.id, name: w.name, address: w.address })),
    counts: { total: walletList.length, sent: 0, confirmed: 0, failed: 0, skipped: 0 },
    gateMs: null, offsetMs: 0, // chain-time gate + chain↔local offset → UI countdown
  };
  runs.set(runId, state);

  (async () => {
    try {
      emit(runId, { level: 'info', msg: `run ${cfg.name || cfg.address} on ${c.name} · ${walletList.length} wallets · mode=${state.mode}` });
      const gas = await resolveGas(cfg.chain, cfg);
      emit(runId, { level: 'info', msg: `gas maxFee=${ethers.formatUnits(gas.maxFeePerGas, 'gwei')} tip=${ethers.formatUnits(gas.maxPriorityFeePerGas, 'gwei')} gwei limit=${gas.gasLimit ?? 'auto'}` });

      if (cfg.method === 'abi' && !cfg.abi) {
        const r = await abiMod.resolveAbi(cfg.chain, cfg.address);
        cfg.abi = r.abi;
        emit(runId, { level: 'info', msg: `ABI ${r.source}${r.proxy ? ` impl=${r.proxy}` : ''}` });
      }

      const urls = cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : rpc.urlsFor(cfg.chain);
      const timed = !!cfg.startTimestamp;
      let targetMs = timed ? Number(cfg.startTimestamp) * 1000 : null; // chain-time gate, ms
      let offsetMs = 0;   // chain clock − local clock, ms (positive = chain ahead)
      let blockMs = null; // ms per block on this chain
      const syncGate = () => { state.gateMs = targetMs; state.offsetMs = offsetMs; };

      if (timed) {
        state.status = 'armed';
        syncGate();
        emit(runId, { level: 'info', msg: `armed for ${new Date(targetMs).toISOString()} (chain time)${cfg.chainSync === false ? ' · chainsync off' : ''}` });
        if (cfg.chainSync !== false) {
          offsetMs = (await chainClockOffset(cfg.chain, urls)) ?? 0;
          blockMs = await measureBlockMs(cfg.chain, urls);
          syncGate();
          emit(runId, { level: 'info', msg: `chain clock ${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(2)}s vs local · block ~${blockMs ? blockMs.toFixed(0) : '?'}ms` });
        }
        const prepLocal = targetMs + offsetMs - PREP_WINDOW_MS;
        while (Date.now() < prepLocal && !state.stopped) {
          await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(50, prepLocal - Date.now()))));
        }
        if (state.stopped) { state.status = 'stopped'; return; }
        if (cfg.chainSync !== false) { offsetMs = (await chainClockOffset(cfg.chain, urls)) ?? offsetMs; syncGate(); }
      }

      const balances = {};
      const osFuture = cfg.method === 'opensea-api' && timed && targetMs + offsetMs > Date.now();
      if (state.mode !== 'simulate' && cfg.preflight !== false && !osFuture) {
        await Promise.all(walletList.map(async (w, i) => {
          try { balances[w.address] = await rpc.provider(urls[i % urls.length], c.id).getBalance(w.address); }
          catch { balances[w.address] = null; }
        }));
        const funded = walletList.filter((w) => balances[w.address] > 0n);
        const candidates = (funded.length ? funded : walletList).slice(0, 3);
        let sim = null;
        for (const wc of candidates) {
          /* a per-wallet revert (eligibility/limit) says nothing about the sale — try another wallet before warning */
          const call0 = await buildCall(cfg, wc, {});
          sim = await simulateOne(cfg, wc, call0, gas);
          if (sim.ok || sim.action === STOP_ALL) break;
        }
        emit(runId, { level: sim.ok ? 'info' : 'warn', msg: `preflight ${sim.ok ? 'PASS' : 'FAIL: ' + sim.error}`, data: sim });
        if (!sim.ok && sim.action === STOP_ALL && cfg.ignorePreflight !== true) {
          state.status = 'aborted';
          emit(runId, { level: 'error', msg: `aborted on preflight: ${sim.error}` });
          return;
        }
        if (sim.gasEstimate && !gas.gasLimit) gas.gasLimit = (BigInt(sim.gasEstimate) * 13n) / 10n;
      } else if (timed) {
        await Promise.all(walletList.map(async (w, i) => {
          try { balances[w.address] = await rpc.provider(urls[i % urls.length], c.id).getBalance(w.address); }
          catch { balances[w.address] = null; }
        }));
      }

      if (!gas.gasLimit) gas.gasLimit = 300000n;

      const nonces = {};
      const CONC = 10;
      for (let i = 0; i < walletList.length; i += CONC) {
        await Promise.all(walletList.slice(i, i + CONC).map(async (w, j) => {
          if (cfg.nonceOverride != null && cfg.nonceOverride !== '') { nonces[w.address] = Number(cfg.nonceOverride); return; }
          /* try every RPC before giving up — a single dead endpoint must not kill half the fleet */
          for (const u of urls) {
            try { nonces[w.address] = await rpc.provider(u, c.id).getTransactionCount(w.address, 'pending'); break; }
            catch { /* next url */ }
          }
          if (nonces[w.address] == null) {
            try { nonces[w.address] = await rpc.readRace(cfg.chain, (p) => p.getTransactionCount(w.address, 'pending'), urls); } catch { /* stays null */ }
          }
        }));
      }
      emit(runId, { level: 'info', msg: `nonces fetched (${Object.values(nonces).filter((n) => n != null).length}/${walletList.length})` });

      const signedList = [];
      const signWallet = async (w) => {
        if (nonces[w.address] == null) {
          state.counts.skipped++;
          state.results.push({ ok: false, address: w.address, error: 'nonce fetch failed' });
          emit(runId, { level: 'fail', wallet: w.name, msg: 'nonce fetch failed' });
          return;
        }
        if (balances[w.address] === 0n) {
          state.counts.skipped++;
          state.results.push({ ok: false, address: w.address, error: 'no balance' });
          emit(runId, { level: 'fail', wallet: w.name, msg: 'no balance' });
          return;
        }
        const mintVal = ethers.parseEther(String(cfg.pricePerNft || '0')) * BigInt(cfg.amount || 1);
        const minBal = mintVal + (gas.gasLimit * gas.maxFeePerGas * 11n / 10n);
        if (balances[w.address] != null && balances[w.address] < minBal) {
          state.counts.skipped++;
          state.results.push({ ok: false, address: w.address, error: 'underfunded' });
          emit(runId, { level: 'fail', wallet: w.name, msg: `underfunded: has ${ethers.formatEther(balances[w.address])} ETH, need ~${ethers.formatEther(minBal)} ETH` });
          return;
        }
        try {
          const call = await buildCall(cfg, w, {});
          /* instant mode: sale is live NOW — a reverting sim means this wallet can't mint. Skip it instead of broadcasting gas into a revert. */
          if (!timed && cfg.perWalletSim !== false && state.mode !== 'spam' && !cfg.war) {
            const sim = await simulateOne(cfg, w, call, gas);
            if (!sim.ok && sim.action === SKIP) {
              state.counts.skipped++;
              state.results.push({ ok: false, address: w.address, error: `skipped: ${sim.error}` });
              emit(runId, { level: 'fail', wallet: w.name, msg: `skip (${sim.error})` });
              return;
            }
          }
          const signer = new ethers.Wallet(w.pk);
          const baseNonce = nonces[w.address];
          /* spam mode: sign N txs with incrementing nonces (Zyper-style) */
          const spamCount = state.mode === 'spam' ? Math.max(1, Number(cfg.spamCount || cfg.maxTx || 20)) : 1;
          for (let n = 0; n < spamCount; n++) {
            const tx = {
              chainId: c.id, to: call.to, data: call.data, value: call.value,
              nonce: baseNonce + n, gasLimit: gas.gasLimit,
              maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas, type: 2,
            };
            signedList.push({ w, raw: await signer.signTransaction(tx), value: call.value, call, nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
          }
          if (spamCount > 1) emit(runId, { level: 'info', wallet: w.name, msg: `pre-signed ${spamCount} txs (nonces ${baseNonce}..${baseNonce + spamCount - 1})` });
        } catch (e) {
          state.counts.failed++;
          const cl = classify(e);
          state.results.push({ ok: false, address: w.address, error: cl.reason });
          emit(runId, { level: 'fail', wallet: w.name, msg: `sign failed: ${cl.reason}` });
        }
      };
      if (!osFuture && cfg.method === 'opensea-api' && cfg.stageId) {
        try { await verifyDropStage(cfg, 'live', emit, runId); }
        catch (e) {
          state.status = 'aborted';
          emit(runId, { level: 'error', msg: String(e.message || e) });
          return;
        }
      }
      if (!osFuture) {
        for (const w of walletList) await signWallet(w);
        emit(runId, { level: 'info', msg: `pre-signed ${signedList.length} tx` });
      }

      if (timed && cfg.chainSync !== false && signedList.length && cfg.method !== 'opensea-api') {
        try {
          const gateTx = { from: signedList[0].w.address, to: signedList[0].call.to, data: signedList[0].call.data, value: signedList[0].value };
          const probe = await probeGateStart(cfg, gateTx, Math.floor(targetMs / 1000), urls);
          if (probe && probe.openNow) {
            emit(runId, { level: 'warn', msg: 'gate already OPEN onchain — firing immediately' });
            targetMs = null;
          } else if (probe && probe.startTs) {
            const corrected = probe.startTs * 1000;
            if (Math.abs(corrected - targetMs) > 2000) {
              emit(runId, { level: 'warn', msg: `ONCHAIN GATE ${new Date(corrected).toISOString()} ≠ API ${new Date(targetMs).toISOString()} (${Math.round((targetMs - corrected) / 1000)}s off) — following ONCHAIN` });
            } else {
              emit(runId, { level: 'info', msg: `onchain gate confirmed ${new Date(corrected).toISOString()}` });
            }
            targetMs = corrected;
          } else {
            emit(runId, { level: 'info', msg: 'RPC has no blockOverrides — will gate-poll live eth_call at fire time' });
          }
        } catch (e) {
          emit(runId, { level: 'warn', msg: `gate probe failed (${String(e.message).slice(0, 100)}) — using API timestamp` });
        }
      }
      state.status = 'running';

      if (cfg.flashbotsBundle && signedList.length) {
        try {
          const fb = await flashbotsSend(cfg.chain, signedList.map((s) => s.raw), { authKey: cfg.flashbotsAuthKey });
          emit(runId, { level: 'ok', msg: `bundle sent block ${fb.targetBlock} · ${fb.accepted}/${fb.relays} relays accepted` });
          state.counts.sent = signedList.length;
          signedList.forEach((s) => state.results.push({ ok: true, address: s.w.address, bundle: fb.targetBlock }));
        } catch (e) {
          emit(runId, { level: 'error', msg: `bundle failed: ${String(e.message).slice(0, 160)}` });
        }
        state.status = 'done';
        return;
      }

      const fire = async (s) => {
        if (state.stopped) return;
        if (state.mode === 'simulate' && s.call) {
          const interval = Math.max(200, Number(cfg.delayMs || 800));
          const maxTry = Number(cfg.attemptCount || 0);
          emit(runId, { level: 'info', wallet: s.w.name, msg: `simulate: polling until mint open…` });
          let tries = 0, sim = null, lastErr = '';
          while (!state.stopped) {
            tries++;
            sim = await simulateOne(cfg, { address: s.w.address }, s.call, gas);
            if (sim.ok) { emit(runId, { level: 'ok', wallet: s.w.name, msg: `simulate PASS (try ${tries}) → sending real tx` }); break; }
            lastErr = sim.error;
            if (sim.action === STOP_ALL && cfg.stopOnSoldOut !== false) {
              state.stopped = true;
              emit(runId, { level: 'error', msg: `STOP ALL (sim): ${sim.error} (${s.w.name})` });
              break;
            }
            if (maxTry > 0 && tries >= maxTry) { emit(runId, { level: 'fail', wallet: s.w.name, msg: `simulate max attempts (${maxTry})` }); break; }
            if (tries % 20 === 0) emit(runId, { level: 'info', wallet: s.w.name, msg: `still reverting (${tries}): ${lastErr}` });
            await new Promise((r) => setTimeout(r, interval));
          }
          if (state.stopped) return;
          if (!(sim && sim.ok)) {
            state.counts.skipped++;
            state.results.push({ ok: false, address: s.w.address, error: `simulate: ${lastErr || 'no pass'}` });
            return;
          }
        }
        try {
          let res;
          if (cfg.flashbots) res = await flashbotsPrivate(cfg.chain, s.raw, { authKey: cfg.flashbotsAuthKey });
          else res = await rpc.broadcast(cfg.chain, s.raw, urls);
          state.counts.sent++;
          state.results.push({ ok: true, address: s.w.address, hash: res.hash, pending: true, ts: Date.now(), nonce: s.nonce, pk: s.w.pk, call: s.call, value: s.value, maxFeePerGas: s.maxFeePerGas, maxPriorityFeePerGas: s.maxPriorityFeePerGas });
          emit(runId, { level: 'ok', wallet: s.w.name, msg: `sent ${res.hash}`, hash: res.hash });
        } catch (e) {
          const cl = classify(e);
          if (cl.action === STOP_ALL && cfg.stopOnSoldOut !== false) {
            state.stopped = true;
            emit(runId, { level: 'error', msg: `STOP ALL: ${cl.reason} (${s.w.name})` });
          }
          if (cl.action === SKIP) state.counts.skipped++; else state.counts.failed++;
          state.results.push({ ok: false, address: s.w.address, error: cl.reason });
          emit(runId, { level: 'fail', wallet: s.w.name, msg: cl.reason });
        }
      };

      if (timed && targetMs != null) {
        const mode = cfg.fireMode === 'lead' || cfg.fireMode === 'gate-poll'
          ? cfg.fireMode
          : (blockMs != null && blockMs >= 5000 ? 'lead' : 'gate-poll');
        const leadMs = cfg.leadMs != null ? Number(cfg.leadMs) : Math.round(Math.min(Math.max(blockMs || 2000, 1000), 15000));
        const fcfsOn = cfg.method === 'opensea-api' && cfg.fcfs !== false;
        const fcfsLeadMs = cfg.fcfsLeadMs != null ? Number(cfg.fcfsLeadMs) : (cfg.war ? 10000 : 1500);
        let fireLocal = targetMs + offsetMs - (mode === 'lead' ? leadMs : 0);
        emit(runId, { level: 'info', msg: `fire plan: ${mode}${mode === 'lead' ? ` · lead ${(leadMs / 1000).toFixed(1)}s` : ` · poll every ${Math.max(50, Number(cfg.monitor?.pollMs || 150))}ms`} · at ${new Date(fireLocal).toISOString()} local${fcfsOn ? ' · FCFS bundle on' : ''}` });

        let lastSchedCheck = 0;
        while (Date.now() < fireLocal - 10000 && !state.stopped) {
          await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(200, fireLocal - 10000 - Date.now()))));
          if (cfg.chainSync !== false && fireLocal - Date.now() > 20000) {
            const o = await chainClockOffset(cfg.chain, urls);
            if (o != null && Math.abs(o - offsetMs) >= 500) {
              offsetMs = o;
              syncGate();
              emit(runId, { level: 'info', msg: `chain clock re-synced: ${offsetMs >= 0 ? '+' : ''}${(offsetMs / 1000).toFixed(2)}s` });
            }
          }
          if (cfg.method === 'opensea-api' && cfg.slug && cfg.stageId && Date.now() - lastSchedCheck > 30000) {
            lastSchedCheck = Date.now();
            try {
              const v = await verifyDropStage(cfg, 'schedule', emit, runId, Math.floor(targetMs / 1000));
              if (v && v.movedStart) {
                const delta = v.movedStart * 1000 - targetMs;
                if (cfg.followSchedule !== true) {
                  state.stopped = true;
                  state.status = 'aborted';
                  emit(runId, { level: 'error', msg: `STAGE GUARD: creator moved stage start ${delta > 0 ? '+' : ''}${Math.round(delta / 1000)}s → ${new Date(v.movedStart * 1000).toISOString()}. Run cancelled.` });
                  return;
                }
                targetMs = v.movedStart * 1000;
                fireLocal = targetMs + offsetMs - (mode === 'lead' ? leadMs : 0);
                syncGate();
                emit(runId, { level: 'warn', msg: `SCHEDULE MOVED ${delta > 0 ? '+' : ''}${Math.round(delta / 1000)}s by creator → now ${new Date(targetMs).toISOString()}` });
              }
            } catch (e) {
              if (/STAGE GUARD/.test(String(e.message || ''))) {
                state.stopped = true;
                state.status = 'aborted';
                emit(runId, { level: 'error', msg: String(e.message) });
                return;
              }
            }
          }
        }
        if (state.stopped) { state.status = 'stopped'; return; }

        if (signedList.length && cfg.nonceOverride == null) {
          await Promise.all(signedList.map(async (s, i) => {
            try {
              const p = rpc.provider(urls[i % urls.length], c.id);
              const n = await p.getTransactionCount(s.w.address, 'pending');
              if (n !== nonces[s.w.address]) {
                nonces[s.w.address] = n;
                const signer = new ethers.Wallet(s.w.pk);
                s.raw = await signer.signTransaction({
                  chainId: c.id, to: s.call.to, data: s.call.data, value: s.value,
                  nonce: n, gasLimit: gas.gasLimit,
                  maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas, type: 2,
                });
                emit(runId, { level: 'info', wallet: s.w.name, msg: `nonce moved → re-signed (${n})` });
              }
            } catch { /* keep existing signature */ }
          }));
        }

        if (fcfsOn) {
          const hammerStart = fireLocal - fcfsLeadMs;
          let lastWarm = 0;
          while (Date.now() < hammerStart - 150 && !state.stopped) {
            const sleepMs = Math.min(3000, Math.max(50, hammerStart - Date.now()));
            await new Promise((r) => setTimeout(r, sleepMs));
            if (Date.now() - lastWarm >= 3000) {
              lastWarm = Date.now();
              try { await launchpads.openseaKeepWarm(); } catch { /* warming is best-effort */ }
              try { await rpc.readRace(cfg.chain, (p) => p.getBlockNumber(), urls); } catch { /* ditto */ }
            }
          }
          while (Date.now() < hammerStart && !state.stopped) preciseSleep(Math.min(2, Math.max(0.2, hammerStart - Date.now())));
          if (state.stopped) { state.status = 'stopped'; return; }

          if (cfg.nonceOverride == null) {
            await Promise.all(walletList.map(async (w, i) => {
              try { nonces[w.address] = await rpc.provider(urls[i % urls.length], c.id).getTransactionCount(w.address, 'pending'); }
              catch { /* keep previous value */ }
            }));
          }

          emit(runId, { level: 'info', msg: `FCFS hammer: pulling calldata ${fcfsLeadMs}ms pre-gate (${cfg.osPath === 'v2' ? 'v2 API' : 'gql batch + v2 fallback'})…` });
          try { await verifyDropStage(cfg, 'live', emit, runId, null, Math.ceil((fcfsLeadMs + Math.abs(offsetMs || 0)) / 1000) + 1); }
          catch (e) {
            state.stopped = true;
            state.status = 'aborted';
            emit(runId, { level: 'error', msg: String(e.message || e) });
            return;
          }
          cfg._offsetMs = offsetMs || 0;
          await fcfsHammer({ cfg, state, runId, emit, walletList, nonces, balances, gas, urls, c, signedList });
          if (state.stopped) { if (state.status !== 'aborted') state.status = 'stopped'; return; }
          if (!signedList.length) {
            state.status = 'aborted';
            emit(runId, { level: 'error', msg: 'OpenSea never served calldata — stage may be sold out or wallets ineligible' });
            return;
          }
          emit(runId, { level: 'info', msg: `signed ${signedList.length} tx ${mode === 'lead' ? 'before lead-fire' : 'before the on-chain gate'}` });
        }

        if (mode === 'lead') {
          while (Date.now() < fireLocal && !state.stopped) preciseSleep(Math.min(5, Math.max(0.5, fireLocal - Date.now())));
        } else {
          if (osFuture && !fcfsOn) {
            emit(runId, { level: 'info', msg: 'fetching OpenSea calldata at the gate…' });
            try { await verifyDropStage(cfg, 'live', emit, runId); }
            catch (e) {
              state.status = 'aborted';
              emit(runId, { level: 'error', msg: String(e.message || e) });
              return;
            }
            const want = walletList.filter((w) => balances[w.address] !== 0n && nonces[w.address] != null);
            const failed = new Set();
            while (!state.stopped && signedList.length + failed.size < want.length && Date.now() < fireLocal + 90000) {
              const missing = want.filter((w) => !failed.has(w.address) && !signedList.some((s) => s.w.address === w.address));
              await Promise.all(missing.map(async (w) => {
                try {
                  const call = await buildCall(cfg, w, {});
                  const signer = new ethers.Wallet(w.pk);
                  const tx = {
                    chainId: c.id, to: call.to, data: call.data, value: call.value,
                    nonce: nonces[w.address], gasLimit: gas.gasLimit,
                    maxFeePerGas: gas.maxFeePerGas, maxPriorityFeePerGas: gas.maxPriorityFeePerGas, type: 2,
                  };
                  signedList.push({ w, raw: await signer.signTransaction(tx), value: call.value, call, nonce: tx.nonce, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
                } catch (e) {
                  const msg = String(e.message || '');
                  if (/sold out|max supply/i.test(msg)) { state.stopped = true; emit(runId, { level: 'error', msg: `OpenSea says sold out: ${msg.slice(0, 120)}` }); }
                  else if (/limit|allowlist|whitelist|insufficient|ineligible/i.test(msg)) {
                    failed.add(w.address);
                    state.counts.skipped++;
                    state.results.push({ ok: false, address: w.address, error: msg.slice(0, 120) });
                    emit(runId, { level: 'fail', wallet: w.name, msg: msg.slice(0, 120) });
                  }
                }
              }));
              if (signedList.length + failed.size < want.length && !state.stopped) await new Promise((r) => setTimeout(r, 250));
            }
            if (state.stopped) { state.status = 'stopped'; return; }
            if (!signedList.length) {
              state.status = 'aborted';
              emit(runId, { level: 'error', msg: 'OpenSea never served calldata — stage may be sold out or wallets ineligible' });
              return;
            }
            emit(runId, { level: 'info', msg: `signed ${signedList.length} tx at the gate` });
          }
          const pollMs = Math.max(50, Number(cfg.monitor?.pollMs || 150));
          emit(runId, { level: 'info', msg: `gate-polling ${signedList.length} wallets every ${pollMs}ms…` });
          let opened = false;
          const PROBE_BATCH = 4;
          while (!state.stopped && Date.now() < targetMs + offsetMs + 90000 && !opened) {
            /* probe several signed wallets per tick — an ineligible first wallet must not blind the gate */
            for (let base = 0; base < signedList.length && !opened && !state.stopped; base += PROBE_BATCH) {
              const verdicts = await Promise.all(signedList.slice(base, base + PROBE_BATCH).map(async (s2) => {
                try {
                  await rpc.readRace(cfg.chain, (p) => p.call({ from: s2.w.address, to: s2.call.to, data: s2.call.data, value: s2.value }), urls);
                  return 'open';
                } catch (e) {
                  if (e && e.code !== 'CALL_EXCEPTION') return 'flaky';
                  const cl = classify(e);
                  if (cl.action === STOP_ALL && cfg.stopOnSoldOut !== false) {
                    state.stopped = true;
                    emit(runId, { level: 'error', msg: `STOP ALL (gate): ${cl.reason}` });
                    return 'stop';
                  }
                  return 'closed';
                }
              }));
              if (verdicts.includes('open')) opened = true;
              else if (verdicts.includes('stop')) break;
            }
            if (!opened && !state.stopped) preciseSleep(Math.min(pollMs, Math.max(20, targetMs + offsetMs - Date.now())));
          }
          if (state.stopped) { state.status = 'stopped'; return; }
          if (!opened) {
            state.status = 'aborted';
            emit(runId, { level: 'error', msg: 'gate never opened within 90s of timestamp — sold out or wrong timestamp?' });
            return;
          }
          emit(runId, { level: 'ok', msg: 'gate OPEN onchain — FIRE' });
        }
      }
      if (state.stopped) { state.status = 'stopped'; return; }

      if (cfg.monitor && cfg.monitor.mode === 'onchain' && !state.stopped) {
        state.status = 'monitoring';
        const ok = await waitOnchainOpen(runId, cfg, state);
        if (!ok) { state.status = 'stopped'; return; }
      }
      if (state.stopped) { state.status = 'stopped'; return; }

      if (!signedList.length) {
        state.status = 'done';
        emit(runId, { level: 'warn', msg: 'nothing signed — nothing to send' });
        return;
      }

      if (timed || state.mode === 'spam' || state.mode === 'instant') {
        await Promise.all(signedList.map(fire));
      } else {
        for (const s of signedList) {
          if (state.stopped) break;
          await fire(s);
          if (cfg.delayMs) await new Promise((r) => setTimeout(r, Number(cfg.delayMs)));
        }
      }

      state.status = 'confirming';
      await trackReceipts(runId, cfg, state, urls);
      state.status = 'done';
      emit(runId, { level: 'info', msg: `done · sent ${state.counts.sent} confirmed ${state.counts.confirmed} failed ${state.counts.failed} skipped ${state.counts.skipped}` });
      store.appendLog('mint-runs.log', `${runId} ${cfg.name || cfg.address} ${c.key} sent=${state.counts.sent} ok=${state.counts.confirmed} fail=${state.counts.failed}`);
      require('./notify').notify('Mint done', [['run', runId], ['name', cfg.name || cfg.address], ['chain', c.name], ['sent', state.counts.sent], ['ok', state.counts.confirmed], ['fail', state.counts.failed]]);
    } catch (e) {
      state.status = 'error';
      emit(runId, { level: 'error', msg: String(e.message || e).slice(0, 300) });
    }
  })();

  return { runId };
}

async function waitOnchainOpen(runId, cfg, state) {
  const poll = Number(cfg.monitor.pollMs || 1500);
  const fn = cfg.monitor.fn || 'mintOpen';
  const sigs = [`function ${fn}() view returns (bool)`, 'function saleActive() view returns (bool)', 'function paused() view returns (bool)'];
  emit(runId, { level: 'info', msg: `monitoring ${fn}() every ${poll}ms` });
  let n = 0;
  while (!state.stopped) {
    for (const sig of sigs) {
      try {
        const iface = new ethers.Interface([sig]);
        const name = iface.fragments[0].name;
        const raw = await rpc.readRace(cfg.chain, (p) => p.call({ to: cfg.address, data: iface.encodeFunctionData(name, []) }), cfg.rpcs);
        const v = iface.decodeFunctionResult(name, raw)[0];
        const open = name === 'paused' ? !v : !!v;
        if (open) { emit(runId, { level: 'ok', msg: `mint OPEN detected via ${name}()` }); return true; }
        break;
      } catch { /* try next sig */ }
    }
    if (++n % 20 === 0) emit(runId, { level: 'info', msg: `still closed (${n} polls)` });
    await new Promise((r) => setTimeout(r, poll));
  }
  return false;
}

async function trackReceipts(runId, cfg, state, urls) {
  const c = chainsMod.chain(cfg.chain);
  const pend = state.results.filter((r) => r.ok && r.hash && r.pending);
  if (!pend.length) return;
  const deadline = Date.now() + Number(cfg.receiptTimeoutMs || 90000);
  const pendingTimeoutMs = Number(cfg.pendingTimeoutMs || 20000);
  const maxAttempts = Math.max(1, Number(cfg.maxRetries || 1));
  const bumpBps = 11250n; // 112.5% same-nonce fee bump (osnm-z default)
  while (Date.now() < deadline) {
    const left = pend.filter((r) => r.pending);
    if (!left.length) break;
    await Promise.all(left.map(async (r, i) => {
      try {
        const p = rpc.provider(urls[i % urls.length], c.id);
        const rec = await p.getTransactionReceipt(r.hash);
        if (!rec) {
          // same-nonce replacement: still pending past timeout → resubmit with bumped fees
          if (r.pk && r.nonce != null && r.maxFeePerGas && !r.stoppedReplacing
              && Date.now() - r.ts > pendingTimeoutMs && (r.replaces || 0) < maxAttempts) {
            r.replaces = (r.replaces || 0) + 1;
            const maxFee = (BigInt(r.maxFeePerGas) * bumpBps) / 10000n;
            const tip = (BigInt(r.maxPriorityFeePerGas) * bumpBps) / 10000n;
            const signer = new ethers.Wallet(r.pk);
            const raw = await signer.signTransaction({
              chainId: c.id, to: r.call.to, data: r.call.data, value: r.value,
              nonce: r.nonce, gasLimit: r.gasLimit || 300000n,
              maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, type: 2,
            });
            const res = await rpc.broadcast(cfg.chain, raw, urls);
            r.hash = res.hash; r.ts = Date.now(); r.replacedHash = res.hash;
            emit(runId, { level: 'warn', wallet: walletNameFor(state, r.address), msg: `pending → fee-bump resubmit (${r.replaces}/${maxAttempts}) ${res.hash}`, hash: res.hash });
          }
          return;
        }
        r.pending = false;
        r.block = rec.blockNumber;
        r.gasUsed = rec.gasUsed.toString();
        r.effectiveGasPrice = rec.gasPrice ? rec.gasPrice.toString() : null;
        if (rec.status === 1) {
          state.counts.confirmed++;
          const feeEth = rec.gasPrice ? ethers.formatEther(rec.gasUsed * rec.gasPrice) : null;
          r.feeEth = feeEth;
          r.tokenId = tokenIdFromReceipt(rec);
          /* spam mode: first confirm → stop all remaining txs */
          if (state.mode === 'spam') {
            state.stopped = true;
            emit(runId, { level: 'ok', msg: `SPAM WIN — confirmed ${r.hash.slice(0, 16)}… block ${rec.blockNumber}${r.tokenId ? ` #${r.tokenId}` : ''}${feeEth ? ` fee ${Number(feeEth).toFixed(6)}` : ''}`, hash: r.hash });
          }
          const priceEth = ethers.formatEther(
            ethers.parseEther(String(cfg.pricePerNft || '0')) * BigInt(cfg.amount || 1),
          );
          r.priceEth = priceEth;
          activity.add({
            kind: 'mint', ok: true, chain: c.key, wallet: walletNameFor(state, r.address), address: r.address,
            tokenId: r.tokenId, hash: r.hash, collection: cfg.name || cfg.address, feeEth, priceEth,
            slug: cfg.slug || null, qty: Number(cfg.amount || 1),
            explorer: c.explorer ? `${c.explorer}/tx/${r.hash}` : null,
          });
          emit(runId, { level: 'ok', msg: `confirmed ${r.hash.slice(0, 12)}… block ${rec.blockNumber}${r.tokenId ? ` #${r.tokenId}` : ''}${feeEth ? ` fee ${Number(feeEth).toFixed(6)}` : ''}`, hash: r.hash });
        } else {
          state.counts.failed++;
          r.ok = false; r.error = 'tx reverted onchain';
          activity.add({
            kind: 'mint', ok: false, chain: c.key, wallet: walletNameFor(state, r.address), address: r.address,
            hash: r.hash, collection: cfg.name || cfg.address, error: 'reverted onchain',
            explorer: c.explorer ? `${c.explorer}/tx/${r.hash}` : null,
          });
          emit(runId, { level: 'fail', msg: `reverted ${r.hash.slice(0, 12)}… block ${rec.blockNumber}` });
        }
      } catch { /* keep polling */ }
    }));
    await new Promise((r) => setTimeout(r, 3000));
  }
  pend.filter((r) => r.pending).forEach((r) => { r.timedOut = true; emit(runId, { level: 'warn', msg: `receipt timeout ${r.hash.slice(0, 12)}…` }); });
}


function stop(runId) {
  const r = runs.get(runId);
  if (!r) return false;
  r.stopped = true; r.status = 'stopped';
  emit(runId, { level: 'warn', msg: 'STOPPED by user' });
  return true;
}

function stopAll() {
  let n = 0;
  for (const [id, r] of runs) { if (!['done', 'error', 'stopped'].includes(r.status)) { r.stopped = true; r.status = 'stopped'; emit(id, { level: 'warn', msg: 'EMERGENCY STOP' }); n++; } }
  return n;
}

function status(runId) {
  const r = runs.get(runId);
  if (!r) return null;
  let feeWei = 0n;
  for (const x of r.results) {
    if (x.pending || !x.gasUsed || !x.effectiveGasPrice) continue;
    try { feeWei += BigInt(x.gasUsed) * BigInt(x.effectiveGasPrice); } catch { /* skip */ }
  }
  return { id: r.id, status: r.status, mode: r.mode, counts: r.counts, started: r.started, name: r.cfg.name, chain: r.cfg.chain, address: r.cfg.address, gateMs: r.gateMs, offsetMs: r.offsetMs || 0, fees: { wei: feeWei.toString(), eth: ethers.formatEther(feeWei) }, results: r.results.slice(-400).map(stripSensitive) };
}

function stripSensitive(x) {
  if (!x) return x;
  const { pk, call, value, maxFeePerGas, maxPriorityFeePerGas, ...safe } = x;
  return safe;
}

function list() {
  return [...runs.values()].map((r) => ({ id: r.id, name: r.cfg.name, chain: r.cfg.chain, address: r.cfg.address, status: r.status, mode: r.mode, counts: r.counts, started: r.started, gateMs: r.gateMs, offsetMs: r.offsetMs || 0 }));
}

function events(runId, since) {
  const r = runs.get(runId);
  if (!r) return [];
  return r.events.filter((e) => !since || e.t > since);
}

function clearFinished() {
  let n = 0;
  for (const [id, r] of runs) if (['done', 'error', 'stopped', 'aborted'].includes(r.status)) { runs.delete(id); n++; }
  return n;
}


async function seadropProbe(chainKey, nftAddress) {
  const c = chainsMod.chain(chainKey);
  const urls = rpc.urlsFor(chainKey);
  const prov = rpc.provider(urls[0], c.id);
  const SEADROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

  const result = { nftContract: nftAddress, seadropContract: SEADROP, chain: chainKey, chainId: c.id, priceWei: null, timestamps: null, maxPerWallet: null, supply: null, minted: null };

  // totalSupply
  try {
    const ts = await prov.call({ to: nftAddress, data: '0x18160ddd' });
    result.minted = Number(BigInt(ts));
  } catch { /* unverified */ }

  // maxSupply
  try {
    const ms = await prov.call({ to: nftAddress, data: '0xd5abeb01' });
    result.supply = Number(BigInt(ms));
  } catch { /* unverified */ }

  // try mintPublic simulation with 0.002 ETH (common RH price) to extract timestamps from revert
  const selector = '161ac21f';
  const nftPad = nftAddress.toLowerCase().slice(2).padStart(64, '0');
  const feePad = '0000000000000000000000000000a26b00c1f0df003000390027140000faa719';
  const minterPad = '0000000000000000000000000000000000000000000000000000000000000000';
  const qtyPad = '0000000000000000000000000000000000000000000000000000000000000001';
  const calldata = `0x${selector}${nftPad}${feePad}${minterPad}${qtyPad}`;
  const testValue = ethers.parseEther('0.002');

  try {
    await prov.call({ from: '0x0000000000000000000000000000000000000001', to: SEADROP, data: calldata, value: testValue });
    result.openNow = true;
  } catch (e) {
    const msg = String(e?.shortMessage || e?.message || '');
    // extract timestamps from NotActive revert (0x13da22f2 + 3 uint256)
    const data = e?.data || e?.receipt?.data || '';
    if (typeof data === 'string' && data.startsWith('0x13da22f2')) {
      const ts1 = parseInt(data.slice(10, 74), 16);
      const ts2 = parseInt(data.slice(74, 138), 16);
      const ts3 = parseInt(data.slice(138, 202), 16);
      if (ts1 > 1e9) result.publicStart = ts1;
      if (ts2 > 1e9) result.publicEnd = ts2;
      if (ts3 > 1e9) result.publicEnd = ts3;
      result.timestamps = { start: ts1, mid: ts2, end: ts3 };
    }
    // try extract from err.message hex blob
    const hexMatch = msg.match(/0x13da22f2([0-9a-f]{192})/);
    if (hexMatch) {
      const h = hexMatch[1];
      const ts1 = parseInt(h.slice(0, 64), 16);
      const ts2 = parseInt(h.slice(64, 128), 16);
      const ts3 = parseInt(h.slice(128, 192), 16);
      if (ts1 > 1e9) result.publicStart = ts1;
      if (ts2 > 1e9) result.publicEnd = ts2;
      if (ts3 > 1e9) result.publicEnd = ts3;
      result.timestamps = { start: ts1, mid: ts2, end: ts3 };
    }
    if (/0xe12d2314|0xc30436e9|sold out/i.test(msg)) result.soldOut = true;
  }

  // price check via getPublicDrop (0x6d5e40d6)
  try {
    const pd = await prov.call({ to: SEADROP, data: '0x6d5e40d6' + nftPad });
    if (pd && pd !== '0x' && pd.length > 2) {
      // decode: price is first uint256 after slot offset
      const priceHex = pd.slice(2 + 24, 2 + 64); // rough extraction
      const priceVal = BigInt('0x' + priceHex);
      if (priceVal > 0n && priceVal < ethers.parseEther('10')) {
        result.priceWei = priceVal.toString();
      }
    }
  } catch { /* no public drop configured yet */ }

  return result;
}


async function gasCalc(chainKey, gasLimit, gweiList, nftCount, pricePerNft) {
  const fee = await wallets.feeData(chainKey);
  const gl = BigInt(gasLimit || 250000);
  const gweis = (gweiList && gweiList.length ? gweiList : [Number(ethers.formatUnits(fee.maxFeePerGas, 'gwei'))]);
  const price = ethers.parseEther(String(pricePerNft || '0'));
  const n = BigInt(nftCount || 1);
  const fx = await fxrate.rates();
  const usd = fx.ethUsd;
  const idrOf = (ethStr) => {
    const { idr } = fxrate.convert(ethStr, fx);
    return idr != null ? Math.round(idr) : null;
  };
  return {
    chain: chainKey, gasLimit: gl.toString(),
    currentGwei: Number(ethers.formatUnits(fee.expectedGwei, 'gwei')).toFixed(4),
    baseGwei: Number(ethers.formatUnits(fee.baseFeePerGas, 'gwei')).toFixed(4),
    currentTipGwei: Number(ethers.formatUnits(fee.maxPriorityFeePerGas, 'gwei')).toFixed(4),
    ethUsd: usd, usdIdr: fx.usdIdr,
    presets: await Promise.all(Object.keys(GAS_PRESETS).map(async (k) => {
      const g = await resolveGas(chainKey, { gasPreset: k });
      const gasWei = gl * g.maxFeePerGas;
      const expGasWei = gl * (fee.baseFeePerGas + g.maxPriorityFeePerGas);
      const totalWei = gasWei + price * n;
      const expTotalWei = expGasWei + price * n;
      return {
        key: k,
        maxFeeGwei: Number(ethers.formatUnits(g.maxFeePerGas, 'gwei')).toFixed(3),
        tipGwei: Number(ethers.formatUnits(g.maxPriorityFeePerGas, 'gwei')).toFixed(3),
        maxGasEth: ethers.formatEther(gasWei),
        maxTotalEth: ethers.formatEther(totalWei),
        maxTotalUsd: usd ? (Number(ethers.formatEther(totalWei)) * usd).toFixed(2) : null,
        maxTotalIdr: idrOf(ethers.formatEther(totalWei)),
        gasEth: ethers.formatEther(expGasWei),
        totalEth: ethers.formatEther(expTotalWei),
        totalUsd: usd ? (Number(ethers.formatEther(expTotalWei)) * usd).toFixed(2) : null,
        totalIdr: idrOf(ethers.formatEther(expTotalWei)),
      };
    })),
    rows: gweis.map((g) => {
      const gasWei = gl * ethers.parseUnits(String(g), 'gwei');
      const mintWei = price * n;
      const totalWei = gasWei + mintWei;
      return {
        gwei: g,
        gasEth: ethers.formatEther(gasWei),
        mintEth: ethers.formatEther(mintWei),
        totalEth: ethers.formatEther(totalWei),
        gasUsd: usd ? (Number(ethers.formatEther(gasWei)) * usd).toFixed(2) : null,
        totalUsd: usd ? (Number(ethers.formatEther(totalWei)) * usd).toFixed(2) : null,
        gasIdr: idrOf(ethers.formatEther(gasWei)),
        totalIdr: idrOf(ethers.formatEther(totalWei)),
      };
    }),
  };
}

module.exports = { start, stop, stopAll, status, list, events, clearFinished, bus, classify, simulateOne, buildCall, flashbotsSend, flashbotsPrivate, resolveGas, gasCalc, seadropProbe, FLASHBOTS_RELAYS, GAS_PRESETS, chainClockOffset, measureBlockMs, probeGateStart, gateCallAtTime, verifyDropStage, assertValueOk, expectedValueWei };
