'use strict';
/* NFT ops — inventory, auto-transfer, Seaport 1.6 listing, accept WETH offers, PnL. */
const { ethers } = require('ethers');
const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const wallets = require('./wallets');
const keys = require('./keys');
const fxrate = require('./fxrate');

const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395'; // Seaport 1.6
const SEAPORT_1_5 = '0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC';
const CONDUIT = '0x1E0049783F008A0085193E00003D00cd54003c71';
const CONDUIT_KEY = '0x61159fefdfada89302ed55f8b9e89e2d67d8258712b3a3f89aa88525877f1d5e';
const OS_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719';

const ERC721 = new ethers.Interface([
  'function transferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
  'function name() view returns (string)',
]);
const ERC1155 = new ethers.Interface([
  'function safeTransferFrom(address,address,uint256,uint256,bytes)',
  'function balanceOf(address,uint256) view returns (uint256)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function setApprovalForAll(address,bool)',
]);
const SEAPORT_IFACE = new ethers.Interface([
  'function getCounter(address offerer) view returns (uint256)',
  'function getConduit(bytes32 conduitKey) view returns (address conduit, bool isOpen)',
  'function fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32) payable returns (bool)',
  'function validate(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes)[]) returns (bool)',
]);
/* Seaport 1.6 cancel — encoded WITHOUT an AbiParser fragment: ethers v6 rejects
   the cancel OrderComponents[] tuple in some versions, keep the selector +
   AbiCoder raw-array form (selectors verified on-chain). */
const CANCEL_SELECTOR = '0xfd9f1e10'; // cancel((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256)[])
const CANCEL_TUPLE = '(address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256)[]';
function cancelCallData(comp) {
  const itemToArr = (o) => [Number(o.itemType), String(o.token), String(o.identifierOrCriteria), String(o.startAmount), String(o.endAmount)];
  const consToArr = (o) => [Number(o.itemType), String(o.token), String(o.identifierOrCriteria), String(o.startAmount), String(o.endAmount), String(o.recipient)];
  const asArray = [String(comp.offerer), String(comp.zone), comp.offer.map(itemToArr), comp.consideration.map(consToArr), Number(comp.orderType), String(comp.startTime), String(comp.endTime), String(comp.zoneHash), String(comp.salt), String(comp.conduitKey), String(comp.counter)];
  return CANCEL_SELECTOR + ethers.AbiCoder.defaultAbiCoder().encode([CANCEL_TUPLE], [[asArray]]).slice(2);
}

function osKey() { return keys.next('openseaKey'); }

/* Rotates across every OpenSea key in Settings. A 429/401 penalises that key
 * and the request is retried on the next one, so bulk PnL/inventory over many
 * wallets no longer dies on a single key's rate limit. */
async function osFetch(path, opts = {}) {
  const { fetch } = require('undici');
  const attempts = Math.max(1, Math.min(4, keys.count('openseaKey') || 1));
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const key = keys.require('openseaKey', 'OpenSea API key');
    const r = await fetch(`https://api.opensea.io${path}`, {
      method: opts.method || 'GET',
      headers: { 'X-API-KEY': key, accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
      body: opts.body, signal: AbortSignal.timeout(opts.timeout || 25000),
    });
    const t = await r.text();
    let d = null; try { d = JSON.parse(t); } catch { /* html */ }
    if (r.ok) return d;
    last = new Error(`OpenSea ${path} ${r.status}: ${t.slice(0, 1000)}`);
    if (r.status === 429 || r.status === 401 || r.status === 403) { keys.penalise(key); continue; }
    throw last;
  }
  throw last;
}

/* ---------------- inventory ---------------- */

async function inventory(chainKey, addresses, opts = {}) {
  const c = chainsMod.chain(chainKey);
  if (!c.osSlug) throw new Error(`no OpenSea support on ${c.name}`);
  const out = [];
  for (const a of addresses) {
    let next = null, pages = 0;
    do {
      const q = new URLSearchParams({ limit: '50' });
      if (next) q.set('next', next);
      if (opts.collection) q.set('collection', opts.collection);
      const d = await osFetch(`/api/v2/chain/${c.osSlug}/account/${a}/nfts?${q}`);
      for (const n of d.nfts || []) {
        out.push({
          owner: a, contract: n.contract, tokenId: n.identifier, standard: n.token_standard,
          name: n.name, collection: n.collection, image: n.display_image_url || n.image_url,
        });
      }
      next = d.next || null;
    } while (next && ++pages < (opts.maxPages || 6));
  }
  return out;
}

/* ---------------- transfer / sweep ---------------- */

async function transferNft(chainKey, walletId, contract, tokenId, to, opts = {}) {
  const c = chainsMod.chain(chainKey);
  const w = wallets.getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);
  const is1155 = opts.standard === 'erc1155';
  const data = is1155
    ? ERC1155.encodeFunctionData('safeTransferFrom', [w.address, to, tokenId, opts.amount || 1, '0x'])
    : ERC721.encodeFunctionData('transferFrom', [w.address, to, tokenId]);
  const fee = await wallets.feeData(chainKey, opts);
  let gasLimit = opts.gasLimit ? BigInt(opts.gasLimit) : null;
  if (!gasLimit) {
    try { gasLimit = (await p.estimateGas({ from: w.address, to: contract, data })) * 12n / 10n; }
    catch { gasLimit = is1155 ? 120000n : 100000n; }
  }
  const nonce = opts.nonce ?? await p.getTransactionCount(w.address, 'pending');
  const raw = await signer.signTransaction({
    chainId: c.id, to: contract, data, nonce, gasLimit,
    maxFeePerGas: opts.maxFee ? ethers.parseUnits(String(opts.maxFee), 'gwei') : fee.maxFeePerGas,
    maxPriorityFeePerGas: opts.priorityFee ? ethers.parseUnits(String(opts.priorityFee), 'gwei') : fee.maxPriorityFeePerGas,
    type: 2,
  });
  const res = await rpc.broadcast(chainKey, raw, urls);
  store.appendLog('nft-ops.log', `transfer ${c.key} ${contract}#${tokenId} ${w.address} -> ${to} ${res.hash}`);
  return { hash: res.hash, from: w.address, tokenId };
}

/* Sweep every NFT of a collection from many wallets to one destination.
 * FAST mode (default): wallets processed in parallel (opts.parallel, default 3),
 * gas estimated ONCE per standard per wallet, and every transfer is broadcast
 * back-to-back with pipelined nonces — no waiting between sends. Set
 * opts.delayMs to fall back to the old sequential behavior. */
async function sweepCollection(chainKey, walletIds, contract, to, opts = {}) {
  if (opts.bulk) return sweepCollectionBulk(chainKey, walletIds, contract, to, opts);
  const perWallet = async (id) => {
    const w = wallets.getWallet('evm', id);
    if (!w) return [];
    let items = [];
    try {
      items = (await inventory(chainKey, [w.address], { collection: opts.collection })).filter((n) => n.contract.toLowerCase() === contract.toLowerCase());
    } catch (e) { return [{ address: w.address, error: String(e.message).slice(0, 120) }]; }
    if (!items.length) return [];
    const c = chainsMod.chain(chainKey);
    const p = rpc.provider(rpc.urlsFor(chainKey)[0], c.id);
    let nonce = await p.getTransactionCount(w.address, 'pending');

    if (opts.delayMs) {
      /* legacy sequential mode */
      const seq = [];
      for (const n of items) {
        try {
          const r = await transferNft(chainKey, id, contract, n.tokenId, to, { ...opts, standard: n.standard === 'erc1155' ? 'erc1155' : 'erc721', nonce: nonce++ });
          seq.push({ address: w.address, tokenId: n.tokenId, hash: r.hash });
        } catch (e) { seq.push({ address: w.address, tokenId: n.tokenId, error: String(e.shortMessage || e.message).slice(0, 120) }); }
        await new Promise((r) => setTimeout(r, Number(opts.delayMs)));
      }
      return seq;
    }

    /* fast mode: estimate gas once per standard, fire everything in parallel */
    const gasByStd = {};
    const firstByStd = {};
    for (const n of items) { const s = n.standard === 'erc1155' ? 'erc1155' : 'erc721'; if (!firstByStd[s]) firstByStd[s] = n; }
    for (const [std, n] of Object.entries(firstByStd)) {
      if (opts.gasLimit) { gasByStd[std] = BigInt(opts.gasLimit); continue; }
      const data = std === 'erc1155'
        ? ERC1155.encodeFunctionData('safeTransferFrom', [w.address, to, n.tokenId, 1, '0x'])
        : ERC721.encodeFunctionData('transferFrom', [w.address, to, n.tokenId]);
      try { gasByStd[std] = await p.estimateGas({ from: w.address, to: contract, data }) * 12n / 10n; }
      catch { gasByStd[std] = std === 'erc1155' ? 120000n : 100000n; }
    }
    const sends = items.map((n) => {
      const std = n.standard === 'erc1155' ? 'erc1155' : 'erc721';
      return transferNft(chainKey, id, contract, n.tokenId, to, { ...opts, standard: std, nonce: nonce++, gasLimit: gasByStd[std] })
        .then((r) => ({ address: w.address, tokenId: n.tokenId, hash: r.hash }))
        .catch((e) => ({ address: w.address, tokenId: n.tokenId, error: String(e.shortMessage || e.message).slice(0, 120) }));
    });
    return Promise.all(sends);
  };
  const results = await poolMap(walletIds, Math.max(1, Number(opts.parallel) || 6), perWallet);
  const flat = results.flat();
  store.appendLog('nft-ops.log', `sweep ${chainKey} ${contract} -> ${to}: ${flat.filter((x) => x.hash).length} sent, ${flat.filter((x) => x.error).length} errors`);
  return flat;
}

/* ---------------- bulk transfers (many NFTs, fewer txs) ----------------
 * Two levels:
 *  1) transferBatch  — one HTTP call for many NFTs across wallets/contracts;
 *     per wallet the transfers are nonce-pipelined and broadcast in parallel
 *     (still 1 tx per NFT, but no sequential waiting).
 *  2) sweepCollectionBulk — ONE tx per wallet via the BatchNftSender helper
 *     contract (contracts/BatchNftSender.sol, artifact in src/). First use of
 *     a wallet on a collection costs one setApprovalForAll; after that every
 *     sweep is a single tx regardless of how many NFTs move.
 */

let _batchIface = null;
function batchIface() {
  if (!_batchIface) _batchIface = new ethers.Interface(require('./batchSender.artifact.json').abi);
  return _batchIface;
}
function batchBytecode() { return require('./batchSender.artifact.json').bytecode; }

function getBatchSender(chainKey) {
  const d = store.readPlain('batch_sender', {});
  return d[String(chainKey).toLowerCase()] || null;
}

/* Deploy BatchNftSender on a chain (deployer wallet pays the deploy gas,
 * ~200k). Address cached in data/batch_sender.json. Idempotent. */
async function deployBatchSender(chainKey, walletId) {
  const c = chainsMod.chain(chainKey);
  const w = wallets.getWallet('evm', walletId);
  if (!w) throw new Error('deployer wallet not found');
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const existing = getBatchSender(chainKey);
  if (existing) {
    try { if ((await p.getCode(existing)) !== '0x') return { address: existing, already: true }; } catch { /* fall through, redeploy */ }
  }
  const fee = await wallets.feeData(chainKey);
  const nonce = await p.getTransactionCount(w.address, 'pending');
  let gasLimit = 1500000n;
  try { gasLimit = await p.estimateGas({ from: w.address, data: batchBytecode() }) * 12n / 10n; } catch { /* keep fallback */ }
  const signer = new ethers.Wallet(w.pk, p);
  const rawTx = await signer.signTransaction({
    chainId: c.id, to: null, data: batchBytecode(), nonce, gasLimit,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });
  const res = await rpc.broadcast(chainKey, rawTx, urls);
  const address = ethers.getContractAddress({ from: w.address, nonce });
  let live = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { if ((await p.getCode(address)) !== '0x') { live = true; break; } } catch { /* retry */ }
  }
  if (live) {
    const d = store.readPlain('batch_sender', {});
    d[String(chainKey).toLowerCase()] = address;
    store.writePlain('batch_sender', d);
    store.appendLog('nft-ops.log', `batch-sender deployed on ${chainKey} at ${address} by ${w.address} (${res.hash})`);
  }
  return { address, hash: res.hash, live, deployer: w.address };
}

/* Transfer many NFTs (any mix of wallets/contracts/standards) in ONE request.
 * items: [{ walletId, contract, tokenId, standard, amount? }] */
async function transferBatch(chainKey, items, to, opts = {}) {
  const byWallet = {};
  for (const it of items || []) {
    if (!it || !it.walletId || !it.contract || it.tokenId == null) continue;
    (byWallet[it.walletId] = byWallet[it.walletId] || []).push(it);
  }
  const c = chainsMod.chain(chainKey);
  const perWallet = async ([id, list]) => {
    const w = wallets.getWallet('evm', id);
    if (!w) return list.map((x) => ({ wallet: id, tokenId: x.tokenId, error: 'wallet not found' }));
    const p = rpc.provider(rpc.urlsFor(chainKey)[0], c.id);
    let nonce = await p.getTransactionCount(w.address, 'pending');
    const gasBy = {};
    for (const it of list) {
      const std = it.standard === 'erc1155' ? 'erc1155' : 'erc721';
      const k = String(it.contract).toLowerCase() + ':' + std;
      if (opts.gasLimit) { gasBy[k] = BigInt(opts.gasLimit); continue; }
      if (gasBy[k]) continue;
      const data = std === 'erc1155'
        ? ERC1155.encodeFunctionData('safeTransferFrom', [w.address, to, it.tokenId, Number(it.amount || 1), '0x'])
        : ERC721.encodeFunctionData('transferFrom', [w.address, to, it.tokenId]);
      try { gasBy[k] = await p.estimateGas({ from: w.address, to: it.contract, data }) * 12n / 10n; }
      catch { gasBy[k] = std === 'erc1155' ? 120000n : 100000n; }
    }
    return Promise.all(list.map((it) => {
      const std = it.standard === 'erc1155' ? 'erc1155' : 'erc721';
      const k = String(it.contract).toLowerCase() + ':' + std;
      return transferNft(chainKey, id, it.contract, it.tokenId, to, { ...opts, standard: std, amount: it.amount, nonce: nonce++, gasLimit: gasBy[k] })
        .then((r) => ({ wallet: w.address, contract: it.contract, tokenId: it.tokenId, hash: r.hash }))
        .catch((e) => ({ wallet: w.address, contract: it.contract, tokenId: it.tokenId, error: String(e.shortMessage || e.message).slice(0, 120) }));
    }));
  };
  const results = await poolMap(Object.entries(byWallet), Math.max(1, Number(opts.parallel) || 6), perWallet);
  const flat = results.flat();
  store.appendLog('nft-ops.log', `transfer-batch ${chainKey} -> ${to}: ${flat.filter((x) => x.hash).length} sent, ${flat.filter((x) => x.error).length} errors`);
  return flat;
}

/* Sweep with ONE tx per wallet per standard via BatchNftSender.
 * opts.deployerWalletId — who pays the one-time deploy if no sender on chain
 * (defaults to the first wallet in the list). Wallets where the batch route
 * fails simulation (e.g. operator-filtered collections) fall back to the
 * per-NFT fast mode automatically. */
