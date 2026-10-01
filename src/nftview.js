'use strict';
/* NFT collection viewer — the "NFT Manager" surface.
 *
 * Zyper's NFT tab answers one question fast: which of MY wallets hold tokens
 * from THIS contract, and what is each token worth right now. That needs four
 * different OpenSea endpoints stitched together, so it lives here rather than
 * in nftops.js (which is about writing: transfer, list, accept).
 *
 *   contract -> slug        /api/v2/chain/{c}/contract/{addr}
 *   slug     -> floor       /api/v2/collections/{slug}/stats
 *   wallet   -> held tokens /api/v2/chain/{c}/account/{a}/nfts?collection=
 *   token    -> listing     /api/v2/listings/collection/{slug}/nfts/{id}/best
 *   token    -> rarity      carried on the nft payload itself
 *
 * Per-token lookups are the expensive part (2 calls each), so they run with a
 * small concurrency window and the collection-wide floor is fetched once.
 */
const { ethers } = require('ethers');
const chainsMod = require('./chains');
const nftops = require('./nftops');
const store = require('./store');

const CONC = 6;

/* ---------- TTL cache ----------
 * Collection loads used to be fully serial (resolve -> stats -> inventory per
 * wallet -> ownerOf per token -> listings -> rarity per token) with zero
 * caching, so every reload paid the sum of every phase. Static-ish data
 * (identity, fees, floor, listings, owners) is now cached briefly and the
 * remaining phases run concurrently. Reloads within TTL are near-instant. */
