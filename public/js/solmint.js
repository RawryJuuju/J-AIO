'use strict';
/* Solana mint page + gas calculator */

const SSEL = new Set();

page('solmint', {
  label: 'Solana Mint', group: 'Minting', icon: 'solmint',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Solana Mint</h2>
      <p class="ps">Candy Machine, LaunchMyNFT, or raw instructions. Jito tip supported.</p>

      <div class="card">
        <h3>1 · Target</h3>
        <div class="row">
          <div style="flex:1;min-width:240px"><label class="f">Site URL or mint address</label>
            <input id="sUrl" class="mono" placeholder="https://launchmynft.io/collections/…"></div>
          <button class="btn pri" id="sResolve">Resolve</button>
        </div>
        <div id="sInfo"></div>
      </div>

      <div class="card">
        <h3>2 · Transaction</h3>
        <div class="row">
          <div style="width:190px"><label class="f">Method</label>
            <select id="sMethod">
              <option value="serialized">Serialized tx (site API)</option>
              <option value="raw-ix">Raw instructions</option>
              <option value="transfer">SOL transfer</option>
            </select></div>
          <div style="flex:1" id="sApiWrap"><label class="f">Mint API endpoint <span class="opt">— {wallet} substituted</span></label>
            <input id="sApi" class="mono" placeholder="https://…/api/mint?wallet={wallet}"></div>
        </div>
        <div id="sBodyWrap"><label class="f">POST body JSON <span class="opt">— blank = GET</span></label>
          <textarea id="sBody" rows="3" class="mono" placeholder='{"wallet":"{wallet}","quantity":1}'></textarea></div>
        <div id="sIxWrap" style="display:none"><label class="f">Instructions JSON array</label>
          <textarea id="sIx" rows="6" class="mono" placeholder='[{"programId":"…","keys":[{"pubkey":"{wallet}","isSigner":true,"isWritable":true}],"data":"base64"}]'></textarea></div>
        <div id="sTrWrap" style="display:none" class="grid g2">
          <div><label class="f">To address</label><input id="sTo" class="mono"></div>
          <div><label class="f">Amount SOL</label><input id="sAmt" class="mono" value="0.01"></div>
        </div>
      </div>

      <div class="card">
        <h3>3 · Fees</h3>
        <div class="grid g3">
          <div><label class="f">Priority fee <span class="opt">— microLamports/CU</span></label><input id="sPrio" type="number" value="200000"></div>
          <div><label class="f">Compute unit limit</label><input id="sCu" type="number" value="400000"></div>
          <div><label class="f">Jito tip <span class="opt">— lamports, 0 = off</span></label><input id="sJito" type="number" value="0"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="flex:1"><label class="f">RPC override <span class="opt">— blank = settings default</span></label><input id="sRpc" class="mono" placeholder="https://…"></div>
        </div>
      </div>

      <div class="card">
        <h3>4 · Wallets <span class="sub" id="sWCount">0 selected</span></h3>
        <div class="row">
          <div style="flex:1;min-width:170px"><label class="f">Group</label><select id="sWGroup"></select></div>
          <button class="btn sm" id="sWAll">Select all</button>
          <button class="btn sm" id="sWNone">Clear</button>
          <button class="btn sm" id="sWBal">Balances</button>
        </div>
        <div id="sWPills"></div>
      </div>

      <div class="card">
        <h3>5 · Run</h3>
        <div class="row">
          <div style="width:150px"><label class="f">Mode</label>
            <select id="sMode"><option value="execute">Execute</option><option value="simulate">Simulate</option><option value="spam">Spam</option></select></div>
          <div style="width:130px"><label class="f">Delay ms</label><input id="sDelay" type="number" value="0"></div>
          <div style="width:150px"><label class="f">Start time</label><input id="sTs" type="datetime-local"></div>
          <div style="flex:1"></div>
          <button class="btn pri lg" id="sFire">Arm & Mint</button>
          <button class="btn danger" id="sStop" style="display:none">Stop</button>
        </div>
      </div>

      <div class="card"><h3>Live <span class="sub" id="sRunTag"></span></h3>
        <div id="sCounts" class="tiles sm"></div>
        <div class="con" id="sCon"></div>
        <div id="sResults"></div>
      </div>`;

    let runId = null;
    const con = $('sCon');
    const off = onEvent((e) => { if (!runId || e.runId === runId) conLine(con, e); });

    function syncMethod() {
      const m = $('sMethod').value;
      $('sApiWrap').style.display = m === 'serialized' ? '' : 'none';
      $('sBodyWrap').style.display = m === 'serialized' ? '' : 'none';
      $('sIxWrap').style.display = m === 'raw-ix' ? '' : 'none';
      $('sTrWrap').style.display = m === 'transfer' ? 'grid' : 'none';
    }
    $('sMethod').onchange = syncMethod; syncMethod();

    function renderWG() {
      $('sWGroup').innerHTML = '<option value="">All groups</option>'
        + S.wgroups.sol.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');
    }
    function renderPills() {
      const g = $('sWGroup').value;
      const rows = S.wallets.sol.filter((w) => !g || w.groupId === g);
      const box = $('sWPills'); box.innerHTML = '';
      if (!rows.length) { box.innerHTML = emptyState({ icon: 'wallets', title: 'No SOL wallets', desc: 'Generate or import Solana wallets first.', action: { label: 'Open Wallets', onclick: "go('wallets')" } }); return; }
      box.appendChild(pillList(rows.map((w) => ({ id: w.id, label: w.name })), SSEL, () => { $('sWCount').textContent = `${SSEL.size} selected`; }));
      $('sWCount').textContent = `${SSEL.size} selected`;
    }
    $('sWGroup').onchange = renderPills;
    $('sWAll').onclick = () => { const g = $('sWGroup').value; S.wallets.sol.filter((w) => !g || w.groupId === g).forEach((w) => SSEL.add(w.id)); renderPills(); };
    $('sWNone').onclick = () => { SSEL.clear(); renderPills(); };
    renderWG(); renderPills();

    $('sWBal').onclick = async () => {
      const sel = S.wallets.sol.filter((w) => SSEL.has(w.id));
      if (!sel.length) return warn('Select wallets first');
      try {
        const r = await api('/wallets/balances', { kind: 'sol', addresses: sel.map((w) => w.address) });
        const list = r.balances || r;
        const total = list.reduce((a, x) => a + Number(x.balance ?? x.sol ?? 0), 0);
        ok('SOL balances', `${fx(total, 5)} SOL across ${list.length}`);
      } catch (e) { err('Failed', e.message); }
    };

    $('sResolve').onclick = async () => {
      const b = $('sResolve'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api('/resolve', { input: $('sUrl').value.trim(), chain: 'solana' });
        $('sInfo').innerHTML = `<div class="kv">
          <div><span>Platform</span><b>${esc(r.platform)}</b></div>
          <div><span>Creator</span><b class="m">${esc(r.creator || '—')}</b></div>
          <div><span>Collection</span><b class="m">${esc(r.collectionHash || r.address || '—')}</b></div>
          <div><span>Price</span><b>${esc(String(r.price ?? r.stages?.[0]?.price ?? '—'))}</b></div>
        </div>${r.note ? `<div class="infobox">${esc(r.note)}</div>` : ''}`;
        if (r.mintApi) $('sApi').value = r.mintApi;
        ok('Resolved', r.platform);
      } catch (e) { err('Resolve failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Resolve'; }
    };

    function buildCfg(mode) {
      if (!SSEL.size) throw new Error('no SOL wallets selected');
      const cfg = {
        method: $('sMethod').value, walletIds: [...SSEL], mode,
        delayMs: Number($('sDelay').value || 0),
        priorityFeeMicroLamports: Number($('sPrio').value || 0) || null,
        computeUnitLimit: Number($('sCu').value || 0) || null,
        jitoTipLamports: Number($('sJito').value || 0) || null,
        rpc: $('sRpc').value.trim() || null,
      };
      if (cfg.method === 'serialized') {
        cfg.mintApi = $('sApi').value.trim();
        if (!cfg.mintApi) throw new Error('mint API endpoint required');
        const bodyTxt = $('sBody').value.trim();
        if (bodyTxt) { JSON.parse(bodyTxt); cfg.mintApiBody = bodyTxt; }
      } else if (cfg.method === 'raw-ix') {
        cfg.instructions = JSON.parse($('sIx').value || '[]');
      } else {
        cfg.to = $('sTo').value.trim(); cfg.amountSol = $('sAmt').value;
      }
      if ($('sTs').value) cfg.startTimestamp = Math.floor(new Date($('sTs').value).getTime() / 1000);
      return cfg;
    }

    async function launch(mode) {
      let cfg; try { cfg = buildCfg(mode); } catch (e) { return err('Cannot start', e.message); }
      con.innerHTML = '';
      try {
        const r = await api('/sol/start', cfg);
        runId = r.runId || r.id;
        $('sRunTag').textContent = `${runId} · ${mode}`;
        $('sStop').style.display = '';
        poll();
        ok('Started', runId);
      } catch (e) { err('Start failed', e.message); }
    }

    $('sFire').onclick = () => {
      const mode = $('sMode').value;
      confirmBox('Send real Solana transactions?',
        `Mode <b>${esc(mode)}</b> from <b>${SSEL.size}</b> wallet(s). Confirmed transactions are irreversible.`,
        () => launch(mode), 'Broadcast');
    };
    $('sStop').onclick = async () => { if (runId) await stopRun(runId, true); };

    let iv = null;
    function poll() {
      clearInterval(iv);
      iv = setInterval(async () => {
        if (!runId || S.page !== 'solmint') return;
        try {
          const st = await api('/sol/status?runId=' + encodeURIComponent(runId));
          const c = st.counts || {};
          $('sCounts').innerHTML = `
            <div class="tile"><div class="k">Status</div><div class="v accent">${esc(st.status)}</div></div>
            <div class="tile"><div class="k">Sent</div><div class="v">${c.sent ?? 0}/${c.total ?? 0}</div></div>
            <div class="tile"><div class="k">Confirmed</div><div class="v ok">${c.confirmed ?? 0}</div></div>
            <div class="tile"><div class="k">Failed</div><div class="v fail">${c.failed ?? 0}</div></div>`;
          if (st.results?.length) {
            $('sResults').innerHTML = `<div class="tw" style="margin-top:var(--s3)"><table><thead><tr><th>Wallet</th><th>Status</th><th>Signature / error</th></tr></thead><tbody>
              ${st.results.slice(-40).map((r) => `<tr><td class="m">${esc(short(r.address, 6))}</td>
                <td><span class="tag ${r.ok ? 'ok' : 'fail'}">${esc(r.status || (r.ok ? 'ok' : 'fail'))}</span></td>
                <td class="m sm">${r.signature ? `<a href="https://solscan.io/tx/${esc(r.signature)}" target="_blank" rel="noopener">${esc(short(r.signature, 10))}</a>` : esc(r.error || '')}</td></tr>`).join('')}
              </tbody></table></div>`;
          }
          if (['done', 'error', 'stopped'].includes(st.status)) { $('sStop').style.display = 'none'; clearInterval(iv); }
        } catch { /* */ }
      }, 1500);
    }

    el._cleanup = () => { off(); clearInterval(iv); };
  },
});

page('gas', {
  label: 'Gas Calculator', group: 'Infra', icon: 'gas',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Gas Calculator</h2>
      <p class="ps">Cost per wallet across gwei scenarios, plus mint value.</p>
      <div class="card">
        <div class="grid g4">
          <div><label class="f">Chain</label><select id="gChain">${chainOpts('ethereum')}</select></div>
          <div><label class="f">Gas limit</label><input id="gLimit" type="number" value="300000"></div>
          <div><label class="f">NFTs per wallet</label><input id="gN" type="number" value="1"></div>
          <div><label class="f">Price per NFT</label><input id="gPrice" class="mono" value="0"></div>
        </div>
        <label class="f" style="margin-top:var(--s3)">Gwei scenarios <span class="opt">— comma separated, blank = current</span></label>
        <input id="gGweis" class="mono" placeholder="5, 15, 40, 100">
        <div class="row" style="margin-top:var(--s3)">
          <div style="flex:1"><label class="f">Wallet count <span class="opt">— for totals</span></label><input id="gW" type="number" value="10"></div>
          <button class="btn pri" id="gGo" style="align-self:flex-end">Calculate</button>
        </div>
      </div>
      <div class="card"><h3>Result <span class="sub" id="gNow"></span></h3><div id="gOut">${emptyState({ icon: 'gas', title: 'No estimate yet', desc: 'Fill in gas limit and mint count, then calculate.' })}</div></div>
      <div class="card"><h3>Unix time converter <span class="sub">— Zyper Calculator parity</span></h3>
        <div class="grid g2">
          <div><label class="f">Unix timestamp</label><input id="uTs" class="mono" placeholder="1786155242"></div>
          <div><label class="f">Date (WIB)</label><input id="uDate" class="mono" placeholder="2026-08-08 11:07"></div>
        </div>
        <div class="acts" style="margin-top:var(--s3)"><button class="btn" id="uTsToDate">Unix → Date</button><button class="btn" id="uDateToTs">Date → Unix</button><span class="sm mut" id="uOut" style="align-self:center"></span></div>
      </div>`;

    $('gGo').onclick = async () => {
      const b = $('gGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        const gweis = $('gGweis').value.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
        const r = await api('/gas', {
          chain: $('gChain').value, gasLimit: Number($('gLimit').value || 300000),
          gweis, nftCount: Number($('gN').value || 1), pricePerNft: $('gPrice').value || '0',
        });
        const nw = Number($('gW').value || 1);
        if (r.usdIdr) S.usdIdr = r.usdIdr;
        if (r.ethUsd) S.ethUsd = r.ethUsd;
        $('gNow').textContent = `current ${r.currentGwei} gwei · tip ${r.currentTipGwei}${r.ethUsd ? ` · ETH $${num(r.ethUsd, 0)}` : ''}${r.usdIdr ? ` · USD Rp ${num(r.usdIdr, 0)}` : ''}`;
        $('gOut').innerHTML = `<div class="tw"><table><thead><tr>
          <th class="rt">Gwei</th><th class="rt">Gas</th><th class="rt">Mint</th><th class="rt">Per wallet</th>
          <th class="rt">USD</th><th class="rt">IDR</th><th class="rt">× ${nw} wallets</th></tr></thead><tbody>
          ${r.rows.map((x) => `<tr>
            <td class="num">${esc(String(x.gwei))}</td>
            <td class="num">${fx(x.gasEth, 6)}</td>
            <td class="num">${fx(x.mintEth, 5)}</td>
            <td class="num"><b>${fx(x.totalEth, 6)}</b></td>
            <td class="num">${x.totalUsd ? '$' + x.totalUsd : '—'}</td>
            <td class="num">${idr(x.totalIdr)}</td>
            <td class="num">${fx(Number(x.totalEth) * nw, 5)}${x.totalIdr != null ? ` <span class="mut">(${idr(x.totalIdr * nw)})</span>` : (x.totalUsd ? ` <span class="mut">($${num(Number(x.totalUsd) * nw, 2)})</span>` : '')}</td>
          </tr>`).join('')}</tbody></table></div>`;
      } catch (e) { err('Failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Calculate'; }
    };
    $('gGo').onclick();
    $('uTsToDate').onclick = () => {
      const s = $('uTs').value.trim(); if (!/^\d{9,11}$/.test(s)) return err('Unix', 'timestamp must be 10-11 digits');
      const d = new Date(Number(s) * 1000); const wib = new Date(d.getTime());
      $('uOut').textContent = `${s} → ${wib.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })} WIB`;
    };
    $('uDateToTs').onclick = () => {
      const s = $('uDate').value.trim();
      const t = Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + (/:/.test(s) ? ':00+07:00' : 'T00:00:00+07:00'));
      if (Number.isNaN(t)) return err('Unix', 'format YYYY-MM-DD HH:MM');
      $('uOut').textContent = `${s} WIB → ${Math.floor(t / 1000)}`;
    };
  },
});