async function sweepCollectionBulk(chainKey, walletIds, contract, to, opts = {}) {
  const c = chainsMod.chain(chainKey);
  let sender = getBatchSender(chainKey);
  if (!sender) {
    const dep = await deployBatchSender(chainKey, opts.deployerWalletId || walletIds[0]);
    sender = dep.address;
    if (!dep.live) throw new Error(`batch sender deployed at ${sender} but code not confirmed yet — retry the sweep in a few seconds`);
  }
  const iface = batchIface();
  const CHUNK = Math.max(1, Number(opts.chunk) || 120);
  const urls = rpc.urlsFor(chainKey);

  const perWallet = async (id) => {
    const w = wallets.getWallet('evm', id);
    if (!w) return { address: String(id), error: 'wallet not found' };
    let items = [];
    try {
      items = (await inventory(chainKey, [w.address], { collection: opts.collection }))
        .filter((n) => n.contract.toLowerCase() === contract.toLowerCase());
    } catch (e) { return { address: w.address, error: String(e.message).slice(0, 120) }; }
    if (!items.length) return { address: w.address, sent: 0, note: 'empty' };

    const p = rpc.provider(urls[0], c.id);
    const fee = await wallets.feeData(chainKey, opts);
    const signer = new ethers.Wallet(w.pk, p);
    let nonce = await p.getTransactionCount(w.address, 'pending');
    const out = { address: w.address, txs: [], sent: 0 };

    const sendStd = async (std) => {
      const is1155 = std === 'erc1155';
      const list = items.filter((n) => (n.standard === 'erc1155') === is1155);
      if (!list.length) return;
      const apData = ERC721.encodeFunctionData('isApprovedForAll', [w.address, sender]);
      let approved = false;
      try { approved = ERC721.decodeFunctionResult('isApprovedForAll', await p.call({ to: contract, data: apData }))[0]; } catch { /* treat as not approved */ }
      let approvalSent = false;
      for (let s = 0; s < list.length; s += CHUNK) {
        const slice = list.slice(s, s + CHUNK);
        const data = is1155
          ? iface.encodeFunctionData('send1155', [contract, slice.map((n) => BigInt(n.tokenId)), slice.map((n) => BigInt(n.amount || 1)), to])
          : iface.encodeFunctionData('send721', [contract, slice.map((n) => BigInt(n.tokenId)), to]);
        if (!approved && !approvalSent) {
          const setData = ERC721.encodeFunctionData('setApprovalForAll', [sender, true]);
          /* simulate first — operator-filtered collections revert here */
          try { await p.call({ from: w.address, to: contract, data: setData }); }
          catch { throw Object.assign(new Error('approval sim failed (operator-filtered collection?)'), { simFailed: true }); }
          const apRaw = await signer.signTransaction({ chainId: c.id, to: contract, data: setData, nonce: nonce++, gasLimit: 90000n, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2 });
          const apRes = await rpc.broadcast(chainKey, apRaw, urls);
          out.txs.push({ kind: 'approve', hash: apRes.hash });
          approvalSent = true;
        }
        let gasLimit;
        if (approvalSent) {
          /* approval still pending on-chain -> estimateGas would sim against
           * unapproved state and fail; use a generous formula instead. */
          gasLimit = 100000n + 75000n * BigInt(slice.length);
        } else {
          try { gasLimit = await p.estimateGas({ from: w.address, to: sender, data }) * 13n / 10n; }
          catch (e) { throw Object.assign(new Error('batch sim failed: ' + String(e.shortMessage || e.message).slice(0, 100)), { simFailed: true }); }
        }
        const raw = await signer.signTransaction({ chainId: c.id, to: sender, data, nonce: nonce++, gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2 });
        const res = await rpc.broadcast(chainKey, raw, urls);
        out.txs.push({ kind: std, ids: slice.length, hash: res.hash });
        out.sent += slice.length;
      }
    };

    try {
      await sendStd('erc721');
      await sendStd('erc1155');
      return out;
    } catch (e) {
      if (!e.simFailed) return { address: w.address, error: String(e.shortMessage || e.message).slice(0, 140) };
      const fb = await sweepCollection(chainKey, [id], contract, to, { ...opts, bulk: false });
      return { address: w.address, fallback: true, items: fb };
    }
  };

  const results = await poolMap(walletIds, Math.max(1, Number(opts.parallel) || 6), perWallet);
  const sent = results.reduce((a, r) => a + (r.sent || (r.items || []).filter((x) => x.hash).length), 0);
  store.appendLog('nft-ops.log', `sweep-bulk ${chainKey} ${contract} -> ${to} via ${sender}: ${sent} nfts across ${results.length} wallets`);
  return { sender, results };
}

/* ---------------- approvals ---------------- */

async function ensureApproval(chainKey, walletId, contract, opts = {}) {
  const c = chainsMod.chain(chainKey);
  const w = wallets.getWallet('evm', walletId);
  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);
  const operator = opts.operator || CONDUIT;
  const raw = await p.call({ to: contract, data: ERC721.encodeFunctionData('isApprovedForAll', [w.address, operator]) });
  const approved = ERC721.decodeFunctionResult('isApprovedForAll', raw)[0];
  if (approved) return { approved: true, already: true };
  const signer = new ethers.Wallet(w.pk, p);
  const fee = await wallets.feeData(chainKey);
  const data = ERC721.encodeFunctionData('setApprovalForAll', [operator, true]);
  const nonce = await p.getTransactionCount(w.address, 'pending');
  const rawTx = await signer.signTransaction({
    chainId: c.id, to: contract, data, nonce, gasLimit: 60000n,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });
  const res = await rpc.broadcast(chainKey, rawTx, urls);
  return { approved: false, hash: res.hash, waiting: true };
}

/* ---------------- Seaport listing ---------------- */

const ORDER_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' },
  ],
};

/* ---------- OpenSea listing actions (server-built order) ---------- */

/* OpenSea's /api/v2/listings/actions returns the Seaport order it wants us to
 * sign — zone (Signed Zone V2 where the collection requires it), orderType,
 * zoneHash, conduit and every fee consideration item come from OpenSea itself,
 * which is the only source that matches its own listing validation. Hand-built
 * orders failed that validation ("requires Signed Zone V2", "not provided all
 * required creator fees"), so we sign only what OpenSea generated.
 * Steps are free-form JsonNode in proto3 JSON: default values (zone "0x0",
 * orderType 0, counter "0") are OMITTED, so every field needs an explicit
 * default before signing. Find the order by shape, not exact key names. */
function pick(o, camel, snake, dflt) {
  const v = o[camel] !== undefined ? o[camel] : (snake ? o[snake] : undefined);
  return v === undefined || v === null || v === '' ? dflt : v;
}

function normalizeOrder(o) {
  const item = (it, withRecipient) => ({
    itemType: Number(pick(it, 'itemType', 'item_type', 0)),
    token: pick(it, 'token', null, ethers.ZeroAddress),
    identifierOrCriteria: BigInt(pick(it, 'identifierOrCriteria', 'identifier_or_criteria', '0')),
    startAmount: BigInt(pick(it, 'startAmount', 'start_amount', '0')),
    endAmount: BigInt(pick(it, 'endAmount', 'end_amount', '0')),
    ...(withRecipient ? { recipient: pick(it, 'recipient', null, ethers.ZeroAddress) } : {}),
  });
  const order = {
    offerer: pick(o, 'offerer', null, null),
    zone: pick(o, 'zone', null, ethers.ZeroAddress),
    offer: (o.offer || []).map((x) => item(x, false)),
    consideration: (o.consideration || []).map((x) => item(x, true)),
    orderType: Number(pick(o, 'orderType', 'order_type', 0)),
    startTime: BigInt(pick(o, 'startTime', 'start_time', '0')),
    endTime: BigInt(pick(o, 'endTime', 'end_time', '0')),
    zoneHash: pick(o, 'zoneHash', 'zone_hash', ethers.ZeroHash),
    salt: BigInt(pick(o, 'salt', null, '0')),
    conduitKey: pick(o, 'conduitKey', 'conduit_key', ethers.ZeroHash),
    counter: BigInt(pick(o, 'counter', null, '0')),
  };
  if (!order.offerer || !/^0x[a-fA-F0-9]{40}$/.test(order.offerer)) throw new Error('listing action payload missing offerer');
  if (!order.offer.length || !order.consideration.length) throw new Error('listing action payload incomplete');
  if (!order.startTime || !order.endTime) throw new Error('listing action payload missing expiry');
  return order;
}

/* The types OpenSea asks us to sign MUST be the canonical Seaport ones — if
 * they ever differ, our signature would hash to a different order than the
 * one we verified. Compare structurally before trusting the payload. */
function typesMatch(t) {
  if (!t || typeof t !== 'object') return false;
  const norm = (arr) => (Array.isArray(arr) ? arr.map((f) => `${f && f.name}:${f && f.type}`).join(',') : null);
  for (const k of ['OrderComponents', 'OfferItem', 'ConsiderationItem']) {
    if (norm(t[k]) !== norm(ORDER_TYPES[k])) return false;
  }
  return true;
}

/* Decode the operator out of a setApprovalForAll(operator,bool) calldata. */
function approvalOperator(data) {
  if (typeof data !== 'string' || !/^0xa22cb465/i.test(data) || data.length < 74) return null;
  const op = '0x' + data.slice(34, 74);
  return /^0x[a-fA-F0-9]{40}$/.test(op) ? op : null;
}

/* OpenSea /api/v2/listings/actions has two observed shapes:
 *
 * A) steps format (proto3 JSON, current — robinhood & new integrations):
 *    { steps: [
 *        { itemApprovalAction: { transaction: { to, data, ... } } },
 *        { createListingsAction: { signatureRequest: {
 *            message: "<JSON string of EIP-712 typed data>", ... } } } ] }
 *    The typed-data JSON is {types, primaryType, domain, message}; `message`
 *    holds the order value (proto JSON: uints as strings, defaults omitted).
 *
 * B) legacy flat format: an object containing the order by shape.
 *
 * Return { order, protocolAddress, operator, domain } or null. */
function extractListingOrder(actions) {
  let order = null;
  let protocolAddress = null;
  let operator = null;
  let domain = null;

  if (actions && Array.isArray(actions.steps)) {
    for (const step of actions.steps) {
      if (!step || typeof step !== 'object') continue;
      const ap = step.itemApprovalAction && step.itemApprovalAction.transaction;
      if (ap) { const op = approvalOperator(ap.data); if (op) operator = op; }
      const sr = step.createListingsAction && step.createListingsAction.signatureRequest;
      if (sr && !order) {
        let typed = sr.message;
        try {
          if (typeof typed === 'string') typed = JSON.parse(typed);
          if (typeof typed === 'string') typed = JSON.parse(typed); /* double-encoded guard */
        } catch { typed = null; }
        if (typed && typeof typed === 'object') {
          if (!typesMatch(typed.types)) {
            throw new Error('OpenSea sign request uses non-canonical Seaport types — refusing');
          }
          const msg = typed.message || typed.value;
          if (msg && Array.isArray(msg.offer) && Array.isArray(msg.consideration)) {
            try { order = normalizeOrder(msg); domain = typed.domain || null; } catch { /* keep looking */ }
          }
        }
        if (!protocolAddress) {
          protocolAddress = (typed && typed.domain && typed.domain.verifyingContract)
            || sr.verifyingContract || sr.protocolAddress || null;
        }
      }
    }
  }

  /* Legacy shape fallback: find the order by walking for offer+consideration. */
  if (!order) {
    const isOrder = (n) => n && typeof n === 'object' && Array.isArray(n.offer) && Array.isArray(n.consideration);
    const walk = (n) => {
      if (!n || typeof n !== 'object' || order) return;
      if (isOrder(n)) { try { order = normalizeOrder(n); } catch { /* keep looking */ } }
      for (const [k, v] of Object.entries(n)) {
        if (!protocolAddress && /protocol/i.test(k) && typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)) protocolAddress = v;
        if (v && typeof v === 'object') walk(v);
      }
    };
    walk(actions);
  }

  return order ? { order, protocolAddress, operator, domain } : null;
}

/* Plural variant: collect EVERY createListingsAction order from one actions
 * response (used by bulk listing — one multi-item /listings/actions call). */
function extractListingOrders(actions) {
  const out = [];
  let protocolAddress = null;
  let operator = null;
  if (actions && Array.isArray(actions.steps)) {
    for (const step of actions.steps) {
      if (!step || typeof step !== 'object') continue;
      const ap = step.itemApprovalAction && step.itemApprovalAction.transaction;
      if (ap) { const op = approvalOperator(ap.data); if (op) operator = op; }
      const sr = step.createListingsAction && step.createListingsAction.signatureRequest;
      if (!sr) continue;
      let typed = sr.message;
      try {
        if (typeof typed === 'string') typed = JSON.parse(typed);
        if (typeof typed === 'string') typed = JSON.parse(typed);
      } catch { typed = null; }
      if (typed && typeof typed === 'object') {
        if (!typesMatch(typed.types)) {
          throw new Error('OpenSea sign request uses non-canonical Seaport types — refusing');
        }
        const msg = typed.message || typed.value;
        if (msg && Array.isArray(msg.offer) && Array.isArray(msg.consideration)) {
          try {
            out.push({
              order: normalizeOrder(msg),
              protocolAddress: (typed.domain && typed.domain.verifyingContract) || sr.verifyingContract || sr.protocolAddress || protocolAddress,
              operator,
              domain: typed.domain || null,
            });
          } catch { /* skip malformed */ }
        }
        if (!protocolAddress) {
          protocolAddress = (typed.domain && typed.domain.verifyingContract) || sr.verifyingContract || sr.protocolAddress || null;
        }
      }
    }
  }
  return out;
}

/* ---------- pre-sign verification (never sign blind) ---------- */

/* Max total fees (platform + creator) in bps we accept on a listing order.
 * Anything above this refuses to sign — a fee this high is either a unit bug
 * or a hostile order. Configurable via settings.maxTotalFeeBps. */
function maxTotalFeeBps() {
  const v = Number((store.readSettings() || {}).maxTotalFeeBps);
  return Number.isFinite(v) && v > 0 && v <= 5000 ? v : 2500;
}

/* The order we sign is OpenSea-built, so verify it actually IS a listing of our
 * token that pays us — before the signature exists:
 *  - offer side: exactly our token, correct id and quantity, nothing else
 *  - consideration: native ETH only; items sum EXACTLY to the sale price;
 *    exactly one item pays our wallet; total fees within the cap
 *  - times sane, counter matches on-chain getCounter() (real chain read),
 *    zone (if any) is a deployed contract (getCode), conduit operator is a
 *    deployed contract AND actually approved by our wallet on-chain
 * Any mismatch throws and nothing gets signed. */
