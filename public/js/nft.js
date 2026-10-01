'use strict';
/* NFT ops — inventory, transfer/sweep, list, floor war, offers, PnL */

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
  /* Auto-detect the collection's listing currency — some RH collections only
   * list in a specific ERC20 (hoodwarrios → USDG). Update the price suffix +
   * show a note so the entered unit is never ambiguous. */
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
  /* ETH <-> USD two-way sync; ETH field is the value that gets listed. */
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

page('floorwar', {
  label: 'Floor War & Offers', group: 'NFT', icon: 'floor',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Floor War & Offers</h2>
      <p class="ps">Auto-undercut the floor, or accept the best WETH offer.</p>
      <div class="grid g2">
        <div class="card"><h3>New floor war</h3>
          <div class="grid g2">
            <div><label class="f">Chain</label><select id="fwChain">${chainOpts('ethereum')}</select></div>
            <div><label class="f">Collection slug</label><input id="fwSlug" class="mono"></div>
          </div>
          <div class="grid g2" style="margin-top:var(--s3)">
            <div><label class="f">Contract</label><input id="fwC" class="mono" placeholder="0x…"></div>
            <div><label class="f">NFT ID</label><input id="fwT" class="mono"></div>
          </div>
          <div class="grid g3" style="margin-top:var(--s3)">
            <div><label class="f">Wallet</label><select id="fwW">${S.wallets.evm.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select></div>
            <div><label class="f">My price</label><input id="fwP" class="mono"></div>
            <div><label class="f">Min price <span class="opt">— floor stop</span></label><input id="fwMin" class="mono"></div>
          </div>
          <div class="row" style="margin-top:var(--s3)">
            <div style="flex:1"><label class="f">Poll ms</label><input id="fwPoll" type="number" value="60000"></div>
            <button class="btn pri" id="fwGo" style="align-self:flex-end">Start</button>
            <button class="btn" id="fwFloor" style="align-self:flex-end">Check floor</button>
          </div>
          <div class="warnbox">Relisting repeatedly burns nothing on-chain but can undercut you below cost. The min price is your hard stop.</div>
        </div>
        <div class="card"><h3>Best offers</h3>
          <div class="row">
            <div style="flex:1"><label class="f">Collection slug</label><input id="foSlug" class="mono"></div>
            <button class="btn" id="foGo" style="align-self:flex-end">Load offers</button>
          </div>
          <div id="foOut">${emptyState({ icon: 'floor', title: 'No offers loaded', desc: 'Load collection offers to bid or accept.' })}</div>
        </div>
      </div>
      <div class="card"><h3>Active floor wars</h3><div id="fwList">${emptyState({ icon: 'floor', title: 'No floor wars running', desc: 'Start one to auto-undercut the floor.' })}</div></div>`;

    $('fwFloor').onclick = async () => {
      try { const r = await api('/nft/floor', { chain: $('fwChain').value, slug: $('fwSlug').value.trim() }); ok('Floor', r.floor != null ? `${r.floor} ETH` : 'no listings'); }
      catch (e) { err('Failed', e.message); }
    };

    $('fwGo').onclick = async () => {
      try {
        await api('/nft/floorwar/start', {
          chain: $('fwChain').value, slug: $('fwSlug').value.trim(), contract: $('fwC').value.trim(),
          tokenId: $('fwT').value.trim(), walletId: $('fwW').value,
          myPrice: $('fwP').value, minPrice: $('fwMin').value, pollMs: Number($('fwPoll').value || 60000),
        });
        ok('Floor war started'); refresh();
      } catch (e) { err('Failed', e.message); }
    };

    $('foGo').onclick = async () => {
      const b = $('foGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        const offers = await api('/nft/offers', { chain: $('fwChain').value, slug: $('foSlug').value.trim(), limit: 20 });
        $('foOut').innerHTML = offers.length ? `<div class="tw"><table><thead><tr><th class="rt">WETH</th><th class="rt">Qty</th><th>Hash</th><th></th></tr></thead><tbody>
          ${offers.map((o) => `<tr><td class="num"><b>${fx(o.price, 4)}</b></td><td class="num">${esc(String(o.quantity))}</td>
            <td class="m sm">${esc(short(o.orderHash, 8))}</td>
            <td class="rt"><button class="btn xs" data-h="${esc(o.orderHash)}" data-p="${esc(String(o.price))}" data-pr="${esc(String(o.protocolAddress || ''))}">accept</button></td></tr>`).join('')}
          </tbody></table></div>` : emptyState({ icon: 'floor', title: 'No offers', desc: 'This collection has no active offers.' });
        qa('#foOut button[data-h]').forEach((btn) => {
          btn.onclick = () => {
            modal(`<h3>Accept offer</h3><div class="sm mut">${esc(short(btn.dataset.h, 10))} · ${esc(btn.dataset.p)} WETH</div>
              <label class="f" style="margin-top:var(--s3)">Wallet holding the NFT</label>
              <select id="aoW">${S.wallets.evm.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</select>
              <div class="warnbox">Accepting sells the NFT immediately for WETH. This cannot be undone.</div>
              <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="aoGo">Accept & sell</button></div>`);
            $('aoGo').onclick = async () => {
              try {
                const r = await api('/nft/accept-offer', {
                  chain: $('fwChain').value, walletId: $('aoW').value, orderHash: btn.dataset.h,
                  expectedPrice: btn.dataset.p, protocolAddress: btn.dataset.pr || undefined,
                });
                closeModal(); ok('Accepted', r.hash);
              }
              catch (e) { err('Failed', e.message); }
            };
          };
        });
      } catch (e) { err('Failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Load offers'; }
    };

    async function refresh() {
      if (S.page !== 'floorwar') return;
      try {
        const list = await api('/nft/floorwar');
        $('fwList').innerHTML = list.length ? `<div class="tw"><table><thead><tr>
          <th>Slug</th><th>NFT</th><th class="rt">My price</th><th class="rt">Floor</th><th class="rt">Relists</th><th>Status</th><th></th></tr></thead><tbody>
          ${list.map((f) => `<tr><td>${esc(f.slug)}</td><td class="m">#${esc(String(f.tokenId))}</td>
            <td class="num">${fx(f.myPrice, 5)}${S.ethUsd && f.myPrice ? `<span class="uusd">$${num(f.myPrice * S.ethUsd, 2)}</span>` : ''}</td><td class="num">${fx(f.lastFloor, 5)}${S.ethUsd && f.lastFloor ? `<span class="uusd">$${num(f.lastFloor * S.ethUsd, 2)}</span>` : ''}</td><td class="num">${f.relists}</td>
            <td><span class="tag ${f.running ? 'ok' : 'mut'}">${f.running ? 'running' : 'stopped'}</span></td>
            <td class="rt">${f.running ? `<button class="btn xs danger" data-stop="${esc(f.id)}">stop</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : emptyState({ icon: 'floor', title: 'No floor wars running', desc: 'Start one to auto-undercut the floor.' });
        qa('#fwList button[data-stop]').forEach((b) => {
          b.onclick = async () => { await api('/nft/floorwar/stop', { id: b.dataset.stop }); warn('Stopped'); refresh(); };
        });
      } catch { /* */ }
    }
    refresh();
    let iv = setInterval(refresh, 10000);
    el._hide = () => { clearInterval(iv); iv = null; };
    el._show = () => { if (!iv) { refresh(); iv = setInterval(refresh, 10000); } };
    el._cleanup = el._hide;
  },
});
