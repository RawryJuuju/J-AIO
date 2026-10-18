'use strict';
const { ethers } = require('ethers');
const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');

const CACHE = 'abi_cache';

function cacheGet(chainKey, addr) {
  const c = store.readPlain(CACHE, {});
  return c[`${chainKey}:${addr.toLowerCase()}`] || null;
}
function cacheSet(chainKey, addr, val) {
  const c = store.readPlain(CACHE, {});
  c[`${chainKey}:${addr.toLowerCase()}`] = val;
  store.writePlain(CACHE, c);
}

async function fetchAbi(chainKey, address) {
  const cached = cacheGet(chainKey, address);
  if (cached) return cached;
  const c = chainsMod.chain(chainKey);
  const settings = store.readSettings();
  const { fetch } = require('undici');
  const attempts = [];

  if (settings.etherscanKey) {
    attempts.push(async () => {
      const u = `https://api.etherscan.io/v2/api?chainid=${c.id}&module=contract&action=getsourcecode&address=${address}&apikey=${settings.etherscanKey}`;
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.status !== '1' || !j.result?.[0]) throw new Error(j.result || 'not verified');
      const row = j.result[0];
      if (!row.ABI || row.ABI === 'Contract source code not verified') throw new Error('not verified');
      return {
        abi: JSON.parse(row.ABI), name: row.ContractName || null,
        proxy: row.Proxy === '1' ? row.Implementation : null, source: 'etherscan',
      };
    });
  }
  attempts.push(async () => {
    const u = `https://repo.sourcify.dev/contracts/full_match/${c.id}/${ethers.getAddress(address)}/metadata.json`;
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`sourcify ${r.status}`);
    const j = await r.json();
    return { abi: j.output.abi, name: Object.values(j.settings?.compilationTarget || {})[0] || null, proxy: null, source: 'sourcify' };
  });

  let lastErr;
  for (const fn of attempts) {
    try {
      const res = await fn();
      cacheSet(chainKey, address, res);
      return res;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`ABI not found: ${String(lastErr?.message || lastErr).slice(0, 100)}`);
}

async function detectProxy(chainKey, address) {
  const SLOT_1967 = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
  try {
    const code = await rpc.readAny(chainKey, (p) => p.getCode(address));
    const m = /363d3d373d3d3d363d73([0-9a-f]{40})5af43d82/i.exec(code);
    if (m) return { proxy: true, impl: ethers.getAddress('0x' + m[1]), kind: 'erc1167' };
    for (const [slot, kind] of [[SLOT_1967, 'eip1967'], [SLOT_BEACON, 'beacon']]) {
      const v = await rpc.readAny(chainKey, (p) => p.getStorage(address, slot));
      const a = '0x' + v.slice(26);
      if (a !== ethers.ZeroAddress && /^0x[0-9a-f]{40}$/i.test(a) && a !== '0x0000000000000000000000000000000000000000') {
        return { proxy: true, impl: ethers.getAddress(a), kind };
      }
    }
    return { proxy: false, hasCode: code !== '0x' };
  } catch (e) { return { proxy: false, error: String(e.message).slice(0, 80) }; }
}

async function resolveAbi(chainKey, address) {
  let impl = null;
  const pr = await detectProxy(chainKey, address);
  if (pr.proxy) impl = pr.impl;
  try {
    const direct = await fetchAbi(chainKey, address);
    if (direct.proxy && direct.proxy !== ethers.ZeroAddress) impl = direct.proxy;
    if (impl) {
      try {
        const ia = await fetchAbi(chainKey, impl);
        const merged = dedupeAbi([...direct.abi, ...ia.abi]);
        return { abi: merged, name: ia.name || direct.name, proxy: impl, proxyKind: pr.kind || 'etherscan', source: `${direct.source}+impl` };
      } catch { /* impl not verified */ }
    }
    return { ...direct, proxy: impl, proxyKind: pr.kind || null };
  } catch (e) {
    if (impl) {
      const ia = await fetchAbi(chainKey, impl);
      return { ...ia, proxy: impl, proxyKind: pr.kind, source: ia.source + ' (impl only)' };
    }
    throw e;
  }
}