async function verifyListingOrder({ order, wallet, contract, tokenId, quantity, priceEth, proto, provider, operator, currency = ethers.ZeroAddress, decimals = 18 }) {
  const err = (m) => { throw new Error(`refusing to sign: ${m}`); };
  if (order.offer.length !== 1) err('order offers more than one item');
  const off = order.offer[0];
  if (off.itemType !== 2 && off.itemType !== 3) err('offer item is not ERC721/ERC1155');
  if (off.token.toLowerCase() !== contract.toLowerCase()) err('offer token is not the listed contract');
  if (off.identifierOrCriteria !== BigInt(tokenId)) err('offer token id mismatch');
  if (off.startAmount !== off.endAmount || off.startAmount !== BigInt(quantity)) err('offer quantity mismatch');

  /* Some RH collections only list in a specific ERC20 (e.g. hoodwarrios →
   * USDG). `currency` declares what the consideration must be paid in. */
  const cur = String(currency).toLowerCase();
  const isNative = cur === ethers.ZeroAddress.toLowerCase();
  const expectedTotal = ethers.parseUnits(String(priceEth), decimals) * BigInt(quantity);
  let proceeds = null;
  let feeSum = 0n;
  for (const it of order.consideration) {
    if (isNative) {
      if (it.itemType !== 0) err('non-native consideration item — expected native only');
      if (it.token.toLowerCase() !== ethers.ZeroAddress.toLowerCase()) err('consideration token not native');
    } else {
      if (it.itemType !== 1) err('non-ERC20 consideration item — expected the collection currency');
      if (it.token.toLowerCase() !== cur) err(`consideration token ${it.token} is not the declared currency ${currency}`);
    }
    if (it.startAmount !== it.endAmount) err('consideration amount changes over time');
    if (it.recipient.toLowerCase() === wallet.toLowerCase()) {
      if (proceeds !== null) err('multiple proceeds items to seller');
      proceeds = it.startAmount;
    } else {
      if (it.recipient === ethers.ZeroAddress) err('fee item to zero address');
      feeSum += it.startAmount;
    }
  }
  if (proceeds === null) err('no consideration item pays the seller wallet');
  if (proceeds + feeSum !== expectedTotal) err(`consideration sum ${proceeds + feeSum} wei != sale price ${expectedTotal} wei`);
  const capBps = maxTotalFeeBps();
  if (feeSum * 10000n > expectedTotal * BigInt(capBps)) err(`total fees ${(Number((feeSum * 10000n) / expectedTotal) / 100).toFixed(2)}% exceed ${capBps / 100}% cap`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (order.startTime > now + 300n) err('order starts in the future');
  if (order.endTime < now + 3600n) err('order expires in under an hour');

  const counterRaw = await provider.call({ to: proto, data: SEAPORT_IFACE.encodeFunctionData('getCounter', [wallet]) });
  const onchainCounter = SEAPORT_IFACE.decodeFunctionResult('getCounter', counterRaw)[0];
  if (order.counter !== onchainCounter) err(`counter ${order.counter} != on-chain ${onchainCounter} — stale order`);

  if (order.zone !== ethers.ZeroAddress) {
    const code = await provider.getCode(order.zone);
    if (!code || code === '0x') err('zone is not a deployed contract');
  }
  if (order.conduitKey !== ethers.ZeroHash) {
    if (operator) {
      /* Operator came from OpenSea's own approval action — verify it exists
       * on-chain and that our wallet really approved it (else the listing
       * would be unfillable, or worse, fillable by a surprise operator). */
      const code = await provider.getCode(operator);
      if (!code || code === '0x') err('conduit operator is not a deployed contract');
      const raw = await provider.call({ to: contract, data: ERC721.encodeFunctionData('isApprovedForAll', [wallet, operator]) });
      const approved = ERC721.decodeFunctionResult('isApprovedForAll', raw)[0];
      if (!approved) err(`wallet has not approved conduit operator ${operator}`);
    } else if (order.conduitKey.toLowerCase() !== CONDUIT_KEY.toLowerCase()) {
      err(`unknown conduit key ${order.conduitKey} — approval target unclear`);
    }
  }
}

/* Seaport EIP-712 domain version: known addresses map directly; anything else
 * must identify itself on-chain via information() → (name, version). */
const INFO_IFACE = new ethers.Interface(['function information() view returns (string name, string version)']);
async function seaportVersion(proto, provider) {
  const lc = proto.toLowerCase();
  if (lc === SEAPORT.toLowerCase()) return '1.6';
  if (lc === SEAPORT_1_5.toLowerCase()) return '1.5';
  const raw = await provider.call({ to: proto, data: INFO_IFACE.encodeFunctionData('information', []) }).catch(() => null);
  if (!raw || raw === '0x') throw new Error(`unknown Seaport protocol ${proto} — cannot verify domain`);
  const [name, version] = INFO_IFACE.decodeFunctionResult('information', raw);
  if (!/seaport/i.test(String(name))) throw new Error(`protocol ${proto} identifies as "${name}", not Seaport`);
  return String(version);
}

async function listNft(chainKey, walletId, contract, tokenId, priceEth, opts = {}) {
  /* Some collections only accept listings in a specific ERC20 (seen on RH:
   * hoodwarrios → USDG). Detect the currency up front from the collection's
   * own listings so the first attempt already uses it; if detection misses,
   * OpenSea names the required currency in the submit validation error —
   * retry once with it. */
  let currency = String(opts.currency || ethers.ZeroAddress);
  if (currency.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    const c0 = chainsMod.chain(chainKey);
    let slug = opts.slug || null;
    if (!slug) {
      const cd = await osFetch(`/api/v2/chain/${c0.osSlug}/contract/${contract}`).catch(() => null);
      slug = cd?.collection || null;
    }
    const det = await collectionListingCurrency(chainKey, slug).catch(() => null);
    if (det && !det.native && det.currency) currency = det.currency;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await listNftOnce(chainKey, walletId, contract, tokenId, priceEth, { ...opts, currency });
    } catch (e) {
      const m = String(e.message).match(/requires currency: (0x[0-9a-fA-F]{40})/);
      if (m && attempt === 0 && m[1].toLowerCase() !== currency.toLowerCase()) { currency = m[1]; continue; }
      throw e;
    }
  }
}

async function listNftOnce(chainKey, walletId, contract, tokenId, priceEth, opts = {}) {
  const c = chainsMod.chain(chainKey);
  if (!c.osSlug) throw new Error(`OpenSea not on ${c.name}`);
  const w = wallets.getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const p = rpc.provider(rpc.urlsFor(chainKey)[0], c.id);
  const signer = new ethers.Wallet(w.pk, p);

  const startSec = Math.floor(Date.now() / 1000) - 60;
  const durSec = Number(opts.durationSec || (opts.durationDays ? opts.durationDays * 86400 : 30 * 86400));
  const currency = String(opts.currency || ethers.ZeroAddress);
  let decimals = 18; let currencySymbol = null;
  if (currency.toLowerCase() !== ethers.ZeroAddress.toLowerCase()) {
    const ti = await tokenInfo(chainKey, currency);
    decimals = Number.isFinite(ti.decimals) ? ti.decimals : 18;
    currencySymbol = ti.symbol || null;
  }
  const actions = await osFetch('/api/v2/listings/actions', {
    method: 'POST',
    body: JSON.stringify({
      address: w.address,
      use_creator_fee: true,
      items: [{
        chain: c.osSlug,
        contract,
        token_id: String(tokenId),
        quantity: Number(opts.amount || 1),
        price: { amount: String(priceEth), currency },
        start_time: new Date(startSec * 1000).toISOString(),
        end_time: new Date((startSec + durSec) * 1000).toISOString(),
      }],
    }),
  });

  const built = extractListingOrder(actions);
  if (!built) {
    store.appendLog('nft-ops.log', `list-actions unexpected payload: ${JSON.stringify(actions).slice(0, 20000)}`);
    throw new Error('OpenSea returned no signable order for this item');
  }
  const order = built.order;
  if (order.offerer.toLowerCase() !== w.address.toLowerCase()) throw new Error('order offerer mismatch — not your wallet');
  const proto = built.protocolAddress || SEAPORT;
  /* On-chain proof the protocol we're about to sign against exists here —
   * catches payloads that omit the protocol address on non-ethereum chains. */
  const protoCode = await p.getCode(proto);
  if (!protoCode || protoCode === '0x') throw new Error(`Seaport protocol ${proto} not deployed on ${c.name}`);

  /* Approval target comes from OpenSea's own payload when present (conduit
   * operators differ per chain — robinhood's is NOT the ethereum one). Fall
   * back to the canonical conduit, or to Seaport itself when the order has no
   * conduit key (Seaport then transfers directly and needs the approval). */
  const opTarget = built.operator
    || (order.conduitKey === ethers.ZeroHash ? proto : CONDUIT);
  const ap = await ensureApproval(chainKey, walletId, contract, { operator: opTarget });
  if (ap.waiting) {
    await p.waitForTransaction(ap.hash, 1, 120000).catch(() => null);
  }

  /* Verify the order is exactly a listing of our token that pays us, with
   * fees in bounds and on-chain facts (counter, zone code, approval) checked
   * — BEFORE any signature exists. Throws on any mismatch. */
  await verifyListingOrder({
    order, wallet: w.address, contract, tokenId,
    quantity: Number(opts.amount || 1), priceEth, proto, provider: p,
    operator: built.operator || null, currency, decimals,
  });

  /* EIP-712 domain: prefer what OpenSea embedded in the sign request (it is
   * the exact domain their order hash uses); validate it before trusting. */
  let version = null;
  if (built.domain && built.domain.verifyingContract
    && built.domain.verifyingContract.toLowerCase() === proto.toLowerCase()) {
    if (built.domain.chainId && Number(built.domain.chainId) !== Number(c.id)) {
      throw new Error(`sign request domain chainId ${built.domain.chainId} != ${c.id}`);
    }
    if (built.domain.name && !/seaport/i.test(String(built.domain.name))) {
      throw new Error(`sign request domain name "${built.domain.name}" is not Seaport`);
    }
    version = built.domain.version ? String(built.domain.version) : await seaportVersion(proto, p);
  } else {
    version = await seaportVersion(proto, p);
  }

  const domain = { name: 'Seaport', version, chainId: c.id, verifyingContract: proto };
  const signature = await signer.signTypedData(domain, ORDER_TYPES, order);

  const body = JSON.stringify({
    parameters: {
      ...order,
      offer: order.offer.map((o) => ({ ...o, identifierOrCriteria: o.identifierOrCriteria.toString(), startAmount: o.startAmount.toString(), endAmount: o.endAmount.toString() })),
      consideration: order.consideration.map((o) => ({ ...o, identifierOrCriteria: o.identifierOrCriteria.toString(), startAmount: o.startAmount.toString(), endAmount: o.endAmount.toString() })),
      startTime: order.startTime.toString(), endTime: order.endTime.toString(),
      salt: order.salt.toString(), counter: order.counter.toString(),
      totalOriginalConsiderationItems: order.consideration.length,
    },
    signature,
    protocol_address: proto,
  });

  const res = await osFetch(`/api/v2/orders/${c.osSlug}/seaport/listings`, { method: 'POST', body });
  store.appendLog('nft-ops.log', `list ${c.key} ${contract}#${tokenId} ${priceEth}${currencySymbol ? ' ' + currencySymbol : ''} by ${w.address} zone=${order.zone} orderType=${order.orderType} op=${opTarget}`);
  return { ok: true, orderHash: res?.order?.order_hash || null, price: priceEth, wallet: w.address, currency: currencySymbol ? currency : null, currencySymbol };
}

/* ---------------- bulk listing (many NFTs in seconds) ----------------
 * One currency detect, one multi-item actions call per wallet+contract group
 * (falls back to parallel single-item calls), approvals deduped & waited ONCE,
 * then sign everything locally and POST orders with bounded concurrency.
 * items: [{ walletId, contract, tokenId, price, standard?, amount? }] */
async function listNftBulk(chainKey, items, opts = {}) {
  let res = await _listBulkOnce(chainKey, items, opts);
  /* Same currency-retry safety net as single listNft: OpenSea names the
   * required currency in the submit error when detection missed. */
  const cur = String(opts.currency || ethers.ZeroAddress);
  const bad = res.find((r) => r && r.error && /requires currency/.test(r.error));
  if (bad) {
    const m = String(bad.error).match(/requires currency: (0x[0-9a-fA-F]{40})/);
    if (m && m[1].toLowerCase() !== cur.toLowerCase()) {
      const failedIdx = res.map((r, i) => (r && r.error ? i : -1)).filter((i) => i >= 0);
      const retryItems = failedIdx.map((i) => items[i]);
      try {
        const r2 = await _listBulkOnce(chainKey, retryItems, { ...opts, currency: m[1] });
        failedIdx.forEach((origI, j) => { if (r2[j]) res[origI] = r2[j]; });
      } catch { /* keep first-round errors */ }
    }
  }
  return res;
}

