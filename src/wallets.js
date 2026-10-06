'use strict';
/* Wallet manager — EVM / Solana / Bitcoin. Groups, generate, import, balances,
 * single send, disperse/consolidate, EIP-7702 delegation check. */
const { ethers } = require('ethers');
const store = require('./store');
const chains = require('./chains');
const rpc = require('./rpc');

const KIND = { evm: 'wallets_evm', sol: 'wallets_sol', btc: 'wallets_btc' };

function load(kind) { return store.readSealed(KIND[kind], { groups: [] }); }
function save(kind, d) { return store.writeSealed(KIND[kind], d); }

function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/* ---------------- groups ---------------- */

function addGroup(kind, name) {
  const d = load(kind);
  const g = { id: nid('wg'), name, wallets: [] };
  d.groups.push(g); save(kind, d); return g;
}

function renameGroup(kind, id, name) {
  const d = load(kind);
  const g = d.groups.find((x) => x.id === id);
  if (!g) throw new Error('group not found');
  g.name = name; save(kind, d); return g;
}

function removeGroup(kind, id) {
  const d = load(kind);
  d.groups = d.groups.filter((g) => g.id !== id);
  save(kind, d); return true;
}

function groups(kind) {
  const d = load(kind);
  return d.groups.map((g) => ({ id: g.id, name: g.name, count: g.wallets.length }));
}

/* Wallets without private keys — safe for UI. */
function listSafe(kind, groupIds) {
  const d = load(kind);
  const sel = groupIds && groupIds.length ? d.groups.filter((g) => groupIds.includes(g.id)) : d.groups;
  return sel.flatMap((g) => g.wallets.map((w) => ({
    id: w.id, name: w.name, address: w.address, group: g.id, groupId: g.id, groupName: g.name,
  })));
}

function getWallet(kind, id) {
  const d = load(kind);
  for (const g of d.groups) {
    const w = g.wallets.find((x) => x.id === id);
    if (w) return { ...w, group: g.id, groupName: g.name };
  }
  return null;
}

/* ---------------- key handling ---------------- */

function evmFromKey(pk) {
  const k = pk.trim();
  const hex = k.startsWith('0x') ? k : '0x' + k;
  const w = new ethers.Wallet(hex);
  return { address: w.address, pk: hex };
}

function solFromKey(secret) {
  const { Keypair } = require('@solana/web3.js');
  const bs58 = require('bs58');
  const b58 = bs58.default || bs58;
  const s = secret.trim();
  let bytes;
  if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = b58.decode(s);
  const kp = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes.slice(0, 32));
  return { address: kp.publicKey.toBase58(), pk: b58.encode(Buffer.from(kp.secretKey)) };
}

function btcFromKey(wifOrHex) {
  const btc = require('@scure/btc-signer');
  const { hex, base58 } = require('@scure/base');
  const s = wifOrHex.trim();
  let priv;
  if (/^[0-9a-fA-F]{64}$/.test(s)) priv = hex.decode(s);
  else {
    const dec = base58.decode(s);
    priv = dec.slice(1, 33); // strip version byte + checksum/compress flag
  }
  const pub = btc.utils.pubSchnorr(priv);
  const p2tr = btc.p2tr(pub);
  return { address: p2tr.address, pk: hex.encode(priv) };
}

function derive(kind, key) {
  if (kind === 'evm') return evmFromKey(key);
  if (kind === 'sol') return solFromKey(key);
  if (kind === 'btc') return btcFromKey(key);
  throw new Error('bad kind');
}

/* ---------------- generate / import ---------------- */

function generate(kind, groupId, count, prefix) {
  const d = load(kind);
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const made = [];
  for (let i = 0; i < count; i++) {
    let address, pk;
    if (kind === 'evm') { const w = ethers.Wallet.createRandom(); address = w.address; pk = w.privateKey; }
    else if (kind === 'sol') {
      const { Keypair } = require('@solana/web3.js');
      const bs58 = require('bs58'); const b58 = bs58.default || bs58;
      const kp = Keypair.generate(); address = kp.publicKey.toBase58(); pk = b58.encode(Buffer.from(kp.secretKey));
    } else {
      const crypto = require('crypto');
      const r = btcFromKey(crypto.randomBytes(32).toString('hex'));
      address = r.address; pk = r.pk;
    }
    const w = { id: nid('w'), name: `${prefix || 'gen'}${g.wallets.length + i + 1}`, address, pk, created: Date.now() };
    g.wallets.push(w); made.push({ id: w.id, name: w.name, address, pk });
  }
  save(kind, d);
  return made;
}