const TTL = { resolve: 600e3, stats: 45e3, market: 45e3, owner: 30e3, royalty: 600e3, rarityMiss: 600e3 };
const cache = new Map();
function cacheGet(k) {
  const e = cache.get(k);
  if (e && Date.now() - e.at < e.ttl) return e.v;
  if (e) cache.delete(k);
  return undefined;
}
function cacheSet(k, v, ttl) {
  if (cache.size > 800) {
    const now = Date.now();
    for (const [key, e] of cache) if (now - e.at >= e.ttl) cache.delete(key);
  }
  cache.set(k, { v, at: Date.now(), ttl });
  return v;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { error: String(e.message).slice(0, 120) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------- collection identity ---------- */

/* Accepts a contract address, an OpenSea slug, or a full OpenSea URL. */
function parseTarget(input) {
  const s = String(input || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return { address: s };
  const m = s.match(/opensea\.io\/(?:[a-z-]+\/)?collection\/([^/?#]+)/i);
  if (m) return { slug: m[1] };
  const m2 = s.match(/opensea\.io\/assets\/([a-z_-]+)\/(0x[a-fA-F0-9]{40})/i);
  if (m2) return { chain: m2[1], address: m2[2] };
  if (/^[a-z0-9-]+$/i.test(s)) return { slug: s };
  return {};
}

/* On-chain EIP-2981 royalty read, cached — royalty config changes rarely and
 * the RPC round-trip on every collection load was a big slice of latency. */
async function readRoyaltyOnchain(chainKey, address) {
  const ck = `royalty:${chainKey}:${String(address).toLowerCase()}`;
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;
  let out = null;
  try {
    const c = chainsMod.chain(chainKey);
    const urls = require('./rpc').readUrls(chainKey);
    if (!urls.length) return null;
    const provider = require('./rpc').provider(urls[0], c.id);
    const iface = new ethers.Interface(['function royaltyInfo(uint256,uint256) view returns (address,uint256)']);
    const raw = await provider.call({ to: address, data: iface.encodeFunctionData('royaltyInfo', ['0', '10000']) });
    const [recipient, amount] = iface.decodeFunctionResult('royaltyInfo', raw);
    const bps = Number(amount);
    if (recipient !== ethers.ZeroAddress && bps > 0 && bps <= 1000) out = { recipient, bps };
  } catch { /* contract has no EIP-2981 or RPC unavailable */ }
  return cacheSet(ck, out, TTL.royalty);
}

async function resolveCollection(chainKey, input) {
  const ck = `resolve:${chainKey}:${String(input || '').trim().toLowerCase()}`;
  const hit = cacheGet(ck);
  if (hit) return hit;

  const c = chainsMod.chain(chainKey);
  if (!c.osSlug) throw new Error(`no OpenSea support on ${c.name}`);
  const t = parseTarget(input);
  if (!t.slug && !t.address) throw new Error('paste a contract address, OpenSea slug, or OpenSea URL');

  let slug = t.slug || null;
  let address = t.address || null;

  if (!slug && address) {
    const d = await nftops.osFetch(`/api/v2/chain/${c.osSlug}/contract/${address}`);
    slug = d.collection || null;
    if (!slug) throw new Error('contract has no OpenSea collection');
  }

  /* When the address is known up front, fetch the collection metadata and the
   * on-chain royalty in parallel instead of back-to-back. */
  let col = null;
  let onchainFee = null;
  if (address) {
    [col, onchainFee] = await Promise.all([
      nftops.osFetch(`/api/v2/collections/${slug}`).catch(() => null),
      readRoyaltyOnchain(chainKey, address),
    ]);
  } else {
    col = await nftops.osFetch(`/api/v2/collections/${slug}`).catch(() => null);
    if (col) {
      const onChain = (col.contracts || []).find((x) => x.chain === c.osSlug) || (col.contracts || [])[0];
      address = onChain ? onChain.address : null;
    }
    if (address) onchainFee = await readRoyaltyOnchain(chainKey, address);
  }

  /* Creator fee resolution (display only — the listing order itself is built
   * by OpenSea's /listings/actions, so its fee items are authoritative).
   * 1. On-chain EIP-2981 royaltyInfo — works for most mainnet contracts.
   * 2. OpenSea collection `fees` array — REQUIRED for e.g. Robinhood chain,
   *    where EIP-1167 clones answer royaltyInfo() with (0x0, 0) while OpenSea
   *    still enforces creator fees. `fee` is in PERCENT (1 = 1%); the old
   *    ×10000 normalisation is what produced the 1100% bug. OpenSea's own
   *    recipient is the platform fee, not a creator — skip it here. */
  let creatorFees = [];
  let feeSource = 'none';
  if (onchainFee) {
    creatorFees = [{ recipient: onchainFee.recipient, bps: onchainFee.bps, enforced: true }];
    feeSource = 'onchain';
  }
  if (!creatorFees.length && col && Array.isArray(col.fees)) {
    for (const f of col.fees) {
      const recipient = f && f.recipient;
      if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) continue;
      if (recipient.toLowerCase() === nftops.OS_FEE_RECIPIENT.toLowerCase()) continue;
      const pct = Number(f.fee);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 25) continue; /* unit-corruption guard */
      creatorFees.push({ recipient, bps: Math.round(pct * 100), enforced: f.required !== false });
    }
    feeSource = 'opensea';
  }

  return cacheSet(ck, {
    chain: c.key, osChain: c.osSlug, slug, address,
    /* Empty array = no creator fee (legit); OpenSea validates the final order
     * either way, so the UI never hard-blocks listing on fee reads. */
    creatorFees,
    creatorFeesRead: true,
    feeSource,
    name: (col && col.name) || slug,
    image: (col && (col.image_url || col.banner_image_url)) || null,
    supply: col ? col.total_supply : null,
    verified: col ? col.safelist_status === 'verified' : null,
  }, TTL.resolve);
}

async function collectionStats(slug) {
  const ck = `stats:${slug}`;
  const hit = cacheGet(ck);
  if (hit) return hit;
  const d = await nftops.osFetch(`/api/v2/collections/${slug}/stats`).catch(() => null);
  if (!d) return { floor: null, volume: null, owners: null, listed: null };
  const t = d.total || {};
  return cacheSet(ck, {
    floor: t.floor_price != null ? Number(t.floor_price) : null,
    floorSymbol: t.floor_price_symbol || 'ETH',
    volume: t.volume != null ? Number(t.volume) : null,
    owners: t.num_owners != null ? Number(t.num_owners) : null,
    sales: t.sales != null ? Number(t.sales) : null,
    marketCap: t.market_cap != null ? Number(t.market_cap) : null,
  }, TTL.stats);
}

/* ---------- per-token market data ---------- */

function wei(x, decimals) {
  if (x == null) return null;
  try { return Number(ethers.formatUnits(String(x), decimals == null ? 18 : decimals)); } catch { return null; }
}

const ERC721_IFACE = new ethers.Interface(['function ownerOf(uint256) view returns (address)']);

/* Bulk fetch of every listing for the collection (1 call + pagination, vs 1
 * call per token), cached briefly. Map by tokenId. */
async function allListings(slug, maxPages = 6) {
  const ck = `market:${slug}`;
  const hit = cacheGet(ck);
  if (hit) return hit;

  const out = {};
  let next = null, pages = 0, okPages = 0;
  do {
    const q = new URLSearchParams({ limit: '200' });
    if (next) q.set('next', next);
    const d = await nftops.osFetch(`/api/v2/listings/collection/${slug}/all?${q}`).catch(() => null);
    if (!d) break;
    okPages++;
    for (const o of d.listings || []) {
      if (o.status === 'cancelled' || o.status === 'expired') continue;
      const p = o.price ? (o.price.current || o.price) : null;
      if (!p) continue;
      const val = wei(p.value, p.decimals);
      if (val == null) continue;
      const entry = { price: val, symbol: p.currency || 'ETH', orderHash: o.order_hash || null, protocolAddress: o.protocol_address || null };
      const tid = o.asset && o.asset.identifier != null ? String(o.asset.identifier) : null;
      if (tid) {
        /* token-specific order — keep the highest */
        if (!out[tid] || !out[tid].listing || out[tid].listing.price < val) out[tid] = { listing: entry };
      }
    }
    next = d.next || null;
  } while (next && ++pages < maxPages);

  if (!okPages) throw new Error(`listings fetch failed for ${slug}`); /* don't cache failures */
  return cacheSet(ck, out, TTL.market);
}

async function bestListingFor(slug, tokenId) {
  const d = await nftops.osFetch(`/api/v2/listings/collection/${slug}/nfts/${tokenId}/best`).catch(() => null);
  if (!d || !d.price) return null;
  const p = d.price.current || d.price;
  return { price: wei(p.value, p.decimals), symbol: p.currency || 'ETH', orderHash: d.order_hash || null };
}

/* Re-verify each token's real owner on-chain. OpenSea's account inventory lags
 * after transfers, so a moved NFT would keep showing under the old wallet.
 * ownerOf() is ground truth: reassign to whichever selected wallet actually
 * holds it, drop tokens that left the selection entirely. ERC-1155 has no
 * ownerOf — balanceOf per wallet; only check tokens we already have. */
async function verifyOwners(chainKey, info, owned, walletList, maxConcurrency = 6) {
  const c = require('./chains').chain(chainKey);
  const walletByAddr = new Map(walletList.map((w) => [String(w.address).toLowerCase(), w]));
  if (owned.length === 0) return owned;
  if (!c.rpcs || !c.rpcs.length) return owned;
  if (owned.some((n) => (n.standard || 'erc721').toLowerCase() === 'erc1155')) return owned; /* no ownerOf — trust OS inventory */

  const { provider, readUrls } = require('./rpc');
  const urls = readUrls(chainKey);
  if (!urls.length) return owned;
  const p = provider(urls[0], c.id);
  const owners = await mapLimit(owned, maxConcurrency, async (n) => {
    /* Ownership rarely flips between reloads — cache hits skip the RPC entirely,
     * which is most of the reload latency on single-RPC chains like robinhood. */
    const ck = `owner:${chainKey}:${String(info.address).toLowerCase()}:${n.tokenId}`;
    const hit = cacheGet(ck);
    if (hit !== undefined) return { tokenId: n.tokenId, owner: hit };
    try {
      const addr = await p.call({ to: info.address, data: ERC721_IFACE.encodeFunctionData('ownerOf', [n.tokenId]) });
      const owner = ethers.getAddress('0x' + addr.slice(-40));
      cacheSet(ck, owner, TTL.owner);
      return { tokenId: n.tokenId, owner };
    } catch { return null; }
  });

  const byToken = new Map(owned.map((n) => [n.tokenId, n]));
  const out = [];
  for (const o of owners) {
    if (!o) continue;
    const n = byToken.get(o.tokenId);
    if (!n) continue;
    const w = walletByAddr.get(o.owner.toLowerCase());
    if (!w) continue; /* moved to a wallet outside the selection — drop */
    if (w.id !== n.ownerId) { n.ownerId = w.id; n.ownerName = w.name; n.owner = w.address; }
    out.push(n);
  }
  return out;
}

/* Rarity comes back on the account-nfts payload for most collections, but not
 * all — fall back to local trait cache or a single-token read when missing. */
function readRarityCache(slug) {
  try {
    const store = require('./store');
    const c = store.readPlain('rarity_cache', {});
    return c[slug] || null;
  } catch { return null; }
}

function writeRarityCache(slug, ranks) {
  try {
    const store = require('./store');
    const c = store.readPlain('rarity_cache', {});
    c[slug] = { ranks, at: Date.now() };
    store.writePlain('rarity_cache', c);
  } catch { /* ignore */ }
}

/* Local Trait Rarity Builder — computes RarityScore for collections without OS rarity.
   Score = sum(1 / (trait_count / total_tokens)). Rank = sorted by score DESC. */
async function buildRarityFromTraits(osChain, contractAddr, slug, totalTokens = 100) {
  const existing = readRarityCache(slug);
  if (existing) return existing.ranks;

  const nfts = [];
  let next = null;
  for (let p = 0; p < 10; p++) {
    const q = new URLSearchParams({ limit: '50' });
    if (next) q.set('next', next);
    const d = await nftops.osFetch(`/api/v2/chain/${osChain}/contract/${contractAddr}/nfts?${q}`).catch(() => null);
    if (!d || !d.nfts || !d.nfts.length) break;
    for (const n of d.nfts) {
      if (n.traits && Array.isArray(n.traits)) {
        nfts.push({ tokenId: String(n.identifier), traits: n.traits });
      }
    }
    next = d.next;
    if (!next) break;
  }
  if (!nfts.length) return null;

  const N = nfts.length;
  const traitCounts = {};
  for (const n of nfts) {
    for (const t of n.traits) {
      const key = `${t.trait_type}:${t.value}`;
      traitCounts[key] = (traitCounts[key] || 0) + 1;
    }
  }

  const scores = nfts.map((n) => {
    let score = 0;
    for (const t of n.traits) {
      const key = `${t.trait_type}:${t.value}`;
      const cnt = traitCounts[key] || 1;
      score += 1 / (cnt / N);
    }
    return { tokenId: n.tokenId, score };
  });

  scores.sort((a, b) => b.score - a.score);
  const ranks = {};
  scores.forEach((s, idx) => { ranks[s.tokenId] = { rank: idx + 1, score: Math.round(s.score * 100) / 100 }; });
  writeRarityCache(slug, ranks);
  return ranks;
}

async function rarityFor(osChain, address, tokenId, slug) {
  if (slug) {
    const cached = readRarityCache(slug);
    if (cached && cached.ranks && cached.ranks[tokenId]) return cached.ranks[tokenId];
  }
  /* Tokens without OS rarity re-hit the single-token endpoint on EVERY reload
   * before — cache the miss so the cost is paid once per 10 minutes. */
  const ck = `rarity:${osChain}:${String(address).toLowerCase()}:${tokenId}`;
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;
  const d = await nftops.osFetch(`/api/v2/chain/${osChain}/contract/${address}/nfts/${tokenId}`).catch(() => null);
  const r = d && d.nft && d.nft.rarity;
  const out = r ? { rank: r.rank, score: r.score } : null;
  return cacheSet(ck, out, out ? TTL.market : TTL.rarityMiss);
}

/* ---------- main entry ---------- */

/* wallets: [{id,name,address}]. Returns one row per held token, plus the
 * merged collection header the UI shows above the table. */
async function collection(chainKey, input, walletList, opts = {}) {
  const info = await resolveCollection(chainKey, input);
  const wantMarket = opts.market !== false;

  /* Phase 2 — all independent, run concurrently: collection stats, every
   * wallet's inventory at once (was serial per wallet), and the collection-wide
   * listings page. A load that used to sum every phase now costs only the
   * slowest one. */
  const [stats, invByWallet, listings] = await Promise.all([
    collectionStats(info.slug),
    /* Inventory is cached briefly too — ownerOf() below is ground truth on who
     * still holds what, so a 30s-stale inventory list is safe and makes warm
     * reloads cost zero network calls. Failures are NOT cached. */
    Promise.all(walletList.map((w) => {
      const ck = `inv:${chainKey}:${String(w.address).toLowerCase()}:${info.slug}`;
      const hit = cacheGet(ck);
      if (hit) return hit;
      return nftops.inventory(chainKey, [w.address], {
        collection: info.slug, maxPages: opts.maxPages || 4,
      }).then((r) => cacheSet(ck, r, TTL.owner)).catch(() => []);
    })),
    wantMarket ? allListings(info.slug).catch(() => null) : Promise.resolve(null),
  ]);

  let owned = [];
  walletList.forEach((w, i) => {
    for (const n of invByWallet[i] || []) {
      if (info.address && String(n.contract).toLowerCase() !== String(info.address).toLowerCase()) continue;
      owned.push({
        tokenId: String(n.tokenId), name: n.name || `#${n.tokenId}`, image: n.image || null,
        standard: n.standard || 'erc721',
        ownerId: w.id, ownerName: w.name, owner: w.address,
      });
    }
  });

  /* on-chain ownerOf() fixes the OpenSea indexing lag after transfers */
  owned = await verifyOwners(chainKey, info, owned, walletList);

  let market = [];
  if (wantMarket) {
    if (listings) {
      /* bulk data present — map it over our tokens, no per-token calls */
      const rarity = await mapLimit(owned, CONC, async (n) => {
        let r = n.rarity || null;
        if (!r && opts.rarity !== false) r = await rarityFor(info.osChain, info.address, n.tokenId, info.slug).catch(() => null);
        return r;
      });
      market = owned.map((n, i) => {
        const m = listings[String(n.tokenId)] || {};
        return { listing: m.listing || null, rarity: rarity[i] || null };
      });
    } else {
      /* bulk endpoint down — fall back to per-token best reads */
      market = await mapLimit(owned, CONC, async (n) => {
        const listing = await bestListingFor(info.slug, n.tokenId);
        let rarity = n.rarity || null;
        if (!rarity && opts.rarity !== false) rarity = await rarityFor(info.osChain, info.address, n.tokenId, info.slug).catch(() => null);
        return { listing, rarity };
      });
    }
  }

  const rows = owned.map((n, i) => ({
    ...n,
    listing: market[i] && market[i].listing ? market[i].listing.price : null,
    listingHash: market[i] && market[i].listing ? market[i].listing.orderHash : null,
    rarityRank: market[i] && market[i].rarity ? market[i].rarity.rank : null,
  }));

  rows.sort((a, b) => (a.rarityRank || 1e9) - (b.rarityRank || 1e9));

  /* Currency sanity: stats floor_price_symbol may default to ETH while the
   * collection actually trades in another token (e.g. USDG on Robinhood).
   * If the active listings overwhelmingly use one symbol, trust it and recompute
   * the floor as the cheapest listing in that symbol. */
  let floorSymbol = stats.floorSymbol || 'ETH';
  let floor = stats.floor;
  if (listings) {
    const bySymbol = {};
    for (const k of Object.keys(listings)) {
      const l = listings[k].listing;
      if (!l) continue;
      const s = l.symbol || 'ETH';
      (bySymbol[s] = bySymbol[s] || { n: 0, min: Infinity }).n++;
      bySymbol[s].min = Math.min(bySymbol[s].min, l.price);
    }
    const dom = Object.entries(bySymbol).sort((a, b) => b[1].n - a[1].n)[0];
    if (dom && dom[0].toUpperCase() !== floorSymbol.toUpperCase()) {
      floorSymbol = dom[0];
      if (Number.isFinite(dom[1].min)) floor = dom[1].min;
    }
  }

  const walletsHolding = new Set(rows.map((r) => r.owner.toLowerCase())).size;
  return {
    ...info, ...stats,
    floor, floorSymbol,
    rows,
    count: rows.length,
    walletsHolding,
    at: Date.now(),
  };
}

/* ---------- PnL card data ---------- */

/* The card in Zyper shows Minted / Sold / Bought / Holding with an ETH figure
 * under each, then the net. The numbers come from the same OpenSea event crawl
 * PnL already does, filtered to one collection so the card is per-project. */
async function pnlCard(chainKey, input, walletList, opts = {}) {
  const info = await resolveCollection(chainKey, input);
  const stats = await collectionStats(info.slug);
  const addresses = walletList.map((w) => w.address);

  const acc = {
    minted: 0, mintedEth: 0, sold: 0, soldEth: 0,
    bought: 0, boughtEth: 0, holding: 0, gasEth: 0,
  };

  for (const a of addresses) {
    let next = null, pages = 0;
    do {
      const q = new URLSearchParams({ limit: '50' });
      if (next) q.set('next', next);
      const d = await nftops.osFetch(`/api/v2/events/accounts/${a}?${q}`).catch(() => null);
      if (!d) break;
      for (const ev of d.asset_events || []) {
        if (info.slug && ev.nft && ev.nft.collection !== info.slug) continue;
        const p = ev.payment;
        const px = p ? wei(p.quantity, p.decimals) || 0 : 0;
        const me = (x) => String(x || '').toLowerCase() === a.toLowerCase();
        if (ev.event_type === 'sale') {
          if (me(ev.seller)) { acc.sold++; acc.soldEth += px; }
          else if (me(ev.buyer)) { acc.bought++; acc.boughtEth += px; }
        } else if (ev.event_type === 'transfer' && me(ev.to_address)
          && /^0x0{40}$/.test(String(ev.from_address || ''))) {
          acc.minted++;
        }
      }
      next = d.next || null;
    } while (next && ++pages < (opts.maxPages || 4));
  }

  const inv = await nftops.inventory(chainKey, addresses, { collection: info.slug, maxPages: 3 }).catch(() => []);
  acc.holding = inv.filter((n) => !info.address
    || String(n.contract).toLowerCase() === String(info.address).toLowerCase()).length;

  const fp = stats.floor;
  const holdEth = fp != null ? fp * acc.holding : 0;
  const spent = acc.boughtEth + acc.mintedEth;
  const net = acc.soldEth + holdEth - spent;
  const pct = spent > 0 ? (net / spent) * 100 : null;

  let ethUsd = null, usdIdr = null;
  try {
    const fx = await require('./fxrate').rates();
    ethUsd = fx.ethUsd; usdIdr = fx.usdIdr;
  } catch { /* offline — card renders crypto only */ }

  const card = {
    collection: info.name, slug: info.slug, image: info.image, chain: info.chain,
    floor: fp, wallets: addresses.length,
    minted: acc.minted, mintedEth: acc.mintedEth,
    sold: acc.sold, soldEth: acc.soldEth,
    bought: acc.bought, boughtEth: acc.boughtEth,
    holding: acc.holding, holdingEth: holdEth,
    spentEth: spent, netEth: net, pct, ethUsd, usdIdr,
    netUsd: ethUsd != null ? net * ethUsd : null,
    netIdr: ethUsd != null && usdIdr != null ? net * ethUsd * usdIdr : null,
    at: Date.now(),
  };
  try { store.writeSealed('pnl_card_last', card); } catch { /* locked */ }
  return card;
}

module.exports = {
  parseTarget, resolveCollection, collectionStats, collection, pnlCard,
  bestListingFor, buildRarityFromTraits,
};
