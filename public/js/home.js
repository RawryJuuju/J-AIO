'use strict';
/* Home — the landing page. Three things, in order of what a beginner needs:
 *   1. one big "paste a link and mint" box
 *   2. all-time PnL (filled from the PnL page, cached server-side)
 *   3. what just happened (activity feed: every confirmed/failed mint)
 *
 * No module marketplace, no per-task grid. Deep features live on their own
 * pages; this page only summarises and points.
 */

page('home', {
  label: 'Home', group: 'Overview', icon: 'dash',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Home</h2>
      <p class="ps">Paste a drop link below. Chain, phase, price and mint method are detected for you.</p>

      <div class="card hero">
        <div class="row">
          <div style="flex:1;min-width:260px">
            <label class="f">OpenSea link, launchpad link, or contract address</label>
            <input id="hUrl" class="mono" placeholder="https://opensea.io/collection/… or 0x…" autocomplete="off">
          </div>
          <button class="btn pri lg" id="hGo" style="align-self:flex-end">Start mint</button>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <button class="btn sm" onclick="go('wlcheck')">${icon('check')} WL Checker</button>
          <button class="btn sm" onclick="go('nftview')">${icon('pnl')} Collection PnL</button>
          <button class="btn sm" onclick="go('wallets')">${icon('wallets')} Wallets</button>
          <button class="btn sm" onclick="go('settings')">${icon('key')} API keys</button>
        </div>
      </div>

      <div class="card">
        <h3>${icon('pnl')} Coin price check <span class="sub" id="fxInfo"></span>
          <span style="margin-left:auto"><button class="btn xs ghost" id="fxRefresh">Refresh rate</button></span>
        </h3>
        <div class="row" style="align-items:flex-end">
          <div style="flex:1;min-width:170px">
            <label class="f" id="fxAmtLabel">Amount (ETH)</label>
            <input id="fxAmt" type="number" step="any" min="0" placeholder="0.00" class="mono" autocomplete="off">
          </div>
          <div style="min-width:230px">
            <label class="f">Direction</label>
            <div class="seg-row" id="fxDir">
              <button type="button" data-d="eth" class="on">ETH → USD</button>
              <button type="button" data-d="usd">USD → ETH</button>
            </div>
          </div>
          <div style="flex:1.2;min-width:210px">
            <label class="f">Result</label>
            <div id="fxOut" class="bignum" style="font-size:22px">—</div>
            <div class="sm mut" id="fxSub"></div>
          </div>
        </div>
      </div>

      <div class="grid g2 eq" style="margin-bottom:var(--s4)">
        <div class="card flex">
          <h3>${icon('pnl')} All-time PnL <span class="sub" id="hPnlAt"></span></h3>
          <div class="fill" id="hPnl"></div>
        </div>
        <div class="card flex">
          <h3>${icon('feed')} Activity
            <span class="sub" id="hActCount"></span>
            <span style="margin-left:auto"><button class="btn xs ghost" id="hActClear">Clear</button></span>
          </h3>
          <div class="fill" id="hAct"></div>
        </div>
      </div>

      <div class="card">
        <h3>${icon('runs')} Runs <span class="sub" id="hRunTag"></span></h3>
        <div id="hRuns"></div>
      </div>

      <div class="card">
        <h3>${icon('key')} API keys</h3>
        <div id="hKeys"></div>
      </div>`;

    /* Home is a launcher: hand the pasted value to Quick Mint rather than
       duplicating the detect flow here. */
    function launch() {
      const v = $('hUrl').value.trim();
      if (!v) return warn('Paste a link or contract address first');
      go('quick');
      const inp = $('qUrl');
      if (inp) {
        inp.value = v;
        $('qDetect').click();
      }
    }
    $('hGo').onclick = launch;
    $('hUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') launch(); });

    /* ---------- coin price check (ETH <-> USD, Coinbase spot via /api/fx) ----------
       Rates come from the shared fxrate cache (5-min TTL, Coinbase ETH-USD +
       USD-IDR), so the converter always agrees with the header ticker and the
       PnL USD numbers. IDR is shown as a bonus line on every result. */
    let fxRate = { ethUsd: S.ethUsd, usdIdr: S.usdIdr, at: null };
    let fxDirection = 'eth';

    function fxRender() {
      const r = fxRate.ethUsd;
      $('fxInfo').textContent = r
        ? `1 ETH = $${num(r, 2)}${fxRate.usdIdr ? ` · $1 = ${idr(fxRate.usdIdr)}` : ''}${fxRate.at ? ` · updated ${ago(fxRate.at)} ago` : ''}`
        : 'rate unavailable';
      const raw = $('fxAmt').value.trim();
      const v = Number(raw);
      if (raw === '' || !isFinite(v) || !r) { $('fxOut').textContent = '—'; $('fxSub').textContent = ''; return; }
      if (fxDirection === 'eth') {
        const usd = v * r;
        $('fxOut').textContent = `$${num(usd, 2)}`;
        $('fxSub').textContent = `${num(v, 6)} ETH${fxRate.usdIdr ? ` · ${idr(usd * fxRate.usdIdr)}` : ''}`;
      } else {
        const eth = v / r;
        $('fxOut').textContent = `${num(eth, 6)} ETH`;
        $('fxSub').textContent = `$${num(v, 2)}${fxRate.usdIdr ? ` · ${idr(v * fxRate.usdIdr)}` : ''}`;
      }
    }
    async function fxLoad(force) {
      try {
        const r = await api('/fx' + (force ? '?force=1' : ''));
        if (r.ethUsd) { fxRate = r; S.ethUsd = r.ethUsd; if (r.usdIdr) S.usdIdr = r.usdIdr; }
      } catch { /* locked or offline — fall back to cached S rates */ }
      fxRender();
    }
    qa('#fxDir button').forEach((b) => {
      b.onclick = () => {
        fxDirection = b.dataset.d;
        qa('#fxDir button').forEach((x) => x.classList.toggle('on', x === b));
        $('fxAmtLabel').textContent = fxDirection === 'eth' ? 'Amount (ETH)' : 'Amount (USD)';
        $('fxAmt').placeholder = fxDirection === 'eth' ? '0.00' : '0';
        fxRender();
      };
    });
    $('fxAmt').addEventListener('input', fxRender);
    $('fxRefresh').onclick = () => fxLoad(true);
    fxLoad(false);

    function pnlBox(p) {
      if (!p || !p.totals) {
        return emptyState({
          icon: 'pnl', title: 'No PnL yet',
          desc: 'Generate it once on the PnL page and the total shows up here.',
          action: { label: 'Generate PnL', onclick: "go('nftview')" },
        });
      }
      const t = p.totals;
      const sign = t.net >= 0 ? '+' : '';
      const usd = S.ethUsd ? ` · $${num(t.net * S.ethUsd, 0)}` : '';
      const rp = ethIdr(t.net) != null ? ` · ${idr(ethIdr(t.net))}` : '';
      return `<div class="bignum ${t.net >= 0 ? 'ok' : 'fail'}">${sign}${fx(t.net, 3)} <span>ETH</span></div>
        <div class="sub" style="margin-bottom:var(--s3)">spent ${fx(t.spent, 3)} · gas ${fx(t.gas || 0, 4)} · sold ${fx(t.received, 3)} · holding ${fx(t.holdValue, 3)}${usd}${rp}</div>
        ${(p.top || []).length ? `<div class="toplist">
          ${p.top.map((x) => `<div class="tl">
            <span class="n">${esc(x.collection)}</span>
            <b class="${x.net >= 0 ? 'ok' : 'fail'}">${x.net >= 0 ? '+' : ''}${fx(x.net, 3)}</b>
          </div>`).join('')}
        </div>` : ''}`;
    }

    function actBox(items) {
      if (!items || !items.length) {
        return emptyState({ icon: 'feed', title: 'Nothing yet', desc: 'Confirmed and failed mints land here.' });
      }
      return `<div class="tw"><table><thead><tr>
        <th>Time</th><th>Wallet</th><th>Token</th><th>What</th></tr></thead><tbody>
        ${items.map((a) => `<tr>
          <td class="sm mut">${esc(ts(a.t))}</td>
          <td class="sm">${esc(a.wallet || '—')}<div class="m xs mut">${esc(short(a.address || '', 6))}</div></td>
          <td class="num">${a.tokenId ? '#' + esc(String(a.tokenId)) : '—'}</td>
          <td class="sm">${a.hash && a.chain
    ? `<a href="${explorerTx(a.chain, a.hash)}" target="_blank" rel="noopener">${esc(a.label || 'View transaction')} ${icon('external')}</a>`
    : `<span class="${a.ok ? 'ok' : 'fail'}">${esc(a.label || (a.ok ? 'ok' : 'failed'))}</span>`}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
    }

    function keyBox(k) {
      const rows = [
        ['OpenSea', 'opensea', 'phases, floor, PnL, eligibility'],
        ['Etherscan', 'etherscan', 'contract ABI'],
        ['Alchemy', 'alchemy', 'NFT inventory'],
        ['Helius', 'helius', 'Solana RPC'],
      ];
      return `<div class="tw"><table><thead><tr><th>Service</th><th>Keys</th><th>Used for</th></tr></thead><tbody>
        ${rows.map(([label, id, why]) => {
    const s = (k && k[id]) || { total: 0 };
    return `<tr><td>${esc(label)}</td>
            <td><span class="tag ${s.total ? 'ok' : 'mut'}">${s.total ? `${s.total} key${s.total > 1 ? 's' : ''}` : 'none'}</span>
            ${s.cooling ? ` <span class="tag warn">${s.cooling} cooling</span>` : ''}</td>
            <td class="sm mut">${esc(why)}</td></tr>`;
  }).join('')}
      </tbody></table></div>
      <div class="infobox" style="margin-top:var(--s3)">Add more than one key per service in Settings (one per line) and they rotate automatically, so bulk PnL and eligibility sweeps do not hit rate limits.</div>`;
    }

    function runsBox(all) {
      if (!all.length) {
        return emptyState({ icon: 'runs', title: 'No runs yet', desc: 'Start a mint and progress shows here.', action: { label: 'Quick Mint', onclick: "go('quick')" } });
      }
      return `<div class="tw"><table><thead><tr>
        <th>Name</th><th>Chain</th><th>Status</th><th class="rt">Sent</th><th class="rt">Minted</th><th class="rt">Failed</th><th></th></tr></thead><tbody>
        ${all.slice().reverse().slice(0, 10).map((r) => `<tr>
          <td>${esc(r.name || r.method || r.id)}</td>
          <td class="sm mut">${esc(r.chain || (r.sol ? 'solana' : '—'))}</td>
          <td><span class="tag ${r.status === 'done' ? 'ok' : ['error', 'aborted'].includes(r.status) ? 'fail' : r.status === 'stopped' ? 'mut' : ''}">${esc(r.status)}</span></td>
          <td class="num">${r.counts.sent ?? 0}</td>
          <td class="num" style="color:var(--ok)">${r.counts.confirmed ?? r.counts.ok ?? 0}</td>
          <td class="num" style="color:var(--fail)">${r.counts.failed ?? r.counts.fail ?? 0}</td>
          <td class="rt">${['done', 'error', 'stopped', 'aborted'].includes(r.status) ? '' : `<button class="btn xs danger" onclick="stopRun('${r.id}',${!!r.sol})">Stop</button>`}</td>
        </tr>`).join('')}
      </tbody></table></div>`;
    }

    $('hActClear').onclick = () => confirmBox('Clear activity?',
      'Only the local activity list is removed. Transactions and wallets are untouched.',
      async () => { try { await api('/activity/clear', {}); refresh(); } catch (e) { err('Failed', e.message); } }, 'Clear');

    async function refresh() {
      if (S.page !== 'home') return;
      try {
        const [h, runs, sruns] = await Promise.all([api('/home'), api('/mint/runs'), api('/sol/runs')]);
        const all = [...runs, ...sruns.map((r) => ({ ...r, sol: true }))];
        S.runs = all;
        const active = all.filter((r) => !['done', 'error', 'stopped', 'aborted'].includes(r.status));
        const pb = $('panicBtn');
        if (pb) gate(pb, active.length > 0, 'No active runs');

        $('hPnl').innerHTML = pnlBox(h.pnl);
        $('hPnlAt').textContent = h.pnl && h.pnl.at ? `${ago(h.pnl.at)} ago` : '';
        $('hAct').innerHTML = actBox(h.activity);
        const c = h.counts || {};
        $('hActCount').innerHTML = (c.minted || c.failed)
          ? `<span class="ok">${c.minted || 0} minted</span> · <span class="fail">${c.failed || 0} failed</span>` : '';
        $('hRuns').innerHTML = runsBox(all);
        $('hRunTag').textContent = active.length ? `${active.length} active` : `${all.length} total`;
        $('hKeys').innerHTML = keyBox(h.keys);
      } catch { /* locked */ }
    }
    refresh();
    let iv = setInterval(refresh, 5000);
    el._hide = () => { clearInterval(iv); iv = null; };
    el._show = () => { if (!iv) { refresh(); iv = setInterval(refresh, 5000); } };
    el._cleanup = el._hide;
  },
});
