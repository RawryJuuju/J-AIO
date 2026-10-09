'use strict';
/* J-AIO server — localhost only, no auth (single-user local tool).
 * Serves /public and a JSON API over all modules. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { ethers } = require('ethers');

const store = require('./store');
const chainsMod = require('./chains');
const rpc = require('./rpc');
const wallets = require('./wallets');
const proxies = require('./proxies');
const accounts = require('./accounts');
const abiMod = require('./abi');
const launchpads = require('./launchpads');
const mint = require('./mint');
const nftops = require('./nftops');
const nftview = require('./nftview');
const sniper = require('./sniper');
const taskmgr = require('./taskmgr');
const wl = require('./wl');
const xmodule = require('./xmodule');
const eligibility = require('./eligibility');
const activity = require('./activity');
const fxrate = require('./fxrate');
const keys = require('./keys');
const btc = require('./btc');
const pnl = require('./pnl');

const PORT = Number(process.env.PORT || 8899);
const HOST = '127.0.0.1';
const PUB = path.join(__dirname, '..', 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function jsonSafe(v) {
  return JSON.parse(JSON.stringify(v, (k, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (SECRET_KEYS.has(k)) return val ? '***' : null;
    return val;
  }));
}

/* Never let a key, token, or password reach the client in any field name. */
const SECRET_FIELD_NAMES = [
  'pk', 'privateKey', 'secretKey', 'mnemonic', 'seed', 'wif',
  'gmailAppPass', 'xToken', 'xCt0', 'discordToken', 'pass', 'password',
  'etherscanKey', 'openseaKey', 'heliusKey', 'alchemyKey', 'flashbotsAuthKey',
  'etherscanKeys', 'openseaKeys', 'heliusKeys', 'alchemyKeys',
];
const SECRET_KEYS = new Set(SECRET_FIELD_NAMES);