/* Import: lines of `pk` or `name,pk` or `name,address,pk` (CSV) */
function importKeys(kind, groupId, text) {
  const d = load(kind);
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const out = { added: 0, skipped: 0, errors: [] };
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    let name = null, key = null;
    if (parts.length === 1) key = parts[0];
    else if (parts.length === 2) { name = parts[0]; key = parts[1]; }
    else { name = parts[0]; key = parts[parts.length - 1]; }
    if (/^(name|nama)$/i.test(name || '')) { out.skipped++; continue; }
    try {
      const { address, pk } = derive(kind, key);
      if (g.wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) { out.skipped++; continue; }
      g.wallets.push({ id: nid('w'), name: name || `w${g.wallets.length + 1}`, address, pk, created: Date.now() });
      out.added++;
    } catch (e) { out.errors.push(`${line.slice(0, 14)}…: ${e.message}`); }
  }
  save(kind, d);
  return out;
}

function renameWallet(kind, id, name) {
  const d = load(kind);
  for (const g of d.groups) {
    const w = g.wallets.find((x) => x.id === id);
    if (w) { w.name = name; save(kind, d); return w; }
  }
  throw new Error('wallet not found');
}

function bulkRename(kind, ids, pattern) {
  const d = load(kind);
  const order = Array.isArray(ids) ? ids : [];
  let updated = 0;
  for (const g of d.groups) {
    for (const w of g.wallets) {
      if (!order.includes(w.id)) continue;
      // {i} = 1-based index in the selection, {n} = the wallet's previous name
      const i = order.indexOf(w.id) + 1;
      w.name = String(pattern).replace(/\{i\}/g, String(i)).replace(/\{n\}/g, w.name);
      updated++;
    }
  }
  save(kind, d);
  return updated;
}

function removeWallet(kind, id) {
  const d = load(kind);
  for (const g of d.groups) {
    const i = g.wallets.findIndex((x) => x.id === id);
    if (i >= 0) { g.wallets.splice(i, 1); save(kind, d); return true; }
  }
  return false;
}

function exportKeys(kind, ids) {
  const d = load(kind);
  const out = [];
  for (const g of d.groups) for (const w of g.wallets) {
    if (!ids || ids.includes(w.id)) out.push(`${w.name},${w.address},${w.pk}`);
  }
  return out.join('\n');
}

/* ---------------- EVM balances ---------------- */

const ERC20 = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function withdraw(uint256)',
]);

async function balances(chainKey, addresses, erc20) {
  const c = chains.chain(chainKey);
  const urls = rpc.readUrls(chainKey);
  const out = {};
  const CONC = 12;
  for (let i = 0; i < addresses.length; i += CONC) {
    const batch = addresses.slice(i, i + CONC);
    await Promise.all(batch.map(async (addr, j) => {
      const url = urls[(i + j) % urls.length];
      const p = rpc.provider(url, c.id);
      try {
        const native = await p.getBalance(addr);
        const row = { native: ethers.formatEther(native), nativeWei: native.toString() };
        if (erc20) {
          try {
            const raw = await p.call({ to: erc20, data: ERC20.encodeFunctionData('balanceOf', [addr]) });
            const dec = await p.call({ to: erc20, data: ERC20.encodeFunctionData('decimals', []) });
            const d = Number(ERC20.decodeFunctionResult('decimals', dec)[0]);
            row.token = ethers.formatUnits(ERC20.decodeFunctionResult('balanceOf', raw)[0], d);
            row.tokenWei = ERC20.decodeFunctionResult('balanceOf', raw)[0].toString();
          } catch { row.token = '-'; }
        }
        out[addr] = row;
      } catch (e) {
        out[addr] = { native: '-', error: String(e.message || e).slice(0, 60) };
      }
    }));
  }
  return out;
}

/* ---------------- gas helpers ---------------- */

