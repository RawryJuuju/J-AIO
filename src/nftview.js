'use strict';
const { ethers } = require('ethers');
const chainsMod = require('./chains');
const nftops = require('./nftops');
const store = require('./store');

const CONC = 6;

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


function wei(x, decimals) {
  if (x == null) return null;
  try { return Number(ethers.formatUnits(String(x), decimals == null ? 18 : decimals)); } catch { return null; }
}

const ERC721_IFACE = new ethers.Interface(['function ownerOf(uint256) view returns (address)']);

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
  const ck = `rarity:${osChain}:${String(address).toLowerCase()}:${tokenId}`;
  const hit = cacheGet(ck);
  if (hit !== undefined) return hit;
  const d = await nftops.osFetch(`/api/v2/chain/${osChain}/contract/${address}/nfts/${tokenId}`).catch(() => null);
  const r = d && d.nft && d.nft.rarity;
  const out = r ? { rank: r.rank, score: r.score } : null;
  return cacheSet(ck, out, out ? TTL.market : TTL.rarityMiss);
}


async function collection(chainKey, input, walletList, opts = {}) {
  const info = await resolveCollection(chainKey, input);
  const wantMarket = opts.market !== false;

  const [stats, invByWallet, listings] = await Promise.all([
    collectionStats(info.slug),
    mapLimit(walletList, 8, async (w) => {
      const ck = `inv:${chainKey}:${String(w.address).toLowerCase()}:${info.slug}`;
      const hit = cacheGet(ck);
      if (hit) return hit;
      const fetchInv = () => nftops.inventory(chainKey, [w.address], {
        collection: info.slug, maxPages: opts.maxPages || 4,
      });
      let r = null;
      try { r = await fetchInv(); }
      catch { /* rate-limited or proxy hiccup — one retry before giving up as empty */ await new Promise((res) => setTimeout(res, 800)); try { r = await fetchInv(); } catch { r = []; } }
      return r && r.length ? cacheSet(ck, r, TTL.owner) : r || [];
    }),
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

  owned = await verifyOwners(chainKey, info, owned, walletList);

  let market = [];
  if (wantMarket) {
    if (listings) {
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