function send(res, code, obj, raw) {
  const body = JSON.stringify(raw ? obj : jsonSafe(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 20 * 1024 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return {}; }
}

/* ---------------- SSE ---------------- */

const sseClients = new Set();

function sseSend(payload) {
  const line = `data: ${JSON.stringify(jsonSafe(payload))}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}

mint.bus.on('event', (e) => sseSend({ kind: 'mint', ...e }));
xmodule.bus.on('event', (e) => sseSend({ kind: 'x', ...e }));
wl.bus.on('event', (e) => sseSend({ kind: 'wl', ...e }));

/* ---------------- routes ---------------- */

const routes = {
  /* --- session / vault --- */
  'GET /api/state': async () => ({
    locked: store.isLocked(), initialized: store.isInitialized(),
    chains: chainsMod.list(), settings: redactSettings(store.readSettings()),
    idleLockMinutes: store.getIdleTimeout(),
    version: require('../package.json').version || '1.0.0',
  }),
  'POST /api/unlock': async (b) => {
    if (!b.password) throw new Error('password required');
    if (!store.isInitialized()) store.initVault(b.password);
    else store.unlock(b.password);
    const s = store.readSettings();
    store.setIdleTimeout(s.idleLockMinutes == null ? 0 : s.idleLockMinutes);
    store.appendLog('security.log', 'vault unlocked');
    return { locked: false, idleLockMinutes: store.getIdleTimeout(), sessionToken: store.sessionToken() };
  },
  'POST /api/lock': async () => { store.lock(); store.appendLog('security.log', 'vault locked (manual)'); return { locked: true }; },

  /* --- fx rates (ETH→USD, USD→IDR) --- */
  'GET /api/fx': async (b, q) => fxrate.rates(q && q.force === '1'),

  /* --- settings --- */
  'GET /api/settings': async () => redactSettings(store.readSettings()),
  'POST /api/settings': async (b) => {
    const cur = store.readSettings();
    const next = { ...cur };
    for (const [k, v] of Object.entries(b || {})) {
      if (v === '***') continue;                       // untouched redacted secret
      if (v === '' || v === null) delete next[k];      // explicit clear
      else next[k] = v;
    }
    if (Object.prototype.hasOwnProperty.call(b || {}, 'idleLockMinutes')) {
      next.idleLockMinutes = store.setIdleTimeout(b.idleLockMinutes);
    }
    store.writeSettings(next);
    return redactSettings(store.readSettings());
  },

  /* --- chains + rpc --- */
  'GET /api/chains': async () => chainsMod.list(),
  'POST /api/chains/custom': async (b) => chainsMod.addCustom(b),
  'DELETE /api/chains/custom': async (b) => chainsMod.removeCustom(b.key),
  'POST /api/chains/private-rpc': async (b) => {
    const key = String(b.chain || '').toLowerCase();
    chainsMod.chain(key); // validate
    const urls = String(b.urls || '').split(/[\s,]+/).map((u) => u.trim()).filter(Boolean)
      .filter((u) => /^https?:\/\//i.test(u));
    const settings = store.readSettings();
    settings.privateRpc = settings.privateRpc || {};
    if (urls.length) settings.privateRpc[key] = urls; else delete settings.privateRpc[key];
    store.writeSettings(settings);
    return { chain: key, privateRpc: urls };
  },
  'GET /api/rpc': async () => rpc.listSafe(),
  'POST /api/rpc/group': async (b) => rpc.addGroup(b.name, b.chain),
  'DELETE /api/rpc/group': async (b) => rpc.removeGroup(b.id),
  'POST /api/rpc/add': async (b) => rpc.addRpcs(b.groupId, b.text || b.urls),
  'POST /api/rpc/probe': async (b) => rpc.probeGroup(b.groupId),
  'DELETE /api/rpc': async (b) => rpc.removeRpc(b.groupId, b.url || b.rpcId),
  'POST /api/rpc/seed': async () => rpc.seedDefaults(),

  /* --- proxies --- */
  'GET /api/proxies': async () => proxies.listSafe(),
  'POST /api/proxies/group': async (b) => proxies.addGroup(b.name),
  'DELETE /api/proxies/group': async (b) => proxies.removeGroup(b.id),
  'POST /api/proxies/add': async (b) => proxies.addProxies(b.groupId, b.text),
  'POST /api/proxies/probe': async (b) => proxies.reprobeGroup(b.groupId, b.testUrl),
  'DELETE /api/proxies': async (b) => proxies.removeProxy(b.groupId, b.proxyId),

  /* --- wallets --- */
  'GET /api/wallets': async (b, q) => ({
    groups: wallets.groups(q.kind || 'evm'),
    wallets: wallets.listSafe(q.kind || 'evm', q.groups ? q.groups.split(',') : null),
  }),
  'POST /api/wallets/group': async (b) => wallets.addGroup(b.kind || 'evm', b.name),
  'POST /api/wallets/group/rename': async (b) => wallets.renameGroup(b.kind || 'evm', b.id, b.name),
  'DELETE /api/wallets/group': async (b) => wallets.removeGroup(b.kind || 'evm', b.id),
  'POST /api/wallets/generate': async (b) => wallets.generate(b.kind || 'evm', b.groupId, Number(b.count || 1), b.prefix),
  'POST /api/wallets/import': async (b) => wallets.importKeys(b.kind || 'evm', b.groupId, b.text),
  'POST /api/wallets/rename': async (b) => wallets.renameWallet(b.kind || 'evm', b.id, b.name),
  'POST /api/wallets/bulk-rename': async (b) => ({ updated: wallets.bulkRename(b.kind || 'evm', b.ids, b.pattern) }),
  'DELETE /api/wallets': async (b) => ({ removed: wallets.removeWallet(b.kind || 'evm', b.id) }),
  'POST /api/wallets/export': async (b) => {
    // Key export is the single most dangerous operation in the app: re-auth every time.
    if (!store.verifyPassword(b.password)) {
      store.appendLog('security.log', `DENIED key export (bad/missing master password) kind=${b.kind || 'evm'} ids=${(b.ids || []).length || 'all'}`);
      throw new Error('master password required to export private keys');
    }
    store.appendLog('security.log', `key export kind=${b.kind || 'evm'} ids=${(b.ids || []).length || 'all'}`);
    return { csv: wallets.exportKeys(b.kind || 'evm', b.ids) };
  },

  'POST /api/wallets/balances': async (b) => {
    const kind = b.kind || 'evm';
    const raw = kind === 'sol' ? await wallets.solBalances(b.addresses)
      : kind === 'btc' ? await wallets.btcBalances(b.addresses)
      : await wallets.balances(b.chain || 'ethereum', b.addresses, b.token);
    // normalise {addr: row} -> [{address, balance, token}] so the page can
    // iterate it directly ((r.balances || r).forEach)
    const balances = Object.entries(raw).map(([address, x]) => ({
      address,
      balance: x.native,
      token: x.token != null ? x.token : null,
      wei: x.nativeWei ?? x.lamports ?? null,
      error: x.error || null,
    }));
    return { balances };
  },
  'POST /api/wallets/send': async (b) => {
    if ((b.kind || 'evm') === 'sol') {
      const amt = b.max ? b.amount : amount(b.amount, 'amount');
      return wallets.solSend(b.walletId, solAddr(b.to, 'destination'), amt, b);
    }
    if (b.randomMin != null) {
      const mn = Number(b.randomMin), mx = Number(b.randomMax);
      if (!Number.isFinite(mn) || !Number.isFinite(mx) || mn < 0 || mx <= 0 || mn > mx) throw new Error(`random range: min ${mn} max ${mx}`);
      b.amount = String(mn + Math.random() * (mx - mn));
      b.max = false;
    }
    const to = addr(b.to, 'to');
    const amt = b.max ? b.amount : amount(b.amount, 'amount');
    if (b.token) return wallets.sendToken(b.chain, b.walletId, addr(b.token, 'token'), to, amt, b);
    return wallets.sendNative(b.chain, b.walletId, to, amt, b);
  },
  'POST /api/wallets/disperse': async (b) => {
    const targets = Array.isArray(b.targets) ? b.targets : [];
    if (!targets.length) throw new Error('no disperse targets');
    if ((b.kind || 'evm') === 'evm') {
      const known = new Set(wallets.listSafe('evm').map((w) => w.address.toLowerCase()));
      const unknown = targets.filter((t) => !t || !/^0x[0-9a-fA-F]{40}$/.test(String(t.address || '')) || !known.has(String(t.address).toLowerCase()));
      if (unknown.length) throw new Error(`target wallet not found in J-AIO: ${unknown.map((t) => t && t.address).join(', ')}`);
      if (new Set(targets.map((t) => String(t.address).toLowerCase())).size !== targets.length) throw new Error('duplicate disperse target');
    }
    if ((b.kind || 'evm') === 'sol') {
      return wallets.solDisperse(b.sourceId, targets.map((t) => ({ ...t, address: solAddr(t.address, 'target') })), b);
    }
    return wallets.disperse(b.chain, b.sourceId, targets.map((t) => ({ ...t, address: addr(t.address, 'target') })), b);
  },
  'POST /api/wallets/delegation-scan': async (b) => wallets.scanDelegation(b.chain, b.groupIds),
  'POST /api/wallets/consolidate': async (b) => {
    if ((b.kind || 'evm') === 'sol') return wallets.solConsolidate(ids(b.walletIds, 'walletIds'), solAddr(b.destination, 'destination'), b);
    return wallets.consolidate(b.chain, ids(b.walletIds, 'walletIds'), addr(b.destination, 'destination'), b);
  },
  'POST /api/wallets/unwrap': async (b) => wallets.unwrapWeth(b.chain, b.walletId, b.amount),
  'GET /api/btc/fee': async (b, q) => btc.getFeeRates(q && q.network),
  'POST /api/btc/send': async (b) => btc.sendBtc(b),
  'GET /api/pnl/config': async () => pnl.getPnlConfig(),
  'POST /api/pnl/config': async (b) => pnl.savePnlConfig(b),
  'POST /api/pnl/card': async (b) => pnl.generatePnlCardData(b),
  'POST /api/wallets/delegation': async (b) => wallets.checkDelegation(b.chain, b.addresses),
  'POST /api/wallets/delegation/revoke': async (b) => wallets.revokeDelegation(b.chain, b.walletId),

  /* --- accounts --- */
  'GET /api/accounts': async (b, q) => {
    // ?group=<id> returns a flat array (page-level use); no query returns {groups, accounts}
    if (q.group) return accounts.listSafe([q.group]);
    return { groups: accounts.groups(), accounts: accounts.listSafe(q.groups ? q.groups.split(',') : null) };
  },
  'GET /api/accounts/groups': async () => accounts.groups(),
  'POST /api/accounts/groups/add': async (b) => accounts.addGroup(b.name, b.walletGroup || b.walletGroupId),
  'POST /api/accounts/groups/remove': async (b) => ({ ok: accounts.removeGroup(b.id) }),
  'POST /api/accounts/groups/rename': async (b) => accounts.renameGroup(b.id, b.name),
  'POST /api/accounts/remove': async (b) => ({ ok: accounts.removeAccount(b.id) }),
  'POST /api/accounts/from-wallets': async (b) => accounts.fromWallets(b.groupId, b.walletGroup || b.walletGroupId),
  'POST /api/accounts/group': async (b) => accounts.addGroup(b.name, b.walletGroupId),
  'DELETE /api/accounts/group': async (b) => ({ ok: accounts.removeGroup(b.id) }),
  'POST /api/accounts/add': async (b) => accounts.addAccount(b.groupId, b.fields || b),
  'POST /api/accounts/update': async (b) => {
    const fields = b.fields || b;
    const a = accounts.updateAccount(b.id, fields);
    // Auto-detect: a freshly pasted credential is probed immediately so the row
    // fills in its handle and green/red state without a manual re-test.
    const which = [];
    if (fields.xToken) which.push('x');
    if (fields.discordToken) which.push('discord');
    if (fields.gmailAppPass || fields.gmail) which.push('gmail');
    if (!which.length || b.probe === false) return a;
    const probe = {};
    for (const k of which) {
      probe[k] = k === 'x' ? await accounts.testX(b.id)
        : k === 'discord' ? await accounts.testDiscord(b.id)
          : await accounts.testGmailImap(b.id);
    }
    return { ...accounts.getAccountSafe(b.id), probe };
  },
  'POST /api/accounts/bulk-update': async (b) => ({ updated: accounts.bulkUpdate(b.ids, b.fields) }),
  'POST /api/accounts/bulk-connect': async (b) => {
    const r = accounts.bulkConnect(b.groupId, b.text, b.order, b.ids);
    if (b.probe === false || !r.ids.length || !r.which.length) return r;
    // Probe only what the paste actually touched, so a Gmail-only paste does not
    // hammer X/Discord for every row.
    const results = await accounts.testAccounts(r.ids, r.which.length === 1 ? r.which[0] : 'all');
    return { ...r, results };
  },
  'POST /api/accounts/bulk-remove': async (b) => ({ removed: accounts.bulkRemove(b.ids) }),
  'POST /api/accounts/bulk-disconnect': async (b) => ({ cleared: accounts.bulkDisconnect(b.ids, b.which || 'all') }),
  'POST /api/accounts/assign-proxies': async (b) => ({ assigned: accounts.assignProxies(b.groupId, b.proxyGroupId) }),
  'DELETE /api/accounts': async (b) => ({ ok: accounts.removeAccount(b.id) }),
  'POST /api/accounts/test': async (b) => (b.ids ? accounts.testAccounts(b.ids, b.which || 'all')
    : b.groupId ? accounts.testGroup(b.groupId, b.which || 'all')
    : b.which === 'discord' ? accounts.testDiscord(b.id)
      : b.which === 'gmail' ? accounts.testGmailImap(b.id) : accounts.testX(b.id)),

  /* --- launchpad / contract resolve --- */
  'POST /api/resolve': async (b) => launchpads.resolve(b.input, b.chain),
  'POST /api/abi': async (b) => {
    const r = await abiMod.resolveAbi(b.chain, b.address);
    return { ...r, functions: abiMod.writeFunctions(r.abi) };
  },
  'POST /api/probe': async (b) => abiMod.probeContract(b.chain, b.address, b.rpcs),

  /* --- mint --- */
  // opensea-api resolves the target contract from the drop itself, so address is optional there.
  'POST /api/mint/start': async (b) => mint.start(
    b.method === 'opensea-api' && !b.address ? b : { ...b, address: addr(b.address, 'contract address') },
  ),

  'POST /api/mint/stop': async (b) => ({ ok: mint.stop(b.runId) }),
  'POST /api/mint/stop-all': async () => ({ stopped: mint.stopAll() }),
  'GET /api/mint/runs': async () => mint.list(),
  'GET /api/mint/status': async (b, q) => mint.status(q.runId),
  'GET /api/mint/events': async (b, q) => mint.events(q.runId, q.since ? Number(q.since) : null),
  'POST /api/mint/clear': async () => ({ cleared: mint.clearFinished() }),
  'POST /api/gas': async (b) => mint.gasCalc(b.chain, b.gasLimit, b.gweis, b.nftCount, b.pricePerNft),


  /* --- nft ops --- */
  'POST /api/nft/inventory': async (b) => nftops.inventory(b.chain, b.addresses, b),
  'POST /api/nft/transfer': async (b) => nftops.transferNft(b.chain, b.walletId, addr(b.contract, 'contract'), b.tokenId, addr(b.to, 'destination'), b),
  'POST /api/nft/sweep': async (b) => nftops.sweepCollection(b.chain, ids(b.walletIds, 'walletIds'), addr(b.contract, 'contract'), addr(b.to, 'destination'), b),
  'POST /api/nft/transfer-batch': async (b) => nftops.transferBatch(b.chain, Array.isArray(b.items) ? b.items : [], addr(b.to, 'destination'), b),
  'POST /api/nft/deploy-batch-sender': async (b) => nftops.deployBatchSender(b.chain, String(b.walletId || '').trim() || (() => { throw new Error('walletId is required'); })()),
  'POST /api/nft/batch-sender': async (b) => ({ chain: b.chain, address: nftops.getBatchSender(b.chain) }),
  'POST /api/nft/approve': async (b) => nftops.ensureApproval(b.chain, b.walletId, addr(b.contract, 'contract'), b),
  'POST /api/nft/list': async (b) => nftops.listNft(b.chain, b.walletId, addr(b.contract, 'contract'), b.tokenId, amount(b.price, 'price'), b),
  'POST /api/nft/list-batch': async (b) => nftops.listNftBulk(b.chain, Array.isArray(b.items) ? b.items.map((it) => ({ ...it, contract: it.contract ? addr(it.contract, 'contract') : b.contract && addr(b.contract, 'contract') })) : [], b),
  'POST /api/nft/cancel': async (b) => nftops.cancelListing(b.chain, b.walletId, addr(b.contract, 'contract'), String(b.tokenId), b),
  'POST /api/nft/cancel-batch': async (b) => nftops.cancelBatch(b.chain, Array.isArray(b.items) ? b.items.map((it) => ({ ...it, contract: it.contract ? addr(it.contract, 'contract') : b.contract && addr(b.contract, 'contract') })) : [], b),
  'POST /api/nft/floor': async (b) => ({ floor: await nftops.collectionFloor(b.chain, b.slug) }),
  'POST /api/nft/collection-currency': async (b) => nftops.collectionListingCurrency(b.chain, b.slug),
  'POST /api/nft/rarity-build': async (b) => {
    const info = await nftview.resolveCollection(b.chain, b.input);
    const ranks = await nftview.buildRarityFromTraits(info.osChain, info.address, info.slug);
    return { ok: true, slug: info.slug, count: ranks ? Object.keys(ranks).length : 0 };
  },
  'POST /api/nft/floorwar/start': async (b) => nftops.startFloorWar(b),
  'POST /api/nft/floorwar/stop': async (b) => ({ ok: nftops.stopFloorWar(b.id) }),
  'GET /api/nft/floorwar': async () => nftops.listFloorWars(),
  'POST /api/nft/sniper/start': async (b) => sniper.startSniper(b),
  'POST /api/nft/sniper/stop': async (b) => ({ ok: sniper.stopSniper(b.id) }),
  'GET /api/nft/sniper': async () => sniper.listSnipers(),
  'POST /api/nft/offers': async (b) => nftops.bestOffers(b.chain, b.slug, b),
  'POST /api/nft/token-info': async (b) => nftops.tokenInfo(b.chain, b.address),
  'POST /api/nft/offer-preview': async (b) => nftops.previewOfferAccept(b.chain, b.walletId, b.orderHash, b),
  'POST /api/nft/accept-offer': async (b) => nftops.acceptOffer(b.chain, b.walletId, b.orderHash, b),
  'POST /api/nft/accept-offers': async (b) => nftops.acceptOffersBulk(b.chain, Array.isArray(b.items) ? b.items : [], b),
  'POST /api/nft/pnl': async (b) => {
    const r = await nftops.pnl(b.chain, b.addresses, b);
    // cached so the home dashboard can show all-time PnL without re-crawling
    try { store.writeSealed('pnl_cache', { t: Date.now(), chain: b.chain, addresses: b.addresses, ...r }); } catch { /* locked */ }
    return r;
  },
  'GET /api/nft/pnl-cache': async () => {
    try { return store.readSealed('pnl_cache', null); } catch { return null; }
  },

  /* --- nft viewer (collection manager) --- */
  'POST /api/nft/collection': async (b) => {
    const list = walletSelection(b);
    if (!list.length) throw new Error('no wallets selected');
    return nftview.collection(b.chain, b.input, list, b);
  },
  'POST /api/nft/resolve-collection': async (b) => nftview.resolveCollection(b.chain, b.input),
  'POST /api/nft/pnl-card': async (b) => {
    const list = walletSelection(b);
    if (!list.length) throw new Error('no wallets selected');
    return nftview.pnlCard(b.chain, b.input, list, b);
  },
  'GET /api/nft/pnl-card': async () => {
    try { return store.readSealed('pnl_card_last', null); } catch { return null; }
  },
  /* Image proxy → data URL. Lets the PnL-card canvas use remote pictures
     (OpenSea CDN etc.) without CORS tainting toDataURL(). */
  'GET /api/img': async (b, q) => {
    const u = String(q.url || '');
    if (!/^https?:\/\/[^/]/.test(u)) throw new Error('url required');
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`image fetch failed (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw new Error('image too large (max 8MB)');
    const type = String(r.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!/^image\/(png|jpe?g|webp|gif|avif)$/.test(type)) throw new Error(`not an image (${type})`);
    return { dataUrl: `data:${type};base64,${buf.toString('base64')}` };
  },

  /* --- whitelist checker (all stages at once) --- */
  'POST /api/wl/check': async (b) => wl.startCheck(b),
  'POST /api/wl/stop': async (b) => ({ ok: wl.stopCheck(b.runId) }),
  'GET /api/wl/status': async (b, q) => wl.statusCheck(q.runId),
  'GET /api/wl/runs': async () => wl.listChecks(),
  'POST /api/wl/save': async (b) => wl.saveCheck(b.runId, b),
  'POST /api/wl/custom/add': async (b) => wl.addCustomChecker(b.name, b.phases),
  'GET /api/wl/custom': async () => wl.listCustomCheckers(),

  /* --- tasks --- */
  'GET /api/tasks': async () => taskmgr.listAllTasks(),
  'POST /api/tasks/stop': async (b) => ({ ok: taskmgr.stopTask(b.id, b.kind) }),
  'GET /api/projects': async () => ({ projects: wl.listProjects() }),
  'POST /api/projects/save': async (b) => wl.saveProject(b),
  'POST /api/projects/update': async (b) => wl.updateProject(b.id, b.fields || b),
  'POST /api/projects/remove': async (b) => ({ ok: wl.removeProject(b.id) }),
  'DELETE /api/projects': async (b) => ({ ok: wl.removeProject(b.id) }),
  'POST /api/projects/phase': async (b) => wl.phaseWallets(b.id, b.phaseId),

  /* --- eligibility --- */
  'POST /api/eligibility': async (b) => {
    /* full wallet objects (with keys, server-side only) — the OpenSea SIWE
     * check signs a login message per wallet; responses never carry keys */
    const d = wallets.load('evm');
    const groups = b.groupIds && b.groupIds.length ? d.groups.filter((g) => b.groupIds.includes(g.id)) : d.groups;
    const list = (b.walletIds && b.walletIds.length)
      ? b.walletIds.map((id) => wallets.getWallet('evm', id)).filter(Boolean)
      : groups.flatMap((g) => g.wallets);
    if (!list.length) throw new Error('no wallets selected');
    return eligibility.check({ ...b, wallets: list });
  },

  /* --- activity feed --- */
  'GET /api/activity': async (b, q) => ({ items: activity.list(q.n), counts: activity.counts() }),
  'POST /api/activity/clear': async () => ({ ok: activity.clear() }),
  'GET /api/keystatus': async () => ({
    opensea: keys.status('openseaKey'), alchemy: keys.status('alchemyKey'),
    etherscan: keys.status('etherscanKey'), helius: keys.status('heliusKey'),
  }),

  /* Live latency badge per key. Hits each provider once — slow on purpose,
   * so the UI calls it on demand rather than on every settings render. */
  'POST /api/keyprobe': async (b) => keys.probe(b.fields),
  'POST /api/webhook/test': async (b) => {
    const url = (b && b.url) || store.readSettings().webhookUrl;
    if (!url) return { ok: false, error: 'webhook url is empty' };
    const t = Date.now();
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**J-AIO webhook test** — ${new Date().toISOString()}` }) });
      if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
      return { ok: true, ms: Date.now() - t };
    } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 80) }; }
  },
  /* J-AIO Capture parity: browser extension forwards dapp tx to this endpoint.
     No session needed (extension can't hold one) — loopback + X-JAIO-App only. */
  'POST /api/capture': async (b) => {
    const d = { ...(b || {}), ts: new Date().toISOString(), ip: 'loopback' };
    store.appendLog('capture.log', JSON.stringify(d));
    return { ok: true, ts: d.ts };
  },

  /* --- home dashboard: one call for PnL + activity + key health --- */
  /* The PnL crawl is slow (OpenSea events API, paged per wallet), so the home
   * page reads the cached result written by POST /api/nft/pnl instead of
   * recomputing on every 5s refresh. */
  'GET /api/home': async () => {
    let cached = null;
    try { cached = store.readSealed('pnl_cache', null); } catch { cached = null; }
    return {
      activity: activity.list(25),
      counts: activity.counts(),
      pnl: cached ? { totals: cached.totals, top: cached.top || [], at: cached.at || cached.t, chain: cached.chain } : null,
      keys: {
        opensea: keys.status('openseaKey'), etherscan: keys.status('etherscanKey'),
        alchemy: keys.status('alchemyKey'), helius: keys.status('heliusKey'),
      },
    };
  },

  /* --- X module --- */
  'POST /api/x/start': async (b) => xmodule.start(b),
  'POST /api/x/stop': async (b) => ({ ok: xmodule.stop(b.runId) }),
  'GET /api/x/runs': async () => xmodule.list(),
  'GET /api/x/status': async (b, q) => xmodule.status(q.runId),

  /* --- logs --- */
  'GET /api/logs': async (b, q) => ({ lines: store.tailLog(q.name || 'mint-runs.log', Number(q.n || 200)) }),
};

function redactSettings(s) {
  const out = { ...s };
  for (const k of store.SECRET_SETTING_KEYS) if (out[k]) out[k] = '***';
  return out;
}

/* ---------------- input validation ----------------
 * Fund-moving routes take a destination straight from the request body. A typo
 * or a mangled address means coins land somewhere unrecoverable, so every
 * destination is checksum-validated here before any signing happens.
 */
function addr(v, label) {
  if (v == null || v === '') throw new Error(`${label} is required`);
  try { return ethers.getAddress(String(v).trim()); }
  catch { throw new Error(`${label} is not a valid EVM address: ${String(v).slice(0, 24)}`); }
}

function solAddr(v, label) {
  const s = String(v ?? '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error(`${label} is not a valid Solana address`);
  return s;
}

/* Positive decimal amount. Rejects NaN/Infinity/negatives/exponent notation. */
function amount(v, label) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${label} must be a positive decimal number`);
  if (Number(s) <= 0) throw new Error(`${label} must be greater than zero`);
  return s;
}

function ids(v, label) {
  if (!Array.isArray(v) || !v.length) throw new Error(`${label} must be a non-empty array`);
  return v.map(String);
}

/* Wallet picker shared by every route that acts on "the wallets I selected":
 * explicit ids win, otherwise fall back to whole groups, otherwise every EVM
 * wallet in the vault. */
function walletSelection(b) {
  if (b.walletIds && b.walletIds.length) {
    return b.walletIds
      .map((id) => wallets.getWallet('evm', id))
      .filter(Boolean)
      .map((w) => ({ id: w.id, name: w.name, address: w.address }));
  }
  return wallets.listSafe('evm', b.groupIds);
}

const OPEN_ROUTES= new Set(['GET /api/state', 'POST /api/unlock', 'GET /api/chains', 'POST /api/capture']);

/* ---------------- request guards ----------------
 * The server has no per-request auth, so a web page you visit in the same
 * browser could otherwise POST to 127.0.0.1:8899 and drain wallets (classic
 * CSRF), or a hostile DNS name could resolve to 127.0.0.1 and do the same
 * (DNS rebinding). Three cheap checks close both:
 *   1. Host must be a literal loopback host — kills DNS rebinding.
 *   2. Origin/Referer, when present, must be our own origin — kills CSRF
 *      from ordinary pages.
 *   3. Mutating API calls must carry X-JAIO-App, a header a cross-site
 *      request cannot set without a CORS preflight that we never approve.
 */
const ALLOWED_HOSTS= new Set([
  `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`,
]);
const ALLOWED_ORIGINS= new Set([
  `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`,
]);

function guard(req) {
  const host = String(req.headers.host || '');
  if (!ALLOWED_HOSTS.has(host)) return `bad host ${host}`;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return `cross-origin request blocked (${origin})`;
  if (!origin && req.headers.referer) {
    try {
      const r= new URL(req.headers.referer);
      if (!ALLOWED_ORIGINS.has(r.origin)) return `cross-site referer blocked (${r.origin})`;
    } catch { return 'bad referer'; }
  }
  return null;
}


/* ---------------- server ---------------- */

const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  // 'unsafe-inline' is required because the UI uses inline onclick handlers and
  // style attributes. The value still matters: connect-src 'self' stops any
  // exfiltration of keys to a remote host, and frame-ancestors/base-uri/form-action
  // block framing and hijacked form posts.
  'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.seadn.io https://*.openseauserdata.com https://*.opensea.io https://*.arweave.net https://ipfs.io https://*.ipfs.dweb.link; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const key = `${req.method} ${u.pathname}`;

  const bad = guard(req);
  if (bad) {
    store.appendLog('security.log', `BLOCKED ${key} — ${bad} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}`);
    res.writeHead(403, { 'content-type': 'application/json', ...SEC_HEADERS });
    return res.end(JSON.stringify({ error: bad }));
  }

  // Idle auto-lock: a walked-away-from laptop should not stay unlocked forever.
  if (store.idleCheck()) {
    store.appendLog('security.log', 'auto-locked vault after idle timeout');
    sseSend({ kind: 'security', level: 'warn', msg: 'vault auto-locked (idle)' });
  }

  if (u.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...SEC_HEADERS,
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
    return;
  }

  if (u.pathname.startsWith('/api/')) {
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: `no route ${key}` });
    // Custom header requirement: unsettable cross-site without a preflight we never answer.
    if (req.method !== 'GET' && req.headers['x-jaio-app'] !== '1') {
      store.appendLog('security.log', `BLOCKED ${key} — missing X-JAIO-App header`);
      return send(res, 403, { error: 'missing X-JAIO-App header' });
    }
    if (req.method !== 'GET' && !['POST /api/unlock', 'POST /api/lock', 'POST /api/capture'].includes(key) && !store.hasSessionToken(req.headers['x-jaio-session'])) return send(res, 401, { error: 'missing or invalid session capability' });
    if (store.isLocked() && !OPEN_ROUTES.has(key)) return send(res, 423, { error: 'vault locked', locked: true });
    store.touch();
    try {
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const q = Object.fromEntries(u.searchParams);
      const audit = (v) => {
        const redact = (x, k = '') => {
          if (/(password|pass|pk|private|secret|token|authorization|session)/i.test(k)) return '[REDACTED]';
          if (Array.isArray(x)) return x.map((z) => redact(z, k));
          if (!x || typeof x !== 'object') return x;
          return Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, redact(vv, kk)]));
        };
        try { return JSON.stringify(redact(v)).slice(0, 12000); } catch { return '[unserializable]'; }
      };
      store.appendLog('audit.log', `${key} request=${audit(body)} query=${audit(q)}`);
      const out = await handler(body, q);
      store.appendLog('audit.log', `${key} result=${audit(out)}`);
      // keyprobe payload is pre-masked (keys.js mask()) and keyed by secret field
      // names — jsonSafe would redact the whole result to '***'. Send it raw.
      const raw = key === 'POST /api/keyprobe';
      return send(res, 200, out ?? { ok: true }, raw);
    } catch (e) {
      store.appendLog('audit.log', `${key} error=${String(e.message || e).slice(0, 1000)}`);
      return send(res, 400, { error: String(e.message || e).slice(0, 400) });
    }
  }

  // static
  const p = u.pathname === '/' ? '/index.html' : u.pathname;
  const file = path.resolve(PUB, '.' + path.posix.normalize(p));
  if (file !== PUB && !file.startsWith(PUB + path.sep)) {
    res.writeHead(403, SEC_HEADERS); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...SEC_HEADERS,
    });
    res.end(data);
  });
});

