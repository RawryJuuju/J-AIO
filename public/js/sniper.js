'use strict';

page('sniper', {
  label: 'NFT Sniper', group: 'NFT', icon: 'tools',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">NFT Sniper</h2>
      <p class="ps">Polls OpenSea listings for a collection. When a listing drops below your max price, auto-buys via Seaport fulfillOrder.</p>
      
      <div class="card">
        <div class="grid g4">
          <div><label class="f">Chain</label><select id="snpChain">${chainOpts('ethereum')}</select></div>
          <div><label class="f">Collection Slug</label><input id="snpSlug" class="mono" placeholder="npc-on-chain"></div>
          <div><label class="f">Max Price ETH</label><input id="snpMax" class="mono" placeholder="0.05"></div>
          <div><label class="f">Buyer Wallet</label><select id="snpWallet"></select></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="width:140px"><label class="f">Interval (s)</label><input id="snpIv" type="number" value="10"></div>
          <label class="chk" style="margin-top:var(--s4)"><input type="checkbox" id="snpDry" checked> Dry Run (sim only)</label>
          <label class="chk" style="margin-top:var(--s4);margin-left:var(--s3)"><input type="checkbox" id="snpOnce"> Stop after 1 buy</label>
          <div class="sp"></div>
          <button class="btn pri" id="snpStart" style="align-self:flex-end">Start Sniper</button>
        </div>
      </div>

      <div class="card">
        <h3>Active Snipers <span class="sub" id="snpCount"></span></h3>
        <div id="snpList">${emptyState({ icon: 'tools', title: 'No active snipers', desc: 'Configure target price and wallet, then Start.' })}</div>
      </div>`;

    $('snpWallet').innerHTML = S.wallets.evm.map((w) => `<option value="${w.id}">${esc(w.name)} (${short(w.address)})</option>`).join('');

    async function poll() {
      try {
        const list = await api('/nft/sniper');
        $('snpCount').textContent = `${list.length} running`;
        if (!list.length) {
          $('snpList').innerHTML = emptyState({ icon: 'tools', title: 'No active snipers', desc: 'Configure target price and wallet, then Start.' });
          return;
        }
        $('snpList').innerHTML = list.map((s) => `
          <div class="card" style="margin-bottom:var(--s3);background:var(--panel2)">
            <div class="row">
              <div><b>${esc(s.slug)}</b> <span class="tag mut">${esc(s.chain)}</span></div>
              <div class="sm mut">Max: ${s.maxPrice} ETH · Buys: ${s.buys}</div>
              <div class="sp"></div>
              <button class="btn sm danger" data-stop="${s.id}">Stop</button>
            </div>
            <div class="con fill" style="margin-top:var(--s2);max-height:120px;overflow-y:auto">
              ${s.log.map((l) => `<div class="l info"><span class="t">${ts(l.t)}</span><span class="m">${esc(l.msg)}</span></div>`).join('')}
            </div>
          </div>
        `).join('');
        qa('#snpList [data-stop]').forEach((b) => {
          b.onclick = async () => {
            await api('/nft/sniper/stop', { id: b.dataset.stop });
            ok('Stopped sniper'); poll();
          };
        });
      } catch { /* locked */ }
    }

    $('snpStart').onclick = () => {
      const slug = $('snpSlug').value.trim();
      const maxPrice = $('snpMax').value.trim();
      if (!slug || !maxPrice) return warn('Collection slug and max price required');
      const isDry = $('snpDry').checked;
      confirmTyped(
        'Start NFT Sniper',
        `This will poll ${esc(slug)} and ${isDry ? 'DRY RUN' : 'REAL BUY'} listings <= ${esc(maxPrice)} ETH.`,
        isDry ? 'SNIPE' : 'BUY REAL NFT',
        async () => {
          try {
            await api('/nft/sniper/start', {
              chain: $('snpChain').value, slug, maxPrice, walletId: $('snpWallet').value,
              intervalSec: Number($('snpIv').value || 10), dryRun: isDry, once: $('snpOnce').checked,
            });
            ok('Sniper started', `${slug} <= ${maxPrice} ETH`);
            poll();
          } catch (e) { err('Failed', e.message); }
        },
        'Start'
      );
    };

    poll();
    let iv = setInterval(poll, 3000);
    el._hide = () => { clearInterval(iv); iv = null; };
    el._show = () => { if (!iv) { poll(); iv = setInterval(poll, 3000); } };
    el._cleanup = el._hide;
  },
});