async function feeData(chainKey, opts = {}) {
  const settings = store.readSettings();
  const mult = Number(opts.tipMultiplier || settings.autoTipMultiplier || 1.25);
  const fd = await rpc.readRace(chainKey, (p) => p.getFeeData());
  let maxPriority = fd.maxPriorityFeePerGas ?? ethers.parseUnits('0.01', 'gwei');
  let maxFee = fd.maxFeePerGas ?? (fd.gasPrice ?? ethers.parseUnits('1', 'gwei'));
  maxPriority = (maxPriority * BigInt(Math.round(mult * 1000))) / 1000n;
  if (maxPriority <= 0n) maxPriority = ethers.parseUnits('0.01', 'gwei');
  const base = fd.gasPrice ?? maxFee;
  const doubled = base * 2n + ethers.parseUnits('0.01', 'gwei');
  if (maxFee < doubled) maxFee = doubled;
  if (maxFee < maxPriority) maxFee = maxPriority;
  // baseFeePerGas = what the chain charges per gas unit (Etherscan "base").
  // expectedGwei = base + (multiplied) tip = what a tx actually pays per gas.
  const rawTip = fd.maxPriorityFeePerGas ?? 0n;
  let baseFee;
  if (fd.gasPrice && fd.gasPrice > rawTip) baseFee = fd.gasPrice - rawTip;
  else if (fd.maxFeePerGas && fd.maxFeePerGas > rawTip) baseFee = (fd.maxFeePerGas - rawTip) / 2n;
  else baseFee = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const expectedGwei = baseFee + maxPriority;
  return { maxFeePerGas: maxFee, maxPriorityFeePerGas: maxPriority, gasPrice: fd.gasPrice ?? null, baseFeePerGas: baseFee, expectedGwei };
}

/* ---------------- EVM single send ---------------- */

async function sendNative(chainKey, walletId, to, amountEth, opts = {}) {
  const c = chains.chain(chainKey);
  const w = getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const urls = opts.rpcs && opts.rpcs.length ? opts.rpcs : rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);
  const fee = await feeData(chainKey, opts);
  const nonce = opts.nonce ?? await p.getTransactionCount(w.address, 'pending');
  let gasLimit = opts.gasLimit ? BigInt(opts.gasLimit) : 21000n;
  let value;
  if (opts.max) {
    const bal = await p.getBalance(w.address);
    const cost = gasLimit * fee.maxFeePerGas;
    value = bal - cost;
    if (value <= 0n) throw new Error('balance below gas cost');
    if (!opts.gasLimit) {
      // destination may be a contract / EIP-7702 delegated EOA (intrinsic gas > 21000)
      try {
        const est = await p.estimateGas({ from: w.address, to, value });
        if (est > gasLimit) { gasLimit = est; value = bal - gasLimit * fee.maxFeePerGas; }
      } catch { /* keep 21000 */ }
      if (value <= 0n) throw new Error('balance below gas cost');
    }
  } else {
    value = ethers.parseEther(String(amountEth));
    if (!opts.gasLimit) {
      try { const est = await p.estimateGas({ from: w.address, to, value }); if (est > gasLimit) gasLimit = est; }
      catch { /* keep 21000 */ }
    }
  }
  const tx = {
    chainId: c.id, to, value, nonce, gasLimit,
    maxFeePerGas: opts.maxFeePerGas ? ethers.parseUnits(String(opts.maxFeePerGas), 'gwei') : fee.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas ? ethers.parseUnits(String(opts.maxPriorityFeePerGas), 'gwei') : fee.maxPriorityFeePerGas,
    type: 2,
  };
  const raw = await signer.signTransaction(tx);
  const res = await rpc.broadcast(chainKey, raw, urls);
  store.appendLog('funds-sessions.log', `send native ${c.key} ${w.address} -> ${to} ${ethers.formatEther(value)} ${res.hash}`);
  return { hash: res.hash, rpc: res.rpc, from: w.address, value: ethers.formatEther(value) };
}

async function sendToken(chainKey, walletId, token, to, amount, opts = {}) {
  const c = chains.chain(chainKey);
  const w = getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);
  const decRaw = await p.call({ to: token, data: ERC20.encodeFunctionData('decimals', []) });
  const dec = Number(ERC20.decodeFunctionResult('decimals', decRaw)[0]);
  const val = ethers.parseUnits(String(amount), dec);
  const data = ERC20.encodeFunctionData('transfer', [to, val]);
  const fee = await feeData(chainKey, opts);
  const nonce = opts.nonce ?? await p.getTransactionCount(w.address, 'pending');
  let gasLimit = opts.gasLimit ? BigInt(opts.gasLimit) : null;
  if (!gasLimit) {
    try { gasLimit = (await p.estimateGas({ from: w.address, to: token, data })) * 12n / 10n; }
    catch { gasLimit = 90000n; }
  }
  const raw = await signer.signTransaction({
    chainId: c.id, to: token, data, nonce, gasLimit,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });
  const res = await rpc.broadcast(chainKey, raw, urls);
  store.appendLog('funds-sessions.log', `send token ${c.key} ${token} ${w.address} -> ${to} ${amount} ${res.hash}`);
  return { hash: res.hash, from: w.address };
}

