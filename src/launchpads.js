'use strict';
const { ethers } = require('ethers');
const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const abiMod = require('./abi');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function detect(url) {
  const u = String(url || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(u)) return { kind: 'contract', address: u };
  if (/^[a-z0-9_-]+$/i.test(u)) return { kind: 'opensea', url: `https://opensea.io/collection/${u}` };
  let h = '';
  let parsed;
  try { parsed = new URL(u); h = parsed.hostname.replace(/^www\./, ''); } catch { return { kind: 'unknown' }; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return { kind: 'custom', url: u };
  if (h === 'opensea.io' || h === 'testnets.opensea.io') return { kind: 'opensea', url: u };
  if (h === 'mintbay.xyz' || h.endsWith('.mintbay.xyz')) return { kind: 'mintbay', url: u };
  if (h === 'transient.xyz' || h.endsWith('.transient.xyz') || h === 'transientlabs.xyz' || h.endsWith('.transientlabs.xyz')) return { kind: 'transient', url: u };
  if (h === 'blever.xyz' || h.endsWith('.blever.xyz') || h === 'blever.io' || h.endsWith('.blever.io')) return { kind: 'blever', url: u };
  if (h === 'launchmynft.io' || h === 'www.launchmynft.io') return { kind: 'launchmynft', url: u };
  if (h === 'zora.co' || h.endsWith('.zora.co')) return { kind: 'zora', url: u };
  if (h === 'manifold.xyz' || h.endsWith('.manifold.xyz') || h === 'manifold.gallery' || h.endsWith('.manifold.gallery')) return { kind: 'manifold', url: u };
  if (h === 'scatter.art' || h === 'www.scatter.art') return { kind: 'scatter', url: u };
  return { kind: 'custom', url: u };
}

function rejectPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/[\[\]]/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal' || h.endsWith('.local')) throw new Error('private host rejected');
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) throw new Error('private host rejected');
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')) throw new Error('private host rejected');
}