async function _listBulkOnce(chainKey, items, opts = {}) {
  const c = chainsMod.chain(chainKey);
  if (!c.osSlug) throw new Error(`OpenSea not on ${c.name}`);
  const list = (items || [])
    .map((it) => ({ ...it, contract: it.contract || opts.contract }))
    .filter((it) => it && it.walletId && it.contract && it.tokenId != null && it.price != null);
  const results = (items || []).map((it) => ({ tokenId: it ? it.tokenId : null, error: 'skipped (missing fields)' }));
  if (!list.length) return results;
  const idxOf = new Map(); // list-index -> original-index
  (items || []).forEach((it, oi) => {
    const li = list.findIndex((x) => x === it || (x.walletId === it.walletId && String(x.tokenId) === String(it.tokenId) && String(x.contract).toLowerCase() === String(it.contract).toLowerCase()));
    if (li >= 0 && !idxOf.has(li)) idxOf.set(li, oi);
  });

  /* 1. currency detect ONCE */
  let currency = String(opts.currency || ethers.ZeroAddress);
  if (currency.toLowerCase() === ethers.ZeroAddress.toLowerCase()) {
    let slug = opts.slug || null;
    if (!slug) {
      const cd = await osFetch(`/api/v2/chain/${c.osSlug}/contract/${list[0].contract}`).catch(() => null);
      slug = cd?.collection || null;
    }
    const det = await collectionListingCurrency(chainKey, slug).catch(() => null);
    if (det && !det.native && det.currency) currency = det.currency;
  }
  let decimals = 18; let currencySymbol = null;
  if (currency.toLowerCase() !== ethers.ZeroAddress.toLowerCase()) {
    const ti = await tokenInfo(chainKey, currency);
    decimals = Number.isFinite(ti.decimals) ? ti.decimals : 18;
    currencySymbol = ti.symbol || null;
  }

  const startSec = Math.floor(Date.now() / 1000) - 60;
  const durSec = Number(opts.durationSec || (opts.durationDays ? opts.durationDays * 86400 : 30 * 86400));

  /* 2. group by wallet+contract */
  const groups = {};
  list.forEach((it, i) => {
    const k = it.walletId + '|' + String(it.contract).toLowerCase();
    (groups[k] = groups[k] || []).push(i);
  });

  const POST_CONC = Math.max(1, Number(opts.parallel) || 4);
  const versionCache = {};

  await poolMap(Object.entries(groups), 3, async ([, idxs]) => {
    const it0 = list[idxs[0]];
    const w = wallets.getWallet('evm', it0.walletId);
    if (!w) {
      for (const i of idxs) results[idxOf.get(i)] = { tokenId: list[i].tokenId, error: 'wallet not found' };
      return;
    }
    const urls = rpc.urlsFor(chainKey);
    const p = rpc.provider(urls[0], c.id);
    const signer = new ethers.Wallet(w.pk, p);

    const actionBody = (subItems) => JSON.stringify({
      address: w.address,
      use_creator_fee: true,
      items: subItems.map((it) => ({
        chain: c.osSlug, contract: it.contract, token_id: String(it.tokenId),
        quantity: Number(it.amount || 1),
        price: { amount: String(it.price), currency },
        start_time: new Date(startSec * 1000).toISOString(),
        end_time: new Date((startSec + durSec) * 1000).toISOString(),
      })),
    });

    /* 2a. one multi-item actions call; fall back to parallel singles */
    let built = []; // { idx, order, protocolAddress, operator, domain }
    try {
      const actions = await osFetch('/api/v2/listings/actions', { method: 'POST', body: actionBody(idxs.map((i) => list[i])) });
      const multi = extractListingOrders(actions);
      if (multi.length !== idxs.length) throw new Error(`multi-actions returned ${multi.length}/${idxs.length} orders`);
      /* match orders back to items by offered tokenId */
      for (const b of multi) {
        const offId = String(b.order.offer?.[0]?.identifierOrCriteria ?? '');
        const i = idxs.find((x) => String(list[x].tokenId) === offId);
        if (i == null) throw new Error('cannot match multi-actions order to requested tokens');
        built.push({ idx: i, ...b });
      }
    } catch {
      built = await poolMap(idxs, POST_CONC, async (i) => {
        try {
          const actions = await osFetch('/api/v2/listings/actions', { method: 'POST', body: actionBody([list[i]]) });
          const one = extractListingOrder(actions);
          if (!one) return { idx: i, error: 'no signable order returned' };
          return { idx: i, ...one };
        } catch (e) { return { idx: i, error: String(e.message).slice(0, 140) }; }
      });
    }

    /* 2b. approvals: dedupe per (contract, operator), fire, wait ONCE */
    const opSeen = new Set();
    const approvals = [];
    for (const b of built) {
      if (b.error) continue;
      const proto = b.protocolAddress || SEAPORT;
      const op = b.operator || (b.order.conduitKey === ethers.ZeroHash ? proto : CONDUIT);
      const key = String(list[b.idx].contract).toLowerCase() + '|' + op.toLowerCase();
      if (opSeen.has(key)) continue;
      opSeen.add(key);
      try {
        const ap = await ensureApproval(chainKey, it0.walletId, list[b.idx].contract, { operator: op });
        if (ap.waiting) approvals.push(ap.hash);
      } catch (e) {
        for (const x of built) {
          if (!x.error && String(list[x.idx].contract).toLowerCase() === String(list[b.idx].contract).toLowerCase()) {
            x.error = 'approval failed: ' + String(e.message).slice(0, 100);
          }
        }
      }
    }
    if (approvals.length) {
      await Promise.all(approvals.map((h) => p.waitForTransaction(h, 1, 120000).catch(() => null)));
    }

    /* 2c. verify + sign everything in parallel */
    const signed = await Promise.all(built.map(async (b) => {
      const oi = idxOf.get(b.idx);
      if (b.error) { results[oi] = { tokenId: list[b.idx].tokenId, error: b.error }; return null; }
      const it = list[b.idx];
      try {
        const proto = b.protocolAddress || SEAPORT;
        const protoCode = await p.getCode(proto);
        if (!protoCode || protoCode === '0x') throw new Error(`Seaport protocol ${proto} not deployed on ${c.name}`);
        await verifyListingOrder({
          order: b.order, wallet: w.address, contract: it.contract, tokenId: it.tokenId,
          quantity: Number(it.amount || 1), priceEth: it.price, proto, provider: p,
          operator: b.operator || null, currency, decimals,
        });
        let version = null;
        if (b.domain && b.domain.verifyingContract && b.domain.verifyingContract.toLowerCase() === proto.toLowerCase()) {
          if (b.domain.chainId && Number(b.domain.chainId) !== Number(c.id)) throw new Error(`sign request domain chainId ${b.domain.chainId} != ${c.id}`);
          if (b.domain.name && !/seaport/i.test(String(b.domain.name))) throw new Error('sign request domain is not Seaport');
          version = b.domain.version ? String(b.domain.version) : (versionCache[proto] || (versionCache[proto] = await seaportVersion(proto, p)));
        } else {
          version = versionCache[proto] || (versionCache[proto] = await seaportVersion(proto, p));
        }
        const domain = { name: 'Seaport', version, chainId: c.id, verifyingContract: proto };
        const signature = await signer.signTypedData(domain, ORDER_TYPES, b.order);
        const body = JSON.stringify({
          parameters: {
            ...b.order,
            offer: b.order.offer.map((o) => ({ ...o, identifierOrCriteria: o.identifierOrCriteria.toString(), startAmount: o.startAmount.toString(), endAmount: o.endAmount.toString() })),
            consideration: b.order.consideration.map((o) => ({ ...o, identifierOrCriteria: o.identifierOrCriteria.toString(), startAmount: o.startAmount.toString(), endAmount: o.endAmount.toString() })),
            startTime: b.order.startTime.toString(), endTime: b.order.endTime.toString(),
            salt: b.order.salt.toString(), counter: b.order.counter.toString(),
            totalOriginalConsiderationItems: b.order.consideration.length,
          },
          signature,
          protocol_address: proto,
        });
        return { idx: b.idx, body };
      } catch (e) {
        results[oi] = { tokenId: it.tokenId, error: String(e.shortMessage || e.message).slice(0, 140) };
        return null;
      }
    }));

    /* 2d. POST orders with bounded concurrency */
    await poolMap(signed.filter(Boolean), POST_CONC, async (s) => {
      const oi = idxOf.get(s.idx);
      try {
        const res = await osFetch(`/api/v2/orders/${c.osSlug}/seaport/listings`, { method: 'POST', body: s.body });
        results[oi] = { ok: true, tokenId: list[s.idx].tokenId, orderHash: res?.order?.order_hash || null, price: list[s.idx].price, currencySymbol };
      } catch (e) {
        results[oi] = { tokenId: list[s.idx].tokenId, error: String(e.message).slice(0, 140) };
      }
    });
  });

  const okc = results.filter((r) => r && r.ok).length;
  store.appendLog('nft-ops.log', `list-bulk ${chainKey}: ${okc}/${results.length} listed`);
  return results;
}

/* ---------------- Seaport 1.6 cancel ---------------- */

/* Cancels ONE live listing on-chain: fetch the order parameters from OpenSea
   (best-listing endpoint), rebuild the Seaport OrderComponents, then call
   Seaport.cancel() from the seller's wallet. The order payload from OS v2 is
   {order_hash, protocol_data:{parameters, signature}} — parameters already
   match OrderComponents keys. Cancelling on-chain beats any API cancel: it is
   final and indexers confirm it from logs. */
function orderToComponents(p) {
  return {
    offerer: p.offerer,
    zone: p.zone || ethers.ZeroAddress,
    offer: p.offer.map((o) => ({
      itemType: Number(o.itemType), token: o.token, identifierOrCriteria: BigInt(o.identifierOrCriteria),
      startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount),
    })),
    consideration: p.consideration.map((o) => ({
      itemType: Number(o.itemType), token: o.token, identifierOrCriteria: BigInt(o.identifierOrCriteria),
      startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount), recipient: o.recipient,
    })),
    orderType: Number(p.orderType), startTime: BigInt(p.startTime), endTime: BigInt(p.endTime),
    zoneHash: p.zoneHash || ethers.ZeroHash, salt: BigInt(p.salt),
    conduitKey: p.conduitKey || CONDUIT_KEY, counter: BigInt(p.counter || 0),
  };
}