/* Unwrap WETH -> ETH */
async function unwrapWeth(chainKey, walletId, amount) {
  const c = chains.chain(chainKey);
  if (!c.weth) throw new Error('no WETH on this chain');
  const w = getWallet('evm', walletId);
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);
  let val;
  if (amount === 'max' || amount == null) {
    const raw = await p.call({ to: c.weth, data: ERC20.encodeFunctionData('balanceOf', [w.address]) });
    val = ERC20.decodeFunctionResult('balanceOf', raw)[0];
  } else val = ethers.parseEther(String(amount));
  if (val <= 0n) throw new Error('no WETH balance');
  const data = ERC20.encodeFunctionData('withdraw', [val]);
  const fee = await feeData(chainKey);
  const nonce = await p.getTransactionCount(w.address, 'pending');
  const rawTx = await signer.signTransaction({
    chainId: c.id, to: c.weth, data, nonce, gasLimit: 80000n,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });
  const res = await rpc.broadcast(chainKey, rawTx, urls);
  return { hash: res.hash, amount: ethers.formatEther(val) };
}

/* ---------------- disperse / consolidate (Zyper-parity) ---------------- */

const DISPERSE_ABI = new ethers.Interface([
  'function disperseEther(address[] recipients, uint256[] values) payable',
  'function disperseToken(address token, address[] recipients, uint256[] values)',
]);
const ERC20_ABI = new ethers.Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

async function tokenMeta(p, addr) {
  const sym = await p.call({ to: addr, data: ERC20_ABI.encodeFunctionData('symbol') }).catch(() => null);
  const dec = await p.call({ to: addr, data: ERC20_ABI.encodeFunctionData('decimals') }).catch(() => null);
  let symbol = 'TOKEN', decimals = 18;
  if (sym) { try { symbol = ERC20_ABI.decodeFunctionResult('symbol', sym)[0]; } catch {} }
  if (dec) { try { decimals = Number(ERC20_ABI.decodeFunctionResult('decimals', dec)[0]); } catch {} }
  return { symbol, decimals };
}

