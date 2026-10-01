'use strict';
/* Solana mint engine — raw instruction / Candy Machine v3 / LaunchMyNFT,
 * priority fees, Jito tip option, parallel wallets. */
const store = require('./store');
const wallets = require('./wallets');

const bus = new (require('events').EventEmitter)();
bus.setMaxListeners(0);
const runs = new Map();

function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function emit(runId, ev) {
  const r = runs.get(runId);
  if (r) { r.events.push({ t: Date.now(), ...ev }); if (r.events.length > 3000) r.events.shift(); }
  bus.emit('event', { runId, t: Date.now(), ...ev });
}

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
];

function conn() { return wallets.solConn().conn; }

/* Build tx from a raw base64/base58 instruction payload, or an SPL transfer-style mint. */
async function buildTx(cfg, kp) {
  const web3 = require('@solana/web3.js');
  const { Transaction, ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } = web3;
  const tx = new Transaction();

  if (cfg.priorityFeeMicroLamports) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Number(cfg.priorityFeeMicroLamports) }));
  }
  if (cfg.computeUnitLimit) {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: Number(cfg.computeUnitLimit) }));
  }

  if (cfg.method === 'raw-ix') {
    // cfg.instructions: [{programId, keys:[{pubkey,isSigner,isWritable}], data: base64}]
    for (const ix of cfg.instructions || []) {
      tx.add(new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: (ix.keys || []).map((k) => ({
          pubkey: new PublicKey(String(k.pubkey).replace(/\{wallet\}/gi, kp.publicKey.toBase58())),
          isSigner: !!k.isSigner, isWritable: !!k.isWritable,
        })),
        data: Buffer.from(ix.data || '', 'base64'),
      }));
    }
  } else if (cfg.method === 'transfer') {
    tx.add(SystemProgram.transfer({
      fromPubkey: kp.publicKey, toPubkey: new PublicKey(cfg.to),
      lamports: Math.round(Number(cfg.amountSol || 0) * 1e9),
    }));
  } else if (cfg.method === 'serialized') {
    // cfg.txBase64 from a site's API (per-wallet), deserialize + sign
    const buf = Buffer.from(cfg.txBase64, 'base64');
    try {
      const vtx = web3.VersionedTransaction.deserialize(buf);
      vtx.sign([kp]);
      return { versioned: vtx };
    } catch {
      const t = Transaction.from(buf);
      t.feePayer = kp.publicKey;
      return { legacy: t };
    }
  } else if (cfg.method === 'lmn-candy-v6') {
    // LaunchMyNFT Candy (mintV6, legacy nft_candy_machine) — SIMULATE-ONLY; relay NOT called.
    const lmn = require('./lmnsol');
    const plan = lmn.planMintV6({
      machine: cfg.machine, name: cfg.name, wallet: kp.publicKey.toBase58(),
      proof: Array.isArray(cfg.proof) ? cfg.proof : undefined,
    });
    tx.add(new TransactionInstruction({
      programId: new PublicKey(plan.programId),
      keys: plan.accounts,
      data: plan.data || Buffer.concat([Buffer.from(plan.discriminator, 'hex'), Buffer.alloc(0)]),
    }));
  } else if (cfg.method === 'lmn-candy-v2') {
    // LaunchMyNFT Candy V2 (mintV2, current MINT_PROGRAM 32-acc, bundle-verified) — SIMULATE-ONLY; relay NOT called.
    const lmn = require('./lmnsol');
    const plan = lmn.planMintV2({
      machine: cfg.machine, name: cfg.name, wallet: kp.publicKey.toBase58(),
      collection: cfg.collection || null,
      phase: {
        name: cfg.phaseName || cfg.name || 'Public',
        price: Number(cfg.valueSol || 0) * 1e9,
        proof: Array.isArray(cfg.proof) ? cfg.proof : undefined,
        qty: Number(cfg.qty || 1),
      },
    });
    tx.add(new TransactionInstruction({
      programId: new PublicKey(plan.programId),
      keys: plan.keys,
      data: plan.data || Buffer.concat([Buffer.from(plan.discriminator, 'hex'), Buffer.alloc(0)]),
    }));
  } else {
    throw new Error(`unsupported SOL method: ${cfg.method}`);
  }

  if (cfg.jitoTipLamports) {
    const tip = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
    tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(tip), lamports: Number(cfg.jitoTipLamports) }));
  }
  return { legacy: tx };
}

