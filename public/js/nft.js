'use strict';

page('nftinv', {
  label: 'Inventory & Transfer', group: 'NFT', icon: 'inv',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Inventory & Transfer</h2>
      <p class="ps">Read NFTs held by your wallets, then move or sweep them.</p>
      <div class="card">
        <div class="row">
          <div style="width:150px"><label class="f">Chain</label><select id="niChain">${chainOpts('ethereum')}</select></div>
          <div style="flex:1;min-width:170px"><label class="f">Wallet group</label><select id="niGroup"></select></div>
          <div style="flex:1;min-width:200px"><label class="f">Collection filter <span class="opt">— OS slug, optional</span></label><input id="niSlug" class="mono"></div>
          <button class="btn pri" id="niLoad">Load</button>
        </div>
      </div>
      <div class="card"><h3>Items <span class="sub" id="niCount"></span>
        <div style="margin-left:auto" class="row">
          <button class="btn xs" id="niAll">All</button>
          <button class="btn xs" id="niNone">None</button>
          <button class="btn xs" id="niXfer">Transfer selected</button>
          <button class="btn xs" id="niSweep">Sweep collection</button>
        </div></h3>
        <div class="tw" id="niTable">${emptyState({ icon: 'inv', title: 'Nothing loaded', desc: 'Pick wallets and load to see NFT holdings.' })}</div>
      </div>`;

    let items = [];
    const sel = new Set();

    $('niGroup').innerHTML = '<option value="">All groups</option>'
      + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');

    function walletsSel() {
      const g = $('niGroup').value;
      return S.wallets.evm.filter((w) => !g || w.groupId === g);
    }

    function render() {
      $('niCount').textContent = `${items.length} items · ${sel.size} selected`;
      if (!items.length) { $('niTable').innerHTML = emptyState({ icon: 'inv', title: 'Nothing found', desc: 'These wallets hold no NFTs on the selected chain.' }); return; }
      $('niTable').innerHTML = `<table><thead><tr><th style="width:30px"></th><th>Collection</th><th>NFT</th>
        <th>Standard</th><th>Owner</th><th></th></tr></thead><tbody>
        ${items.map((n, i) => `<tr>
          <td><input type="checkbox" data-i="${i}" ${sel.has(i) ? 'checked' : ''}></td>
          <td>${esc(n.collection || '—')}</td>
          <td class="m">#${esc(String(n.tokenId))}</td>
          <td class="sm mut">${esc(n.standard || '')}</td>
          <td class="m sm">${esc(short(n.owner, 6))}</td>
          <td class="rt"><button class="btn xs" data-list="${i}">list</button></td>
        </tr>`).join('')}</tbody></table>`;
      qa('#niTable input[type=checkbox]').forEach((c) => {
        c.onchange = () => { const i = Number(c.dataset.i); if (c.checked) sel.add(i); else sel.delete(i); $('niCount').textContent = `${items.length} items · ${sel.size} selected`; };
      });
      qa('#niTable button[data-list]').forEach((b) => { b.onclick = () => listModal(items[Number(b.dataset.list)], $('niChain').value); });
    }

    $('niAll').onclick = () => { items.forEach((_, i) => sel.add(i)); render(); };
    $('niNone').onclick = () => { sel.clear(); render(); };

    $('niLoad').onclick = async () => {
      const ws = walletsSel();
      if (!ws.length) return warn('No wallets in group');
      const b = $('niLoad'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        items = await api('/nft/inventory', { chain: $('niChain').value, addresses: ws.map((w) => w.address), collection: $('niSlug').value.trim() || null });
        sel.clear(); render(); ok('Loaded', `${items.length} NFTs`);
      } catch (e) { err('Failed', e.message); $('niTable').innerHTML = `<div class="failbox">${esc(e.message)}</div>`; }
      finally { b.disabled = false; b.textContent = 'Load'; }
    };

    $('niXfer').onclick = () => {
      if (!sel.size) return warn('Select items first');
      modal(`<h3>Transfer ${sel.size} NFT(s)</h3>
        <label class="f">Destination address</label><input id="ntTo" class="mono" placeholder="0x…">
        <div class="warnbox">NFT transfers are irreversible. Double-check the destination.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="ntGo">Transfer</button></div>`);
      $('ntGo').onclick = async () => {
        const to = $('ntTo').value.trim();
        if (!/^0x[a-fA-F0-9]{40}$/.test(to)) return err('Bad address');
        const b = $('ntGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const batchItems = [];
          let skipped = 0;
          for (const i of [...sel]) {
            const n = items[i];
            const w = S.wallets.evm.find((x) => x.address.toLowerCase() === String(n.owner).toLowerCase());
            if (!w) { skipped++; continue; }
            batchItems.push({ walletId: w.id, contract: n.contract, tokenId: n.tokenId, standard: n.standard });
          }
          const r = await api('/nft/transfer-batch', { chain: $('niChain').value, items: batchItems, to });
          const done = (r || []).filter((x) => x.hash).length;
          const failed = (r || []).filter((x) => x.error).length + skipped;
          closeModal();
          toast('Transfer done', `${done} sent, ${failed} failed`, failed ? 'warn' : 'ok');
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = 'Transfer'; }
      };
    };

    $('niSweep').onclick = () => {
      modal(`<h3>Sweep collection</h3>
        <label class="f">Contract</label><input id="nsC" class="mono" placeholder="0x…">
        <label class="f" style="margin-top:var(--s3)">Destination</label><input id="nsTo" class="mono" placeholder="0x…">
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:var(--s3);font-size:13px;cursor:pointer">
          <input type="checkbox" id="nsBulk" checked style="margin-top:2px">
          <span><b>Bulk</b> — 1 tx per wallet (all NFTs at once). First use per chain auto-deploys a small helper contract; first sweep per wallet adds 1 approve tx.</span>
        </label>
        <div class="infobox">Every NFT of that contract in the selected wallet group moves to the destination.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="nsGo">Sweep</button></div>`);
      $('nsGo').onclick = async () => {
        const b = $('nsGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const bulk = $('nsBulk').checked;
          const r = await api('/nft/sweep', { chain: $('niChain').value, walletIds: walletsSel().map((w) => w.id), contract: $('nsC').value.trim(), to: $('nsTo').value.trim(), bulk });
          closeModal();
          if (Array.isArray(r)) ok('Swept', `${r.length} transfers`);
          else {
            const res = r.results || [];
            const sent = res.reduce((a, x) => a + (x.sent || (x.items || []).filter((i) => i.hash).length), 0);
            const errs = res.filter((x) => x.error).length;
            const fb = res.filter((x) => x.fallback).length;
            ok('Swept (bulk)', `${sent} NFTs · ${res.length} wallets${fb ? ` · ${fb} via fallback` : ''}${errs ? ` · ${errs} errors` : ''}`);
          }
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = 'Sweep'; }
      };
    };
  },
});

function listModal(n, chain) {
  const w = S.wallets.evm.find((x) => x.address.toLowerCase() === String(n.owner || '').toLowerCase());
  modal(`<h3>List on OpenSea</h3>
    <div class="sm mut">${esc(n.collection || '')} #${esc(String(n.tokenId))} · ${esc(short(n.contract, 8))}</div>
    <div class="infobox hide" id="nlCurNote" style="margin-top:6px"></div>
    <div class="grid g2" style="margin-top:var(--s3)">
      <div><label class="f">Wallet</label><select id="nlW">${S.wallets.evm.map((x) => `<option value="${x.id}"${w && x.id === w.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div><label class="f" id="nlCurLabel">Price</label>
        <div class="price-input"><input id="nlP" class="mono" inputmode="decimal" placeholder="0.05"><span id="nlCur">ETH</span></div>
        <div class="price-input" style="margin-top:6px"><input id="nlPUsd" class="mono" inputmode="decimal" placeholder="${S.ethUsd ? '0.00' : 'rate unavailable'}" ${S.ethUsd ? '' : 'disabled'}><span>USD</span></div>
      </div>
    </div>
    <div class="grid g2" style="margin-top:var(--s3)">
      <div><label class="f">Duration days</label><input id="nlD" type="number" value="7"></div>
      <div><label class="f">Standard</label><select id="nlS"><option value="erc721"${n.standard !== 'erc1155' ? ' selected' : ''}>ERC-721</option><option value="erc1155"${n.standard === 'erc1155' ? ' selected' : ''}>ERC-1155</option></select></div>
    </div>
    <div class="infobox">Seaport 1.6 order signed locally, submitted to the OpenSea API. Needs an OpenSea key in Settings.</div>
    <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="nlGo">List</button></div>`);
  let DETCUR = null;
  api('/nft/collection-currency', { chain, slug: n.collection }).then((r) => {
    if (!r || !r.symbol) return;
    DETCUR = r;
    const cur = $('nlCur'); if (cur) cur.textContent = r.symbol;
    const lb = $('nlCurLabel'); if (lb) lb.textContent = `Price ${r.symbol}`;
    if (!r.native) {
      const note = $('nlCurNote');
      if (note) { note.innerHTML = `This collection lists in <b>${esc(r.symbol)}</b> — the price you enter is in ${esc(r.symbol)}, not ETH.`; note.classList.remove('hide'); }
    }
  }).catch(() => {});
  $('nlP').oninput = () => { const v = Number($('nlP').value); $('nlPUsd').value = v && S.ethUsd ? (v * S.ethUsd).toFixed(2) : ''; };
  $('nlPUsd').oninput = () => { const v = Number($('nlPUsd').value); $('nlP').value = v && S.ethUsd ? String(Number((v / S.ethUsd).toFixed(10))) : ''; };
  $('nlGo').onclick = async () => {
    const raw = Number($('nlP').value);
    if (!raw || isNaN(raw)) return warn('Enter a price');
    const price = $('nlP').value.trim();
    const b = $('nlGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const r = await api('/nft/list', {
        chain, walletId: $('nlW').value, contract: n.contract, tokenId: n.tokenId,
        price, standard: $('nlS').value, durationDays: Number($('nlD').value || 7),
        slug: n.collection || null,
        currency: DETCUR && !DETCUR.native && DETCUR.currency ? DETCUR.currency : undefined,
      });
      closeModal(); ok('Listed', `${r.orderHash || 'ok'}${r.currencySymbol ? ` · ${price} ${r.currencySymbol}` : ''}`);
    } catch (e) { err('List failed', e.message); b.disabled = false; b.textContent = 'List'; }
  };
}