async function cancelListing(chainKey, walletId, contract, tokenId, opts = {}) {
  const c = chainsMod.chain(chainKey);
  if (!c.osSlug) throw new Error(`OpenSea not on ${c.name}`);
  const w = wallets.getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const d = await osFetch(`/api/v2/listings/chain/${c.osSlug}/contract/${contract}/nfts/${tokenId}/best`);
  const order = d?.order || d || {};
  const p = (order.protocol_data && order.protocol_data.parameters) || order.parameters;
  if (!p || !p.offerer) throw new Error(`no live listing on ${String(contract).slice(0, 6)}…#${tokenId}`);
  if (String(p.offerer).toLowerCase() !== w.address.toLowerCase()) {
    throw new Error(`listing belongs to ${p.offerer}, not your wallet`);
  }
  const comp = orderToComponents(p);
  const urls = rpc.urlsFor(chainKey);
  const prov = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, prov);
  const data = cancelCallData(comp);
  let gasLimit;
  try { gasLimit = (await prov.estimateGas({ from: signer.address, to: SEAPORT, data })) * 12n / 10n; }
  catch { gasLimit = 140000n; }
  const fee = await wallets.feeData(chainKey, {});
  const nonce = await prov.getTransactionCount(w.address, 'pending');
  const raw = await signer.signTransaction({
    chainId: c.id, to: SEAPORT, data, gasLimit, nonce,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });
  const res = await rpc.broadcast(chainKey, raw, urls);
  store.appendLog('nft-ops.log', `cancel ${c.key} ${contract}#${tokenId} ${res.hash} by ${w.address}`);
  /* opts.wait: hold until the cancel is mined. Relisting depends on this —
   * if the cancel reverts, the old order stays live and must not be papered
   * over by a fresh listing at a different price. */
  let confirmed = null;
  if (opts.wait) {
    const deadline = Date.now() + Number(opts.waitMs || 90000);
    while (Date.now() < deadline) {
      const rec = await prov.getTransactionReceipt(res.hash).catch(() => null);
      if (rec) {
        if (rec.status !== 1) throw new Error(`cancel tx reverted ${res.hash}`);
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (confirmed !== true) throw new Error(`cancel tx not confirmed within ${Math.round(Number(opts.waitMs || 90000) / 1000)}s: ${res.hash}`);
  }
  return { ok: true, hash: res.hash, orderHash: order.order_hash || null, confirmed };
}

/* Cancel MANY live listings in parallel: fetch best-listing per token (x6),
 * verify offerer, group by wallet, pipeline nonces, broadcast back-to-back,
 * then wait for all receipts at once. Returns per-item results in input order.
 * items: [{ walletId, contract, tokenId }] */
async function cancelBatch(chainKey, items, opts = {}) {
  const c = chainsMod.chain(chainKey);
  if (!c.osSlug) throw new Error(`OpenSea not on ${c.name}`);
  const valid = (items || [])
    .map((it) => ({ ...it, contract: it.contract || opts.contract }))
    .filter((it) => it && it.walletId && it.contract && it.tokenId != null);
  const out = (items || []).map((it) => ({ tokenId: it ? it.tokenId : null, error: 'skipped' }));
  if (!valid.length) return out;
  const origIdx = valid.map((v) => (items || []).findIndex((it) => it && it.walletId === v.walletId && String(it.tokenId) === String(v.tokenId) && String(it.contract).toLowerCase() === String(v.contract).toLowerCase()));

  /* 1. fetch best listing per token in parallel */
  const fetched = await poolMap(valid.map((_, i) => i), 6, async (i) => {
    const it = valid[i];
    try {
      const d = await osFetch(`/api/v2/listings/chain/${c.osSlug}/contract/${it.contract}/nfts/${it.tokenId}/best`);
      const order = d?.order || d || {};
      const p = (order.protocol_data && order.protocol_data.parameters) || order.parameters;
      if (!p || !p.offerer) return { i, error: `no live listing on #${it.tokenId}` };
      return { i, p };
    } catch (e) { return { i, error: String(e.message).slice(0, 100) }; }
  });

  /* 2. group by wallet */
  const byWallet = {};
  for (const f of fetched) {
    const oi = origIdx[f.i];
    if (f.error) { out[oi] = { tokenId: valid[f.i].tokenId, error: f.error }; continue; }
    const w = wallets.getWallet('evm', valid[f.i].walletId);
    if (!w || String(f.p.offerer).toLowerCase() !== w.address.toLowerCase()) {
      out[oi] = { tokenId: valid[f.i].tokenId, error: `listing belongs to ${String(f.p.offerer).slice(0, 8)}…, not your wallet` };
      continue;
    }
    (byWallet[valid[f.i].walletId] = byWallet[valid[f.i].walletId] || []).push(f);
  }

  /* 3. per wallet: pipeline cancel txs, broadcast all, then wait for all */
  await poolMap(Object.entries(byWallet), 6, async ([id, list]) => {
    const w = wallets.getWallet('evm', id);
    const urls = rpc.urlsFor(chainKey);
    const prov = rpc.provider(urls[0], c.id);
    const signer = new ethers.Wallet(w.pk, prov);
    const fee = await wallets.feeData(chainKey, {});
    let nonce = await prov.getTransactionCount(w.address, 'pending');
    const txs = [];
    for (const f of list) {
      const oi = origIdx[f.i];
      try {
        const comp = orderToComponents(f.p);
        const data = cancelCallData(comp);
        let gasLimit;
        try { gasLimit = await prov.estimateGas({ from: w.address, to: SEAPORT, data }) * 12n / 10n; }
        catch { gasLimit = 140000n; }
        const raw = await signer.signTransaction({
          chainId: c.id, to: SEAPORT, data, gasLimit, nonce: nonce++,
          maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
        });
        const res = await rpc.broadcast(chainKey, raw, urls);
        txs.push({ i: f.i, hash: res.hash });
        store.appendLog('nft-ops.log', `cancel-bulk ${c.key} ${valid[f.i].contract}#${valid[f.i].tokenId} ${res.hash} by ${w.address}`);
      } catch (e) {
        out[oi] = { tokenId: valid[f.i].tokenId, error: String(e.shortMessage || e.message).slice(0, 120) };
      }
    }
    await Promise.all(txs.map(async (t) => {
      const oi = origIdx[t.i];
      const deadline = Date.now() + Number(opts.waitMs || 90000);
      while (Date.now() < deadline) {
        const rec = await prov.getTransactionReceipt(t.hash).catch(() => null);
        if (rec) {
          out[oi] = rec.status === 1
            ? { ok: true, tokenId: valid[t.i].tokenId, hash: t.hash }
            : { tokenId: valid[t.i].tokenId, error: `cancel tx reverted ${t.hash}` };
          return;
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      out[oi] = { tokenId: valid[t.i].tokenId, error: 'cancel not confirmed in time' };
    }));
  });
  return out;
}

/* ---------------- floor war auto-relist ---------------- */

function countDecimals(x) {
  const s = String(x);
  return s.includes('.') ? s.split('.')[1].replace(/0+$/, '').length : 0;
}

function shouldRelist(myPrice, newFloor) {
  const diff = myPrice - newFloor;
  if (diff <= 0) return null;
  const significantChange = -Math.floor(Math.log10(diff));
  const myDecimals = countDecimals(myPrice);
  if (significantChange > myDecimals + 5) return null;
  const maxDecimals = Math.max(countDecimals(myPrice), countDecimals(newFloor));
  const smallestUnit = Math.pow(10, -(maxDecimals + 1));
  return parseFloat((newFloor - smallestUnit).toFixed(14));
}

async function collectionFloor(chainKey, slug) {
  const d = await osFetch(`/api/v2/listings/collection/${slug}/best?limit=1`);
  const l = d.listings?.[0];
  if (!l) return null;
  const cur = l.price?.current;
  if (!cur) return null;
  return Number(ethers.formatUnits(String(cur.value), cur.decimals ?? 18));
}

/* Known symbol → per-chain addresses, so detection doesn't need an extra OS
 * call to resolve the token some collections demand (RH: hoodwarrios → USDG). */
const KNOWN_CURRENCY = {
  usdg: { robinhood: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
  weth: { robinhood: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
};
const currencyCache = new Map(); /* chain:slug -> { currency, symbol, decimals, native, at } */

/* Which currency does this collection list in? OS's best listing names the
 * symbol + decimals; the symbol is resolved to an address (known map, else
 * the collection's own offers carry it) so listings/actions can target it on
 * the FIRST attempt. Some RH collections reject anything else at submit time.
 * Returns null when undeterminable — callers fall back to native + the
 * submit-error retry in listNft. */
async function collectionListingCurrency(chainKey, slug) {
  if (!slug) return null;
  const ck = `${chainKey}:${String(slug).toLowerCase()}`;
  const hit = currencyCache.get(ck);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit;
  let out = null;
  try {
    const d = await osFetch(`/api/v2/listings/collection/${slug}/best?limit=1`);
    const cur = d?.listings?.[0]?.price?.current;
    if (cur && cur.currency) {
      const sym = String(cur.currency);
      const decimals = Number.isFinite(Number(cur.decimals)) ? Number(cur.decimals) : 18;
      if (/^w?eth$/i.test(sym)) {
        out = { currency: ethers.ZeroAddress, symbol: sym.toUpperCase(), decimals, native: true };
      } else {
        let address = KNOWN_CURRENCY[sym.toLowerCase()]?.[chainKey] || null;
        if (!address) {
          try {
            const off = await osFetch(`/api/v2/offers/collection/${slug}?limit=1`);
            const o0 = off?.offers?.[0];
            address = o0?.payment_token_address
              || o0?.protocol_data?.parameters?.offer?.find((x) => Number(x.itemType) === 1)?.token
              || null;
          } catch { /* no offers / tier limit — leave unresolved */ }
        }
        out = { currency: address, symbol: sym.toUpperCase(), decimals, native: false };
      }
    }
  } catch { /* leave null */ }
  if (out) { out.at = Date.now(); currencyCache.set(ck, out); }
  return out;
}

const floorWars = new Map();

function startFloorWar(cfg) {
  const id = 'fw' + Date.now().toString(36);
  const st = { id, cfg, running: true, log: [], lastFloor: null, relists: 0 };
  floorWars.set(id, st);
  (async () => {
    while (st.running) {
      try {
        const floor = await collectionFloor(cfg.chain, cfg.slug);
        st.lastFloor = floor;
        if (floor != null && cfg.minPrice != null && floor <= Number(cfg.minPrice)) {
          st.log.push({ t: Date.now(), msg: `floor ${floor} at/below min ${cfg.minPrice} — holding` });
        } else if (floor != null) {
          const target = shouldRelist(Number(cfg.myPrice), floor);
          if (target != null && target >= Number(cfg.minPrice || 0)) {
            try {
              await listNft(cfg.chain, cfg.walletId, cfg.contract, cfg.tokenId, target, { standard: cfg.standard });
              cfg.myPrice = target; st.relists++;
              st.log.push({ t: Date.now(), msg: `relisted at ${target} (floor ${floor})` });
            } catch (e) { st.log.push({ t: Date.now(), msg: `relist failed: ${String(e.message).slice(0, 120)}` }); }
          }
        }
      } catch (e) { st.log.push({ t: Date.now(), msg: `floor check failed: ${String(e.message).slice(0, 100)}` }); }
      if (st.log.length > 200) st.log.splice(0, st.log.length - 200);
      await new Promise((r) => setTimeout(r, Number(cfg.pollMs || 60000)));
    }
  })();
  return { id };
}

function stopFloorWar(id) { const s = floorWars.get(id); if (!s) return false; s.running = false; return true; }
function listFloorWars() { return [...floorWars.values()].map((s) => ({ id: s.id, running: s.running, slug: s.cfg.slug, tokenId: s.cfg.tokenId, myPrice: s.cfg.myPrice, lastFloor: s.lastFloor, relists: s.relists, log: s.log.slice(-30) })); }

/* ---------------- accept WETH offers ---------------- */

/* Only these Seaport entrypoints will ever be executed for offer acceptance.
 * With the conduit approval live, unverified calldata could drain the
 * wallet's NFTs — so anything else is refused outright.
 *
 * Tuples are the EXACT Seaport 1.6 ABI (ProjectOpenSea/seaport-types). Verified
 * against the official @opensea/seaport-js artifact: selectors
 * fulfillBasicOrder=0xfb0f3ee1, fulfillBasicOrder_efficient_6GL6yc=0x00000000
 * (vanity-mined), fulfillOrder=0xb3a34c4c, fulfillAdvancedOrder=0xe7acab24.
 * NOTE the 1.6 layout differs from 1.5: BasicOrderParameters carries
 * basicOrderType right after offerAmount and ends with `bytes signature`, and
 * fulfillOrder takes an Order (parameters+signature), not bare parameters. */
const ADDL_RECIPIENT_TUPLE = '(uint256 amount,address recipient)';
const BASIC_ORDER_TUPLE = `(address considerationToken,uint256 considerationIdentifier,uint256 considerationAmount,address offerer,address zone,address offerToken,uint256 offerIdentifier,uint256 offerAmount,uint8 basicOrderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 offererConduitKey,bytes32 fulfillerConduitKey,uint256 totalOriginalAdditionalRecipients,${ADDL_RECIPIENT_TUPLE}[] additionalRecipients,bytes signature)`;
const OFFER_ITEM_TUPLE = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)';
const CONSIDERATION_ITEM_TUPLE = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const ORDER_PARAMS_TUPLE = `(address offerer,address zone,${OFFER_ITEM_TUPLE}[] offer,${CONSIDERATION_ITEM_TUPLE}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)`;
const ORDER_TUPLE = `(${ORDER_PARAMS_TUPLE} parameters,bytes signature)`;
const ADVANCED_ORDER_TUPLE = `(${ORDER_PARAMS_TUPLE} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)`;
const CRITERIA_RESOLVER_TUPLE = '(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)';
const FULFILL_IFACE = new ethers.Interface([
  `function fulfillBasicOrder(${BASIC_ORDER_TUPLE} parameters)`,
  `function fulfillBasicOrder_efficient_6GL6yc(${BASIC_ORDER_TUPLE} parameters)`,
  `function fulfillOrder(${ORDER_TUPLE} order,bytes32 fulfillerConduitKey)`,
  `function fulfillAdvancedOrder(${ADVANCED_ORDER_TUPLE} advancedOrder,${CRITERIA_RESOLVER_TUPLE}[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient)`,
  /* Seaport 1.6 batch entrypoints — OpenSea uses fulfillAvailableAdvancedOrders
   * for multi-item offer accepts (the order is duplicated per item, each copy
   * carrying its own 1/N fraction and its own zone-signed extraData). The two
   * (uint256,uint256)[][] params are the 1.6 fulfillment-component arrays. */
  `function fulfillAvailableAdvancedOrders(${ADVANCED_ORDER_TUPLE}[] advancedOrders,${CRITERIA_RESOLVER_TUPLE}[] criteriaResolvers,(uint256,uint256)[][] orderComponents,(uint256,uint256)[][] considerationComponents,bytes32 fulfillerConduitKey,address recipient,uint256 maximumFulfilled)`,
  `function fulfillAvailableOrders(${ORDER_TUPLE}[] orders,${CRITERIA_RESOLVER_TUPLE}[] criteriaResolvers,(uint256,uint256)[][] orderComponents,(uint256,uint256)[][] considerationComponents,bytes32 fulfillerConduitKey,address recipient,uint256 maximumFulfilled)`,
  /* Seaport match route — OpenSea serves matchAdvancedOrders for collection
   * OFFER accepts on Robinhood: orders[0] = the bid (zone-restricted, carries
   * the zone-signed extraData), orders[1] = an OS-synthesized counter order
   * "from" the seller (signature 0x — valid because the seller IS the caller);
   * fulfillments route payment/fees/NFT. Selector 0xf2d12b12 verified present
   * in RH Seaport bytecode; real RH fills use it (observed in fill sample). */
  `function matchAdvancedOrders(${ADVANCED_ORDER_TUPLE}[] advancedOrders,${CRITERIA_RESOLVER_TUPLE}[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient)`,
]);

/* Resolve the operator that moves tokens for a Seaport conduit key. Standard
 * Seaport derives it via getConduit(); Robinhood's fork strips that view
 * function entirely, so chains may declare a known conduit in config as a
 * fallback. Returns null when the operator cannot be determined. */
async function resolveConduit(proto, conduitKey, provider, chainCfg) {
  if (!conduitKey || conduitKey === ethers.ZeroHash) return proto;
  try {
    const raw = await provider.call({ to: proto, data: SEAPORT_IFACE.encodeFunctionData('getConduit', [conduitKey]) });
    const [conduit, isOpen] = SEAPORT_IFACE.decodeFunctionResult('getConduit', raw);
    if (isOpen && conduit !== ethers.ZeroAddress) return conduit;
  } catch { /* fork without getConduit — try the chain-level fallback */ }
  if (chainCfg && chainCfg.conduit) return chainCfg.conduit;
  return null;
}

/* Extract the embedded order from fulfill calldata. Returns null when the
 * selector is not one of the known fulfill functions. */
function decodeFulfillCalldata(data) {
  try {
    const parsed = FULFILL_IFACE.parseTransaction({ data });
    if (!parsed) return null;
    if (parsed.name === 'fulfillBasicOrder' || parsed.name === 'fulfillBasicOrder_efficient_6GL6yc') {
      /* basic route: offer* fields = the order's OFFER item (buyer's WETH,
       * we receive it); consideration* = our NFT (we give it);
       * additionalRecipients = fees carved out of what we receive. */
      const b = parsed.args[0];
      return {
        kind: 'basic', name: parsed.name, offerer: b.offerer,
        giveToken: b.considerationToken, giveId: BigInt(b.considerationIdentifier), giveAmount: BigInt(b.considerationAmount),
        getToken: b.offerToken, getId: BigInt(b.offerIdentifier), getAmount: BigInt(b.offerAmount),
        /* which conduit the fulfiller asked for — decides which operator pulls
         * OUR NFT, so it is also the only correct approval target */
        fulfillerConduitKey: b.fulfillerConduitKey,
        feeItems: [...b.additionalRecipients].map((r) => ({ amount: BigInt(r.amount), recipient: r.recipient })),
      };
    }
    /* Batch entrypoints: args[0] is an ARRAY of orders. OpenSea duplicates the
     * same order once per item being sold, each copy with its own fraction and
     * zone-signed extraData. Sum the fractions so downstream math (payment,
     * fees, expectedPrice) reflects the whole batch. */
    if (parsed.name === 'fulfillAvailableAdvancedOrders' || parsed.name === 'fulfillAvailableOrders') {
      const orders = [...parsed.args[0]];
      if (!orders.length) return null;
      const isAdv = parsed.name === 'fulfillAvailableAdvancedOrders';
      const norm = (xs) => [...xs].map((x) => ({
        itemType: Number(x.itemType), token: x.token, id: BigInt(x.identifierOrCriteria),
        startAmount: BigInt(x.startAmount), endAmount: BigInt(x.endAmount), recipient: x.recipient || null,
      }));
      const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));
      let accNum = 0n, accDen = 1n;
      const allParams = [];
      for (const o of orders) {
        allParams.push(o.parameters);
        const n = isAdv ? BigInt(o.numerator) : 1n;
        const d = isAdv ? (BigInt(o.denominator) || 1n) : 1n;
        accNum = accNum * d + n * accDen;
        accDen = accDen * d;
        const g = gcd(accNum, accDen);
        accNum /= g; accDen /= g;
      }
      const first = orders[0].parameters;
      return {
        kind: 'full', name: parsed.name, offerer: first.offerer,
        fulfillerConduitKey: parsed.args[4],
        offer: norm(first.offer), consideration: norm(first.consideration),
        numerator: accNum, denominator: accDen,
        copies: orders.length, allParams,
        criteriaResolvers: [...(parsed.args[1] || [])].map((r) => ({ orderIndex: Number(r.orderIndex), side: Number(r.side), index: Number(r.index), identifier: BigInt(r.identifier) })),
      };
    }
    /* Match route (collection OFFER accepts on Robinhood): the bid is one of
     * the matched orders — identify it as the order paying entirely in ERC20,
     * and normalize it to the same shape the fulfill paths produce so the
     * downstream math (payment, fees, funding guard, preview) is shared. The
     * other order(s) ride along in `otherOrders` for match-specific checks. */
    if (parsed.name === 'matchAdvancedOrders') {
      const orders = [...parsed.args[0]];
      if (!orders.length) return null;
      const norm = (xs) => [...xs].map((x) => ({
        itemType: Number(x.itemType), token: x.token, id: BigInt(x.identifierOrCriteria),
        startAmount: BigInt(x.startAmount), endAmount: BigInt(x.endAmount), recipient: x.recipient || null,
      }));
      let bidIdx = orders.findIndex((o) => o.parameters.offer.length > 0 && [...o.parameters.offer].every((x) => Number(x.itemType) === 1));
      if (bidIdx < 0) bidIdx = 0;
      const bid = orders[bidIdx];
      return {
        kind: 'match', name: parsed.name, offerer: bid.parameters.offerer, bidIndex: bidIdx,
        offer: norm(bid.parameters.offer), consideration: norm(bid.parameters.consideration),
        numerator: BigInt(bid.numerator ?? 1), denominator: BigInt(bid.denominator ?? 1) || 1n,
        otherOrders: orders.filter((_, i) => i !== bidIdx).map((o) => ({ params: o.parameters })),
        criteriaResolvers: [...parsed.args[1]].map((r) => ({
          orderIndex: Number(r.orderIndex), side: Number(r.side), index: Number(r.index), identifier: BigInt(r.identifier),
        })),
        recipient: parsed.args[3],
        fulfillerConduitKey: null, /* match has none — operator comes from the counter order */
      };
    }
    /* fulfillOrder → args[0] is Order {parameters, signature};
     * fulfillAdvancedOrder → args[0] is AdvancedOrder {parameters, ...}. */
    const params = parsed.args[0].parameters;
    const norm = (xs) => [...xs].map((x) => ({
      itemType: Number(x.itemType), token: x.token, id: BigInt(x.identifierOrCriteria),
      startAmount: BigInt(x.startAmount), endAmount: BigInt(x.endAmount), recipient: x.recipient || null,
    }));
    return {
      kind: 'full', name: parsed.name, offerer: params.offerer,
      fulfillerConduitKey: parsed.name === 'fulfillAdvancedOrder' ? parsed.args[2] : parsed.args[1],
      offer: norm(params.offer), consideration: norm(params.consideration),
      /* Partial fill fraction for multi-item (collection) offers. Selling one
       * NFT into a 14-item order arrives as numerator=1, denominator=14 —
       * payment and fees must be scaled by it or the preview shows the whole
       * order's value instead of this fill's. */
      numerator: parsed.name === 'fulfillAdvancedOrder' ? BigInt(parsed.args[0].numerator) : 1n,
      denominator: parsed.name === 'fulfillAdvancedOrder' ? BigInt(parsed.args[0].denominator) : 1n,
      criteriaResolvers: parsed.name === 'fulfillAdvancedOrder'
        ? [...(parsed.args[1] || [])].map((r) => ({ orderIndex: Number(r.orderIndex), side: Number(r.side), index: Number(r.index), identifier: BigInt(r.identifier) }))
        : [],
    };
  } catch { return null; }
}

/* Small async pool — funding checks fan out per offer but must not hammer the
 * RPC with 20 parallel calls. */
async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j], j);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return out;
}