/* Zyper amountMode: fixed | random | max ; strategy: amount | target */
async function disperse(chainKey, sourceWalletId, targets, opts = {}) {
  const c = chains.chain(chainKey);
  const w = getWallet('evm', sourceWalletId);
  if (!w) throw new Error('source wallet not found');
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);
  const fee = await feeData(chainKey, opts);
  const gasOverride = {
    maxFeePerGas: opts.maxFeePerGas ? ethers.parseUnits(String(opts.maxFeePerGas), 'gwei') : fee.maxFeePerGas,
    maxPriorityFeePerGas: opts.maxPriorityFeePerGas ? ethers.parseUnits(String(opts.maxPriorityFeePerGas), 'gwei') : fee.maxPriorityFeePerGas,
  };
  const amountMode = opts.amountMode || 'fixed';
  const strategy = opts.strategy || 'amount';
  const tokenAddr = opts.token ? addr(String(opts.token), 'token') : null;

  const srcLow = String(w.address).toLowerCase();
  for (const t of targets) {
    if (String(t.address).toLowerCase() === srcLow) throw new Error('destination address cannot also be a source');
  }

  let meta = null;
  if (tokenAddr) meta = await tokenMeta(p, tokenAddr);
  const decimals = meta ? meta.decimals : 18;
  const fmt = (wei) => ethers.formatUnits(wei, decimals);

  /* ---- build plan (wei per recipient) ---- */
  let plan;
  const bal = tokenAddr
    ? await p.call({ to: tokenAddr, data: ERC20_ABI.encodeFunctionData('balanceOf', [w.address]) }).then((r) => ERC20_ABI.decodeFunctionResult('balanceOf', r)[0])
    : await p.getBalance(w.address);

  if (strategy === 'target') {
    const tb = Number(opts.targetBalance);
    if (!Number.isFinite(tb) || tb < 0) throw new Error('target balance must be >= 0');
    const bals = await balances(chainKey, targets.map((t) => t.address), tokenAddr || undefined);
    plan = targets.map((t) => {
      const haveRaw = bals[t.address] && (tokenAddr ? bals[t.address].tokenWei : bals[t.address].nativeWei);
      const have = haveRaw != null ? BigInt(haveRaw) : 0n;
      const want = ethers.parseUnits(String(tb), decimals);
      const need = want > have ? want - have : 0n;
      return { address: t.address, wei: need };
    }).filter((t) => t.wei > 0n);
  } else if (amountMode === 'random') {
    const min = Number(opts.randomMin), max = Number(opts.randomMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max <= 0 || min > max) throw new Error(`random range: min ${min} max ${max}`);
    const minW = ethers.parseUnits(String(min), decimals), maxW = ethers.parseUnits(String(max), decimals);
    plan = targets.map((t) => {
      const span = maxW - minW;
      const draw = minW + (span > 0n ? BigInt(Math.floor(Math.random() * Number(span))) : 0n);
      return { address: t.address, wei: draw };
    }).filter((t) => t.wei > 0n);
  } else if (amountMode === 'max') {
    if (!targets.length) throw new Error('disperse max requires recipients');
    let total;
    if (tokenAddr) {
      total = bal;
    } else {
      const probe = await p.estimateGas({ from: w.address, to: c.disperse || w.address, data: '0x', value: 0n }).catch(() => 21000n);
      const reserve = probe * gasOverride.maxFeePerGas * 13n / 10n;
      total = bal > reserve ? bal - reserve : 0n;
    }
    if (total <= 0n) throw new Error('disperse max balance must be positive');
    plan = targets.map((t) => ({ address: t.address, wei: total / BigInt(targets.length) })).filter((t) => t.wei > 0n);
  } else {
    plan = targets.map((t) => {
      const amt = Number(t.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be > 0');
      return { address: t.address, wei: ethers.parseUnits(String(amt), decimals) };
    }).filter((t) => t.wei > 0n);
  }
  if (!plan.length) return { mode: 'noop', sent: [] };
  for (const t of plan) {
    if (String(t.address).toLowerCase() === srcLow) throw new Error('destination address cannot also be a source');
  }

  const total = plan.reduce((a, b) => a + b.wei, 0n);
  if (tokenAddr && total > bal) throw new Error(`insufficient token balance: need ${fmt(total)} ${meta.symbol}, have ${fmt(bal)}`);
  const useContract = opts.useContract !== false && !opts.forceSingle && !!c.disperse;

  if (useContract) {
    try {
      let data;
      if (tokenAddr) data = DISPERSE_ABI.encodeFunctionData('disperseToken', [tokenAddr, plan.map((x) => x.address), plan.map((x) => x.wei)]);
      else data = DISPERSE_ABI.encodeFunctionData('disperseEther', [plan.map((x) => x.address), plan.map((x) => x.wei)]);
      let gasLimit;
      try { gasLimit = (await p.estimateGas({ from: w.address, to: c.disperse, data, value: tokenAddr ? 0n : total })) * 12n / 10n; }
      catch (e) {
        if (opts.confirmFallback !== true) {
          return { mode: 'needs-confirm-fallback', reason: String(e.shortMessage || e.message).slice(0, 140), plan: plan.map((x) => ({ address: x.address, amount: fmt(x.wei) })) };
        }
        gasLimit = null;
      }
      if (gasLimit) {
        if (!tokenAddr && bal < total + gasLimit * gasOverride.maxFeePerGas) throw new Error('insufficient balance for disperse + gas');
        let nonce = await p.getTransactionCount(w.address, 'pending');
        /* ERC20: ensure allowance for the disperse contract first (Zyper same) */
        if (tokenAddr) {
          const allow = await p.call({ to: tokenAddr, data: ERC20_ABI.encodeFunctionData('allowance', [w.address, c.disperse]) }).then((r) => ERC20_ABI.decodeFunctionResult('allowance', r)[0]);
          if (allow < total) {
            const appData = ERC20_ABI.encodeFunctionData('approve', [c.disperse, ethers.MaxUint256]);
            const appGas = (await p.estimateGas({ from: w.address, to: tokenAddr, data: appData })) * 12n / 10n;
            const appRaw = await signer.signTransaction({ chainId: c.id, to: tokenAddr, data: appData, nonce: nonce++, gasLimit: appGas, ...gasOverride, type: 2 });
            const appRes = await rpc.broadcast(chainKey, appRaw, urls);
            store.appendLog('funds-sessions.log', `DISPERSE_APPROVE source=${w.address} chain=${c.key} token=${tokenAddr} contract=${c.disperse} hash=${appRes.hash}`);
            /* wait for approve receipt before disperseToken */
            await p.waitForTransaction(appRes.hash, 1, 60000).catch(() => null);
          }
        }
        store.appendLog('funds-sessions.log', `DISPERSE_PREPARE source=${w.address} chain=${c.key} contract=${c.disperse} token=${tokenAddr || 'native'} amountMode=${amountMode} strategy=${strategy} targets=${JSON.stringify(plan.map((x) => ({ address: x.address, amount: fmt(x.wei) })))} total=${fmt(total)} gasLimit=${gasLimit} maxFee=${ethers.formatUnits(gasOverride.maxFeePerGas, 'gwei')}`);
        const raw = await signer.signTransaction({ chainId: c.id, to: c.disperse, data, value: tokenAddr ? 0n : total, nonce, gasLimit, ...gasOverride, type: 2 });
        const res = await rpc.broadcast(chainKey, raw, urls);
        store.appendLog('funds-sessions.log', `DISPERSE_BROADCAST source=${w.address} chain=${c.key} token=${tokenAddr || 'native'} targets=${plan.length} total=${fmt(total)} hash=${res.hash} usedDisperse=1`);
        require('./notify').notify('Disperse', [['chain', c.name], ['from', w.name], ['to', plan.length + ' wallet(s)'], ['total', fmt(total) + (meta ? ' ' + meta.symbol : ' ETH')], ['tx', res.hash.slice(0, 18) + '…']]);
        /* Zyper parity: decode the broadcast tx and verify recipients/values */
        let verified = null;
        try {
          const tx = await p.getTransaction(res.hash);
          if (tx && tx.data && tx.data.length > 10) {
            const decoded = DISPERSE_ABI.parseTransaction({ data: tx.data });
            if (decoded && Array.isArray(decoded.args.recipients)) {
              const rec = decoded.args.recipients.map((a) => a.toLowerCase());
              const vals = decoded.args.values.map((v) => v.toString());
              const match = plan.length === rec.length && plan.every((x, i) => x.address.toLowerCase() === rec[i] && x.wei.toString() === vals[i]);
              verified = match ? 'match' : 'mismatch';
              store.appendLog('funds-sessions.log', `DISPERSE_VERIFY hash=${res.hash} ${match ? 'match' : 'MISMATCH'} recipients=${rec.length} total=${vals.reduce((a, b) => (BigInt(a) + BigInt(b)).toString(), '0')}`);
            }
          }
        } catch (e) { store.appendLog('funds-sessions.log', `DISPERSE_VERIFY hash=${res.hash} error=${String(e.message).slice(0, 80)}`); }
        return { mode: 'contract', hash: res.hash, count: plan.length, total: fmt(total), token: tokenAddr || null, verified };
      }
    } catch (e) {
      if (opts.confirmFallback === true) { /* fall through to individual sends */ }
      else throw e;
    }
  }

  /* fallback / direct: individual sends (native value or ERC20 transfer) */
  let nonce = await p.getTransactionCount(w.address, 'pending');
  const sent = [];
  for (const t of plan) {
    try {
      let gasLimit = 21000n;
      let tx;
      if (tokenAddr) {
        const d = ERC20_ABI.encodeFunctionData('transfer', [t.address, t.wei]);
        try { const est = await p.estimateGas({ from: w.address, to: tokenAddr, data: d }); if (est > gasLimit) gasLimit = est; } catch { /* keep */ }
        tx = { chainId: c.id, to: tokenAddr, data: d, value: 0n, nonce: nonce++, gasLimit, ...gasOverride, type: 2 };
      } else {
        try { const est = await p.estimateGas({ from: w.address, to: t.address, value: t.wei }); if (est > gasLimit) gasLimit = est; } catch { /* keep */ }
        tx = { chainId: c.id, to: t.address, value: t.wei, nonce: nonce++, gasLimit, ...gasOverride, type: 2 };
      }
      const raw = await signer.signTransaction(tx);
      const res = await rpc.broadcast(chainKey, raw, urls);
      sent.push({ to: t.address, amount: fmt(t.wei), token: tokenAddr || null, hash: res.hash });
    } catch (e) {
      sent.push({ to: t.address, amount: fmt(t.wei), token: tokenAddr || null, error: String(e.shortMessage || e.message).slice(0, 120) });
    }
  }
  store.appendLog('funds-sessions.log', `disperse single ${c.key} ${sent.length} sends token=${tokenAddr || 'native'} usedDisperse=0`);
  return { mode: 'single', sent };
}

