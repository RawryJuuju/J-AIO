'use strict';
/* Sniper Engine — monitor listings & auto-buy via Seaport 1.6 fulfillOrder.
 * Safety: confirm typed, max price guard, dry-run mode option. */

const { ethers } = require('ethers');
const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const wallets = require('./wallets');
const nftops = require('./nftops');

const snipers = new Map();

function listSnipers() {
  return [...snipers.values()].map((s) => ({
    id: s.id, running: s.running, chain: s.cfg.chain, contract: s.cfg.contract,
    slug: s.cfg.slug, maxPrice: s.cfg.maxPrice, walletId: s.cfg.walletId,
    buys: s.buys, log: s.log.slice(-20),
  }));
}

function stopSniper(id) {
  const s = snipers.get(id);
  if (!s) return false;
  s.running = false;
  return true;
}

async function fulfillSeaportOrder(chainKey, walletId, listingOrder) {
  const c = chainsMod.chain(chainKey);
  const w = wallets.getWallet('evm', walletId);
  if (!w) throw new Error('wallet not found');

  const p = (listingOrder.protocol_data && listingOrder.protocol_data.parameters) || listingOrder.parameters;
  if (!p) throw new Error('invalid order parameters');

  const comp = nftops.orderToComponents(p);
  const sig = listingOrder.protocol_data?.signature || listingOrder.signature || '0x';
  const orderStruct = [
    comp.offerer, comp.zone, comp.offer.map((o) => [o.itemType, o.token, o.identifierOrCriteria, o.startAmount, o.endAmount]),
    comp.consideration.map((o) => [o.itemType, o.token, o.identifierOrCriteria, o.startAmount, o.endAmount, o.recipient]),
    comp.orderType, comp.startTime, comp.endTime, comp.zoneHash, comp.salt, comp.conduitKey, comp.counter,
  ];

  const urls = rpc.urlsFor(chainKey);
  const prov = rpc.provider(urls[0], c.id);
  const signer = new ethers.Wallet(w.pk, prov);

  const priceWei = BigInt(listingOrder.price?.current?.value || p.consideration[0]?.startAmount || '0');
  const SEAPORT_IFACE = new ethers.Interface([
    'function fulfillOrder(((address,address,(uint8,address,uint256,uint256,uint256)[],(uint8,address,uint256,uint256,uint256,address)[],uint8,uint256,uint256,bytes32,uint256,bytes32,uint256),bytes),bytes32) payable returns (bool)',
  ]);

  const data = SEAPORT_IFACE.encodeFunctionData('fulfillOrder', [[orderStruct, sig], nftops.CONDUIT_KEY]);
  const fee = await wallets.feeData(chainKey, {});
  let gasLimit;
  try { gasLimit = (await prov.estimateGas({ from: signer.address, to: nftops.SEAPORT, data, value: priceWei })) * 12n / 10n; }
  catch { gasLimit = 220000n; }

  const nonce = await prov.getTransactionCount(w.address, 'pending');
  const raw = await signer.signTransaction({
    chainId: c.id, to: nftops.SEAPORT, data, value: priceWei, gasLimit, nonce,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2,
  });

  const res = await rpc.broadcast(chainKey, raw, urls);
  store.appendLog('nft-ops.log', `snipe-buy ${c.key} order:${listingOrder.order_hash} price:${ethers.formatEther(priceWei)} by ${w.address} tx:${res.hash}`);
  return { ok: true, hash: res.hash };
}

function startSniper(cfg) {
  if (!cfg.chain || !cfg.slug || !cfg.maxPrice || !cfg.walletId) {
    throw new Error('chain, slug, maxPrice, and walletId required');
  }
  const id = 'snp_' + Date.now().toString(36);
  const state = { id, cfg, running: true, buys: 0, log: [] };
  snipers.set(id, state);

  const log = (msg) => { state.log.push({ t: Date.now(), msg }); };
  log(`Started sniper for ${cfg.slug} max ${cfg.maxPrice} ETH`);

  (async () => {
    while (state.running) {
      try {
        const d = await nftops.osFetch(`/api/v2/listings/collection/${cfg.slug}/all?limit=10`).catch(() => null);
        if (d && d.listings) {
          for (const listing of d.listings) {
            if (!state.running) break;
            const priceEth = Number(listing.price?.current?.value ? ethers.formatEther(listing.price.current.value) : 0);
            if (priceEth > 0 && priceEth <= Number(cfg.maxPrice)) {
              log(`Found listing #${listing.asset?.identifier} at ${priceEth} ETH (<= ${cfg.maxPrice})`);
              if (cfg.dryRun) {
                log(`[DRY RUN] Would buy #${listing.asset?.identifier} at ${priceEth} ETH`);
                state.buys++;
              } else {
                try {
                  const r = await fulfillSeaportOrder(cfg.chain, cfg.walletId, listing);
                  log(`BOUGHT #${listing.asset?.identifier} tx: ${r.hash}`);
                  state.buys++;
                  if (cfg.once) { state.running = false; break; }
                } catch (e) {
                  log(`Buy failed #${listing.asset?.identifier}: ${e.message}`);
                }
              }
            }
          }
        }
      } catch (e) { log(`Poll error: ${e.message}`); }
      for (let i = 0; i < (cfg.intervalSec || 10); i++) {
        if (!state.running) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    log('Sniper stopped');
  })();

  return { id, running: true };
}

module.exports = { startSniper, stopSniper, listSnipers, fulfillSeaportOrder };