page('autoaccept', {
  label: 'Auto Accept Offer', group: 'NFT', icon: 'offer',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Auto Accept Offer</h2>
      <p class="ps">Paste a collection, pick the NFTs to sell, then arm it. Watches funded offers and accepts them automatically — capacity-aware (50 offers + 100 NFTs = only 50 sells), retries until every offer is filled.</p>
      <div class="card">
        <div class="row">
          <div style="width:150px"><label class="f">Chain</label><select id="aaChain">${chainOpts('ethereum')}</select></div>
          <div style="flex:1;min-width:240px"><label class="f">Collection <span class="opt">— 0x…, slug, or OpenSea URL</span></label><input id="aaIn" class="mono" placeholder="0x…" autocomplete="off"></div>
          <div style="flex:1;min-width:170px"><label class="f">Wallet group</label><select id="aaGroup"></select></div>
          <button class="btn pri" id="aaLoad">Load</button>
        </div>
      </div>

      <div id="aaHead"></div>

      <div class="card"><h3><label class="chk" id="aaAllWrap" style="display:none"><input type="checkbox" id="aaAll"> Select all</label>
        <span id="aaQuick" style="display:none;margin-left:10px" class="row">
          ${[10, 20, 30, 40, 50].map((n) => `<button class="btn xs" data-q="${n}">${n}</button>`).join('')}
        </span>
        <select id="aaSort" class="hide"><option value="">Sort…</option><option value="rare">Most rare first</option><option value="common">Least rare first</option></select>
        <span class="sub" id="aaCount"></span></h3>
        <div id="aaGrid">${emptyState({ icon: 'offer', title: 'No collection loaded', desc: 'Paste a contract address or OpenSea link, pick your wallets, then Load. Click a row to select it.' })}</div>
      </div>

      <div class="card"><h3>Armed watchers
        <div class="row" style="margin-left:auto;align-items:flex-end">
          <div style="display:flex;flex-direction:column;justify-content:flex-end"><label class="f" style="font-size:11px">Min price/NFT</label>
            <div class="price-input" style="width:150px"><input id="aaMin" class="mono" inputmode="decimal" placeholder="0.0001"><span id="aaCur">ETH</span></div>
            <div class="sm mut" id="aaMinUsd" style="height:14px;margin-top:2px">&nbsp;</div></div>
          <div style="display:flex;flex-direction:column;justify-content:flex-end"><label class="f" style="font-size:11px">Poll s</label>
            <input id="aaPoll" type="number" value="30" style="width:70px;height:34px">
            <div style="height:14px"></div></div>
          <button class="btn danger" id="aaGo" style="align-self:flex-end">Arm auto accept</button>
        </div></h3>
        <div id="aaJobs">${emptyState({ icon: 'offer', title: 'Nothing armed', desc: 'Load a collection, select NFTs, then arm auto accept.' })}</div></div>`;

    let data = null;
    const SEL = new Set();

    function fillGroups() {
      $('aaGroup').innerHTML = '<option value="">All wallets</option>'
        + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');
    }
    fillGroups();
    /* re-sync wallets/groups so freshly added addresses show up without a full reload */
    api('/wallets?kind=evm').then((r) => {
      if (!r || !Array.isArray(r.wallets)) return;
      S.wallets.evm = r.wallets; S.wgroups.evm = r.groups || [];
      fillGroups();
    }).catch(() => {});

    function walletIds() {
      const g = $('aaGroup').value;
      return S.wallets.evm.filter((w) => !g || w.groupId === g).map((w) => w.id);
    }

    function head() {
      if (!data) { $('aaHead').innerHTML = ''; return; }
      $('aaHead').innerHTML = `<div class="card colhead">
        <div class="ch-img">${data.image ? `<img src="${esc(data.image)}" alt="">` : icon('col')}</div>
        <div class="ch-meta">
          <div class="ch-name">${esc(data.name || data.slug || '—')}<span class="tag mut">${esc(data.chain)}</span></div>
          <div class="ch-sub"><span class="ch-id">${esc(short(data.address, 8))}</span>
            ${data.slug ? `<a class="lnk" href="https://opensea.io/collection/${esc(data.slug)}" target="_blank" rel="noreferrer">${icon('external')} OpenSea</a>` : ''}</div>
        </div>
        <div class="ch-stats">
          <div class="ct"><div class="k">Floor</div><div class="v accent">${fx(data.floor, 14)}</div></div>
          <div class="ct"><div class="k">I hold</div><div class="v">${num(data.count, 0)}</div></div>
        </div>
      </div>`;
    }

    const STABLE_USD = { usdg: 1, usdc: 1, usdt: 1, dai: 1, usd1: 1, pyusd: 1, frax: 1, usds: 1 };
    const curSym = () => (data && data.floorSymbol) || 'ETH';
    const curRate = () => (/^w?eth$/i.test(curSym()) ? S.ethUsd : STABLE_USD[curSym().toLowerCase()] ?? null);
    /* OpenSea-style rarity tiers — same thresholds/colors as Collection Manager */
    const AA_TIERS = [
      { name: 'Legendary', color: '#F6A219', max: 0.01 },
      { name: 'Epic', color: '#A461E4', max: 0.1 },
      { name: 'Rare', color: '#2081E2', max: 0.25 },
      { name: 'Common', color: '#8A8F98', max: Infinity },
    ];
    function tierColor(rank) {
      if (rank == null || !data || !data.supply) return '#8A8F98';
      return AA_TIERS.find((t) => rank / data.supply <= t.max).color;
    }

    function render() {
      $('aaCount').textContent = data ? `${data.rows.length} items · ${SEL.size} selected` : '';
      $('aaAllWrap').style.display = data && data.rows.length ? '' : 'none';
      $('aaQuick').style.display = data && data.rows.length ? '' : 'none';
      $('aaSort').classList.toggle('hide', !(data && data.rows.length));
      if (!data || !data.rows.length) return;
      $('aaGrid').innerHTML = `<div class="tw" style="max-height:420px;overflow:auto"><table><thead><tr><th>NFT</th><th>Wallet</th></tr></thead><tbody>
        ${data.rows.map((n, i) => {
          const rc = n.rarityRank != null ? tierColor(Number(n.rarityRank)) : null;
          return `<tr data-i="${i}" class="rowpick${SEL.has(i) ? ' on' : ''}" style="cursor:pointer">
          <td>${n.image ? `<img src="${esc(n.image)}" loading="lazy" decoding="async" width="26" height="26" style="width:26px;height:26px;border-radius:6px;vertical-align:-8px;margin-right:7px">` : ''}<b>#${esc(String(n.tokenId))}</b> <span class="sm mut">${esc(n.name || '')}</span>${rc ? ` <span class="tag" style="color:${rc};border-color:${rc}">r#${num(n.rarityRank, 0)}</span>` : ''}</td>
          <td class="sm mut">${esc(n.ownerName || short(n.owner, 6))}</td>
        </tr>`;
        }).join('')}</tbody></table></div>`;
      qa('#aaGrid tr.rowpick').forEach((tr) => {
        tr.onclick = () => { const i = Number(tr.dataset.i); if (SEL.has(i)) SEL.delete(i); else SEL.add(i); render(); };
      });
    }

    function pickFirst(n) {
      SEL.clear();
      data.rows.slice(0, n).forEach((_, i) => SEL.add(i));
      render();
    }
    qa('#aaQuick button[data-q]').forEach((b) => { b.onclick = () => pickFirst(Number(b.dataset.q)); });

    let rarityLoaded = false;
    $('aaSort').onchange = async () => {
      if (!data) return;
      const mode = $('aaSort').value;
      if (!mode) return render();
      if (!rarityLoaded) {
        $('aaSort').disabled = true;
        try {
          const full = await api('/nft/collection', { chain: data.chain, input: data.slug || data.address, walletIds: walletIds(), market: true });
          const byId = new Map(full.rows.map((r) => [String(r.tokenId), r.rarityRank]));
          data.rows.forEach((r) => { r.rarityRank = byId.get(String(r.tokenId)); });
          rarityLoaded = true;
        } catch (e) { err('Rarity failed', e.message); $('aaSort').value = ''; $('aaSort').disabled = false; return; }
        $('aaSort').disabled = false;
      }
      const rank = (n) => (n.rarityRank == null ? 1e9 : Number(n.rarityRank));
      data.rows.sort(mode === 'rare' ? (a, b) => rank(a) - rank(b) : (a, b) => rank(b) - rank(a));
      render();
    };

    $('aaAll').onchange = () => {
      SEL.clear();
      if ($('aaAll').checked) data.rows.forEach((_, i) => SEL.add(i));
      render();
    };

    $('aaMin').oninput = () => {
      const v = Number($('aaMin').value);
      const r = curRate();
      $('aaMinUsd').textContent = v && r ? `≈ $${num(v * r, 4)} ${esc(curSym())}` : '';
    };

    $('aaLoad').onclick = async () => {
      const input = $('aaIn').value.trim();
      if (!input) return warn('Paste a contract, slug, or OpenSea link');
      const ids = walletIds();
      if (!ids.length) return warn('No wallets in that group');
      const b = $('aaLoad'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Loading';
      try {
        data = await api('/nft/collection', { chain: $('aaChain').value, input, walletIds: ids, market: false, rarity: false });
        rarityLoaded = false; SEL.clear(); $('aaSort').value = ''; $('aaCur').textContent = curSym(); $('aaMinUsd').textContent = '';
        head(); render();
        ok('Loaded', `${data.count} NFT(s) · floor ${fx(data.floor, 14)} ${curSym()}`);
      } catch (e) { err('Failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Load'; }
    };

    $('aaGo').onclick = async () => {
      if (!data) return warn('Load a collection first');
      const rows = data.rows.filter((_, i) => SEL.has(i));
      if (!rows.length) return warn('Select NFTs first');
      modal(`<h3>${icon('offer')} Arm auto accept</h3>
        <div class="infobox"><b>${rows.length}</b> NFT(s) in <b>${esc(data.name || data.slug)}</b>. Every funded offer that matches gets accepted automatically — capacity-aware, retries on races. This <b>sells your NFTs</b> for real.</div>
        <div class="warnbox">Irreversible: each fill transfers an NFT and pays gas. Stop only prevents future fills.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="aaArm">Arm it</button></div>`);
      $('aaArm').onclick = async () => {
        try {
          await api('/nft/autoaccept/start', {
            chain: data.chain, slug: data.slug, contract: data.address,
            items: rows.map((n) => ({ walletId: n.ownerId, tokenId: String(n.tokenId) })),
            minPrice: $('aaMin').value.trim() || null,
            pollMs: Math.max(5, Number($('aaPoll').value || 30)) * 1000,
          });
          closeModal(); ok('Armed', `${rows.length} NFT(s) watching for offers`);
          jobs();
        } catch (e) { err('Failed', e.message); }
      };
    };

    let lastJobsJson = '';
    async function jobs() {
      if (S.page !== 'autoaccept') return;
      try {
        const list = await api('/nft/autoaccept');
        const snap = JSON.stringify(list);
        if (snap === lastJobsJson) return; /* unchanged — skip DOM rebuild (no jank every 5s) */
        lastJobsJson = snap;
        $('aaJobs').innerHTML = list.length ? `<div class="tw" style="max-height:340px;overflow:auto"><table><thead><tr>
          <th>Collection</th><th class="rt">Selected</th><th class="rt">Left</th><th class="rt">Sold</th><th class="rt">Net</th><th>Status</th><th>Log</th><th></th></tr></thead><tbody>
          ${list.map((j) => `<tr>
            <td><b>${esc(j.slug)}</b> <span class="sm mut">${esc(j.chain)}</span></td>
            <td class="num">${j.selected}</td><td class="num">${j.poolLeft}</td><td class="num ok"><b>${j.soldCount}</b></td>
            <td class="num">${fx(j.netTotal, 6)}${j.symbol ? ` ${esc(j.symbol)}` : ''}${S.ethUsd ? `<span class="uusd">$${num(j.netTotal * S.ethUsd, 2)}</span>` : ''}</td>
            <td><span class="tag ${j.running ? 'ok' : 'mut'}">${j.running ? 'armed' : 'done/stopped'}</span></td>
            <td class="sm mut" style="max-width:280px;font-size:11px;line-height:1.5">${(j.log || []).slice(-4).map((l) => esc(l.msg)).join('<br>')}</td>
            <td class="rt">${j.running ? `<button class="btn xs danger" data-stop="${esc(j.id)}">stop</button>` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>` : emptyState({ icon: 'offer', title: 'Nothing armed', desc: 'Load a collection, select NFTs, then arm auto accept.' });
        qa('#aaJobs button[data-stop]').forEach((b) => {
          b.onclick = async () => { await api('/nft/autoaccept/stop', { id: b.dataset.stop }); warn('Stopped'); jobs(); };
        });
      } catch { /* */ }
    }
    jobs();
    let iv = setInterval(jobs, 5000);
    el._hide = () => { clearInterval(iv); iv = null; };
    el._show = () => { if (!iv) { jobs(); iv = setInterval(jobs, 5000); } };
    el._cleanup = el._hide;
  },
});