/* Funding check for one offer: the maker must hold AND have approved at least
 * one item's worth of the payment token — Seaport pulls it from their wallet
 * at fill time, so an unfunded offer just reverts and burns the seller's gas.
 * Returns { checked, funded, payableItems }; payableItems = how many items the
 * maker can still pay for at the per-item price. RPC read errors return
 * checked:false and the caller fails open (accept-time guard still protects). */
async function checkOfferFunding(offer, provider, chainCfg) {
  try {
    const p = offer.raw?.protocol_data?.parameters;
    const payItem = (p?.offer || []).find((x) => Number(x.itemType) === 1);
    if (!payItem || !offer.maker) return { checked: false };
    const payToken = String(payItem.token);
    const proto = offer.protocolAddress || SEAPORT;
    const qty = BigInt(Math.max(1, Number(offer.quantity) || 1));
    const perItemRaw = BigInt(payItem.startAmount) / qty;
    if (perItemRaw === 0n) return { checked: false };
    /* Who pulls the maker's payment: the order's own conduit, else Seaport.
     * Unresolvable puller (stripped getConduit, no chain override) → fall
     * back to balance-only check instead of a false "unfunded". */
    let puller = proto;
    const conduitKey = p.conduitKey;
    if (conduitKey && conduitKey !== ethers.ZeroHash) {
      puller = await resolveConduit(proto, conduitKey, provider, chainCfg);
    }
    const balHex = await provider.call({ to: payToken, data: ERC20_IFACE.encodeFunctionData('balanceOf', [offer.maker]) });
    const bal = BigInt(balHex || '0x0');
    let usable = bal;
    if (puller) {
      try {
        const allowHex = await provider.call({ to: payToken, data: ERC20_IFACE.encodeFunctionData('allowance', [offer.maker, puller]) });
        const allow = BigInt(allowHex || '0x0');
        if (allow < bal) usable = allow;
      } catch { /* balance-only */ }
    }
    return { checked: true, funded: usable >= perItemRaw, payableItems: Number(usable / perItemRaw) };
  } catch {
    return { checked: false };
  }
}

async function bestOffers(chainKey, slug, opts = {}) {
  const d = await osFetch(`/api/v2/offers/collection/${slug}?limit=${opts.limit || 20}`);
  const list = (d.offers || []).map((o) => {
    /* Prefer OpenSea's normalized price (correct currency + decimals for the
     * chain). Parsing offer items directly assumes WETH/18 decimals, which is
     * wrong on other chains — only a last resort. */
    let price = null;
    if (o.price?.current?.value != null) {
      price = Number(ethers.formatUnits(String(o.price.current.value), o.price.current.decimals ?? 18));
    } else {
      const wethItem = (o.protocol_data?.parameters?.offer || []).find((x) => Number(x.itemType) === 1);
      if (wethItem) price = Number(ethers.formatEther(String(wethItem.startAmount)));
    }
    const cons = o.protocol_data?.parameters?.consideration || [];
    const payItem = (o.protocol_data?.parameters?.offer || []).find((x) => Number(x.itemType) === 1);
    /* Quantity = how many NFTs the buyer wants. ONLY NFT-type consideration
     * items count (2=ERC721, 3=ERC1155, 4/5=criteria variants). Summing every
     * item drags in the ERC20 fee item whose amount is in wei — that produced
     * phantom quantities like 14,000,000,000,014 for a 14-item offer. */
    const quantity = cons.reduce((a, x) => ([2, 3, 4, 5].includes(Number(x.itemType)) ? a + Number(x.startAmount || 0) : a), 0);
    /* OpenSea's normalized price is the order TOTAL for multi-item offers.
     * Normalize to per-item so floor-diff and checkout show real numbers. */
    const perItem = quantity > 1 && price != null ? price / quantity : price;
    return {
      orderHash: o.order_hash,
      price: perItem,
      totalPrice: price,
      quantity,
      criteria: o.criteria || null,
      protocolAddress: o.protocol_address,
      expires: o.expiration_time || null,
      maker: o.maker || o.protocol_data?.parameters?.offerer || null,
      paymentToken: payItem ? String(payItem.token) : null,
      raw: o,
    };
  });

  /* FUNDED-ONLY FILTER. Unfunded offers (maker holds/approves less than one
   * item's payment) can never be accepted — they just clutter the grid and
   * tempt gas-burning accepts. Check balance+allowance per offer in parallel;
   * unreadable checks fail open (the accept-time guard is the backstop). */
  if (list.length) {
    const c = chainsMod.chain(chainKey);
    const urls = rpc.urlsFor(chainKey);
    const provider = rpc.provider(urls[0], c.id);
    const checks = await poolMap(list, 6, (offer) => checkOfferFunding(offer, provider, c));
    for (let i = 0; i < list.length; i++) {
      const chk = checks[i] || { checked: false };
      list[i].funded = chk.checked ? chk.funded : null;
      list[i].payableItems = chk.checked ? chk.payableItems : null;
    }
  }
  const visible = opts.includeUnfunded ? list : list.filter((o) => o.funded !== false);
  return visible.sort((a, b) => (b.price || 0) - (a.price || 0));
}

/* Shared read-only preparation for accepting an offer: fetch the stored order,
 * fetch + decode the fulfillment calldata, run every safety check, derive the
 * approval operator. Used by BOTH the preview (checkout display) and the real
 * accept, so the numbers shown are exactly the numbers that get signed. */
async function _prepareAccept(chainKey, walletId, orderHash, opts = {}) {
  const c = chainsMod.chain(chainKey);
  const w = wallets.getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');
  const proto = opts.protocolAddress || SEAPORT;

  /* 1) Independently fetch the stored order by hash — the reference we verify
   * the fulfillment calldata against. */
  const od = await osFetch(`/api/v2/orders/chain/${c.osSlug}/protocol/${proto}/${orderHash}`);
  const fo = od?.order || od;
  const foParams = fo?.protocol_data?.parameters;
  if (!foParams) throw new Error('order not found on OpenSea');
  const foOffer = (foParams.offer || []).map((x) => ({
    itemType: Number(x.itemType), token: String(x.token).toLowerCase(),
    startAmount: BigInt(x.startAmount), endAmount: BigInt(x.endAmount),
  }));
  if (!foOffer.length) throw new Error('stored order has no offer items');
  if (!foOffer.every((x) => x.itemType === 1)) throw new Error('refusing: offer does not pay entirely in ERC20 (WETH)');

  const urls = rpc.urlsFor(chainKey);
  const p = rpc.provider(urls[0], c.id);

  /* 2) Fulfillment calldata from OpenSea. */
  const d = await osFetch(`/api/v2/offers/fulfillment_data`, {
    method: 'POST',
    body: JSON.stringify({
      offer: { hash: orderHash, chain: c.osSlug, protocol_address: proto },
      fulfiller: { address: w.address },
      consideration: opts.tokenId ? { asset_contract_address: opts.contract, token_id: String(opts.tokenId) } : undefined,
    }),
  });
  const tx = d?.fulfillment_data?.transaction;
  if (!tx) {
    store.appendLog('nft-ops.log', `accept-offer: no transaction in fulfillment_data. raw=${JSON.stringify(d).slice(0, 4000)}`);
    throw new Error(`no fulfillment calldata from OpenSea: ${JSON.stringify(d?.errors || d || {}).slice(0, 200)}`);
  }
  const data = tx.input_data ? encodeFromInputData(tx) : tx.data;
  if (!data) {
    store.appendLog('nft-ops.log', `accept-offer: calldata encode failed. fn=${tx.function} input_keys=${tx.input_data ? Object.keys(tx.input_data).join('|') : 'none'} raw=${JSON.stringify(d).slice(0, 16000)}`);
    throw new Error(`cannot build calldata (fn=${String(tx.function || '?').split('(')[0]}, keys=${tx.input_data ? Object.keys(tx.input_data).join(',') : 'no input_data'})`);
  }

  /* 3) Hard safety checks BEFORE anything is signed:
   * - accepting an offer receives payment — it must never send ETH value;
   * - the calldata target must be exactly the Seaport protocol contract and
   *   actually deployed on-chain (with the conduit approval live, a hostile
   *   `to` could drain the wallet's NFTs). */
  if (BigInt(tx.value || 0) !== 0n) throw new Error('refusing: accepting an offer must not send ETH value');
  const to = String(tx.to || '');
  if (to.toLowerCase() !== proto.toLowerCase()) throw new Error(`refusing: calldata target ${to} is not the Seaport protocol ${proto}`);
  const pcode = await p.getCode(to);
  if (!pcode || pcode === '0x') throw new Error('refusing: protocol address has no code on-chain');

  /* 4) Decode the calldata (known fulfill selectors only) and cross-check the
   * embedded order against the stored order fetched in step 1. */
  const dec = decodeFulfillCalldata(data);
  if (!dec) throw new Error('refusing: calldata is not a known Seaport fulfill function');
  if (dec.offerer.toLowerCase() !== String(foParams.offerer || '').toLowerCase()) throw new Error('refusing: embedded offerer differs from stored order');
  store.appendLog('nft-ops.log', `accept-offer prep ${orderHash.slice(0, 12)} token=${opts.tokenId ?? '-'} fn=${dec.name} kind=${dec.kind}`);

  let receiveAmount;
  if (dec.kind === 'basic') {
    /* basic route: offer* = what the buyer pays (we receive it),
     * consideration* = our NFT (we give it), additionalRecipients = fees. */
    const pay = foOffer[0];
    if (dec.getToken.toLowerCase() !== pay.token) throw new Error('refusing: payment token differs from stored order');
    if (dec.getAmount !== pay.startAmount) throw new Error('refusing: payment amount differs from stored order');
    if (opts.contract && dec.giveToken.toLowerCase() !== String(opts.contract).toLowerCase()) throw new Error('refusing: NFT contract differs from expected');
    if (opts.tokenId != null && dec.giveId !== BigInt(opts.tokenId)) throw new Error('refusing: NFT token id differs from expected');
    receiveAmount = dec.getAmount;
    const feeSum = dec.feeItems.reduce((a, x) => a + x.amount, 0n);
    const capBps = maxTotalFeeBps();
    if (feeSum * 10000n > receiveAmount * BigInt(capBps)) {
      throw new Error(`refusing: offer fees ${(Number((feeSum * 10000n) / receiveAmount) / 100).toFixed(2)}% exceed ${capBps / 100}% cap`);
    }
  } else if (dec.kind === 'match') {
    /* Match route: OpenSea matches the bid against a synthetic counter order
     * it builds from the seller's acceptance. Verify the bid copy against the
     * stored order, then verify the counter order is EXACTLY "we give this one
     * NFT, we receive the bid's net amount" — nothing more can move. */
    if (dec.offer.length !== foOffer.length) throw new Error('refusing: match bid offer item count differs from stored order');
    for (let i = 0; i < foOffer.length; i++) {
      const a = dec.offer[i]; const b = foOffer[i];
      if (a.token.toLowerCase() !== b.token || a.itemType !== b.itemType || a.startAmount !== b.startAmount) {
        throw new Error(`refusing: match bid offer item ${i} differs from stored order`);
      }
    }
    if (opts.contract) {
      const nftItem = dec.consideration.find((x) => ([2, 3, 4, 5].includes(x.itemType)) && x.token.toLowerCase() === String(opts.contract).toLowerCase());
      if (!nftItem) throw new Error('refusing: match bid has no consideration item for the expected NFT contract');
    }
    /* The criteria resolver must aim the bid at exactly the token we're selling. */
    if (opts.tokenId != null) {
      const aimed = dec.criteriaResolvers.some((r) => r.orderIndex === dec.bidIndex && r.side === 1 && r.identifier === BigInt(opts.tokenId));
      if (!aimed) throw new Error('refusing: match calldata does not resolve the bid to the expected token id');
    }
    const fillNum = dec.numerator ?? 1n;
    const fillDen = (dec.denominator ?? 1n) || 1n;
    receiveAmount = dec.offer[0].startAmount * fillNum / fillDen;
    const feeSum = dec.consideration.filter((x) => x.itemType === 1).reduce((a, x) => a + x.startAmount * fillNum / fillDen, 0n);
    const capBps = maxTotalFeeBps();
    if (feeSum * 10000n > receiveAmount * BigInt(capBps)) {
      throw new Error(`refusing: offer fees ${(Number((feeSum * 10000n) / receiveAmount) / 100).toFixed(2)}% exceed ${capBps / 100}% cap`);
    }
    /* Payment routing: recipient must be the selling wallet, and the counter
     * order (offerer = us) must offer exactly our NFT and be paid the net. */
    if (String(dec.recipient).toLowerCase() !== w.address.toLowerCase()) {
      throw new Error(`refusing: match recipient ${dec.recipient} is not the selling wallet`);
    }
    if (dec.otherOrders.length !== 1) throw new Error(`refusing: expected exactly 1 counter order in match calldata, got ${dec.otherOrders.length}`);
    const ctr = dec.otherOrders[0].params;
    if (String(ctr.offerer).toLowerCase() !== w.address.toLowerCase()) {
      throw new Error('refusing: match counter order is not from the selling wallet');
    }
    const ctrOffer = [...ctr.offer].map((x) => ({ itemType: Number(x.itemType), token: String(x.token).toLowerCase(), id: BigInt(x.identifierOrCriteria), amount: BigInt(x.startAmount) }));
    if (ctrOffer.length !== 1 || ![2, 3].includes(ctrOffer[0].itemType) || ctrOffer[0].amount !== 1n) {
      throw new Error('refusing: counter order does not offer exactly one NFT');
    }
    if (opts.contract && ctrOffer[0].token !== String(opts.contract).toLowerCase()) throw new Error('refusing: counter order offers a different NFT contract');
    if (opts.tokenId != null && ctrOffer[0].id !== BigInt(opts.tokenId)) throw new Error('refusing: counter order offers a different token id');
    const ctrPay = [...ctr.consideration].filter((x) => Number(x.itemType) === 1);
    if (!ctrPay.length) throw new Error('refusing: counter order receives no ERC20 payment');
    if (ctrPay.some((x) => String(x.token).toLowerCase() !== dec.offer[0].token.toLowerCase())) throw new Error('refusing: counter order is paid in a different token than the bid');
    const ctrSum = ctrPay.reduce((a, x) => a + BigInt(x.startAmount), 0n);
    const net = receiveAmount - feeSum;
    if (ctrSum * 100n < net * 99n) throw new Error('refusing: counter order pays less than the bid net amount');
    if (ctrPay.some((x) => String(x.recipient).toLowerCase() !== w.address.toLowerCase())) throw new Error('refusing: counter order payment does not go to the selling wallet');
    /* Who pulls our NFT: the counter order's own conduit key (Seaport moves
     * offer items via the order's conduit in match). */
    dec.counterConduitKey = ctr.conduitKey;
  } else {
    if (dec.offer.length !== foOffer.length) throw new Error('refusing: offer item count differs from stored order');
    for (let i = 0; i < foOffer.length; i++) {
      const a = dec.offer[i]; const b = foOffer[i];
      if (a.token.toLowerCase() !== b.token || a.itemType !== b.itemType || a.startAmount !== b.startAmount) {
        throw new Error(`refusing: offer item ${i} differs from stored order`);
      }
    }
    /* Batch fills duplicate the order once per item — every copy must match
     * the stored order, not just the first one. */
    if (dec.allParams) {
      for (let k = 1; k < dec.allParams.length; k++) {
        const prm = dec.allParams[k];
        if (String(prm.offerer).toLowerCase() !== String(foParams.offerer || '').toLowerCase()) {
          throw new Error(`refusing: batch copy ${k} offerer differs from stored order`);
        }
        const off = [...prm.offer].map((x) => ({ itemType: Number(x.itemType), token: String(x.token).toLowerCase(), startAmount: BigInt(x.startAmount) }));
        if (off.length !== foOffer.length || off.some((x, i) => x.token !== foOffer[i].token || x.itemType !== foOffer[i].itemType || x.startAmount !== foOffer[i].startAmount)) {
          throw new Error(`refusing: batch copy ${k} offer items differ from stored order`);
        }
      }
    }
    if (opts.contract) {
      /* 2=ERC721, 3=ERC1155, 4/5=criteria (wildcard/merkle) variants —
       * collection offers use 4, so all four count here. */
      const nftItem = dec.consideration.find((x) => ([2, 3, 4, 5].includes(x.itemType)) && x.token.toLowerCase() === String(opts.contract).toLowerCase());
      if (!nftItem) throw new Error('refusing: no consideration item for the expected NFT contract');
      /* criteria offers carry a merkle root instead of the id — only enforce
       * the id when an item actually names it */
      if (opts.tokenId != null) {
        /* id=0 is a WILDCARD criteria (any token in the collection) — it must
         * NOT be compared against the requested tokenId; a merkle root
         * (id >= 2^200) can't be compared either. For both, the criteria
         * resolver inside the calldata is what actually picks the token, so
         * verify THAT aims at our tokenId instead. Only a real explicit id
         * (0 < id < 2^200) is compared directly. */
        const explicitId = nftItem.id > 0n && nftItem.id < (BigInt(1) << 200n);
        if (explicitId) {
          if (nftItem.id !== BigInt(opts.tokenId)) {
            throw new Error('refusing: NFT token id differs from expected');
          }
        } else if (dec.criteriaResolvers && dec.criteriaResolvers.length) {
          const aimed = dec.criteriaResolvers.some((r) => r.identifier === BigInt(opts.tokenId));
          if (!aimed) throw new Error('refusing: criteria resolver does not target the expected token id');
        }
      }
    }
    /* Scale by the fill fraction: selling 1 item into a 14-item order pays
     * 1/14 of the order's WETH total, not the whole thing. */
    const fillNum = dec.numerator ?? 1n;
    const fillDen = (dec.denominator ?? 1n) || 1n;
    receiveAmount = dec.offer[0].startAmount * fillNum / fillDen;
    const feeSum = dec.consideration.filter((x) => x.itemType === 1).reduce((a, x) => a + x.startAmount * fillNum / fillDen, 0n);
    const capBps = maxTotalFeeBps();
    if (feeSum * 10000n > receiveAmount * BigInt(capBps)) {
      throw new Error(`refusing: offer fees ${(Number((feeSum * 10000n) / receiveAmount) / 100).toFixed(2)}% exceed ${capBps / 100}% cap`);
    }
  }

  /* 5) The UI passes the price it displayed — the order must actually pay it. */
  if (opts.expectedPrice != null && opts.expectedPrice !== '') {
    const exp = ethers.parseUnits(String(opts.expectedPrice), 18);
    if (receiveAmount * 100n < exp * 99n) {
      throw new Error(`refusing: order pays less than the ${opts.expectedPrice} that was displayed`);
    }
  }

  /* 6) Maker funding check. Seaport pulls the payment from the maker's wallet
   * at fill time — an unfunded or unapproved offer REVERTS and burns the
   * seller's gas. Verify balance and allowance of this fill's payment before
   * anything is signed. Read errors are non-fatal (we only block on a
   * definitive shortfall). */
  {
    const payTokenAddr = dec.kind === 'basic' ? dec.getToken : dec.offer[0].token;
    const fmtU = (v) => { try { return ethers.formatUnits(v, 18); } catch { return String(v); } };
    let bal = null;
    try {
      bal = BigInt(await p.call({ to: payTokenAddr, data: ERC20_IFACE.encodeFunctionData('balanceOf', [foParams.offerer]) }));
    } catch { /* unreadable — skip balance guard */ }
    if (bal != null && bal < receiveAmount) {
      throw new Error(`maker cannot pay: holds ${fmtU(bal)} but this fill needs ${fmtU(receiveAmount)} — offer is unfunded, accepting would just burn gas`);
    }
    /* Allowance goes to whatever operator moves the maker's payment: the
     * order's own conduit, or Seaport directly when it has no conduit. When
     * the puller can't be determined (fork without getConduit and no chain
     * override), skip the allowance check — balance check still applies. */
    try {
      let puller = null;
      const orderConduit = foParams.conduitKey;
      if (orderConduit && orderConduit !== ethers.ZeroHash) {
        puller = await resolveConduit(proto, orderConduit, p, c);
      } else {
        puller = proto; /* no conduit — Seaport pulls the payment directly */
      }
      if (puller) {
        const allow = BigInt(await p.call({ to: payTokenAddr, data: ERC20_IFACE.encodeFunctionData('allowance', [foParams.offerer, puller]) }));
        if (allow < receiveAmount) {
          throw new Error(`maker has not approved the marketplace for this payment (allowance ${fmtU(allow)} < ${fmtU(receiveAmount)}) — accepting would just burn gas`);
        }
      }
    } catch (e) {
      if (/maker has not approved/.test(String(e.message))) throw e;
      /* allowance unreadable — don't block on it */
    }
  }

  /* The operator that pulls our NFT out of the wallet is chosen by the
   * fulfillment calldata itself (fulfillerConduitKey), and it differs per
   * chain — approving ethereum's conduit on another chain makes the fulfill
   * revert. Derive the exact operator on-chain: no conduit -> Seaport pulls
   * directly (approve the protocol), otherwise Seaport.getConduit(key). */
  let fulfillOperator = proto;
  if (dec.kind === 'match') {
    /* Match route: our NFT leaves via the counter order's offer items, which
     * Seaport moves through that order's own conduit. Approve that operator. */
    if (dec.counterConduitKey && dec.counterConduitKey !== ethers.ZeroHash) {
      const conduit = await resolveConduit(proto, dec.counterConduitKey, p, c);
      if (!conduit) {
        throw new Error(`refusing: no open conduit for counter-order key ${String(dec.counterConduitKey).slice(0, 14)}… on ${c.name} — approval target unclear`);
      }
      fulfillOperator = conduit;
    }
  } else if (dec.fulfillerConduitKey && dec.fulfillerConduitKey !== ethers.ZeroHash) {
    /* resolveConduit handles forks without getConduit() via chain config. */
    const conduit = await resolveConduit(proto, dec.fulfillerConduitKey, p, c);
    if (!conduit) {
      throw new Error(`refusing: no open conduit for key ${String(dec.fulfillerConduitKey).slice(0, 14)}… on ${c.name} — approval target unclear`);
    }
    fulfillOperator = conduit;
  }

  return { c, w, proto, p, urls, to, data, dec, receiveAmount, fulfillOperator, foParams };
}

