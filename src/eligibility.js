'use strict';
const { ethers } = require('ethers');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const walletsMod = require('./wallets');
const launchpads = require('./launchpads');
const nftops = require('./nftops');
const keys = require('./keys');

const SIWE_NONCE_URL = 'https://opensea.io/__api/auth/siwe/nonce';
const SIWE_VERIFY_URL = 'https://opensea.io/__api/auth/siwe/verify';
const GQL_URL = 'https://gql.opensea.io/graphql';
const DROP_ELIGIBILITY_HASH = 'd893f026d731e8f14986921fa4229098e018289f6cc7683f8ee2dd83749dd95d';
const OS_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ELIG_TTL = 600e3; /* 10 min — long enough for re-runs, short enough for phase flips */
const eligCache = new Map();

async function osSiweLogin(pk) {
  const { fetch } = require('undici');
  const wallet = new ethers.Wallet(pk);
  const checksummed = wallet.address;
  const nr = await fetch(SIWE_NONCE_URL, { method: 'POST', headers: { 'user-agent': OS_UA }, signal: AbortSignal.timeout(30000) });
  if (!nr.ok) throw new Error(`siwe nonce http ${nr.status}`);
  const { nonce } = await nr.json();
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const statement = 'Click to sign in and accept the OpenSea Terms of Service (https://opensea.io/tos) and Privacy Policy (https://opensea.io/privacy).';
  const message = `opensea.io wants you to sign in with your Ethereum account:\n${checksummed}\n\n${statement}\n\nURI: https://opensea.io/\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
  const signature = await wallet.signMessage(message);
  const vr = await fetch(SIWE_VERIFY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': OS_UA },
    body: JSON.stringify({
      message: { domain: 'opensea.io', address: checksummed, statement, uri: 'https://opensea.io/', version: '1', chainId: '1', nonce, issuedAt, accountType: 'Ethereum' },
      signature, chainArch: 'EVM', connectorId: 'io.metamask',
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!vr.ok) throw new Error(`siwe verify http ${vr.status}`);
  const cookies = vr.headers.getSetCookie ? vr.headers.getSetCookie() : [vr.headers.get('set-cookie') || ''];
  const token = cookies.find((c) => c.includes('access_token='));
  if (!token) throw new Error('no access_token cookie');
  return { cookie: token.split(';')[0], address: checksummed };
}

const _sessCache = new Map();
async function osSessionCached(pk) {
  const hit = _sessCache.get(pk);
  if (hit && Date.now() < hit.exp) return hit.sess;
  const sess = await osSiweLogin(pk);
  _sessCache.set(pk, { sess, exp: Date.now() + 40 * 60e3 });
  return sess;
}

async function osDropEligibility(sess, slug) {
  const { fetch } = require('undici');
  const body = {
    extensions: { persistedQuery: { sha256Hash: DROP_ELIGIBILITY_HASH, version: 1 } },
    operationName: 'DropEligibilityQuery',
    variables: { address: sess.address, collectionSlug: slug },
  };
  const r = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-app-id': 'os2-web', 'x-graphql-operation-type': 'query',
      accept: '*/*', origin: 'https://opensea.io', referer: 'https://opensea.io/', 'user-agent': OS_UA,
      cookie: `${sess.cookie}; connected-account-server-hint=${sess.address}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 429) throw new Error('RATE_LIMITED');
  if (r.status === 401 || r.status === 403) throw new Error(`AUTH_FAILED (${r.status})`);
  if (!r.ok) throw new Error(`HTTP_${r.status}`);
  const d = await r.json();
  if (d.errors) {
    const m = (d.errors[0] || {}).message || '';
    if (/PersistedQueryNotFound/.test(m)) throw new Error('QUERY_HASH_EXPIRED');
    throw new Error(`GRAPHQL_ERROR: ${m.slice(0, 120)}`);
  }
  const drop = (d.data && (d.data.dropBySlug || d.data.drop)) || {};
  return (Array.isArray(drop.stages) ? drop.stages : []).map((s) => ({
    stageIndex: Number(s.stageIndex || 0),
    stageType: s.stageType || s.__typename || '',
    isEligible: !!s.isEligible,
  }));
}

async function osDropLabels(slug) {
  try {
    const d = await nftops.osFetch(`/api/v2/drops/${slug}`);
    const arr = Array.isArray(d && d.stages) ? d.stages : [];
    return arr.map((s) => s.label || s.name || s.stage_type || '');
  } catch { return []; }
}

const normLabel = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function matchEligStage(elig, labels, stage) {
  const want = normLabel(stage.name);
  for (const g of elig) {
    const lab = normLabel(labels[g.stageIndex] || g.stageType);
    if (want && lab && lab === want) return g;
  }
  const wantType = normLabel(stage.stageType);
  if (wantType) {
    for (const g of elig) if (normLabel(g.stageType) === wantType) return g;
  }
  if (/^\d+$/.test(String(stage.id))) {
    const idx = Number(stage.id);
    const g = elig.find((x) => x.stageIndex === idx);
    if (g) return g;
  }
  return null;
}