async function consolidate(chainKey, walletIds, destination, opts = {}) {
  const c = chains.chain(chainKey);
  const urls = rpc.urlsFor(chainKey);
  const fee = await feeData(chainKey, opts);
  const maxFeePerGas = opts.maxFeePerGas ? ethers.parseUnits(String(opts.maxFeePerGas), 'gwei') : fee.maxFeePerGas;
  const maxPriorityFeePerGas = opts.maxPriorityFeePerGas ? ethers.parseUnits(String(opts.maxPriorityFeePerGas), 'gwei') : fee.maxPriorityFeePerGas;
  const leave = opts.leave ? ethers.parseEther(String(opts.leave)) : 0n;
  const tokenAddr = opts.token ? addr(String(opts.token), 'token') : null;
  let decimals = 18, fmt;
  if (tokenAddr) {
    const p0 = rpc.provider(urls[0], c.id);
    const meta = await tokenMeta(p0, tokenAddr);
    decimals = meta.decimals;
  }
  fmt = (wei) => ethers.formatUnits(wei, decimals);
  const out = [];
  const CONC = 8;
  for (let i = 0; i < walletIds.length; i += CONC) {
    await Promise.all(walletIds.slice(i, i + CONC).map(async (id, j) => {
      const w = getWallet('evm', id);
      if (!w) { out.push({ id, error: 'not found' }); return; }
      const p = rpc.provider(urls[(i + j) % urls.length], c.id);
      try {
        const signer = new ethers.Wallet(w.pk);
        const nonce = await p.getTransactionCount(w.address, 'pending');
        if (tokenAddr) {
          const bal = await p.call({ to: tokenAddr, data: ERC20_ABI.encodeFunctionData('balanceOf', [w.address]) }).then((r) => ERC20_ABI.decodeFunctionResult('balanceOf', r)[0]);
          if (bal <= 0n) { out.push({ address: w.address, skipped: 'no tokens' }); return; }
          const d = ERC20_ABI.encodeFunctionData('transfer', [destination, bal]);
          let gasLimit = 21000n;
          try { const est = await p.estimateGas({ from: w.address, to: tokenAddr, data: d }); if (est > gasLimit) gasLimit = est; } catch { /* keep */ }
          const raw = await signer.signTransaction({ chainId: c.id, to: tokenAddr, data: d, value: 0n, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 2 });
          const res = await rpc.broadcast(chainKey, raw, urls);
          out.push({ address: w.address, amount: fmt(bal), token: tokenAddr, hash: res.hash });
        } else {
          const bal = await p.getBalance(w.address);
          let gasLimit = 21000n;
          try { const est = await p.estimateGas({ from: w.address, to: destination, value: 0n }); if (est > gasLimit) gasLimit = est; }
          catch { /* keep */ }
          const gasCost = gasLimit * maxFeePerGas;
          const value = bal - gasCost - leave;
          if (value <= 0n) { out.push({ address: w.address, skipped: 'dust' }); return; }
          const raw = await signer.signTransaction({ chainId: c.id, to: destination, value, nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, type: 2 });
          const res = await rpc.broadcast(chainKey, raw, urls);
          out.push({ address: w.address, amount: ethers.formatEther(value), hash: res.hash });
        }
      } catch (e) {
        out.push({ address: w.address, error: String(e.shortMessage || e.message).slice(0, 120) });
      }
    }));
  }
  store.appendLog('funds-sessions.log', `consolidate ${c.key} ${out.length} wallets -> ${destination} token=${tokenAddr || 'native'}`);
  require('./notify').notify('Consolidate', [['chain', c.name], ['to', destination], ['wallets', out.filter((x) => x.hash).length]])
  return out;
}