/* Crash guards. A background mint run that rejects unhandled would
 * otherwise kill the process mid-flight (Node 15+ exits on unhandled
 * rejection), losing every in-progress run. Log and keep serving instead. */
process.on('unhandledRejection', (e) => {
  const msg = String(e?.stack || e?.message || e).slice(0, 400);
  store.appendLog('security.log', `unhandledRejection: ${msg}`);
  sseSend({ kind: 'security', level: 'fail', msg: `internal error: ${String(e?.message || e).slice(0, 160)}` });
});
process.on('uncaughtException', (e) => {
  const msg = String(e?.stack || e?.message || e).slice(0, 400);
  store.appendLog('security.log', `uncaughtException: ${msg}`);
  sseSend({ kind: 'security', level: 'fail', msg: `internal error: ${String(e?.message || e).slice(0, 160)}` });
});

/* Zeroize the master key on shutdown instead of leaving it in a core dump. */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { store.lock(); store.appendLog('security.log', `vault locked (${sig} shutdown)`); } catch { /* already down */ }
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`J-AIO running: http://${HOST}:${PORT}`);
  console.log(`data dir: ${store.DATA_DIR}`);
  console.log(store.isInitialized() ? 'vault exists — unlock in UI' : 'first run — set a master password in UI');
});

module.exports = server;