async function fetchOsEligibility(info, wallets) {
  const map = {}, err = {};
  const labels = await osDropLabels(info.slug);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CONC = 2; /* SIWE is IP-rate-limited; keep it tight like plseligbot */
  for (let i = 0; i < wallets.length; i += CONC) {
    await Promise.all(wallets.slice(i, i + CONC).map(async (w) => {
      if (!w.pk) { err[w.id] = 'no wallet key'; return; }
      const ck = `${info.slug}:${w.address.toLowerCase()}`;
      const hit = eligCache.get(ck);
      if (hit && Date.now() - hit.at < ELIG_TTL) { map[w.id] = hit.stages; return; }
      try {
        const sess = await osSiweLogin(w.pk);
        let stages = await osDropEligibility(sess, info.slug);
        if (!stages.length) { await sleep(1200); stages = await osDropEligibility(sess, info.slug); }
        map[w.id] = stages;
        eligCache.set(ck, { stages, at: Date.now() });
      } catch (e) { err[w.id] = String(e.message).slice(0, 90); }
    }));
    if (i + CONC < wallets.length) await sleep(60);
  }
  return { map, err, labels };
}

const MINTED_SIGS = [
  'function numberMinted(address) view returns (uint256)',
  'function mintedCount(address) view returns (uint256)',
  'function _numberMinted(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

async function mintedBy(chainKey, address, wallet, rpcUrls) {
  for (const sig of MINTED_SIGS) {
    try {
      const iface = new ethers.Interface([sig]);
      const name = iface.fragments[0].name;
      const raw = await rpc.readRace(chainKey, (p) => p.call({
        to: address, data: iface.encodeFunctionData(name, [wallet]),
      }), rpcUrls);
      if (!raw || raw === '0x') continue;
      return Number(iface.decodeFunctionResult(name, raw)[0]);
    } catch { /* next sig */ }
  }
  return null;
}

function stageWindow(stage) {
  const now = Math.floor(Date.now() / 1000);
  if (stage.startTime && now < stage.startTime) return { open: false, reason: `starts in ${Math.round((stage.startTime - now) / 60)}m` };
  if (stage.endTime && now > stage.endTime) return { open: false, reason: 'stage ended' };
  return { open: true };
}

async function scatterAllowlist(slug, wallet) {
  const { fetch } = require('undici');
  const r = await fetch(`https://api.scatter.art/v1/collection/${slug}/eligible-invite-lists?minterAddress=${wallet}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  const lists = Array.isArray(d) ? d : (d?.data || []);
  return lists.length ? { ok: true, lists: lists.map((l) => l.name || l.id) } : { ok: false, reason: 'no eligible lists' };
}

async function checkOne(ctx, w) {
  const { info, stage, chainKey, priceWei, qty, gasWei } = ctx;
  const row = { walletId: w.id, name: w.name, address: w.address };

  const win = stageWindow(stage);
  if (!win.open) return { ...row, verdict: 'closed', reason: win.reason };

  try {
    const bal = await rpc.readRace(chainKey, (p) => p.getBalance(w.address), ctx.rpcUrls);
    row.balance = Number(ethers.formatEther(bal));
    const need = priceWei * BigInt(qty) + gasWei;
    row.need = Number(ethers.formatEther(need));
    if (bal < need) {
      return { ...row, verdict: 'underfunded', reason: `has ${row.balance.toFixed(5)}, needs ~${row.need.toFixed(5)}` };
    }
  } catch { /* RPC hiccup — keep going, funds re-checked at mint */ }

  const cap = Number(stage.maxPerWallet || 0);
  if (cap > 0) {
    const done = await mintedBy(chainKey, info.address, w.address, ctx.rpcUrls);
    if (done != null) {
      row.minted = done;
      row.remaining = Math.max(0, cap - done);
      if (done >= cap) return { ...row, verdict: 'limit_reached', reason: `${done}/${cap} already minted` };
    }
  }

  if (stage.isPublic || /public/i.test(stage.stageType || '') || /public/i.test(stage.name || '')) {
    return { ...row, verdict: 'eligible', reason: 'public stage — auto pass' };
  }

  try {
    if (info.platform === 'opensea' && info.slug) {
      const elig = ctx.eligMap && ctx.eligMap[w.id];
      if (elig) {
        const g = matchEligStage(elig, ctx.eligLabels || [], stage);
        if (g) {
          return g.isEligible
            ? { ...row, verdict: 'eligible', reason: 'OpenSea confirmed eligible' }
            : { ...row, verdict: 'not_eligible', reason: 'OpenSea: not on this list' };
        }
        const hits = elig.filter((x) => x.isEligible).length;
        return { ...row, verdict: 'unknown', reason: `stage not in OpenSea response (${hits} eligible stage${hits === 1 ? '' : 's'})` };
      }
      const er = ctx.eligErr && ctx.eligErr[w.id];
      return { ...row, verdict: 'unknown', reason: er ? `OpenSea check failed: ${er}` : 'OpenSea eligibility not fetched' };
    }
    if (info.platform === 'scatter') {
      const a = await scatterAllowlist(info.slug || info.name, w.address);
      if (a && !a.ok) return { ...row, verdict: 'not_eligible', reason: a.reason };
      if (a && a.ok) return { ...row, verdict: 'eligible', reason: `lists: ${a.lists.slice(0, 3).join(', ')}` };
      return { ...row, verdict: 'unknown', reason: 'Scatter API unavailable' };
    }
  } catch (e) {
    return { ...row, verdict: 'unknown', reason: String(e.message).slice(0, 100) };
  }

  const merkle = stage.root || stage.merkleRoot;
  if (merkle && !/^0x0{64}$/.test(String(merkle))) {
    return { ...row, verdict: 'unknown', reason: 'merkle stage — proof source needed' };
  }
  return { ...row, verdict: 'eligible', reason: 'public stage, funded, under cap' };
}

async function check(opts) {
  const info = opts.info || await launchpads.resolve(opts.input, opts.chain);
  const chainKey = opts.chain || info.chain;
  const c = chainsMod.chain(chainKey);
  const stages = (info.stages || []).filter((s) => !s.isPublic && !/public/i.test(s.name || ''));
  if (!stages.length) throw new Error('no non-public OpenSea phases found');
  const stage = stages.find((s) => String(s.id) === String(opts.stageId)) || stages[0];

  const qty = Math.max(1, Number(opts.quantity) || 1);
  const priceEth = opts.price != null && opts.price !== '' ? String(opts.price) : String(stage.price || '0');
  const priceWei = ethers.parseEther(priceEth || '0');

  let gasWei = 0n;
  try {
    const fee = await walletsMod.feeData(chainKey);
    const gl = BigInt(opts.gasLimit || 250000);
    gasWei = (fee.maxFeePerGas || 0n) * gl * 2n;
  } catch { gasWei = ethers.parseEther('0.002'); }

  const ctx0 = { info, chainKey, qty, gasWei, rpcUrls: opts.rpcs || rpc.urlsFor(chainKey) };

  if (info.platform === 'opensea' && info.slug && opts.osEligibility !== false) {
    const { map, err, labels } = await fetchOsEligibility(info, opts.wallets || []);
    ctx0.eligMap = map; ctx0.eligErr = err; ctx0.eligLabels = labels;
  }

  async function runStage(st) {
    const priceEth = opts.price != null && opts.price !== '' ? String(opts.price) : String(st.price || '0');
    const priceWei = ethers.parseEther(priceEth || '0');
    const ctx = { ...ctx0, stage: st, priceWei };
    const list = opts.wallets || [];
    const rows = [];
    const CONC = 5;
    for (let i = 0; i < list.length; i += CONC) {
      const batch = await Promise.all(list.slice(i, i + CONC).map((w) => checkOne(ctx, w).catch((e) => ({
        walletId: w.id, name: w.name, address: w.address, verdict: 'unknown', reason: String(e.message).slice(0, 100),
      }))));
      rows.push(...batch);
    }
    const counts = rows.reduce((a, r) => { a[r.verdict] = (a[r.verdict] || 0) + 1; return a; }, {});
    return { stage: st, priceEth, rows, counts };
  }

  if (opts.allStages) {
    const out = { chain: c.key, platform: info.platform, address: info.address, slug: info.slug || null,
      name: info.name || null, gasHeadroomEth: Number(ethers.formatEther(gasWei)), matrix: true, stages: [] };
    const byWallet = new Map();
    const stageCounts = [];
    for (const st of stages) {
      const { stage, priceEth, rows, counts } = await runStage(st);
      out.stages.push({ id: stage.id, name: stage.name, price: priceEth, isPublic: !!stage.isPublic, maxPerWallet: Number(stage.maxPerWallet) || 0 });
      stageCounts.push({ id: stage.id, counts });
      for (const r of rows) {
        if (!byWallet.has(r.walletId)) {
          byWallet.set(r.walletId, { walletId: r.walletId, name: r.name, address: r.address, balance: r.balance ?? null, stages: {} });
        }
        const w = byWallet.get(r.walletId);
        w.stages[String(stage.id)] = { verdict: r.verdict, reason: r.reason || null, minted: r.minted ?? null, remaining: r.remaining ?? null };
      }
    }
    out.rows = [...byWallet.values()];
    out.stageCounts = stageCounts;
    out.eligible = out.rows.filter((r) => Object.values(r.stages).some((s) => s.verdict === 'eligible')).map((r) => r.walletId);
    return out;
  }

  const chosen = await runStage(stage);
  return {
    chain: c.key, platform: info.platform, address: info.address, slug: info.slug || null,
    name: info.name || null, stage: { id: chosen.stage.id, name: chosen.stage.name, price: chosen.priceEth },
    priceEth: chosen.priceEth, gasHeadroomEth: Number(ethers.formatEther(gasWei)),
    rows: chosen.rows, counts: chosen.counts,
    eligible: chosen.rows.filter((r) => r.verdict === 'eligible').map((r) => r.walletId),
  };
}

module.exports = { check, checkOne, mintedBy, stageWindow, fetchOsEligibility, osSiweLogin, osSessionCached };