/* ---------------- EIP-7702 delegation ---------------- */

async function checkDelegation(chainKey, addresses) {
  const c = chains.chain(chainKey);
  const urls = rpc.urlsFor(chainKey);
  const out = {};
  await Promise.all(addresses.map(async (a, i) => {
    try {
      const code = await rpc.provider(urls[i % urls.length], c.id).getCode(a);
      // EIP-7702 delegation designator: 0xef0100 || address (23 bytes)
      if (code && code.toLowerCase().startsWith('0xef0100')) {
        out[a] = { delegated: true, target: '0x' + code.slice(8, 48) };
      } else out[a] = { delegated: false, code: code === '0x' ? null : code.slice(0, 12) + '…' };
    } catch (e) { out[a] = { error: String(e.message).slice(0, 60) }; }
  }));
  return out;
}

/* Revoke = set delegation target to zero address via type-4 tx. */
async function revokeDelegation(chainKey, walletId) {
  const c = chains.chain(chainKey);
  const w = getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);
  const nonce = await p.getTransactionCount(w.address, 'pending');
  const fee = await feeData(chainKey);
  const auth = await signer.authorize({ address: ethers.ZeroAddress, nonce: nonce + 1, chainId: c.id });
  const tx = await signer.sendTransaction({
    type: 4, to: w.address, value: 0, nonce, gasLimit: 100000n,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    authorizationList: [auth],
  });
  return { hash: tx.hash };
}

/* ---------------- Solana ---------------- */

function solConn() {
  const settings = store.readSettings();
  const urls = [];
  try {
    const d = rpc.load();
    d.groups.filter((g) => g.chain === 'solana').forEach((g) => g.rpcs.forEach((r) => { if (r.healthy) urls.push(r.url); }));
  } catch { /* locked */ }
  if (settings.heliusKey) urls.push(`https://mainnet.helius-rpc.com/?api-key=${settings.heliusKey}`);
  urls.push('https://api.mainnet-beta.solana.com');
  const { Connection } = require('@solana/web3.js');
  return { conn: new Connection(urls[0], 'confirmed'), urls };
}