async function j(url, opts = {}) {
  const { fetch } = require('undici');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('HTTPS URL required');
  if (parsed.username || parsed.password || parsed.port) throw new Error('unsafe URL');
  rejectPrivateHost(parsed.hostname);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, accept: 'application/json', ...(opts.headers || {}) },
    method: opts.method || 'GET', body: opts.body, redirect: 'error',
    dispatcher: opts.dispatcher, signal: AbortSignal.timeout(opts.timeout || 20000),
  });
  if (!r.ok) return { ok: false, status: r.status, data: null, text: '' };
  const len = Number(r.headers.get('content-length') || 0);
  if (len > 5_000_000) throw new Error('response too large');
  const chunks = []; let size = 0;
  if (!r.body) return { ok: true, status: r.status, data: null, text: '' };
  for await (const chunk of r.body) {
    size += chunk.length;
    if (size > 5_000_000) throw new Error('response too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let data = null;
  try { data = JSON.parse(text); } catch { /* html */ }
  return { ok: r.ok, status: r.status, data, text };
}


function osKey() {
  const s = store.readSettings();
  return s.openseaKey || null;
}

function parseOsUrl(u) {
  const m1 = /opensea\.io\/collection\/([^/?#]+)/.exec(u);
  if (m1) return { slug: m1[1] };
  const m2 = /opensea\.io\/(?:item|assets)\/([^/]+)\/(0x[a-fA-F0-9]{40})/.exec(u);
  if (m2) return { chain: m2[1], address: m2[2] };
  return {};
}

async function opensea(url) {
  const key = osKey();
  if (!key) throw new Error('OpenSea API key required in Settings');
  const H = { 'X-API-KEY': key };
  const p = parseOsUrl(url);
  let slug = p.slug, chainSlug = p.chain, address = p.address;

  if (!slug && address) {
    const r = await j(`https://api.opensea.io/api/v2/chain/${chainSlug}/contract/${address}/nfts?limit=1`, { headers: H });
    slug = r.data?.nfts?.[0]?.collection;
  }
  if (!slug) throw new Error('cannot resolve OpenSea collection');

  const col = await j(`https://api.opensea.io/api/v2/collections/${slug}`, { headers: H });
  if (!col.ok) throw new Error(`OpenSea collection ${col.status}`);
  const c0 = col.data.contracts?.[0] || {};
  chainSlug = chainSlug || c0.chain || 'ethereum';
  address = address || c0.address;
  const chainKey = Object.keys(chainsMod.CHAINS).find((k) => chainsMod.CHAINS[k].osSlug === chainSlug) || 'ethereum';

  const stages = [];
  const dropsUrls = [
    `https://api.opensea.io/api/v2/drops/${slug}`,
    `https://api.opensea.io/api/v2/collections/${slug}/drop`,
  ];
  for (const du of dropsUrls) {
    if (stages.length) break;
    const dr = await j(du, { headers: H });
    if (!dr.ok || !dr.data) continue;
    const rawStages = [dr.data.stages, dr.data.public_stages, dr.data.private_stages, dr.data.allowlist_stages, dr.data.phases]
      .flatMap((x) => Array.isArray(x) ? x : []);
    if (!rawStages.length) continue;
    const seenStages = new Set();
    for (const st of rawStages) {
      const sid = String(st.uuid ?? st.stage_id ?? st.id ?? stages.length);
      if (seenStages.has(sid)) continue;
      seenStages.add(sid);
      const stageName = st.label || st.stage_name || st.name || st.phase_name || st.stage_type || (st.is_public ? 'Public' : `Stage ${stages.length}`);
      const stageType = st.stage_type || st.stageType || st.type || '';
      const publicFlag = st.is_public ?? st.isPublic;
      const isPublic = publicFlag === true || /public/.test(stageType) || /(^|[_ -])public([_ -]|$)/i.test(`${stageName} ${stageType}`) || /public[_ -]?sale/i.test(`${stageName} ${stageType}`);
      let price;
      if (st.price?.value != null) price = ethers.formatUnits(String(st.price.value), st.price.decimals ?? 18);
      else if (typeof st.price === 'string' && /^\d+$/.test(st.price)) price = ethers.formatUnits(st.price, 18);
      else price = (st.price_per_token || '0');
      const stT = st.start_time ?? st.startTime;
      const enT = st.end_time ?? st.endTime;
      stages.push({
        id: sid,
        name: stageName,
        price,
        currency: st.price?.currency || 'ETH',
        startTime: stT ? Math.floor(new Date(stT).getTime() / 1000) : null,
        endTime: enT ? Math.floor(new Date(enT).getTime() / 1000) : null,
        maxPerWallet: st.max_per_wallet ?? st.per_wallet_limit ?? st.mint_limit_per_wallet ?? null,
        stageType,
        isPublic,
      });
    }
  }
  const probe = await abiMod.probeContract(chainKey, address).catch(() => null);
  if (!stages.length && probe) {
    probe.phases.forEach((ph, i) => stages.push({ id: String(i), name: ph.name, price: ph.price, currency: 'ETH', maxPerWallet: ph.maxPerWallet, isPublic: true, onchain: true }));
  }
  return {
    platform: 'opensea', chain: chainKey, address, slug,
    name: col.data.name, supply: col.data.total_supply,
    stages, probe, mintMethod: 'opensea-api',
    note: 'OpenSea WL/public mint uses signed API calldata — mint via method=opensea-api',
  };
}

async function openseaMintData(chainKey, slug, stageId, walletAddress, quantity, dispatcher) {
  const key = osKey();
  if (!key) throw new Error('OpenSea API key required');
  const c = chainsMod.chain(chainKey);
  const body = JSON.stringify({ minter: walletAddress, quantity: Number(quantity) || 1 });
  const r = await j(`https://api.opensea.io/api/v2/drops/${slug}/mint`, {
    method: 'POST', headers: { 'X-API-KEY': key, 'content-type': 'application/json' }, body, dispatcher,
  });
  if (!r.ok) throw new Error(`OpenSea mint API ${r.status}: ${r.text.slice(0, 160)}`);
  const t = r.data?.transaction || r.data?.actions?.[0]?.transaction || r.data;
  if (!t?.to || !t?.data) throw new Error(`OpenSea mint API: no calldata (${r.text.slice(0, 120)})`);
  return { to: t.to, data: t.data, value: BigInt(t.value ?? 0), chainId: c.id };
}

async function openseaDropStages(slug) {
  const H = { 'X-API-KEY': osKey() || '', 'accept': 'application/json', 'user-agent': UA };
  const r = await j(`https://api.opensea.io/api/v2/drops/${slug}`, { headers: H });
  if (!r.ok || !r.data) throw new Error(`drops api ${r.status}`);
  const d = r.data;
  const rawStages = [d.stages, d.public_stages, d.private_stages, d.allowlist_stages, d.phases]
    .flatMap((x) => Array.isArray(x) ? x : []);
  const stages = rawStages.map((st) => ({
    id: String(st.uuid ?? st.stage_id ?? st.id ?? ''),
    label: st.label || st.stage_name || st.name || '',
    stageType: st.stage_type || st.stageType || '',
    startTime: st.start_time ? Math.floor(new Date(st.start_time).getTime() / 1000) : null,
    endTime: st.end_time ? Math.floor(new Date(st.end_time).getTime() / 1000) : null,
    priceWei: st.price != null ? BigInt(st.price) : null,
  })).filter((s) => s.id !== '');
  const act = d.active_stage || null;
  return {
    stages,
    activeStageId: act ? String(act.uuid ?? act.stage_id ?? act.id ?? '') : null,
    activeStageLabel: act ? (act.label || act.stage_name || '') : null,
    isMinting: !!d.is_minting,
    totalSupply: d.total_supply != null ? Number(d.total_supply) : null,
    maxSupply: d.max_supply != null ? Number(d.max_supply) : null,
  };
}

async function openseaDropStageTimes(slug) {
  const snap = await openseaDropStages(slug);
  return snap.stages.map((s) => ({ id: s.id, label: s.label, startTime: s.startTime }));
}

async function openseaKeepWarm() {
  await j('https://api.opensea.io/api/v2/chains', { headers: { 'X-API-KEY': osKey() || '', 'accept': 'application/json', 'user-agent': UA } });
}

async function openseaDropContract(slug) {
  const H = { 'X-API-KEY': osKey() || '', 'accept': 'application/json', 'user-agent': UA };
  const r = await j(`https://api.opensea.io/api/v2/collections/${slug}`, { headers: H });
  if (!r.ok) throw new Error(`collection api ${r.status}`);
  return r.data.contracts?.[0]?.address || null;
}

const GQL_URL = 'https://gql.opensea.io/graphql';
const OS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function _swapAlias(alias, chainSlug, wallet, contract, qty) {
  return `${alias}: swap(address: "${wallet}", fromAssets: [{ asset: { chain: "${chainSlug}", contractAddress: "0x0000000000000000000000000000000000000000" } }], toAssets: [{ asset: { chain: "${chainSlug}", contractAddress: "${contract}", tokenId: "0" }, quantity: "${qty}" }], action: MINT, capabilities: { eip7702: false }) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value } } } errors { message } }`;
}

async function openseaMintDataGqlBatch(chainKey, contractAddress, wallets, quantity, sess) {
  const { fetch } = require('undici');
  const c = chainsMod.chain(chainKey);
  const chainSlug = c.osSlug || chainKey;
  const aliases = wallets.map((w, i) => _swapAlias(`w${i}`, chainSlug, w.address, contractAddress.toLowerCase(), quantity));
  const body = JSON.stringify({ query: `query B { ${aliases.join(' ')} }`, variables: {}, operationName: 'B' });
  const r = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-app-id': 'os2-web', 'x-graphql-operation-type': 'query',
      accept: '*/*', origin: 'https://opensea.io', referer: 'https://opensea.io/', 'user-agent': OS_UA,
      cookie: `${sess.cookie}; connected-account-server-hint=${sess.address}`,
    },
    body, signal: AbortSignal.timeout(15000),
  });
  if (r.status === 429) throw new Error('GQL_RATE_LIMITED');
  if (r.status === 401 || r.status === 403) throw new Error(`GQL_AUTH_FAILED (${r.status})`);
  if (!r.ok) throw new Error(`GQL_HTTP_${r.status}`);
  const d = await r.json();
  if (d.errors && d.errors.length && !d.data) {
    throw new Error(`GQL_QUERY_ERROR: ${String((d.errors[0] || {}).message || '').slice(0, 140)}`);
  }
  const out = {};
  wallets.forEach((w, i) => {
    const node = d.data && d.data[`w${i}`];
    if (!node) { out[w.address] = { error: 'no data' }; return; }
    const errs = Array.isArray(node.errors) ? node.errors.map((e) => e.message).filter(Boolean) : [];
    const action = Array.isArray(node.actions) ? node.actions.find((a) => a && a.transactionSubmissionData) : null;
    const t = action && action.transactionSubmissionData;
    if (t && t.to && t.data) {
      out[w.address] = { to: t.to, data: t.data, value: BigInt(t.value ?? 0), chainId: c.id };
    } else {
      out[w.address] = { error: (errs.join('; ') || 'no calldata').slice(0, 160) };
    }
  });
  return out;
}