function dedupeAbi(abi) {
  const seen = new Set();
  return abi.filter((f) => {
    const k = `${f.type}:${f.name}:${(f.inputs || []).map((i) => i.type).join(',')}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

function writeFunctions(abi) {
  return abi.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))
    .map((f) => ({
      name: f.name,
      signature: `${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})`,
      inputs: (f.inputs || []).map((i) => ({ name: i.name, type: i.type, components: i.components || null })),
      payable: f.stateMutability === 'payable',
      selector: ethers.id(`${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})`).slice(0, 10),
    }));
}


const PROBES = [
  ['function mintPhases() view returns (tuple(string name, uint256 price, uint256 maxPerWallet, uint256 startTime, uint256 endTime, bytes32 merkleRoot)[])', 'phases'],
  ['function getPhases() view returns (tuple(string name, uint256 price, uint256 maxPerWallet, uint256 startTime, uint256 endTime)[])', 'phases'],
  ['function stageInfo() view returns (uint8 stage, uint256 price, uint256 maxPerWallet, bool active)', 'stage'],
  ['function price() view returns (uint256)', 'price'],
  ['function mintPrice() view returns (uint256)', 'price'],
  ['function cost() view returns (uint256)', 'price'],
  ['function publicPrice() view returns (uint256)', 'price'],
  ['function PRICE() view returns (uint256)', 'price'],
  ['function maxPerWallet() view returns (uint256)', 'limit'],
  ['function MAX_PER_WALLET() view returns (uint256)', 'limit'],
  ['function maxMintPerWallet() view returns (uint256)', 'limit'],
  ['function maxSupply() view returns (uint256)', 'supply'],
  ['function MAX_SUPPLY() view returns (uint256)', 'supply'],
  ['function totalSupply() view returns (uint256)', 'minted'],
  ['function paused() view returns (bool)', 'paused'],
  ['function mintOpen() view returns (bool)', 'open'],
  ['function saleActive() view returns (bool)', 'open'],
  ['function publicSaleActive() view returns (bool)', 'open'],
  ['function name() view returns (string)', 'name'],
];

async function probeContract(chainKey, address, rpcUrls) {
  const out = { address, chain: chainKey, phases: [], price: null, maxPerWallet: null, maxSupply: null, minted: null, paused: null, open: null, name: null };
  const results = await Promise.allSettled(PROBES.map(async ([sig, kind]) => {
    const iface = new ethers.Interface([sig]);
    const fn = iface.fragments[0];
    const data = iface.encodeFunctionData(fn.name, []);
    const raw = await rpc.readRace(chainKey, (p) => p.call({ to: address, data }), rpcUrls);
    if (!raw || raw === '0x') throw new Error('empty');
    return { kind, name: fn.name, decoded: iface.decodeFunctionResult(fn.name, raw) };
  }));
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const { kind, name, decoded } = r.value;
    try {
      if (kind === 'phases') {
        const arr = decoded[0];
        out.phases = arr.map((ph, i) => ({
          index: i, name: ph.name || ph[0] || `Phase ${i}`,
          price: ethers.formatEther(ph.price ?? ph[1] ?? 0n),
          maxPerWallet: Number(ph.maxPerWallet ?? ph[2] ?? 0),
          startTime: Number(ph.startTime ?? ph[3] ?? 0),
          endTime: Number(ph.endTime ?? ph[4] ?? 0),
          merkleRoot: ph.merkleRoot ?? null,
        }));
      } else if (kind === 'stage') {
        out.phases.push({ index: Number(decoded[0]), name: `Stage ${decoded[0]}`, price: ethers.formatEther(decoded[1]), maxPerWallet: Number(decoded[2]), active: decoded[3] });
      } else if (kind === 'price' && out.price == null) out.price = ethers.formatEther(decoded[0]);
      else if (kind === 'limit' && out.maxPerWallet == null) out.maxPerWallet = Number(decoded[0]);
      else if (kind === 'supply' && out.maxSupply == null) out.maxSupply = Number(decoded[0]);
      else if (kind === 'minted') out.minted = Number(decoded[0]);
      else if (kind === 'paused') out.paused = decoded[0];
      else if (kind === 'open') out.open = decoded[0];
      else if (kind === 'name') out.name = decoded[0];
    } catch { /* decode mismatch */ }
    out[`_${name}`] = true;
  }
  const SEA_DROP = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
  try {
    let targetCode = null;
    try {
      const dp = await detectProxy(chainKey, address);
      if (dp && dp.impl) targetCode = await rpc.readRace(chainKey, (p) => p.getCode(dp.impl), rpcUrls);
    } catch { /* not a proxy */ }
    if (targetCode == null) targetCode = await rpc.readRace(chainKey, (p) => p.getCode(address), rpcUrls);
    if (targetCode && /64869dad/i.test(targetCode)) {
      const sif = new ethers.Interface([
        'function getPublicDrop(address) view returns (uint256 mintPrice, uint256 startTime, uint256 endTime, uint256 maxTotalMintableByWallet, uint256 feeBps, bool restrictFeeRecipients)',
        'function getActiveDropStage(address) view returns (uint256 stageIndex, tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 maxQueueableMints, uint256 startTime, uint256 endTime, uint256 maxWalletMintableByPublic, uint256 maxWalletMintableByAllowList, uint256 feeBps, uint256 lookback, address paymentToken) config)',
      ]);
      const nft = ethers.getAddress(address);
      const now = Math.floor(Date.now() / 1000);
      out.seaDrop = true;
      try {
        const pd = await rpc.readRace(chainKey, (p) => p.call({ to: SEA_DROP, data: sif.encodeFunctionData('getPublicDrop', [nft]) }), rpcUrls);
        if (pd && pd !== '0x') {
          const d = sif.decodeFunctionResult('getPublicDrop', pd);
          if (out.price == null) out.price = ethers.formatEther(d.mintPrice);
          if (out.maxPerWallet == null) out.maxPerWallet = Number(d.maxTotalMintableByWallet);
          out.publicStart = Number(d.startTime);
          out.publicEnd = Number(d.endTime);
          if (out.open == null) out.open = Number(d.endTime) > 0 && now >= Number(d.startTime) && now <= Number(d.endTime);
          const fallbackIdx = out.phases.findIndex((ph) => ph.fallback);
          const pubPhase = { index: 0, name: 'Public', price: ethers.formatEther(d.mintPrice), maxPerWallet: Number(d.maxTotalMintableByWallet), startTime: Number(d.startTime), endTime: Number(d.endTime), seaDrop: true };
          if (fallbackIdx >= 0) out.phases[fallbackIdx] = pubPhase;
          else out.phases.unshift(pubPhase);
        }
      } catch { /* getPublicDrop may revert pre-config */ }
      try {
        const as = await rpc.readRace(chainKey, (p) => p.call({ to: SEA_DROP, data: sif.encodeFunctionData('getActiveDropStage', [nft]) }), rpcUrls);
        if (as && as !== '0x') {
          const d2 = sif.decodeFunctionResult('getActiveDropStage', as);
          const cfg = d2.config;
          if (cfg && Number(d2.stageIndex) > 0) {
            out.phases.push({ index: Number(d2.stageIndex), name: `Stage ${d2.stageIndex}`, price: ethers.formatEther(cfg.mintPrice), maxPerWallet: Number(cfg.maxWalletMintableByPublic), startTime: Number(cfg.startTime), endTime: Number(cfg.endTime), active: true, seaDrop: true });
          }
        }
      } catch { /* getActiveDropStage not on this SeaDrop version */ }
    }
  } catch { /* sea-drop probe failed, keep generic output */ }

  if (!out.phases.length) {
    out.phases = [{ index: 0, name: 'Public', price: out.price || '0', maxPerWallet: out.maxPerWallet || 0, fallback: true }];
  }
  return out;
}

function resolveParam(raw, type, ctx) {
  let v = raw;
  if (typeof v === 'string') {
    v = v.replace(/\{wallet\}|\{self\}/gi, ctx.address || '');
    v = v.replace(/\{id(\d+)\}/gi, (_, n) => String(1 + Math.floor(Math.random() * Number(n))));
    v = v.replace(/\{amount\}/gi, String(ctx.amount ?? 1));
    v = v.trim();
  }
  if (type.endsWith('[]')) {
    const base = type.slice(0, -2);
    const items = Array.isArray(v) ? v : String(v).replace(/^\[|\]$/g, '').split(/[,|]/).map((s) => s.trim()).filter(Boolean);
    return items.map((x) => resolveParam(x, base, ctx));
  }
  if (/^uint|^int/.test(type)) return BigInt(v === '' ? 0 : v);
  if (type === 'bool') return v === true || /^(true|1|yes)$/i.test(String(v));
  if (type === 'address') return ethers.getAddress(String(v));
  if (/^bytes\d*$/.test(type)) return String(v).startsWith('0x') ? v : '0x' + v;
  if (/^tuple/.test(type)) {
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }
  return v;
}

function probeMintCandidates(abi) {
  const seen = new Map();
  for (const f of abi.filter((f) => f.type === 'function' && !['view', 'pure'].includes(f.stateMutability))) {
    const sig = `${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})`;
    const name = f.name;
    const inputs = f.inputs || [];
    const base = name.toLowerCase();
    let score = 0;
    if (/^(mint|drop)$/.test(base)) score = 100;
    else if (/^(publicmint|publicmint|freemint)$/.test(base)) score = 95;
    else if (/^mint/.test(base)) score = 80;
    else if (/^(claim|drop)$/.test(base)) score = 70;
    else if (/^free/.test(base)) score = 65;
    else if (/^(buy|purchase)/.test(base)) score = 50;
    else if (/mint/.test(base)) score = 40;
    else if (/claim/.test(base)) score = 30;
    else continue;
    if (inputs.length > 2) score -= 10 * (inputs.length - 2);
    if (!f.payable) score -= 5;
    const key = name;
    if (!seen.has(key) || score > seen.get(key).score) seen.set(key, { signature: sig, name, inputs: inputs.map((i) => ({ name: i.name, type: i.type })), payable: f.payable, score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

function suggestMintMethod(funcs, probe) {
  const prefersFirstArgWallet = (f) => f.inputs[0] && (f.inputs[0].type === 'address' || /address\[\]/.test(f.inputs[0].type));
  // best: a mint function whose first arg is a wallet (recipient-style mint)
  const recipient = funcs.find((f) => prefersFirstArgWallet(f) && /^(mint|drop)/.test(f.name));
  if (recipient) return recipient;
  const single = funcs.find((f) => f.inputs.length === 1 && /^(mint|claim|drop)/.test(f.name));
  if (single) return single;
  const noArg = funcs.find((f) => f.inputs.length === 0 && /^(mint|claim|drop)/.test(f.name));
  if (noArg) return noArg;
  return funcs[0] || null;
}

function encodeCall(abi, funcSig, params, ctx) {
  const iface = new ethers.Interface(abi);
  let frag = iface.fragments.find((f) => f.type === 'function' && (
    `${f.name}(${f.inputs.map((i) => i.type).join(',')}` === funcSig || f.name === funcSig));
  if (!frag) {
    const name = String(funcSig).split('(')[0];
    const byName = iface.fragments.filter((f) => f.type === 'function' && f.name === name);
    if (byName.length === 1) frag = byName[0];
    else if (byName.length > 1) throw new Error(`ambiguous function ${funcSig} — pass the full signature`);
  }
  if (!frag) throw new Error(`function not in ABI: ${funcSig}`);
  const args = frag.inputs.map((inp, i) => resolveParam(params[i], inp.type, ctx));
  return iface.encodeFunctionData(frag, args);
}

module.exports = { fetchAbi, resolveAbi, detectProxy, writeFunctions, probeContract, encodeCall, resolveParam, cacheGet, cacheSet, dedupeAbi, probeMintCandidates, suggestMintMethod };
