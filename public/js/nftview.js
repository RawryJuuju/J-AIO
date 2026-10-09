'use strict';
/* NFT Manager — one collection, my wallets, live market data.
 *
 * The inventory page answers "what do I own everywhere". This page answers the
 * question you actually ask before selling: for THIS collection, which of my
 * wallets hold what, what is each token's rarity, and is it already listed. Header carries the collection identity
 * and floor so every number in the table has context.
 */

page('nftview', {
  label: 'Collection Manager', group: 'NFT', icon: 'col',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Collection Manager</h2>
      <p class="ps">Paste a contract, OpenSea slug, or link. Reads every selected wallet, then floor, rarity and listing per NFT.</p>

      <div class="card">
        <div class="row">
          <div style="width:150px"><label class="f">Chain</label><select id="cvChain">${chainOpts('ethereum')}</select></div>
          <div style="flex:1;min-width:240px"><label class="f">Collection <span class="opt">— 0x…, slug, or OpenSea URL</span></label><input id="cvIn" class="mono" placeholder="0xa2a6063b910fc7a7a286196f6c9b62b2797fa0ae" autocomplete="off"></div>
          <div style="flex:1;min-width:170px"><label class="f">Wallet group</label><select id="cvGroup"></select></div>
          <button class="btn pri" id="cvGo">Load</button><button class="btn sm" id="cvCard">${icon('pnl')} PnL card</button>
        </div>

      </div>

      <div id="cvHead"></div>

      <div class="card"><h3><label class="chk" id="cvAllWrap" style="display:none"><input type="checkbox" id="cvAll"> Select all</label>
        <span class="sub" id="cvCount"></span>
        <div style="margin-left:auto" class="row">
          <button class="btn xs on" id="cvMarket" title="Listing prices + rarity — turn off for a faster load">${icon('tag')} Market</button>
          <button class="btn xs" id="cvOffers" title="Best open offers for this collection — accept one to sell a held NFT">${icon('offer')} Offers</button>
          <button class="btn xs" id="cvWatch" title="Watch for reveal — flags NFTs whose image changes on refresh">${icon('eye')} Reveal</button><button class="btn xs on" id="cvGridView">Grid</button><button class="btn xs" id="cvTableView">Table</button><button class="btn xs" id="cvCsv">Export CSV</button>
          <button class="btn xs" id="cvRefresh">${icon('refresh')} Refresh</button>
        </div></h3>
        <div class="rarf" id="cvRarf" style="display:none"></div>
        <div id="cvGrid">${emptyState({ icon: 'col', title: 'No collection loaded', desc: 'Paste a contract address or OpenSea link, pick your wallets, then Load.' })}</div>
      </div>

      <div class="selbar hide" id="cvSelBar">
        <span class="n" id="cvSelCount">0 selected</span>
        <span class="sm mut" id="cvSelVal"></span>
        <div class="sp"></div>
        <button class="btn" id="cvTransfer">${icon('send')} Transfer</button><button class="btn" id="cvAccept" title="Sell selected NFTs into the best open offers">${icon('offer')} Accept offer</button><button class="btn" id="cvUnlist">${icon('unlink')} Unlist</button><button class="btn pri" id="cvList">${icon('submit')} List</button>
        <button class="iact x" id="cvSelClear" title="Clear selection">${icon('close')}</button>
      </div>`;

    let data = null;
    const CVSEL = new Set();
    let viewMode = 'grid';   // grid | list
    /* Market toggle: listing prices + rarity are the expensive part of a load
     * (collection-wide listings page + per-token rarity). Off = inventory and
     * floor only, which is dramatically faster on big bags. */
    let wantMarket = true;
    /* Collection payment currency — OpenSea stats report floor_price_symbol
     * (ETH on most chains, USDG on some Robinhood collections, …). USD rate:
     * ETH family uses S.ethUsd, known stablecoins peg 1:1, else no USD tag. */
    const STABLE_USD = { usdg: 1, usdc: 1, usdt: 1, dai: 1, usd1: 1, pyusd: 1, frax: 1, usds: 1 };
    const curSymbol = () => (data && data.floorSymbol) || 'ETH';
    const curIsEth = () => /^w?eth$/i.test(curSymbol());
    const curUsd = () => (curIsEth() ? S.ethUsd : STABLE_USD[curSymbol().toLowerCase()] ?? null);
    const usdTag = (v) => { const r = curUsd(); return (v != null && r) ? `<span class="uusd">$${num(v * r, 2)}</span>` : ''; };
    const selRows = () => (data ? data.rows.filter((n) => CVSEL.has(String(n.tokenId))) : []);

    $('cvGroup').innerHTML = '<option value="">All wallets</option>'
      + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');

    function walletIds() {
      const g = $('cvGroup').value;
      return S.wallets.evm.filter((w) => !g || w.groupId === g).map((w) => w.id);
    }

    /* Collection header: identity on the left, the four numbers that decide
       whether to sell on the right. */
    function head() {
      if (!data) { $('cvHead').innerHTML = ''; return; }
      const c = S.chains.find((x) => x.key === data.chain);
      const osUrl = data.slug ? `https://opensea.io/collection/${data.slug}` : null;
      $('cvHead').innerHTML = `<div class="card colhead">
        <div class="ch-img">${data.image ? `<img src="${esc(data.image)}" alt="">` : icon('col')}</div>
        <div class="ch-meta">
          <div class="ch-name">${esc(data.name || data.slug || '—')}
            ${data.verified ? '<span class="verified-check" title="Verified"><svg viewBox="0 0 24 24"><path d="m12 2 2.1 2.1 3-.4.9 2.9 2.7 1.4-1.4 2.7.4 3-2.9.9-2.1 2.1-2.1-2.1-3 .4-.9-2.9-2.7-1.4 1.4-2.7-.4-3 2.9-.9L12 2zm-1.2 13.4-3.2-3.2 1.4-1.4 1.8 1.8 4.2-4.2 1.4 1.4-5.6 5.6z"/></svg></span>' : ''}
            <span class="tag mut">${esc(c ? c.name : data.chain)}</span></div>
          <div class="ch-sub">
            <span class="ch-id">${esc(short(data.address, 8))}</span>
            <button class="lnk" data-copy="${esc(data.address || '')}">${icon('copy')}</button>
            ${osUrl ? `<a class="lnk" href="${esc(osUrl)}" target="_blank" rel="noreferrer">${icon('external')} OpenSea</a>` : ''}
            ${data.supply != null ? `<span class="mut">·</span><span>${num(data.supply, 0)} supply</span>` : ''}
          </div>
        </div>
        <div class="ch-stats">
          <div class="ct"><div class="k">Floor</div><div class="v accent">${fx(data.floor, 14)}</div><div class="d sm mut">${esc(curSymbol())}${data.floor != null && curUsd() ? ' · $' + num(data.floor * curUsd(), 2) : ''}</div></div>
          <div class="ct"><div class="k">I hold</div><div class="v">${num(data.count, 0)}</div><div class="d sm mut">in ${num(data.walletsHolding, 0)} wallet${data.walletsHolding === 1 ? '' : 's'}</div></div>
          <div class="ct"><div class="k">Est. value</div><div class="v ok">${fx(data.floor != null ? data.floor * data.count : null, 14)}</div><div class="d sm mut">${data.floor != null && curUsd() ? '$' + num(data.floor * data.count * curUsd(), 2) : 'at floor'}</div></div>
          <div class="ct"><div class="k">Owners</div><div class="v">${num(data.owners, 0)}</div><div class="d sm mut">${data.volume != null ? num(data.volume, 0) + ' vol' : ''}</div></div>
        </div>
      </div>`;
      qa('#cvHead [data-copy]').forEach((b) => { b.onclick = () => copy(b.dataset.copy); });
    }

    /* Rarity tiers — share-of-supply buckets, J-AIO-style. The header chips
       carry the counts; the badge class maps to the tier colour. */
    const TIERS = [
      { name: 'Legendary', label: 'Top 1%', color: '#F6A219', max: 0.01 },
      { name: 'Epic', label: 'Top 10%', color: '#A461E4', max: 0.1 },
      { name: 'Rare', label: 'Top 25%', color: '#2081E2', max: 0.25 },
      { name: 'Common', label: '', color: '#8A8F98', max: Infinity },
    ];
    function tierOf(rank) {
      if (rank == null || !data || !data.supply) return null;
      const p = rank / data.supply;
      return TIERS.find((t) => p <= t.max).name;
    }
    function rarityTier(rank) {
      const t = tierOf(rank);
      return t ? t.toLowerCase() : 'unk';
    }

    /* Rarity filter chips — colored boxes with per-tier counts. Empty set =
       no filter; tokens without a rarity rank are hidden while one is on. */
    const RFILT = new Set();
    function rarf() {
      const el = $('cvRarf'); if (!el) return;
      const counts = {};
      data.rows.forEach((n) => { const t = tierOf(n.rarityRank); if (t) counts[t] = (counts[t] || 0) + 1; });
      el.style.display = RFILT.size || Object.keys(counts).length ? '' : 'none';
      el.innerHTML = TIERS.map((t) => {
        const c = counts[t.name] || 0;
        return `<button class="rarf-chip${RFILT.has(t.name) ? ' on' : ''}" data-tier="${t.name}" style="--rc:${t.color}" title="${t.label ? t.label + ' — ' : ''}share-of-supply filter">${t.name} <b>${c}</b></button>`;
      }).join('');
      qa('#cvRarf .rarf-chip').forEach((b) => { b.onclick = () => {
        const t = b.dataset.tier;
        if (RFILT.has(t)) RFILT.delete(t); else RFILT.add(t);
        rarf(); grid();
      }; });
    }

    /* OpenSea-style card grid: image first, checkbox overlay, price rows in
       ETH + USD. Clicking anywhere on a card toggles selection; List / Accept
       live on the bottom bar and only exist while something is selected. */
    function card(n) {
      const tid = String(n.tokenId);
      const tier = rarityTier(n.rarityRank);
      const nown = `<span class="nown" title="${esc(n.owner)}">${icon('wallets')}${esc(n.ownerName)}</span>`;
      return `<div class="ncard${CVSEL.has(tid) ? ' sel' : ''}" data-tid="${esc(tid)}">
        <label class="nchk" title="Select"><input type="checkbox" data-tid="${esc(tid)}" ${CVSEL.has(tid) ? 'checked' : ''}></label>
        <div class="nimg">${n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy">` : `<div class="noimg">${icon('col')}</div>`}
          ${n.listing != null ? '<span class="nbd ls">listed</span>' : ''}
          ${n.rarityRank != null ? `<span class="nbd rar ${tier}">#${num(n.rarityRank, 0)}</span>` : ''}
        </div>
        <div class="nbody">
          <div class="nm" title="${esc(n.name)}">${esc(n.name)}</div>
          <div class="tid">#${esc(n.tokenId)}${viewMode === 'list' ? '' : nown}</div>
          ${viewMode === 'list' ? nown : ''}
          <div class="prow plist"><span class="k">List</span>${n.listing != null ? `<b>${fx(n.listing, 14)} ${esc(curSymbol())}</b>${usdTag(n.listing)}` : '<span class="mut">—</span>'}</div>
        </div>
      </div>`;
    }

    function syncSel() {
      qa('#cvGrid .ncard').forEach((c) => {
        const on = CVSEL.has(c.dataset.tid);
        c.classList.toggle('sel', on);
        const cb = c.querySelector('input'); if (cb) cb.checked = on;
      });
      const all = $('cvAll');
      if (all && data) {
        all.checked = data.rows.length > 0 && CVSEL.size >= data.rows.length;
        all.indeterminate = CVSEL.size > 0 && CVSEL.size < data.rows.length;
      }
      const rows = selRows();
      $('cvSelBar').classList.toggle('hide', rows.length === 0);
      const m = document.querySelector('main');
      if (m) m.classList.toggle('has-selbar', rows.length > 0);
      $('cvSelCount').textContent = `${rows.length} selected`;
      const est = rows.reduce((s, r) => s + (r.listing ?? data.floor ?? 0), 0);
      $('cvSelVal').innerHTML = est ? `est ${fx(est, 14)} ${esc(curSymbol())}${usdTag(est)}` : '';
    }

    function grid() {
      if (!data) return;
      const rows = RFILT.size ? data.rows.filter((r) => RFILT.has(tierOf(r.rarityRank))) : data.rows;
      const total = data.count;
      $('cvCount').textContent = total
        ? `${rows.length}${rows.length !== total ? ` / ${total}` : ''} NFT${total === 1 ? '' : 's'} · ${data.walletsHolding} wallet${data.walletsHolding === 1 ? '' : 's'} · ${ago(data.at)} ago`
        : '';
      $('cvAllWrap').style.display = rows.length ? '' : 'none';
      if (!rows.length) {
        $('cvGrid').innerHTML = emptyState({
          icon: 'col',
          title: RFILT.size ? 'No matches' : 'No NFTs held',
          desc: RFILT.size ? 'None of your NFTs fall in the selected rarity tiers.' : 'None of the selected wallets hold this collection.',
        });
        syncSel();
        return;
      }
      /* drop selections that no longer exist after a refresh */
      const live = new Set(data.rows.map((n) => String(n.tokenId)));
      [...CVSEL].forEach((t) => { if (!live.has(t)) CVSEL.delete(t); });
      const tv = viewMode === 'list';
      $('cvGrid').innerHTML = `<div class="nftgrid${tv ? ' tableview' : ''}">${tv ? '<div class="tvhead"><span></span><span>Item</span><span>List</span><span>Wallet</span></div>' : ''}${rows.map(card).join('')}</div>`;
      syncSel();
    }

    $('cvGrid').addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-tid]'); if (!cb) return;
      if (cb.checked) CVSEL.add(cb.dataset.tid); else CVSEL.delete(cb.dataset.tid);
      syncSel();
    });
    $('cvGrid').addEventListener('click', (e) => {
      if (e.target.closest('.nchk')) return;
      const c = e.target.closest('.ncard'); if (!c) return;
      const tid = c.dataset.tid;
      if (CVSEL.has(tid)) CVSEL.delete(tid); else CVSEL.add(tid);
      syncSel();
    });
    $('cvAll').onchange = () => {
      if (!data) return;
      if ($('cvAll').checked) data.rows.forEach((n) => CVSEL.add(String(n.tokenId)));
      else CVSEL.clear();
      syncSel();
    };
    $('cvSelClear').onclick = () => { CVSEL.clear(); syncSel(); };

    /* ---------- bulk list ---------- */
    $('cvList').onclick = () => {
      const rows = selRows(); if (!rows.length) return;
      /* Already-listed tokens are NOT skipped: they get relisted — existing
       * listing cancelled on-chain first, then the new price (higher or
       * lower) is signed in. Leaving the old order up would keep the old
       * price buyable. */
      const unlisted = rows.filter((r) => r.listing == null);
      const relists = rows.length - unlisted.length;
      const targets = rows;
      let floor = Number(data.floor || 0);
      const SYM = curSymbol();
      const floorHtml = (f) => `${fx(f, 14)} ${esc(SYM)}${f && curUsd() ? `<span class="uusd" style="margin-left:6px">$${num(f * curUsd(), 2)}</span>` : ''}`;
      const usd = (v) => curUsd() && v ? `($${num(v * curUsd(), 2)}) ` : '';
      modal(`<h3>Create listing</h3>
        ${relists ? `<div class="infobox">${relists} already listed — relisted at the new price.<br><b>Drop</b> = free: sign a new order only (OpenSea's zone kills the old one offchain).<br><b>Raise</b> = old order cancelled on-chain first (1 gas tx), since the cheaper order would stay buyable.</div>` : ''}
        ${!curIsEth() ? `<div class="infobox">This collection lists in <b>${esc(SYM)}</b> — the price you enter is in ${esc(SYM)}, not ETH.</div>` : ''}
        <div class="list-summary" style="grid-template-columns:1.5fr auto auto auto"><b>${targets.length} Item${targets.length === 1 ? '' : 's'}</b>
          <span class="mut">Floor</span><b id="blFloorVal">${floorHtml(floor)}</b>
          <button class="iact" id="blFloorRefresh" title="Refresh floor">${icon('refresh')}</button>
        </div>
        <div class="list-controls" style="justify-content:center">
          <button class="btn sm" id="blFloor">SET PRICE TO&nbsp; Floor</button>
          <button class="btn sm" id="blTrait">SET PRICE TO&nbsp; Trait floor</button>
          <button class="btn sm" id="blAdjust">Adjust for fees</button>
        </div>
        <div class="grid g2" style="margin-top:var(--s3)">
          <div><label class="f">Price ${esc(SYM)}</label><div class="price-input"><input id="blP" class="mono" inputmode="decimal" value="${floor ? fx(floor, 14) : ''}" placeholder="0.00"><span>${esc(SYM)}</span></div></div>
          <div><label class="f">Price USD</label><div class="price-input"><input id="blPUsd" class="mono" inputmode="decimal" value="${floor && curUsd() ? (floor * curUsd()).toFixed(2) : ''}" placeholder="${curUsd() ? '0.00' : 'rate unavailable'}" ${curUsd() ? '' : 'disabled'}><span>USD</span></div></div>
        </div>
        <div class="grid g2" style="margin-top:var(--s3)">
          <div><label class="f">Duration</label><select id="blD"><option value="1">1 day</option><option value="7">7 days</option><option value="30">1 month</option><option value="180" selected>6 months</option></select></div>
        </div>
        <div class="fee-box" style="margin-top:var(--s3)">
          <div><span>Total list price</span><b id="blTotal">—</b></div>
          <div><span>Floor difference</span><span id="blDiff">—</span></div>
          <div><span>Platform fees (1%)</span><span id="blPlatform">—</span></div>
          <div><span id="blCreatorLabel">Creator fees</span><span id="blCreator">—</span></div>
          <label class="toggle-row" id="blCreatorToggle"><span>Creator fees</span><input id="blCreatorOn" type="checkbox" checked><b>ON</b></label>
          <div class="fee-total"><span>Total est. proceeds</span><b id="blProceeds">—</b></div>
        </div>
        <div class="infobox">One Seaport 1.6 order per NFT, signed locally with each holding wallet. Needs an OpenSea key in Settings.</div>
        <div id="blProg" class="sm mut" style="margin-top:var(--s3)"></div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="blGo">Review listing</button></div>`);
      const creatorBps = (data.creatorFees || []).reduce((s, x) => s + Number(x.bps || 0), 0);
      const creatorPct = creatorBps / 100;
      /* Price <-> USD fields are two-way synced; the collection currency is
         the source of truth (that's what gets signed), USD mirrors it live. */
      const priceEth = () => {
        const v = Number($('blP').value);
        return (!v || isNaN(v)) ? 0 : v;
      };
      const setP = (eth) => {
        $('blP').value = fx(eth, 14);
        $('blPUsd').value = curUsd() ? (eth * curUsd()).toFixed(2) : '';
      };
      const syncUsd = () => { const v = Number($('blP').value); $('blPUsd').value = v && curUsd() ? (v * curUsd()).toFixed(2) : ''; };
      const syncEth = () => { const v = Number($('blPUsd').value); $('blP').value = v && curUsd() ? String(Number((v / curUsd()).toFixed(10))) : ''; };
      const updUsd = () => {
        const p = priceEth();
        const total = p * targets.length;
        const creator = $('blCreatorOn').checked ? total * creatorBps / 10000 : 0;
        $('blTotal').textContent = p ? `${usd(total)}${fx(total, 14)} ${SYM}` : '—';
        $('blDiff').textContent = p && floor ? `${((p / floor - 1) * 100).toFixed(2)}%` : '—';
        $('blPlatform').textContent = p ? `-${usd(total * .01)}${fx(total * .01, 14)} ${SYM}` : '—';
        $('blCreator').textContent = creator ? `-${usd(creator)}${fx(creator, 14)} ${SYM}` : '—';
        $('blProceeds').textContent = p ? `${usd(total - total * .01 - creator)}${fx(total - total * .01 - creator, 14)} ${SYM}` : '—';
      };
      const traitFloor = Number(data.traitFloor || 0);
      const creatorEnforced = data.creatorFees?.some((x) => x.enforced) === true;
      const creatorFees = creatorEnforced ? (data.creatorFees || []) : [];
      const creatorPctLabel = creatorPct.toFixed(2).replace(/\.00$/, '');
      if (creatorBps > 1000) { $('blCreatorOn').checked = false; $('blCreatorToggle').style.display = 'none'; $('blCreatorLabel').textContent = 'Creator fees unavailable'; }
      else $('blCreatorLabel').textContent = `Creator fees (${creatorPctLabel}%)`;
      if (!creatorEnforced) {
        $('blCreatorOn').checked = false;
        $('blCreatorToggle').style.display = 'none';
      } else {
        $('blCreatorOn').checked = true;
        $('blCreatorOn').disabled = true;
        $('blCreatorToggle').querySelector('span').textContent = 'Creator fees enforced';
      }
      const fetchFloor = async () => {
        const fresh = await api('/nft/floor', { chain: data.chain, slug: data.slug });
        const liveFloor = Number(fresh.floor ?? 0);
        if (!liveFloor) throw new Error('floor unavailable');
        floor = liveFloor; $('blFloorVal').innerHTML = floorHtml(floor); updUsd();
        return liveFloor;
      };
      $('blFloorRefresh').onclick = async () => {
        const b = $('blFloorRefresh'); b.disabled = true;
        try { await fetchFloor(); } catch (e) { warn(`Floor refresh failed: ${e.message}`); }
        finally { b.disabled = false; }
      };
      $('blFloor').onclick = async () => {
        const b = $('blFloor'); b.disabled = true; b.textContent = 'Loading floor…';
        try { setP(await fetchFloor()); updUsd(); } catch (e) { warn(`Floor refresh failed: ${e.message}`); }
        finally { b.disabled = false; b.innerHTML = 'SET PRICE TO&nbsp; Floor'; }
      };
      $('blTrait').onclick = () => { if (traitFloor) setP(traitFloor); else $('blP').value = ''; updUsd(); };
      $('blAdjust').onclick = () => { const p = priceEth(); if (p) { setP(p / (1 - .01 - (creatorEnforced ? creatorBps / 10000 : 0))); updUsd(); } };
      $('blP').oninput = () => { syncUsd(); updUsd(); };
      $('blPUsd').oninput = () => { syncEth(); updUsd(); };
      $('blCreatorOn').onchange = updUsd;
      updUsd();
      $('blGo').onclick = async () => {
        const pEth = priceEth();
        if (!pEth) return warn('Enter a price');
        const price = fx(pEth, 14);
        const b = $('blGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Listing';
        const common = { chain: data.chain, contract: data.address, slug: data.slug || null, durationDays: Number($('blD').value || 7), creatorFees: creatorEnforced ? creatorFees : [] };
        try {
          // Direction matters (orders are zone-gated, orderType=2):
          //  drop  → free: sign the new lower order, OpenSea's zone invalidates
          //          the old one offchain. No tx.
          //  raise → must cancel on-chain first: the old cheaper order stays a
          //          valid Seaport order anyone could fill otherwise.
          let skips = 0;
          const raising = [], listing = [];
          for (const n of targets) {
            const isRelist = n.listing != null;
            const oldP = Number(n.listing);
            const isRaising = isRelist && pEth > oldP * (1 + 1e-9);
            const dropping = isRelist && pEth < oldP * (1 - 1e-9);
            if (isRelist && !isRaising && !dropping) { skips++; continue; } // same price
            const item = { walletId: n.ownerId, tokenId: n.tokenId, price, standard: n.standard === 'erc1155' ? 'erc1155' : 'erc721' };
            if (isRaising) raising.push(item); else listing.push(item);
          }
          if (raising.length) {
            $('blProg').textContent = `Cancelling ${raising.length} old listing(s) on-chain…`;
            const cr = await api('/nft/cancel-batch', { ...common, items: raising });
            const cf = (cr || []).filter((x) => x.error);
            if (cf.length) throw new Error(`cancel failed: ${cf[0].error}`);
          }
          const todo = [...raising, ...listing];
          let okc = 0, fail = 0, lastErr = '';
          if (todo.length) {
            $('blProg').textContent = `Listing ${todo.length} NFT(s)…`;
            let r = await api('/nft/list-batch', { ...common, items: todo });
            // Safety net (same as old flow): OS rejected a no-cancel drop as
            // duplicate → cancel those + retry once.
            const dupes = (r || []).map((x, i) => ({ x, i })).filter(({ x }) => x && x.error && /already|exist|listed|duplicate/i.test(x.error));
            if (dupes.length) {
              $('blProg').textContent = `Re-cancelling ${dupes.length} duplicate(s)…`;
              await api('/nft/cancel-batch', { ...common, items: dupes.map((d) => todo[d.i]) }).catch(() => {});
              const r2 = await api('/nft/list-batch', { ...common, items: dupes.map((d) => todo[d.i]) }).catch(() => []);
              dupes.forEach((d, j) => { if (r2[j]) r[d.i] = r2[j]; });
            }
            okc = (r || []).filter((x) => x && x.ok).length;
            const errs = (r || []).filter((x) => x && x.error);
            fail = errs.length; lastErr = errs[0] ? errs[0].error : '';
          }
          if (okc) { closeModal(); ok('Listed', `${okc} ok${skips ? ` · ${skips} unchanged` : ''}${fail ? ` · ${fail} failed (${lastErr})` : ''}`); CVSEL.clear(); load(); }
          else { err('Listing failed', lastErr || 'nothing changed'); b.disabled = false; b.textContent = 'Retry'; }
        } catch (e) { err('Listing failed', e.message); b.disabled = false; b.textContent = 'Retry'; }
      };
    };

    /* ---------- bulk unlist (Seaport cancel on-chain) ----------
       One /api/nft/cancel per token, sequential. Gas-only fee per tx; safe to
       run on selected listed rows or Select-all. */
    $('cvUnlist').onclick = () => {
      const rows = selRows().filter((r) => r.listing != null);
      if (!rows.length) return warn('Select listed NFTs first');
      modal(`<h3>Unlist ${rows.length} NFT(s)</h3>
        <div class="infobox">Calls Seaport cancel() on-chain — all cancels broadcast back-to-back with pipelined nonces, then confirmed together.</div>
        <div id="unProg" class="sm mut" style="margin-top:var(--s3)"></div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="unGo">Unlist ${rows.length}</button></div>`);
      $('unGo').onclick = async () => {
        const b = $('unGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Cancelling';
        try {
          $('unProg').textContent = `Cancelling ${rows.length} listing(s) in parallel…`;
          const r = await api('/nft/cancel-batch', {
            chain: data.chain, contract: data.address,
            items: rows.map((n) => ({ walletId: n.ownerId, tokenId: n.tokenId })),
          });
          const okc = (r || []).filter((x) => x && x.ok).length;
          const fails = (r || []).filter((x) => x && x.error);
          if (okc) { closeModal(); ok('Unlisted', `${okc} ok${fails.length ? ` · ${fails.length} failed (${fails[0].error})` : ''}`); CVSEL.clear(); load(true); }
          else err('Unlist failed', fails[0] ? fails[0].error : 'nothing to unlist');
        } catch (e) { err('Unlist failed', e.message); b.disabled = false; b.textContent = 'Retry'; }
      };
    };

    /* ---------- bulk list ---------- */
    async function load(silent) {
      const input = $('cvIn').value.trim();
      if (!input) return warn('Paste a contract, slug, or OpenSea link');
      const ids = walletIds();
      if (!ids.length) return warn('No wallets in that group');
      const b = $('cvGo');
      if (!silent) { b.disabled = true; b.innerHTML = '<span class="spin"></span> Loading'; }
      try {
        data = await api('/nft/collection', {
          chain: $('cvChain').value, input, walletIds: ids, market: wantMarket, rarity: wantMarket,
        });
        checkReveal(data.rows);
        head(); grid(); rarf();
        if (!silent) ok('Loaded', `${data.count} NFT(s) · floor ${fx(data.floor, 14)} ${curSymbol()}${curUsd() && data.floor != null ? ' · $' + num(data.floor * curUsd(), 2) : ''}`);
        startAuto();
      } catch (e) {
        if (!silent) err('Failed', e.message);
        $('cvGrid').innerHTML = `<div class="failbox">${esc(e.message)}</div>`;
      } finally { if (!silent) { b.disabled = false; b.textContent = 'Load'; } }
    }

    /* Reveal watch — J-AIO's Viewer reveal monitor, built on the 60s
       auto-refresh already running here. Snapshots each token's image when
       armed; any image change on a later refresh counts as that token being
       revealed. Read-only, no extra API calls, no rate-limit cost. */
    const REV = { on: false, snap: null, revealed: new Set(), total: 0 };
    function watchUI() {
      const b = $('cvWatch'); if (!b) return;
      b.classList.toggle('on', REV.on);
      b.innerHTML = `${icon('eye')} ${REV.on ? `Reveal ${REV.revealed.size}/${REV.total}` : 'Reveal'}`;
    }
    function checkReveal(rows) {
      if (!REV.on || !REV.snap) return;
      const newly = [];
      rows.forEach((n) => {
        const id = String(n.tokenId);
        if (REV.revealed.has(id)) return;
        const prev = REV.snap.get(id);
        if (prev !== undefined && n.image && n.image !== prev) {
          REV.revealed.add(id);
          newly.push(n.name || '#' + n.tokenId);
        }
      });
      if (!newly.length) return;
      REV.snap = new Map(rows.map((n) => [String(n.tokenId), n.image || '']));
      ok('Revealed', `${newly.length} NFT(s): ${newly.slice(0, 3).join(', ')}${newly.length > 3 ? '…' : ''}`);
      if (REV.revealed.size >= REV.total) {
        REV.on = false; REV.snap = null;
        ok('Reveal complete', `All ${REV.total} NFTs revealed`);
      }
      watchUI();
    }
    $('cvMarket').onclick = () => {
      wantMarket = !wantMarket;
      $('cvMarket').classList.toggle('on', wantMarket);
      if (data) load(true); /* silent reload so the view matches the toggle */
    };
    $('cvWatch').onclick = () => {
      if (!data || !data.rows.length) return warn('Load a collection first');
      REV.on = !REV.on;
      if (REV.on) {
        REV.snap = new Map(data.rows.map((n) => [String(n.tokenId), n.image || '']));
        REV.revealed.clear();
        REV.total = data.rows.length;
        ok('Reveal watch on', `Watching ${REV.total} NFTs. Image change = revealed.`);
      } else { REV.snap = null; }
      watchUI();
    };

    /* ---------- collection offers / accept offer (OpenSea-style) ----------
     * On-demand only (never part of the load path, so it costs nothing until
     * clicked). Entry points: the toolbar "Offers" button (all held tokens)
     * and the selection bar "Accept offer" button (selected tokens only).
     * The checkout runs the SAME verification server-side that the real accept
     * runs (preview endpoint), so displayed fees/earnings are exactly what
     * gets signed — no estimates. */
    const fmtExp = (ts) => {
      const s = Number(ts) - Math.floor(Date.now() / 1000);
      if (!ts || !Number.isFinite(s) || s <= 0) return '—';
      if (s < 3600) return `in ${Math.max(1, Math.ceil(s / 60))} min`;
      if (s < 86400) return `in ${(s / 3600).toFixed(1)} h`;
      return `in ${Math.floor(s / 86400)} day${Math.floor(s / 86400) === 1 ? '' : 's'}`;
    };
    /* Criteria offers encode targeted token ids as base64 of concatenated
     * 32-byte big-endian ints. Best-effort decode — null means "any token". */
    function criteriaTokenIds(criteria) {
      try {
        const enc = criteria && (criteria.encodedTokenIds || criteria.encoded_token_ids);
        if (!enc) return null;
        const bin = atob(String(enc));
        if (!bin.length || bin.length % 32) return null;
        const ids = [];
        for (let i = 0; i < bin.length; i += 32) {
          let v = 0n;
          for (let j = 0; j < 32; j++) v = (v << 8n) | BigInt(bin.charCodeAt(i + j));
          ids.push(v.toString());
        }
        return ids.length ? ids : null;
      } catch { return null; }
    }
    let OF = [];
    let OFROWS = [];   // token pool the offers can be accepted into
    let PAY = { symbol: 'WETH', decimals: 18 };
    const payIsEth = () => /^w?eth$/i.test(PAY.symbol || '');
    const payRate = () => (payIsEth() ? S.ethUsd : STABLE_USD[(PAY.symbol || '').toLowerCase()] ?? null);
    const payUsd = (v) => { const r = payRate(); return (r && v != null) ? `<span class="uusd">$${num(v * r, 2)}</span>` : ''; };

    /* Rebuild the offers modal shell from the cached OF (no refetch) — used
     * by the checkout's Back button, since modal() replaces the whole box. */
    function offersShell() {
      modal(`<h3>${icon('offer')} Offers — ${esc(data.name || data.slug)}</h3>
        <div id="ofBody"></div>
        <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
      renderOffers();
    }
    async function openOffersModal(rows) {
      OFROWS = rows;
      modal(`<h3>${icon('offer')} Offers — ${esc(data.name || data.slug)}</h3>
        <div id="ofBody"><div class="empty"><span class="spin"></span><div class="et" style="margin-top:8px">Loading offers…</div></div></div>
        <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
      try {
        OF = await api('/nft/offers', { chain: data.chain, slug: data.slug, limit: 25 });
        if (OF.length && OF[0].paymentToken) {
          try {
            const ti = await api('/nft/token-info', { chain: data.chain, address: OF[0].paymentToken });
            PAY = { symbol: ti.symbol || 'WETH', decimals: ti.decimals || 18 };
          } catch { /* keep default */ }
        }
      } catch (e) {
        OF = [];
        const el = $('ofBody'); if (el) el.innerHTML = `<div class="failbox">${esc(e.message)}</div>`;
        return;
      }
      renderOffers();
    }
    function renderOffers() {
      const el = $('ofBody'); if (!el) return;
      if (!OF.length) { el.innerHTML = emptyState({ icon: 'offer', title: 'No offers', desc: 'No funded offers on this collection right now. Offers whose maker can\'t pay are hidden automatically.' }); return; }
      const floor = Number(data.floor || 0);
      el.innerHTML = `
        <div class="list-controls" style="justify-content:space-between;margin-bottom:8px">
          <button class="btn sm pri" id="ofAuto">${icon('offer')} AUTO ACCEPT — best offer per NFT</button>
          <label class="sm mut" style="display:flex;align-items:center;gap:6px" title="Offers paying less than 1% of the floor are skipped by default (dust/spam bids)"><input type="checkbox" id="ofDust"> include dust offers (&lt;1% of floor)</label>
        </div>
        <div class="tw" style="max-height:380px;overflow:auto"><table><thead><tr>
          <th class="rt">Price</th><th class="rt">Floor diff</th><th class="rt">Quantity</th><th>Expiration</th><th>From</th><th></th>
        </tr></thead><tbody>
        ${OF.map((o, i) => {
          const ids = criteriaTokenIds(o.criteria);
          const matches = ids ? OFROWS.filter((r) => ids.includes(String(r.tokenId))) : OFROWS;
          const fd = floor && o.price ? (o.price / floor - 1) * 100 : null;
          const fdTag = fd == null ? '<span class="mut">—</span>'
            : `<span style="color:${fd >= 0 ? 'var(--ok)' : 'var(--fail)'}">${fd >= 0 ? '+' : ''}${fd.toFixed(1)}%</span>`;
          return `<tr>
            <td class="num"><b>${fx(o.price, 6)}</b> ${esc(PAY.symbol)}${payUsd(o.price)}</td>
            <td class="num sm">${fdTag}</td>
            <td class="num">${num(o.quantity, 0)}${o.payableItems != null && o.payableItems < Number(o.quantity) ? `<div class="mut" style="font-size:11px">can pay ${o.payableItems}</div>` : ''}</td>
            <td class="sm mut">${fmtExp(o.expires)}</td>
            <td class="m sm" title="${esc(o.maker || '')}">${esc(short(o.maker || o.orderHash, 6))}${ids ? `<div class="mut" style="font-size:11px">targets #${esc(ids.slice(0, 2).join(', #'))}${ids.length > 2 ? '…' : ''}</div>` : ''}</td>
            <td class="rt"><button class="btn xs pri" data-i="${i}" ${matches.length ? '' : 'data-gated="1" title="You hold no NFT this offer can take"'}>Accept</button></td>
          </tr>`;
        }).join('')}</tbody></table></div>`;
      qa('#ofBody button[data-i]').forEach((btn) => { btn.onclick = () => checkoutModal(OF[Number(btn.dataset.i)]); });
      const ab = $('ofAuto'); if (ab) ab.onclick = () => autoAccept(ab);
    }

    /* BULK accept for multi-item offers: sells all your matching NFTs in ONE
     * API call — the server prepares every fill in parallel, dedupes approvals,
     * pipelines nonces and broadcasts all fills at once. Per-item errors are
     * reported individually; nothing blocks anything else. */
    async function sellAll(o, rows, btn) {
      const limit = Math.min(rows.length, Math.max(1, Number(o.quantity) || 1));
      const queue = rows.slice(0, limit);
      btn.disabled = true;
      const goBtn = $('coGo'); if (goBtn) goBtn.disabled = true;
      btn.innerHTML = `<span class="spin"></span> Bulk-selling ${queue.length} NFTs…`;
      try {
        const results = await api('/nft/accept-offers', {
          chain: data.chain,
          items: queue.map((row) => ({
            walletId: row.ownerId, orderHash: o.orderHash,
            contract: data.address, tokenId: String(row.tokenId),
            expectedPrice: String(o.price),
            protocolAddress: o.protocolAddress || undefined,
          })),
        });
        const sold = results.filter((r) => r.hash);
        const failed = results.filter((r) => r.error);
        const got = sold.reduce((a, r) => a + Number(r.net || 0), 0);
        const sym = (sold[0] && sold[0].symbol) || PAY.symbol;
        closeModal();
        if (sold.length) ok('Bulk sell done', `${sold.length}/${queue.length} sold for ${fx(got, 6)} ${sym} net${failed.length ? ` · ${failed.length} failed` : ''}`);
        else err('Bulk sell failed', (failed[0] && failed[0].error) || 'no fills succeeded');
      } catch (e) {
        err('Bulk sell failed', e.message);
      }
      CVSEL.clear(); load(true);
    }

    /* AUTO ACCEPT — BULK: walks every NFT in the pool (the selection, or all
     * held tokens), matches each one to the BEST funded offer that can take it,
     * then accepts ALL matches in ONE bulk call (server-side parallel prep +
     * pipelined nonces + parallel broadcast). Items no offer can take are
     * reported as "no offer" — nothing is skipped silently. Dust bids (<1% of
     * floor) are excluded unless the checkbox is on. Offer capacity is reserved
     * optimistically at match time. */
    async function autoAccept(btn) {
      if (!OF.length) { warn('No offers available on this collection right now'); return; }
      const includeDust = !!($('ofDust') && $('ofDust').checked);
      const floor = Number(data.floor || 0);
      const floorUsd = floor && curUsd() ? floor * curUsd() : null;
      const payR = payRate();
      const caps = OF.map((o) => ({
        o,
        ids: criteriaTokenIds(o.criteria),
        left: Math.min(Math.max(1, Number(o.quantity) || 1), o.payableItems != null ? Number(o.payableItems) : Math.max(1, Number(o.quantity) || 1)),
      }));
      const rows = [...OFROWS];
      const results = [];
      const matched = [];
      const label0 = btn.innerHTML;
      btn.disabled = true;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        btn.innerHTML = `<span class="spin"></span> matching ${i + 1}/${rows.length} · #${esc(String(row.tokenId))}`;
        const matchable = caps.filter((c) => !c.ids || c.ids.includes(String(row.tokenId)));
        const candidates = matchable.filter((c) => {
          if (c.left <= 0) return false;
          if (!includeDust && floorUsd != null && payR != null) {
            const ou = (c.o.price || 0) * payR;
            if (ou < floorUsd * 0.01) return false;
          }
          return true;
        }).sort((a, b) => (b.o.price || 0) - (a.o.price || 0));
        if (!candidates.length) {
          results.push({ row, status: matchable.length ? 'dust' : 'no-offer' });
          continue;
        }
        const pick = candidates[0];
        pick.left--; /* reserve capacity at match time (all matching happens before any fill) */
        matched.push({ row, o: pick.o });
      }
      if (matched.length) {
        btn.innerHTML = `<span class="spin"></span> Bulk-accepting ${matched.length} offers…`;
        try {
          const res = await api('/nft/accept-offers', {
            chain: data.chain,
            items: matched.map((m) => ({
              walletId: m.row.ownerId, orderHash: m.o.orderHash,
              contract: data.address, tokenId: String(m.row.tokenId),
              expectedPrice: String(m.o.price),
              protocolAddress: m.o.protocolAddress || undefined,
            })),
          });
          const byKey = new Map(res.map((r) => [`${r.orderHash}|${r.tokenId}`, r]));
          for (const m of matched) {
            const r = byKey.get(`${m.o.orderHash}|${m.row.tokenId}`);
            if (r && r.hash) results.push({ row: m.row, status: 'sold', net: Number(r.net), sym: r.symbol || PAY.symbol });
            else results.push({ row: m.row, status: 'error', msg: (r && r.error) || 'no result returned' });
          }
        } catch (e) {
          for (const m of matched) results.push({ row: m.row, status: 'error', msg: e.message });
        }
      }
      btn.disabled = false; btn.innerHTML = label0;
      const sold = results.filter((r) => r.status === 'sold');
      const noOffer = results.filter((r) => r.status === 'no-offer');
      const dustOnly = results.filter((r) => r.status === 'dust');
      const errs = results.filter((r) => r.status === 'error');
      const totalNet = sold.reduce((a, r) => a + (r.net || 0), 0);
      modal(`<h3>${icon('offer')} Auto accept — results</h3>
        <div class="infobox"><b>${sold.length}</b> sold${sold.length ? ` · net ${fx(totalNet, 8)} ${esc(sold[0].sym || PAY.symbol)}` : ''} · <b>${noOffer.length}</b> no offer${dustOnly.length ? ` · <b>${dustOnly.length}</b> dust only (skipped)` : ''}${errs.length ? ` · <b>${errs.length}</b> error${errs.length === 1 ? '' : 's'}` : ''}</div>
        <div class="tw" style="max-height:380px;overflow:auto"><table><thead><tr>
          <th class="rt">Token</th><th>Wallet</th><th>Result</th>
        </tr></thead><tbody>
        ${results.map((r) => `<tr>
          <td class="num"><b>#${esc(String(r.row.tokenId))}</b></td>
          <td class="sm mut">${esc(r.row.ownerName || short(r.row.owner || '', 6))}</td>
          <td>${r.status === 'sold' ? `<span style="color:var(--ok)">sold · ${fx(r.net, 8)} ${esc(r.sym || '')}</span>`
            : r.status === 'no-offer' ? '<span class="mut">no offer</span>'
            : r.status === 'dust' ? '<span class="mut">only dust offers (&lt;1% of floor)</span>'
            : `<span style="color:var(--fail)">${esc(r.msg || 'error')}</span>`}</td>
        </tr>`).join('')}
        </tbody></table></div>
        <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
      if (sold.length) { CVSEL.clear(); load(true); }
    }

    /* OpenSea-style accept: item card, fee split, "You will receive", one button.
     * Multi-item (collection) offers: each accept is a Seaport partial fill —
     * sell one of your NFTs at the per-item price; "Sell all" loops the rest. */
    function checkoutModal(o) {
      const ids = criteriaTokenIds(o.criteria);
      const rows = ids ? OFROWS.filter((r) => ids.includes(String(r.tokenId))) : OFROWS;
      if (!rows.length) return warn(ids ? 'This offer targets an NFT you don\'t hold' : 'None of your selected NFTs match this offer');
      modal(`<h3>${icon('offer')} Accept offer</h3>
        <div id="coBody"></div>
        <div class="acts" style="margin-top:var(--s3)"><button class="btn pri" id="coGo" style="width:100%" disabled>Verifying…</button></div>`);
      if (rows.length > 1 && Number(o.quantity) > 1) {
        const allBtn = document.createElement('button');
        allBtn.className = 'btn'; allBtn.id = 'coAll';
        allBtn.style.width = '100%'; allBtn.style.marginTop = 'var(--s2)';
        allBtn.textContent = `Sell all ${Math.min(rows.length, Number(o.quantity))} items (auto)`;
        $('coGo').parentElement.appendChild(allBtn);
        allBtn.onclick = () => sellAll(o, rows, allBtn);
      }

      const selHtml = rows.length > 1
        ? `<label class="f">Item to sell</label>
           <select id="coT" style="margin-bottom:var(--s3)">${rows.map((r) => `<option value="${esc(String(r.tokenId))}">#${esc(String(r.tokenId))} · ${esc(r.name)}</option>`).join('')}</select>`
        : '';
      $('coBody').innerHTML = `${selHtml}<div id="coItem"></div><div id="coFees"></div>`;

      let PV = null;
      async function loadPreview() {
        const tid = $('coT') ? $('coT').value : String(rows[0].tokenId);
        const row = rows.find((r) => String(r.tokenId) === tid) || rows[0];
        const itemEl = $('coItem'); const feesEl = $('coFees'); const goBtn = $('coGo');
        goBtn.disabled = true; goBtn.innerHTML = '<span class="spin"></span> Verifying…'; PV = null;
        itemEl.innerHTML = `<div class="ositem">
          ${row.image ? `<img src="${esc(row.image)}" alt="">` : `<div class="noimg">${icon('col')}</div>`}
          <div>
            <div class="sm mut">${esc(data.name || data.slug)}</div>
            <div class="nm">${esc(row.name || '#' + row.tokenId)} <span class="mut">#${esc(String(row.tokenId))}</span></div>
          </div>
        </div>`;
        try {
          PV = await api('/nft/offer-preview', {
            chain: data.chain, walletId: row.ownerId, orderHash: o.orderHash,
            contract: data.address, tokenId: String(row.tokenId),
            protocolAddress: o.protocolAddress || undefined,
          });
          PV._row = row;
          const paySym = PV.paymentToken.symbol || PAY.symbol;
          const sym = esc(paySym);
          const rate = /^w?eth$/i.test(paySym) ? S.ethUsd : STABLE_USD[paySym.toLowerCase()] ?? null;
          const usd = (v) => (rate ? `<span class="uusd">$${num(Number(v) * rate, 2)}</span>` : '');
          feesEl.innerHTML = `<div class="fee-box">
            <div><span>Price</span><b>${fx(Number(PV.gross), 6)} ${sym} ${usd(PV.gross)}</b></div>
            ${PV.fees.map((f) => `<div><span>${esc(f.label)}${f.pct ? ` (${f.pct.toFixed(2).replace(/\.?0+$/, '')}%)` : ''}</span><span>-${fx(Number(f.amount), 6)} ${sym}</span></div>`).join('')}
            <div class="fee-total"><span>You will receive</span><b>${fx(Number(PV.net), 6)} ${sym} ${usd(PV.net)}</b></div>
          </div>
          <div class="sm mut" style="margin-top:var(--s2)">From ${esc(short(PV.maker, 8))} · ${PV.endTime ? 'expires ' + fmtExp(PV.endTime) : 'no expiry'} · paid in ${sym}${PV.fillDenominator > 1 ? ` · partial fill ${PV.fillNumerator}/${PV.fillDenominator} of a multi-item offer` : ''}</div>`;
          goBtn.disabled = false; goBtn.textContent = 'Accept';
        } catch (e) {
          feesEl.innerHTML = `<div class="failbox">${esc(e.message)}</div>`;
          goBtn.disabled = true; goBtn.textContent = 'Unavailable';
        }
      }
      if ($('coT')) $('coT').onchange = loadPreview;
      loadPreview();

      $('coGo').onclick = async () => {
        if (!PV) return;
        const row = PV._row;
        const b = $('coGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Selling';
        try {
          const r = await api('/nft/accept-offer', {
            chain: data.chain, walletId: row.ownerId, orderHash: o.orderHash,
            contract: data.address, tokenId: String(row.tokenId),
            expectedPrice: PV.gross,
            protocolAddress: o.protocolAddress || undefined,
          });
          closeModal();
          ok('Offer accepted', `#${row.tokenId} sold for ${fx(Number(PV.net), 6)} ${PV.paymentToken.symbol} net · tx ${short(r.hash, 10)}`);
          CVSEL.clear(); load(true);
        } catch (e) {
          err('Accept failed', e.message);
          b.disabled = false; b.textContent = 'Retry';
        }
      };
    }
    $('cvOffers').onclick = () => {
      if (!data || !data.slug) return warn('Load a collection first');
      if (!data.rows.length) return warn('None of the selected wallets hold this collection');
      openOffersModal(data.rows);
    };
    $('cvAccept').onclick = () => {
      const rows = selRows();
      if (!rows.length) return;
      openOffersModal(rows);
    };

    /* Auto-refresh: floor, owner and listing follow OpenSea every 60s.
       Silent — no spinner/toast, selection survives. Killed on page leave. */
    const AUTOREFRESH_MS = 60000;
    let autoTimer = null;
    function startAuto() {
      if (autoTimer) return;
      autoTimer = setInterval(() => { if (data) load(true); }, AUTOREFRESH_MS);
    }
    el._hide = () => { if (autoTimer) { clearInterval(autoTimer); autoTimer = null; } };
    el._show = () => { if (data) startAuto(); };
    el._cleanup = el._hide;

    $('cvGo').onclick = () => load();
    function setView(m) {
      viewMode = m;
      $('cvGridView').classList.toggle('on', m === 'grid');
      $('cvTableView').classList.toggle('on', m === 'list');
      grid();
    }
    $('cvGridView').onclick = () => setView('grid');
    $('cvTableView').onclick = () => setView('list');
    $('cvTransfer').onclick = () => {
      const rows = selRows(); if (!rows.length) return;
      modal(`<h3>Transfer ${rows.length} selected NFT(s)</h3>
        <div class="grid g2"><div><label class="f">Mode</label><select id="ctMode"><option value="disperse">Disperse</option><option value="consolidate">Consolidate</option></select></div>
        <div><label class="f">Gas</label><select id="ctGas"><option value="low" selected>Low</option><option value="normal">Normal</option><option value="fast">Fast</option></select></div></div>
        <label class="f" style="margin-top:var(--s3)">Destination address(es)</label><textarea id="ctTo" class="mono" rows="3" placeholder="One 0x address per line"></textarea>
        <div id="ctQtyWrap"><label class="f">NFTs per destination wallet</label><input id="ctQty" type="number" min="1" value="1"></div>
        <div class="infobox">Disperse distributes selected NFTs across destination wallets. Consolidate sends all selected NFTs to one destination.</div>
        <div id="ctProg" class="sm mut"></div><div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="ctGo">Review transfers</button></div>`);
      const syncMode = () => { $('ctQtyWrap').style.display = $('ctMode').value === 'disperse' ? '' : 'none'; };
      $('ctMode').onchange = syncMode; syncMode();
      $('ctGo').onclick = async () => {
        const mode = $('ctMode').value;
        const tos = $('ctTo').value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
        if (!tos.length) return warn('Destination required');
        if (mode === 'consolidate' && tos.length !== 1) return warn('Consolidate needs one destination');
        if (tos.some((x) => !/^0x[a-fA-F0-9]{40}$/.test(x))) return warn('Invalid destination address');
        const qty = Math.max(1, Number($('ctQty').value || 1));
        const jobs = [];
        if (mode === 'consolidate') rows.forEach((n) => jobs.push({ n, to: tos[0] }));
        else {
          let i = 0;
          for (const to of tos) for (let k = 0; k < qty && i < rows.length; k++, i++) jobs.push({ n: rows[i], to });
          if (jobs.length < rows.length) return warn('Not enough destination capacity', `${jobs.length}/${rows.length} NFTs assigned`);
        }
        if (!confirm(`Send ${jobs.length} NFT(s) using ${$('ctGas').value.toUpperCase()} gas? This broadcasts real on-chain transactions.`)) return;
        const speed = $('ctGas').value;
        let totalDone = 0;
        let queue = jobs;
        const run = async () => {
          const fails = [];
          for (let i = 0; i < queue.length; i++) {
            const j = queue[i];
            const pr = $('ctProg') || $('ctProg2');
            if (pr) pr.textContent = `${i + 1}/${queue.length} · #${j.n.tokenId} to ${short(j.to, 6)}`;
            try { await api('/nft/transfer', { chain: data.chain, walletId: j.n.ownerId, contract: data.address, tokenId: j.n.tokenId, to: j.to, speed }); totalDone++; }
            catch (e) { fails.push({ j, err: e.message }); }
          }
          queue = fails.map((f) => f.j);
          if (!fails.length) {
            closeModal();
            ok('Transfer done', `${totalDone} sent`); CVSEL.clear(); load();
            return;
          }
          modal(`<h3>Transfer result</h3>
            <div class="infobox">${totalDone} sent · <b style="color:var(--fail)">${fails.length} failed</b></div>
            <div class="tw" style="margin-top:var(--s3);max-height:230px;overflow:auto"><table><thead><tr><th>NFT</th><th>To</th><th>Error</th></tr></thead><tbody>
              ${fails.map((f) => `<tr><td class="m">#${f.j.n.tokenId}</td><td class="m sm">${esc(short(f.j.to, 6))}</td><td class="sm mut">${esc(String(f.err || '').slice(0, 90))}</td></tr>`).join('')}
            </tbody></table></div>
            <div id="ctProg2" class="sm mut" style="margin-top:var(--s2)"></div>
            <div class="acts" style="margin-top:var(--s3)"><button class="btn" onclick="closeModal()">Close</button><button class="btn pri" id="ctRetry">Retry failed (${fails.length})</button></div>`);
          $('ctRetry').onclick = run;
        };
        run();
      };
    };
    $('cvRefresh').onclick = load;
    $('cvIn').onkeydown = (e) => { if (e.key === 'Enter') load(); };

    $('cvCsv').onclick = () => {
      if (!data || !data.rows.length) return warn('Nothing to export');
      const rows = [['tokenId', 'name', 'rarityRank', 'listing', 'ownerName', 'owner']]
        .concat(data.rows.map((n) => [n.tokenId, n.name, n.rarityRank ?? '', n.listing ?? '', n.ownerName, n.owner]));
      dl(`${data.slug || 'collection'}-holdings.csv`, rows.map((r) => r.join(',')).join('\n'));
    };

    $('cvCard').onclick = () => {
      const input = $('cvIn').value.trim();
      if (!input) return warn('Load a collection first');
      pnlCardModal($('cvChain').value, input, walletIds());
    };
  },
});

function acceptModal(n, data) { /* superseded by bulk accept on the selection bar */ }

/* ---------- PnL card ---------- */

/* A shareable card, the way J-AIO does it: Minted / Sold / Bought / Holding on
 * one row, net underneath, crypto or USD. Rendered to canvas for PNG download
 * so it can be dropped straight into a tweet. */
function pnlCardModal(chain, input, walletIds) {
  modal(`<h3>PnL card</h3>
    <div class="row mb8" style="gap:8px;align-items:center;flex-wrap:wrap">
      <input id="pcImgUrl" class="inp sm" style="flex:1;min-width:180px" placeholder="Card image URL — any ratio, auto center-cropped to 16:9">
      <button class="btn sm" id="pcImgSet">Set</button>
      <button class="btn sm" id="pcImgFile">${icon('col')} Upload</button>
      <button class="btn sm" id="pcImgClear" aria-disabled="true">Clear</button>
      <input type="file" id="pcImgPick" accept="image/*" style="display:none">
    </div>
    <div id="pcBody"><div class="empty"><span class="spin"></span><div class="et" style="margin-top:8px">Crawling sales history…</div>
    <div class="ed">OpenSea events API, paged per wallet. A large group takes a while.</div></div></div>
    <div class="acts">
      <button class="btn" onclick="closeModal()">Close</button>
      <span class="tb-end"></span>
      <button class="btn sm" id="pcUnit" aria-disabled="true">USD</button>
      <button class="btn sm" id="pcCopy" aria-disabled="true">${icon('copy')} Copy text</button>
      <button class="btn pri sm" id="pcPng" aria-disabled="true">Download PNG</button>
    </div>`, true);

  let card = null, unit = 'crypto';
  /* Custom card image (dataURL). Any aspect ratio works — preview uses CSS
     cover+center, the PNG render does the same math on canvas. */
  let bgUrl = null;

  function applyBg() {
    gate('pcImgClear', !!bgUrl, 'No card image set');
    if (card) draw();
  }

  $('pcImgSet').onclick = async () => {
    const u = $('pcImgUrl').value.trim();
    if (!u) return warn('Paste an image URL first');
    const b = $('pcImgSet'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('/img?url=' + encodeURIComponent(u));
      bgUrl = r.dataUrl; applyBg(); ok('Card image set', 'auto center-cropped to 16:9');
    } catch (e) { err('Failed to load image', e.message); }
    finally { b.disabled = false; b.textContent = 'Set'; }
  };

  $('pcImgFile').onclick = () => $('pcImgPick').click();
  $('pcImgPick').onchange = () => {
    const f = $('pcImgPick').files && $('pcImgPick').files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => { bgUrl = String(fr.result); applyBg(); ok('Card image set', f.name); };
    fr.onerror = () => err('Failed to read file');
    fr.readAsDataURL(f);
    $('pcImgPick').value = '';
  };

  $('pcImgClear').onclick = () => { bgUrl = null; $('pcImgUrl').value = ''; applyBg(); };


  /* Three-way toggle: ETH -> USD -> IDR -> ETH. The button label names the
   * NEXT unit so one click always lands where it says. */
  const money = (v) => {
    if (unit === 'usd' && card && card.ethUsd != null) return '$' + num(v * card.ethUsd, 2);
    if (unit === 'idr' && card && card.ethUsd != null && card.usdIdr != null) {
      return idr(v * card.ethUsd * card.usdIdr);
    }
    return fx(v, 4) + ' Ξ';
  };

  function draw() {
    if (!card) return;
    const netPos = card.netEth >= 0;
    const bgCls = bgUrl ? ' pc-img' : '';
    const bgInline = bgUrl ? ` style="background-image:url('${bgUrl}')"` : '';
    $('pcBody').innerHTML = `<div class="pcard${bgCls}" id="pcCard"${bgInline}>
      <div class="pc-top">
        ${card.image ? `<img src="${esc(card.image)}" alt="">` : ''}
        <div class="pc-col">
          <div class="pc-name">${esc(card.collection)}</div>
          <div class="pc-sub">${num(card.wallets, 0)} wallets · floor ${fx(card.floor, 4)} Ξ</div>
        </div>
        <div class="pc-net">
          <div class="pc-sub">Net PnL</div>
          <div class="v ${netPos ? 'up' : 'down'}">${netPos ? '+' : ''}${money(card.netEth)}</div>
          ${card.pct != null ? `<div class="p ${card.pct >= 0 ? 'up' : 'down'}">${card.pct >= 0 ? '+' : ''}${fx(card.pct, 1)}%</div>` : ''}
        </div>
      </div>
      <div class="pc-grid">
        <div class="pc-cell"><div class="k">Minted</div><div class="v">${num(card.minted, 0)}</div><div class="sm mut">${money(card.mintedEth)}</div></div>
        <div class="pc-cell"><div class="k">Bought</div><div class="v">${num(card.bought, 0)}</div><div class="sm mut">${money(card.boughtEth)}</div></div>
        <div class="pc-cell"><div class="k">Sold</div><div class="v ok">${num(card.sold, 0)}</div><div class="sm mut">${money(card.soldEth)}</div></div>
        <div class="pc-cell"><div class="k">Holding</div><div class="v accent">${num(card.holding, 0)}</div><div class="sm mut">${money(card.holdingEth)}</div></div>
      </div>
      <div class="pc-foot"><span>J-AIO</span><span class="tb-end">${new Date(card.at).toLocaleDateString('en-GB')}</span></div>
    </div>`;
    gate('pcUnit', card.ethUsd != null, card.ethUsd == null ? 'ETH price unavailable' : '');
    gate('pcCopy', true); gate('pcPng', true);
  }

  $('pcUnit').onclick = () => {
    /* IDR is only in the cycle when we actually have a USD→IDR rate. */
    const cycle = card && card.usdIdr != null ? ['crypto', 'usd', 'idr'] : ['crypto', 'usd'];
    unit = cycle[(cycle.indexOf(unit) + 1) % cycle.length];
    const next = cycle[(cycle.indexOf(unit) + 1) % cycle.length];
    $('pcUnit').textContent = next === 'crypto' ? 'ETH' : next.toUpperCase();
    draw();
  };

  $('pcCopy').onclick = () => {
    if (!card) return;
    copy([
      `${card.collection} — ${card.wallets} wallets`,
      `net ${card.netEth >= 0 ? '+' : ''}${fx(card.netEth, 4)} ETH${card.netIdr != null ? ` (${idr(card.netIdr)})` : ''}${card.pct != null ? ` (${fx(card.pct, 1)}%)` : ''}`,
      `minted ${card.minted} · bought ${card.bought} · sold ${card.sold} · holding ${card.holding}`,
      `floor ${fx(card.floor, 4)} ETH`,
    ].join('\n'));
  };

  /* Canvas render rather than an HTML-to-image dependency: the card is a fixed
     layout, so drawing it directly is smaller and has no network cost. */
  $('pcPng').onclick = async () => {
    if (!card) return;
    const W = 1000, H = 520, cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    if (bgUrl) {
      /* Custom image: CENTER-CROP to the card's ratio (cover), never stretch —
         a 1:1 picture loses its left/right middles, a tall one its top/bottom. */
      try {
        const im = await new Promise((res, rej) => {
          const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('decode failed')); i.src = bgUrl;
        });
        const t = W / H, s = im.naturalWidth / im.naturalHeight;
        let sw, sh, sx, sy;
        if (s > t) { sh = im.naturalHeight; sw = sh * t; sx = (im.naturalWidth - sw) / 2; sy = 0; }
        else { sw = im.naturalWidth; sh = sw / t; sx = 0; sy = (im.naturalHeight - sh) / 2; }
        g.drawImage(im, sx, sy, sw, sh, 0, 0, W, H);
        g.fillStyle = 'rgba(247,250,253,0.8)'; g.fillRect(0, 0, W, H); /* readability wash */
      } catch { g.fillStyle = '#f7fafd'; g.fillRect(0, 0, W, H); }
    } else {
      g.fillStyle = '#f7fafd'; g.fillRect(0, 0, W, H);
    }
    g.fillStyle = '#fff';
    const rr = (x, y, w, h, r) => {
      g.beginPath(); g.moveTo(x + r, y);
      g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
      g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
    };
    rr(30, 30, W - 60, H - 60, 22); g.fill();
    g.strokeStyle = '#d8e6f5'; g.lineWidth = 2; g.stroke();

    g.fillStyle = '#16273c'; g.font = '700 38px system-ui,sans-serif';
    g.fillText(String(card.collection).slice(0, 26), 70, 110);
    g.fillStyle = '#7b8ea6'; g.font = '400 20px system-ui,sans-serif';
    g.fillText(`${card.wallets} wallets · floor ${fx(card.floor, 4)} ETH`, 70, 146);

    const pos = card.netEth >= 0;
    g.fillStyle = pos ? '#1f9d68' : '#cc4646';
    g.font = '700 60px system-ui,sans-serif';
    const netTxt = `${pos ? '+' : ''}${fx(card.netEth, 4)} ETH`;
    g.textAlign = 'right'; g.fillText(netTxt, W - 70, 128);
    if (card.pct != null) {
      g.font = '600 24px system-ui,sans-serif';
      g.fillText(`${card.pct >= 0 ? '+' : ''}${fx(card.pct, 1)}%`, W - 70, 162);
    }
    g.textAlign = 'left';

    const cells = [
      ['Minted', card.minted, card.mintedEth, '#16273c'],
      ['Bought', card.bought, card.boughtEth, '#16273c'],
      ['Sold', card.sold, card.soldEth, '#1f9d68'],
      ['Holding', card.holding, card.holdingEth, '#3a90dd'],
    ];
    cells.forEach(([k, n, e, col], i) => {
      const x = 70 + i * 222;
      g.fillStyle = '#f2f7fc'; rr(x, 210, 202, 150, 14); g.fill();
      g.fillStyle = '#7b8ea6'; g.font = '700 15px system-ui,sans-serif';
      g.fillText(String(k).toUpperCase(), x + 22, 246);
      g.fillStyle = col; g.font = '700 46px system-ui,sans-serif';
      g.fillText(num(n, 0), x + 22, 302);
      g.fillStyle = '#7b8ea6'; g.font = '400 18px system-ui,sans-serif';
      g.fillText(`${fx(e, 4)} ETH`, x + 22, 336);
    });

    g.fillStyle = '#a8b8c9'; g.font = '600 17px system-ui,sans-serif';
    g.fillText('J-AIO', 70, H - 62);
    g.textAlign = 'right';
    g.fillText(new Date(card.at).toLocaleDateString('en-GB'), W - 70, H - 62);

    const a = document.createElement('a');
    a.href = cv.toDataURL('image/png');
    a.download = `${card.slug || 'pnl'}-card.png`;
    a.click();
    ok('Saved', a.download);
  };

  api('/nft/pnl-card', { chain, input, walletIds })
    .then((r) => { card = r; draw(); })
    .catch((e) => { $('pcBody').innerHTML = `<div class="failbox">${esc(e.message)}</div>`; });
}