async function mintbay(url) {
  const m = /mintbay\.xyz\/(?:mint|collection)\/(\d+)\/(0x[a-fA-F0-9]{40})/i.exec(url);
  if (!m) throw new Error('bad Mintbay URL (expect /mint/<chainId>/<address>)');
  const chainId = Number(m[1]);
  const address = ethers.getAddress(m[2]);
  const c = chainsMod.byId(chainId);
  if (!c) throw new Error(`Mintbay chain ${chainId} not in registry`);
  const probe = await abiMod.probeContract(c.key, address).catch(() => null);
  return {
    platform: 'mintbay', chain: c.key, address, name: probe?.name || null,
    stages: (probe?.phases || []).map((ph, i) => ({ id: String(i), name: ph.name, price: ph.price, maxPerWallet: ph.maxPerWallet, isPublic: true })),
    probe, mintMethod: 'contract',
    suggested: { function: 'mint(uint256)', params: ['{amount}'], gasLimit: 400000 },
    note: 'Hex based, no proxy needed. Gas limit 400k (300k misses).',
  };
}


async function transient(url) {
  const m = /(0x[a-fA-F0-9]{40})/.exec(url);
  if (!m) throw new Error('no contract address in Transient URL');
  const address = ethers.getAddress(m[1]);
  let chainKey = 'ethereum';
  if (/\/base\//i.test(url) || /chain=base/i.test(url)) chainKey = 'base';
  if (/\/shape\//i.test(url)) chainKey = 'shape';
  const probe = await abiMod.probeContract(chainKey, address).catch(() => null);
  return {
    platform: 'transient', chain: chainKey, address, name: probe?.name || null,
    stages: (probe?.phases || []).map((ph, i) => ({ id: String(i), name: ph.name, price: ph.price, maxPerWallet: ph.maxPerWallet, isPublic: true })),
    probe, mintMethod: 'contract',
    suggested: { function: 'mint(uint256,bytes32[])', params: ['{amount}', '[]'] },
  };
}


async function blever(url) {
  const m = /(0x[a-fA-F0-9]{40})/.exec(url);
  const slugM = /blever\.(?:xyz|io)\/(?:mint|drop|c)\/([^/?#]+)/i.exec(url);
  let address = m ? ethers.getAddress(m[1]) : null;
  let chainKey = /base/i.test(url) ? 'base' : 'ethereum';
  if (!address && slugM) {
    for (const ep of [`https://blever.xyz/api/drops/${slugM[1]}`, `https://api.blever.xyz/drops/${slugM[1]}`]) {
      const r = await j(ep).catch(() => null);
      if (r?.ok && r.data) {
        address = r.data.contractAddress || r.data.contract || r.data.address;
        if (r.data.chainId) chainKey = (chainsMod.byId(r.data.chainId) || { key: chainKey }).key;
        break;
      }
    }
  }
  if (!address) throw new Error('cannot resolve Blever contract — paste the CA directly');
  const probe = await abiMod.probeContract(chainKey, address).catch(() => null);
  return {
    platform: 'blever', chain: chainKey, address, name: probe?.name || null,
    stages: (probe?.phases || []).map((ph, i) => ({ id: String(i), name: ph.name, price: ph.price, maxPerWallet: ph.maxPerWallet, isPublic: true })),
    probe, mintMethod: 'contract',
  };
}


async function launchmynft(url) {
  const parts = url.split('/').filter(Boolean);
  const i = parts.findIndex((p) => p === 'collections');
  const mi = parts.findIndex((p) => p === 'mint');
  if (i < 0 && (mi < 0 || !parts[mi + 1])) throw new Error('bad LaunchMyNFT URL');
  const a = i >= 0 ? parts[i + 1] : parts[mi + 1], b = i >= 0 ? parts[i + 2] : null;
  if (/^0x[a-fA-F0-9]{40}$/.test(b || '')) {
    const chainKey = ({ ethereum: 'ethereum', eth: 'ethereum', base: 'base', polygon: 'polygon', bsc: 'bsc', avalanche: 'avalanche' })[String(a).toLowerCase()];
    if (!chainKey) throw new Error('LaunchMyNFT chain unsupported');
    const address = ethers.getAddress(b);
    const probe = await abiMod.probeContract(chainKey, address).catch(() => null);
    return {
      platform: 'launchmynft', chain: chainKey, address, name: probe?.name || null,
      stages: (probe?.phases || []).map((ph, k) => ({ id: String(k), name: ph.name, price: ph.price, maxPerWallet: ph.maxPerWallet, isPublic: true })),
      probe, mintMethod: 'contract',
      suggested: { function: 'mint(uint256)', params: ['{amount}'] },
    };
  }
  throw new Error('LaunchMyNFT Solana collections are not supported');
}


async function zora(url) {
  const m = /(0x[a-fA-F0-9]{40})/.exec(url);
  if (!m) throw new Error('no contract in Zora URL');
  const address = ethers.getAddress(m[1]);
  let chainKey = 'zora';
  if (/\/base:/i.test(url) || /base\//i.test(url)) chainKey = 'base';
  if (/\/eth:/i.test(url)) chainKey = 'ethereum';
  const tokenId = (/\/(\d+)(?:[/?#]|$)/.exec(url.split(address)[1] || '') || [])[1] || null;
  const probe = await abiMod.probeContract(chainKey, address).catch(() => null);
  return {
    platform: 'zora', chain: chainKey, address, tokenId, name: probe?.name || null,
    stages: [{ id: '0', name: 'Public', price: probe?.price || '0.000777', isPublic: true }],
    probe, mintMethod: 'contract',
    suggested: tokenId
      ? { function: 'mintWithRewards(address,uint256,uint256,bytes,address)', params: ['{wallet}', tokenId, '{amount}', '0x', ethers.ZeroAddress] }
      : { function: 'mintWithRewards(address,uint256,bytes,address)', params: ['{wallet}', '{amount}', '0x', ethers.ZeroAddress] },
  };
}


async function manifold(url) {
  const m = /(0x[a-fA-F0-9]{40})/.exec(url);
  const address = m ? ethers.getAddress(m[1]) : null;
  const chainKey = /base/i.test(url) ? 'base' : 'ethereum';
  if (!address) throw new Error('paste Manifold contract address (creator core or extension)');
  const probe = await abiMod.probeContract(chainKey, address).catch(() => null);
  return {
    platform: 'manifold', chain: chainKey, address, name: probe?.name || null,
    stages: [{ id: '0', name: 'Public', price: probe?.price || null, isPublic: true }],
    probe, mintMethod: 'contract',
    suggested: { function: 'mint(address,uint256,uint32,bytes32[],address)', params: [address, '1', '0', '[]', '{wallet}'] },
    note: 'Manifold: instanceId + merkle proof needed for WL; use claim module.',
  };
}


async function scatter(url) {
  const m = /scatter\.art\/(?:c\/)?([^/?#]+)/i.exec(url);
  if (!m) throw new Error('bad Scatter URL');
  const slug = m[1];
  const r = await j(`https://api.scatter.art/v1/collection/${slug}`);
  if (!r.ok || !r.data) throw new Error(`Scatter API ${r.status}`);
  const d = r.data;
  if (!d || typeof d !== 'object' || !Number.isInteger(Number(d.chain_id))) throw new Error('Scatter collection schema invalid');
  const chain = chainsMod.byId(Number(d.chain_id));
  if (!chain) throw new Error('Scatter chain unsupported');
  const chainKey = chain.key;
  let lists = Array.isArray(d.invite_lists) ? d.invite_lists : [];
  const el = await j(`https://api.scatter.art/v1/collection/${slug}/eligible-invite-lists`);
  if (el.ok && el.data) {
    const candidate = Array.isArray(el.data) ? el.data : el.data.data;
    if (!Array.isArray(candidate)) throw new Error('Scatter invite-list schema invalid');
    lists = candidate;
  }
  if (d.address != null) {
    try { d.address = ethers.getAddress(d.address); } catch { throw new Error('Scatter address invalid'); }
  }
  const stages = lists.map((l, i) => {
    if (!l || typeof l !== 'object') throw new Error('Scatter invite-list entry invalid');
    return {
      id: l.id || String(i), name: l.name || `List ${i}`,
      price: l.token_price != null ? String(l.token_price) : '0',
      maxPerWallet: l.wallet_limit ?? null, isPublic: /public/i.test(l.name || ''),
      root: l.root || l.merkleRoot || null,
    };
  });
  return { platform: 'scatter', chain: chainKey, address: d.address || null, name: d.name || null, stages, mintMethod: 'simulate-only',
    api: 'https://api.scatter.art/v1',
    note: 'Scatter resolver read-only. No mint endpoint or calldata builder.' };
}


async function contractOnly(address, chainKey) {
  const probe = await abiMod.probeContract(chainKey || 'ethereum', address);
  let abi = null, funcs = [], mintCandidates = [];
  try {
    const r = await abiMod.resolveAbi(chainKey || 'ethereum', address);
    abi = r.abi; funcs = abiMod.writeFunctions(r.abi);
    mintCandidates = abiMod.probeMintCandidates(r.abi);
    probe.abiSource = r.source; probe.proxyImpl = r.proxy || null; probe.contractName = r.name;
  } catch (e) { probe.abiError = String(e.message).slice(0, 120); }
  const suggested = abiMod.suggestMintMethod(funcs, probe);
  return {
    platform: 'contract', chain: chainKey || 'ethereum', address, name: probe.contractName || probe.name,
    stages: probe.phases.map((ph, i) => ({ id: String(i), name: ph.name, price: ph.price, maxPerWallet: ph.maxPerWallet, isPublic: true })),
    probe, abi, functions: funcs, mintCandidates, mintMethod: 'contract',
    suggested: suggested ? {
      function: suggested.signature,
      params: suggested.inputs.map((i) => i.type === 'address' ? '{wallet}' : (i.type === 'uint256' ? '{amount}' : '')),
      gasLimit: probe.price === '0' ? 300000 : 400000,
    } : null,
  };
}


async function resolve(input, chainHint) {
  const d = detect(input);
  switch (d.kind) {
    case 'opensea': return opensea(d.url);
    case 'mintbay': return mintbay(d.url);
    case 'transient': return transient(d.url);
    case 'blever': return blever(d.url);
    case 'launchmynft': return launchmynft(d.url);
    case 'zora': return zora(d.url);
    case 'manifold': return manifold(d.url);
    case 'scatter': return scatter(d.url);
    case 'contract': return contractOnly(d.address, chainHint);
    default: {
      const m = /(0x[a-fA-F0-9]{40})/.exec(input);
      if (m) return contractOnly(ethers.getAddress(m[1]), chainHint);
      throw new Error('unsupported launchpad — paste contract address instead');
    }
  }
}

module.exports = { detect, resolve, opensea, openseaMintData, openseaMintDataGqlBatch, openseaDropStages, openseaDropStageTimes, openseaKeepWarm, openseaDropContract, mintbay, transient, blever, launchmynft, zora, manifold, scatter, contractOnly };