const ERC20_IFACE = new ethers.Interface([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
/* Best-effort ERC20 metadata. Some tokens return bytes32 symbols — the decode
 * is wrapped, so worst case we fall back to WETH/18 (the common offer token). */
async function tokenInfo(chainKey, address) {
  try {
    const c = chainsMod.chain(chainKey);
    const urls = rpc.urlsFor(chainKey);
    const p = rpc.provider(urls[0], c.id);
    const [s, d] = await Promise.all([
      p.call({ to: address, data: ERC20_IFACE.encodeFunctionData('symbol') }).catch(() => null),
      p.call({ to: address, data: ERC20_IFACE.encodeFunctionData('decimals') }).catch(() => null),
    ]);
    let symbol = null, decimals = 18;
    if (s) { try { symbol = ERC20_IFACE.decodeFunctionResult('symbol', s)[0]; } catch { /* bytes32 symbol */ } }
    if (d) { try { decimals = Number(ERC20_IFACE.decodeFunctionResult('decimals', d)[0]); } catch { /* keep 18 */ } }
    return { symbol, decimals };
  } catch { return { symbol: null, decimals: 18 }; }
}

/* OpenSea-style checkout preview: runs every verification the real accept
 * does, then returns the exact fee split and net proceeds for display. No
 * signing, no approval, no broadcast. */
async function previewOfferAccept(chainKey, walletId, orderHash, opts = {}) {
  const prep = await _prepareAccept(chainKey, walletId, orderHash, opts);
  const { dec, receiveAmount, foParams } = prep;
  /* Fees scaled by the same fill fraction as receiveAmount, so the checkout
   * shows exactly what THIS fill pays (1/14 of a 14-item order, not all). */
  const fillNum = dec.numerator ?? 1n;
  const fillDen = (dec.denominator ?? 1n) || 1n;
  const feeItems = dec.kind === 'basic'
    ? dec.feeItems
    : dec.consideration.filter((x) => x.itemType === 1).map((x) => ({ amount: x.startAmount * fillNum / fillDen, recipient: x.recipient }));
  const feeSum = feeItems.reduce((a, x) => a + x.amount, 0n);
  const payToken = dec.kind === 'basic' ? dec.getToken : dec.offer[0].token;
  const ti = await tokenInfo(chainKey, payToken);
  const decs = Number.isFinite(ti.decimals) ? ti.decimals : 18;
  const fmt = (v) => ethers.formatUnits(v, decs);
  const fees = feeItems.map((f) => ({
    recipient: f.recipient,
    amount: fmt(f.amount),
    pct: receiveAmount > 0n ? Number((f.amount * 10000n) / receiveAmount) / 100 : 0,
    label: String(f.recipient).toLowerCase() === OS_FEE_RECIPIENT.toLowerCase() ? 'OpenSea fee' : 'Creator fee',
  }));
  return {
    gross: fmt(receiveAmount),
    feeTotal: fmt(feeSum),
    net: fmt(receiveAmount - feeSum),
    fees,
    paymentToken: { address: payToken, symbol: ti.symbol || 'WETH', decimals: decs },
    maker: foParams.offerer,
    endTime: foParams.endTime ? Number(foParams.endTime) : null,
    giveToken: dec.kind === 'basic' ? dec.giveToken : (opts.contract || null),
    giveId: dec.kind === 'basic' ? dec.giveId.toString() : (opts.tokenId != null ? String(opts.tokenId) : null),
    approvalOperator: prep.fulfillOperator,
    fillNumerator: Number(fillNum),
    fillDenominator: Number(fillDen),
  };
}

async function acceptOffer(chainKey, walletId, orderHash, opts = {}) {
  const prep = await _prepareAccept(chainKey, walletId, orderHash, opts);
  const { c, w, p, urls, to, data } = prep;
  const appr = await ensureApproval(chainKey, walletId, opts.contract, { operator: prep.fulfillOperator });
  /* If we just broadcast the approval, wait for it to land before estimating
   * the fill — otherwise estimateGas reverts (no approval yet) and the fill
   * flies on a blind fallback gas limit. RH blocks are ~1/s-fast. */
  if (appr.waiting && opts.contract) {
    for (let i = 0; i < 25; i++) {
      try {
        const raw = await p.call({ to: opts.contract, data: ERC721.encodeFunctionData('isApprovedForAll', [w.address, prep.fulfillOperator]) });
        if (ERC721.decodeFunctionResult('isApprovedForAll', raw)[0]) break;
      } catch { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  const signer = new ethers.Wallet(w.pk, p);
  const fee = await wallets.feeData(chainKey);
  let gasLimit;
  try { gasLimit = (await p.estimateGas({ from: w.address, to, data, value: 0n })) * 13n / 10n; }
  catch { gasLimit = 400000n; }
  const nonce = await p.getTransactionCount(w.address, 'pending');
  const raw = await signer.signTransaction({
    chainId: c.id, to, data, value: 0n, nonce, gasLimit,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });
  const res = await rpc.broadcast(chainKey, raw, urls);
  store.appendLog('nft-ops.log', `accept offer ${orderHash.slice(0, 12)} by ${w.address} ${res.hash}`);
  return { hash: res.hash, wallet: w.address };
}

/* BULK offer accept: many offers (possibly across multiple wallets) in ONE call.
 * Same per-offer safety checks as acceptOffer (_prepareAccept), but:
 *  - all offers prepared in PARALLEL (OpenSea fetches + safety checks)
 *  - approvals deduplicated per (wallet, contract, operator), waited once
 *  - fills signed with pipelined sequential nonces, broadcast in PARALLEL
 *  - NO waiting between offers — the whole batch flies in ~one round trip time.
 * Items: [{ walletId, orderHash, contract?, tokenId?, protocolAddress?, expectedPrice? }]
 * Result per item: { orderHash, tokenId, wallet, hash, gross, net, symbol }
 *               or { orderHash, tokenId, wallet, error }. */
async function acceptOffersBulk(chainKey, items, opts = {}) {
  if (!Array.isArray(items) || !items.length) throw new Error('no offers given');
  const c = chainsMod.chain(chainKey);

  /* 1) Prepare every offer in parallel — full safety checks, read-only. */
  const preps = await poolMap(items, 3, async (it) => {
    try {
      const prep = await _prepareAccept(chainKey, it.walletId, it.orderHash, { ...opts, ...it });
      /* net proceeds for reporting (same math as previewOfferAccept) */
      const fillNum = prep.dec.numerator ?? 1n;
      const fillDen = (prep.dec.denominator ?? 1n) || 1n;
      const feeItems = prep.dec.kind === 'basic'
        ? prep.dec.feeItems
        : prep.dec.consideration.filter((x) => x.itemType === 1).map((x) => ({ amount: x.startAmount * fillNum / fillDen }));
      const feeSum = feeItems.reduce((a, x) => a + x.amount, 0n);
      return { it, prep, gross: prep.receiveAmount, net: prep.receiveAmount - feeSum };
    } catch (e) {
      return { it, error: String(e.shortMessage || e.message).slice(0, 180) };
    }
  });
  const out = preps.filter((x) => x.error).map((x) => ({ orderHash: x.it.orderHash, tokenId: x.it.tokenId ?? null, wallet: x.it.walletId, error: x.error }));
  const ok = preps.filter((x) => x.prep);
  if (!ok.length) return out;

  /* 2) Approvals: dedupe per (wallet, contract, operator); ensure once each. */
  const apprSeen = new Map();
  for (const { it, prep } of ok) {
    if (!it.contract) continue;
    const k = `${it.walletId}|${String(it.contract).toLowerCase()}|${String(prep.fulfillOperator).toLowerCase()}`;
    if (!apprSeen.has(k)) apprSeen.set(k, { walletId: it.walletId, contract: it.contract, operator: prep.fulfillOperator });
  }
  let waiting = [];
  for (const a of apprSeen.values()) {
    try {
      const appr = await ensureApproval(chainKey, a.walletId, a.contract, { operator: a.operator });
      if (appr.waiting) waiting.push(a);
    } catch (e) {
      /* approval failed — every fill for this (wallet,contract) will revert; fail them now */
      for (const x of ok) {
        if (x.it.walletId === a.walletId && String(x.it.contract || '').toLowerCase() === String(a.contract).toLowerCase() && !x.dead) {
          x.dead = true;
          out.push({ orderHash: x.it.orderHash, tokenId: x.it.tokenId ?? null, wallet: a.walletId, error: `approval failed: ${String(e.message).slice(0, 120)}` });
        }
      }
    }
  }
  const alive = ok.filter((x) => !x.dead);
  if (!alive.length) return out;

  /* 3) Wait for fresh approvals to land (parallel poll), else estimateGas reverts. */
  if (waiting.length) {
    const p = rpc.provider(rpc.urlsFor(chainKey)[0], c.id);
    for (let i = 0; i < 25 && waiting.length; i++) {
      const states = await Promise.all(waiting.map(async (a) => {
        try {
          const w = wallets.getWallet('evm', a.walletId);
          const raw = await p.call({ to: a.contract, data: ERC721.encodeFunctionData('isApprovedForAll', [w.address, a.operator]) });
          return ERC721.decodeFunctionResult('isApprovedForAll', raw)[0];
        } catch { return false; }
      }));
      waiting = waiting.filter((_, j) => !states[j]);
      if (waiting.length) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  /* 4) Per wallet: fee once, nonce once, estimate in parallel, sign+broadcast all. */
  const fee = await wallets.feeData(chainKey);
  /* payment-token decimals+symbol (deduped) so gross/net report real units */
  const payTokens = [...new Set(alive.map((x) => (x.prep.dec.kind === 'basic' ? x.prep.dec.getToken : x.prep.dec.offer[0].token)))];
  const decByToken = {};
  const symByToken = {};
  await Promise.all(payTokens.map(async (t) => { try { const ti = await tokenInfo(chainKey, t); decByToken[String(t).toLowerCase()] = Number(ti.decimals) || 18; symByToken[String(t).toLowerCase()] = ti.symbol || null; } catch { decByToken[String(t).toLowerCase()] = 18; } }));
  const byWallet = new Map();
  for (const x of alive) {
    if (!byWallet.has(x.it.walletId)) byWallet.set(x.it.walletId, []);
    byWallet.get(x.it.walletId).push(x);
  }
  await Promise.all([...byWallet.entries()].map(async ([walletId, group]) => {
    const w = wallets.getWallet('evm', walletId);
    const p = rpc.provider(rpc.urlsFor(chainKey)[0], c.id);
    const urls = rpc.urlsFor(chainKey);
    /* gas estimates in parallel (approvals are live by now) */
    await Promise.all(group.map(async (x) => {
      try { x.gasLimit = (await p.estimateGas({ from: w.address, to: x.prep.to, data: x.prep.data, value: 0n })) * 13n / 10n; }
      catch { x.gasLimit = 400000n; }
    }));
    let nonce = opts.nonce != null ? Number(opts.nonce) : await p.getTransactionCount(w.address, 'pending');
    group.forEach((x) => { x.nonce = nonce++; }); /* allocate SYNCHRONOUSLY — no collisions */
    const signer = new ethers.Wallet(w.pk, p);
    await Promise.all(group.map(async (x) => {
      try {
        const raw = await signer.signTransaction({
          chainId: c.id, to: x.prep.to, data: x.prep.data, value: 0n, nonce: x.nonce,
          gasLimit: x.gasLimit, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
        });
        const res = await rpc.broadcast(chainKey, raw, urls);
        store.appendLog('nft-ops.log', `accept offer (bulk) ${x.it.orderHash.slice(0, 12)} token=${x.it.tokenId ?? '-'} by ${w.address} ${res.hash}`);
        const payTok = (x.prep.dec.kind === 'basic' ? x.prep.dec.getToken : x.prep.dec.offer[0].token).toLowerCase();
        const decs = decByToken[payTok] || 18;
        out.push({ orderHash: x.it.orderHash, tokenId: x.it.tokenId ?? null, wallet: w.address, hash: res.hash, gross: ethers.formatUnits(x.gross, decs), net: ethers.formatUnits(x.net, decs), symbol: symByToken[payTok] || undefined });
      } catch (e) {
        out.push({ orderHash: x.it.orderHash, tokenId: x.it.tokenId ?? null, wallet: w.address, error: String(e.shortMessage || e.message).slice(0, 180) });
      }
    }));
  }));
  return out;
}

function encodeFromInputData(tx) {
  /* OpenSea returns {function: "<nameless signature>", input_data: {named args}}.
   * The signature carries NO parameter names, so ethers cannot map input_data
   * by name — encode the known entrypoints positionally against the canonical
   * ABI (FULFILL_IFACE, selectors verified on-chain). */
  try {
    const sigName = String(tx.function || '').split('(')[0];
    const inp = tx.input_data || {};
    const pick = (...ks) => { for (const k of ks) { if (inp[k] !== undefined) return inp[k]; } return undefined; };
    const itemArr = (x) => [Number(x.itemType), x.token, String(x.identifierOrCriteria), String(x.startAmount), String(x.endAmount)];
    const consArr = (x) => [Number(x.itemType), x.token, String(x.identifierOrCriteria), String(x.startAmount), String(x.endAmount), x.recipient];
    const advArr = (o) => {
      const p = o.parameters;
      return [
        [p.offerer, p.zone, [...(p.offer || [])].map(itemArr), [...(p.consideration || [])].map(consArr),
          Number(p.orderType), String(p.startTime), String(p.endTime), p.zoneHash, String(p.salt),
          p.conduitKey, Number(p.totalOriginalConsiderationItems)],
        Number(o.numerator ?? 1), Number(o.denominator ?? 1), o.signature || '0x', o.extraData || '0x',
      ];
    };
    const resArr = (r) => [Number(r.orderIndex), Number(r.side), Number(r.index), String(r.identifier), r.criteriaProof || []];
    const compArr = (c) => [Number(c.orderIndex), Number(c.itemIndex)];

    if (sigName === 'matchAdvancedOrders') {
      const orders = pick('orders', 'advancedOrders');
      const fulfillments = pick('fulfillments', 'fulfillmentComponents');
      const recipient = pick('recipient');
      if (!orders || !fulfillments || recipient === undefined) return null;
      return FULFILL_IFACE.encodeFunctionData('matchAdvancedOrders', [
        orders.map(advArr),
        (pick('criteriaResolvers', 'resolvers') || []).map(resArr),
        fulfillments.map((f) => [(f.offerComponents || []).map(compArr), (f.considerationComponents || []).map(compArr)]),
        recipient,
      ]);
    }
    if (sigName === 'fulfillAdvancedOrder') {
      const order = pick('advancedOrder', 'order');
      const conduitKey = pick('fulfillerConduitKey', 'conduitKey');
      const recipient = pick('recipient');
      if (!order || conduitKey === undefined || recipient === undefined) return null;
      return FULFILL_IFACE.encodeFunctionData('fulfillAdvancedOrder', [
        advArr(order), (pick('criteriaResolvers', 'resolvers') || []).map(resArr), conduitKey, recipient,
      ]);
    }
    if (sigName === 'fulfillAvailableAdvancedOrders' || sigName === 'fulfillAvailableOrders') {
      const orders = pick('orders', 'advancedOrders');
      const conduitKey = pick('fulfillerConduitKey', 'conduitKey');
      const recipient = pick('recipient');
      const maxF = pick('maximumFulfilled', 'maximumFulfill');
      if (!orders || conduitKey === undefined || recipient === undefined) return null;
      const isAdv = sigName === 'fulfillAvailableAdvancedOrders';
      return FULFILL_IFACE.encodeFunctionData(sigName, [
        orders.map(isAdv ? advArr : (o) => [advArr(o)[0], o.signature || '0x']),
        (pick('criteriaResolvers', 'resolvers') || []).map(resArr),
        (pick('orderComponents', 'fulfillments') || []).map((x) => (Array.isArray(x) ? x.map(compArr) : x)),
        (pick('considerationComponents') || []).map((x) => (Array.isArray(x) ? x.map(compArr) : x)),
        conduitKey, recipient, String(maxF ?? orders.length),
      ]);
    }
    if (sigName === 'fulfillOrder') {
      const order = pick('order');
      const conduitKey = pick('fulfillerConduitKey', 'conduitKey');
      if (!order || conduitKey === undefined) return null;
      return FULFILL_IFACE.encodeFunctionData('fulfillOrder', [[advArr(order)[0], order.signature || '0x'], conduitKey]);
    }
    /* Unknown entrypoint: last-ditch positional encode from JSON key order. */
    const iface = new ethers.Interface([`function ${tx.function}`]);
    const frag = iface.getFunction(sigName);
    let args = frag.inputs.map((i) => inp[i.name]);
    if (args.some((a) => a === undefined)) {
      const vals = Object.values(inp);
      if (vals.length !== frag.inputs.length) return null;
      args = vals;
    }
    return iface.encodeFunctionData(frag, args);
  } catch { return null; }
}

/* ---------------- PnL ---------------- */

async function pnl(chainKey, addresses, opts = {}) {
  const c = chainsMod.chain(chainKey);
  const fx = await fxrate.rates();
  const ethUsd = fx.ethUsd;

  const rows = [];
  /* Primary mints come from the local activity log, not OpenSea. A mint that
   * was never resold has no sale event, so without this the mint price and gas
   * are invisible and every held mint looks like pure profit. */
  const activity = require('./activity');
  const mintSpend = {};   // "address|slug" -> { spent, gas, qty }
  for (const it of activity.list(300)) {
    if (it.kind !== 'mint' || !it.ok || !it.address) continue;
    const slug = it.slug || it.collection || 'unknown';
    const k = `${String(it.address).toLowerCase()}|${slug}`;
    mintSpend[k] = mintSpend[k] || { spent: 0, gas: 0, qty: 0 };
    mintSpend[k].spent += Number(it.priceEth || 0);
    mintSpend[k].gas += Number(it.feeEth || 0);
    mintSpend[k].qty += Number(it.qty || 1);
  }

  for (const a of addresses) {
    let next = null, pages = 0;
    const per = {};
    do {
      const q = new URLSearchParams({ limit: '50', event_type: 'sale' });
      if (next) q.set('next', next);
      const d = await osFetch(`/api/v2/events/accounts/${a}?${q}`).catch(() => null);
      if (!d) break;
      for (const ev of d.asset_events || []) {
        const slug = ev.nft?.collection || 'unknown';
        per[slug] = per[slug] || { collection: slug, bought: 0, sold: 0, spent: 0, received: 0 };
        const px = ev.payment ? Number(ethers.formatUnits(String(ev.payment.quantity), ev.payment.decimals ?? 18)) : 0;
        if (String(ev.seller || '').toLowerCase() === a.toLowerCase()) { per[slug].sold++; per[slug].received += px; }
        else if (String(ev.buyer || '').toLowerCase() === a.toLowerCase()) { per[slug].bought++; per[slug].spent += px; }
      }
      next = d.next || null;
    } while (next && ++pages < (opts.maxPages || 4));

    // holdings valued at floor
    const inv = await inventory(chainKey, [a], { maxPages: 3 }).catch(() => []);
    const bySlug = {};
    for (const n of inv) { bySlug[n.collection] = (bySlug[n.collection] || 0) + 1; }
    for (const [slug, count] of Object.entries(bySlug)) {
      per[slug] = per[slug] || { collection: slug, bought: 0, sold: 0, spent: 0, received: 0 };
      per[slug].holding = count;
      const fp = await collectionFloor(chainKey, slug).catch(() => null);
      per[slug].floor = fp;
      per[slug].holdValue = fp != null ? fp * count : null;
    }
    /* Fold mint cost in. Keyed per wallet+collection, so a mint on one wallet
     * never lands on another's row. */
    for (const [k, m] of Object.entries(mintSpend)) {
      const [addr, slug] = k.split('|');
      if (addr !== a.toLowerCase()) continue;
      per[slug] = per[slug] || { collection: slug, bought: 0, sold: 0, spent: 0, received: 0 };
      per[slug].minted = (per[slug].minted || 0) + m.qty;
      per[slug].mintSpent = (per[slug].mintSpent || 0) + m.spent;
      per[slug].gas = (per[slug].gas || 0) + m.gas;
      per[slug].spent += m.spent;
    }
    for (const r of Object.values(per)) {
      /* Gas is a real cost and it is known exactly for mints done here, so it
       * is subtracted rather than ignored. */
      r.net = (r.received + (r.holdValue || 0)) - r.spent - (r.gas || 0);
      r.netUsd = ethUsd ? r.net * ethUsd : null;
      rows.push({ wallet: a, ...r });
    }
  }
  const totals = rows.reduce((a, r) => ({
    spent: a.spent + r.spent, received: a.received + r.received,
    gas: a.gas + (r.gas || 0),
    holdValue: a.holdValue + (r.holdValue || 0), net: a.net + r.net,
  }), { spent: 0, received: 0, gas: 0, holdValue: 0, net: 0 });

  /* Best collections, merged across wallets — this is what the home dashboard
   * shows as "Top plays", so it is computed here rather than in the UI where
   * only the cached slice is available. */
  const byCol = {};
  for (const r of rows) {
    byCol[r.collection] = byCol[r.collection] || { collection: r.collection, net: 0, holding: 0 };
    byCol[r.collection].net += r.net;
    byCol[r.collection].holding += r.holding || 0;
  }
  const top = Object.values(byCol).sort((x, y) => y.net - x.net).slice(0, 6);

  return {
    chain: c.key, ethUsd, usdIdr: fx.usdIdr, rows, totals, top,
    netUsd: ethUsd ? totals.net * ethUsd : null,
    netIdr: fxrate.convert(totals.net, fx).idr,
    at: Date.now(),
  };
}

module.exports = {
  SEAPORT, SEAPORT_1_5, CONDUIT, CONDUIT_KEY, OS_FEE_RECIPIENT,
  inventory, transferNft, sweepCollection, ensureApproval, listNft, cancelListing, orderToComponents, cancelCallData, CANCEL_TUPLE,
  transferBatch, sweepCollectionBulk, deployBatchSender, getBatchSender,
  listNftBulk, cancelBatch,
  extractListingOrder, typesMatch, approvalOperator,
  /* internals exported for the self-test harness (/tmp/sim-all.js) — pure
   * logic only, not wired to any HTTP route */
  verifyListingOrder, normalizeOrder, seaportVersion, decodeFulfillCalldata, encodeFromInputData, ORDER_TYPES,
  shouldRelist, collectionFloor, collectionListingCurrency, startFloorWar, stopFloorWar, listFloorWars,
  bestOffers, acceptOffer, acceptOffersBulk, previewOfferAccept, tokenInfo, pnl, osFetch,
};