async function solBalances(addresses) {
  const { PublicKey } = require('@solana/web3.js');
  const { conn } = solConn();
  const out = {};
  const CONC = 10;
  for (let i = 0; i < addresses.length; i += CONC) {
    await Promise.all(addresses.slice(i, i + CONC).map(async (a) => {
      try {
        const lam = await conn.getBalance(new PublicKey(a));
        out[a] = { native: (lam / 1e9).toFixed(9), lamports: lam };
      } catch (e) { out[a] = { native: '-', error: String(e.message).slice(0, 60) }; }
    }));
  }
  return out;
}

async function solSend(walletId, to, amountSol, opts = {}) {
  const { Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
  const bs58 = require('bs58'); const b58 = bs58.default || bs58;
  const w = getWallet('sol', walletId);
  if (!w) throw new Error('wallet not found');
  const { conn } = solConn();
  const kp = Keypair.fromSecretKey(b58.decode(w.pk));
  let lamports;
  if (opts.max) {
    const bal = await conn.getBalance(kp.publicKey);
    lamports = bal - 5000;
    if (lamports <= 0) throw new Error('balance below fee');
  } else lamports = Math.round(Number(amountSol) * 1e9);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(to), lamports }));
  const sig = await sendAndConfirmTransaction(conn, tx, [kp], { commitment: 'confirmed' });
  store.appendLog('funds-sessions.log', `SOL send ${w.address} -> ${to} ${lamports / 1e9} ${sig}`);
  return { signature: sig, amount: lamports / 1e9 };
}

async function solConsolidate(walletIds, destination, opts = {}) {
  const out = [];
  for (const id of walletIds) {
    try { out.push({ ...(await solSend(id, destination, null, { max: true })), id }); }
    catch (e) { out.push({ id, error: String(e.message).slice(0, 120) }); }
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
  }
  return out;
}

async function solDisperse(sourceId, targets, opts = {}) {
  const out = [];
  for (const t of targets) {
    let amt = t.amount;
    if (opts.randomMin != null) amt = (Number(opts.randomMin) + Math.random() * (Number(opts.randomMax) - Number(opts.randomMin))).toFixed(6);
    try { out.push({ to: t.address, ...(await solSend(sourceId, t.address, amt)) }); }
    catch (e) { out.push({ to: t.address, error: String(e.message).slice(0, 120) }); }
  }
  return out;
}

/* ---------------- Bitcoin (balance only + fee params) ---------------- */

async function btcBalances(addresses) {
  const { fetch } = require('undici');
  const out = {};
  for (const a of addresses) {
    try {
      const r = await fetch(`https://mempool.space/api/address/${a}`, { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      const sats = (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum);
      out[a] = { native: (sats / 1e8).toFixed(8), sats };
    } catch (e) { out[a] = { native: '-', error: String(e.message).slice(0, 60) }; }
  }
  return out;
}

/* Batch EIP-7702 delegation scan across a wallet group. Read-only inventory:
   which wallets carry code, and for designated-delegation code (0xef0100 +
   20-byte target) who the target is. Concurrency 4 — sufficient for 100+
   wallets without hammering the RPC. */
async function scanDelegation(chainKey, groupIds) {
  const c = chains.chain(chainKey);
  const list = listSafe('evm', groupIds);
  const out = [];
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (w) => {
      try {
        const code = await rpc.readAny(chainKey, (p) => p.getCode(w.address), rpc.urlsFor(chainKey));
        const hex = String(code || '').toLowerCase();
        let kind = 'eoa', target = null;
        if (hex.startsWith('0xef0100') && hex.length >= 46) {
          kind = 'delegated'; target = '0x' + hex.slice(10, 50);
        } else if (hex.length > 2) kind = 'contract';
        out.push({ id: w.id, address: w.address, name: w.name, kind, target });
      } catch (e) {
        out.push({ id: w.id, address: w.address, name: w.name, kind: 'error', error: String(e.message || e).slice(0, 100) });
      }
    }));
  }
  return out;
}

module.exports = {
  KIND, load, save, addGroup, renameGroup, removeGroup, groups, listSafe, getWallet,
  generate, importKeys, renameWallet, bulkRename, removeWallet, exportKeys,
  balances, feeData, sendNative, sendToken, unwrapWeth, disperse, consolidate,
  checkDelegation, revokeDelegation, scanDelegation,
  solConn, solBalances, solSend, solConsolidate, solDisperse, btcBalances,
  ERC20, derive,
};