async function start(cfg) {
  const runId = nid('srun');
  const list = (cfg.walletIds || []).map((id) => wallets.getWallet('sol', id)).filter(Boolean);
  if (!list.length) throw new Error('no SOL wallets selected');
  // Zyper parity: 'simulate' = poll simulateTransaction until it passes, then send.
  const state = { id: runId, cfg, status: 'starting', started: Date.now(), events: [], results: [], stopped: false, counts: { total: list.length, sent: 0, confirmed: 0, failed: 0 }, mode: 'simulate' };
  runs.set(runId, state);

  (async () => {
    const web3 = require('@solana/web3.js');
    const bs58 = require('bs58'); const b58 = bs58.default || bs58;
    const c = conn();
    try {
      if (cfg.startTimestamp) {
        state.status = 'armed';
        const target = Number(cfg.startTimestamp) * 1000;
        emit(runId, { level: 'info', msg: `armed for ${new Date(target).toISOString()}` });
        while (Date.now() < target - 30 && !state.stopped) await new Promise((r) => setTimeout(r, 200));
      }
      state.status = 'running';
      emit(runId, { level: 'info', msg: `SOL run · ${list.length} wallets · ${cfg.method}` });

      const fire = async (w) => {
        if (state.stopped) return;
        // Zyper 'simulate' mode (SOL): keep simulateTransaction-ing until the
        // tx stops erroring, then land it once. Fresh build each try.
        if (state.mode === 'simulate') {
          const maxTry = Number(cfg.attemptCount || 0);
          const interval = Math.max(300, Number(cfg.delayMs || 1000));
          let tries = 0, ok = false, lastErr = '';
          while (!state.stopped) {
            tries++;
            const kp = web3.Keypair.fromSecretKey(b58.decode(w.pk));
            const built = await buildTx(cfg, kp).catch((e) => ({ buildErr: String(e.message || e) }));
            if (built.buildErr) { lastErr = built.buildErr; }
            else {
              let sim;
              try {
                if (built.versioned) sim = await c.simulateTransaction(built.versioned, { sigVerify: true });
                else {
                  built.legacy.feePayer = kp.publicKey;
                  const { blockhash } = await c.getLatestBlockhash('confirmed');
                  built.legacy.recentBlockhash = blockhash;
                  sim = await c.simulateTransaction(built.legacy, [kp], { sigVerify: true });
                }
              } catch (e) { sim = { value: { err: String(e.message || e) } }; }
              if (sim && sim.value && !sim.value.err) { ok = true; break; }
              lastErr = sim && sim.value && sim.value.err
                ? (typeof sim.value.err === 'object' ? JSON.stringify(sim.value.err).slice(0, 100) : String(sim.value.err))
                : 'simulate error';
            }
            emit(runId, { level: 'info', wallet: w.name, msg: `simulate revert (${tries}): ${String(lastErr).slice(0, 80)}` });
            if (maxTry > 0 && tries >= maxTry) break;
            await new Promise((r) => setTimeout(r, interval));
          }
          if (!ok) {
            if (state.stopped) return;
            state.counts.failed++;
            state.results.push({ ok: false, address: w.address, error: `simulate: ${lastErr}` });
            emit(runId, { level: 'fail', wallet: w.name, msg: `simulate max attempts / never passed: ${String(lastErr).slice(0, 120)}` });
            return;
          }
          emit(runId, { level: 'ok', wallet: w.name, msg: 'simulate PASS — broadcast disabled' });
          state.results.push({ ok: true, simulated: true, address: w.address, attempts: tries });
          state.counts.confirmed++;
          return;
        }
        try {
          const kp = web3.Keypair.fromSecretKey(b58.decode(w.pk));
          const built = await buildTx(cfg, kp);
          if (built.versioned) {
            const sig = await c.sendRawTransaction(built.versioned.serialize(), { skipPreflight: !!cfg.skipPreflight, maxRetries: 3 });
            state.counts.sent++;
            state.results.push({ ok: true, address: w.address, signature: sig });
            emit(runId, { level: 'ok', wallet: w.name, msg: `sent ${sig.slice(0, 16)}…` });
            return;
          }
          const t = built.legacy;
          t.feePayer = kp.publicKey;
          const { blockhash } = await c.getLatestBlockhash('confirmed');
          t.recentBlockhash = blockhash;
          const sig = await web3.sendAndConfirmTransaction(c, t, [kp], { commitment: 'confirmed', skipPreflight: !!cfg.skipPreflight, maxRetries: 3 });
          state.counts.sent++; state.counts.confirmed++;
          state.results.push({ ok: true, address: w.address, signature: sig });
          emit(runId, { level: 'ok', wallet: w.name, msg: `confirmed ${sig.slice(0, 16)}…` });
        } catch (e) {
          state.counts.failed++;
          const msg = String(e.message || e).slice(0, 160);
          state.results.push({ ok: false, address: w.address, error: msg });
          emit(runId, { level: 'fail', wallet: w.name, msg });
        }
      };

      if (state.mode === 'spam') await Promise.all(list.map(fire));
      else for (const w of list) { if (state.stopped) break; await fire(w); if (cfg.delayMs) await new Promise((r) => setTimeout(r, Number(cfg.delayMs))); }

      state.status = 'done';
      emit(runId, { level: 'info', msg: `done · sent ${state.counts.sent} ok ${state.counts.confirmed} fail ${state.counts.failed}` });
      store.appendLog('mint-runs.log', `${runId} SOL ${cfg.method} sent=${state.counts.sent} ok=${state.counts.confirmed}`);
      require('./notify').notify('SOL mint done', [['run', runId], ['method', cfg.method], ['sent', state.counts.sent], ['failed', state.counts.failed]]);
    } catch (e) {
      state.status = 'error';
      emit(runId, { level: 'error', msg: String(e.message).slice(0, 240) });
    }
  })();

  return { runId };
}

function stop(id) { const r = runs.get(id); if (!r) return false; r.stopped = true; r.status = 'stopped'; emit(id, { level: 'warn', msg: 'STOPPED' }); return true; }
function stopAll() { let n = 0; for (const [id, r] of runs) if (!['done', 'error', 'stopped'].includes(r.status)) { r.stopped = true; r.status = 'stopped'; n++; } return n; }
function status(id) { const r = runs.get(id); return r ? { id, status: r.status, counts: r.counts, mode: r.mode, results: r.results.slice(-300) } : null; }
function list() { return [...runs.values()].map((r) => ({ id: r.id, status: r.status, counts: r.counts, method: r.cfg.method, started: r.started })); }
function events(id, since) { const r = runs.get(id); return r ? r.events.filter((e) => !since || e.t > since) : []; }

module.exports = { start, stop, stopAll, status, list, events, bus, buildTx, JITO_TIP_ACCOUNTS };
