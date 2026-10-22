'use strict';

const WARSEL = new Set();     // selected wallet ids for war

page('war', {
  label: 'WAR Mint', group: 'Minting', icon: 'mint',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">WAR Mint</h2>
      <p class="ps">FCFS battle mode. Fresh calldata, parallel wallets, aggressive gas, continue-on-failure.</p>

      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:280px">
            <label class="f">OpenSea link, launchpad link, or contract address</label>
            <input id="wUrl" class="mono" placeholder="https://opensea.io/collection/… or 0x…" autocomplete="off">
          </div>
          <button class="btn pri" id="wDetect" style="align-self:flex-end">Detect</button>
        </div>
        <div id="wStatus"></div>
      </div>

      <div class="card" id="wCard" style="display:none">
        <h3>Detected <span class="sub" id="wTag"></span></h3>
        <div id="wInfo"></div>
        <div class="grid g3" style="margin-top:var(--s4)">
          <div><label class="f">Mint phase</label><select id="wStage"></select></div>
          <div><label class="f">How many <span class="opt" id="wMaxHint"></span></label><input id="wAmt" type="number" value="1" min="1"></div>
          <div><label class="f">Price each <span class="opt">— ETH, auto</span></label><input id="wPrice" class="mono" value="0"></div>
        </div>
        <div id="wTime"></div>
      </div>

      <div class="card" id="wWCard" style="display:none">
        <h3>Wallets <span class="sub" id="wWCount">0 selected</span></h3>
        <div id="wWPills"></div>
      </div>

      <div class="card" id="wActCard" style="display:none">
        <div class="row">
          <div style="flex:1"></div>
          <button class="btn pri lg" id="wGo">Mint now</button>
        </div>
        <div class="sm mut" id="wGasEst" style="margin-top:var(--s2)">—</div>
      </div>

      <div class="card" id="wLive" style="display:none"><h3>Live <span class="sub" id="wRunTag"></span>
        <div style="margin-left:auto"><button class="btn xs danger" id="wStop" style="display:none">Stop</button></div></h3>
        <div id="wCounts" class="tiles sm"></div>
        <div id="wResults"></div>
      </div>`;

    let WRES = null;
    let GW = null;      // last /gas response (used by the confirm dialog)
    let warRunId = null;
    let warDetectSeq = 0;
    const wname = (addr) => {
      const w = S.wallets.evm.find((x) => x.address.toLowerCase() === String(addr || '').toLowerCase());
      return w ? w.name : short(addr, 6);
    };


    function looksMintable(v) {
      const s = v.trim();
      return /^0x[a-fA-F0-9]{40}$/.test(s) || /^https?:\/\/\S+\.\S+/.test(s);
    }

    async function detect(silent) {
      const raw = $('wUrl').value.trim();
      if (!looksMintable(raw)) {
        if (!silent) warn('Paste a link or a 0x contract address');
        return;
      }
      const seq = ++warDetectSeq;
      const b = $('wDetect');
      b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      $('wStatus').innerHTML = '<div class="infobox">Detecting…</div>';
      try {
        const r = await api('/resolve', { input: raw });
        if (seq !== warDetectSeq) return;          // a newer paste won the race
        WRES = r;
        apply(r);
        $('wStatus').innerHTML = '';
        if (!silent) ok('Detected', `${r.platform} · ${r.name || short(r.address || '', 6)}`);
      } catch (e) {
        if (seq !== warDetectSeq) return;
        WRES = null;
        $('wCard').style.display = 'none';
        $('wWCard').style.display = 'none';
        $('wActCard').style.display = 'none';
        $('wStatus').innerHTML = `<div class="failbox">${esc(e.message)}</div>`;
      } finally {
        if (seq === warDetectSeq) { b.disabled = false; b.textContent = 'Detect'; }
      }
    }

    function stages() {
      const st = (WRES && WRES.stages) || [];
      return st.length ? st : [{ id: '0', name: 'Public', price: (WRES && WRES.probe && WRES.probe.price) || '0' }];
    }

    function currentStage() {
      const st = stages();
      return st.find((s) => String(s.id) === $('wStage').value) || st[0];
    }

    function apply(r) {
      const st = stages();
      const chainName = (S.chains.find((c) => c.key === r.chain) || {}).name || r.chain || '—';

      $('wTag').textContent = `${r.platform} · ${chainName}`;
      $('wInfo').innerHTML = `<div class="kv">
        <div><span>Collection</span><b>${esc(r.name || '—')}</b></div>
        <div><span>Chain</span><b>${esc(chainName)}</b></div>
        <div><span>Contract</span><b class="m">${esc(r.address || r.collectionHash || '—')}</b></div>
        <div><span>Supply</span><b>${esc(String(r.supply ?? r.probe?.maxSupply ?? '—'))}</b></div>
        <div><span>Minted</span><b>${esc(String(r.probe?.minted ?? '—'))}</b></div>
        <div><span>Phases</span><b>${st.length}</b></div>
      </div>`;

      $('wStage').innerHTML = st.map((s) => {
        const price = s.price != null && Number(s.price) > 0 ? `${fx(s.price, 4)} ETH` : 'free';
        return `<option value="${esc(String(s.id))}">${esc(s.name)} · ${price}</option>`;
      }).join('');

      const openIdx = st.findIndex((s) => !s.startTime || s.startTime * 1000 <= Date.now());
      $('wStage').value = String(st[openIdx >= 0 ? openIdx : 0].id);

      $('wCard').style.display = '';
      $('wWCard').style.display = '';
      $('wActCard').style.display = '';
      syncStage();
      renderPills();
    }

    let stageGateMs = null, wGateInfo = null;

    function syncStage() {
      const s = currentStage();
      if (s.price != null) $('wPrice').value = s.price;
      const cap = Number(s.maxPerWallet || WRES?.probe?.maxPerWallet || 0);
      $('wMaxHint').textContent = cap > 0 ? `— max ${cap} per wallet` : '';
      $('wAmt').max = cap > 0 ? cap : '';
      if (cap > 0) $('wAmt').value = cap;
      else if (Number($('wAmt').value) < 1) $('wAmt').value = 1;

      if (s.startTime) {
        const when = new Date(s.startTime * 1000).toLocaleString('en-GB');
        const inSec = s.startTime - Math.floor(Date.now() / 1000);
        if (inSec > 0) {
          stageGateMs = s.startTime * 1000;
          $('wTime').innerHTML = `<div class="infobox">Opens in <b id="wStageIn">${esc(fmtCountdown(stageGateMs - Date.now()))}</b> · ${esc(when)} — press Mint now and it waits, then fires on the second.</div>`;
        } else {
          stageGateMs = null;
          $('wTime').innerHTML = `<div class="infobox">Phase opened ${esc(when)}.</div>`;
        }
      } else {
        stageGateMs = null;
        $('wTime').innerHTML = '';
      }
      qGas();
    }
    $('wStage').onchange = syncStage;

    async function qGas() {
      if (!WRES) return;
      try {
        const g = await api('/gas', {
          chain: WRES.chain,
          gasLimit: null,
          nftCount: Number($('wAmt').value || 1),
          pricePerNft: $('wPrice').value || '0',
        });
        GW = g;
        if (g.usdIdr) S.usdIdr = g.usdIdr;
        if (g.ethUsd) S.ethUsd = g.ethUsd;
        const p = (g.presets || []).find((x) => x.key === 'safe') || (g.presets || [])[0];
        const n = WARSEL.size;
        if (!p) { $('wGasEst').textContent = `Gas ${fx(g.currentGwei, 2)} gwei`; return; }
        const per = Number(p.gasEth);
        const tot = per * n;
        const fiat = [S.ethUsd ? `$${num(tot * S.ethUsd, 2)}` : null, ethIdr(tot) != null ? idr(ethIdr(tot)) : null].filter(Boolean).join(' · ');
        $('wGasEst').innerHTML = `Gas <b>${fx(g.currentGwei, 2)} gwei</b> (base ${fx(g.baseGwei, 2)}) · ~<b>${fx(per, 5)} ETH</b>/wallet`
          + (n > 1 ? ` · <b>${fx(tot, 4)} ETH</b> total` : '')
          + (fiat ? ` <span class="mut">(${fiat})</span>` : '');
      } catch { /* locked or offline */ }
    }
    $('wAmt').addEventListener('change', qGas);
    $('wPrice').addEventListener('change', qGas);

    function humanIn(s) {
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
      return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
    }

    let dtv = null;
    $('wUrl').addEventListener('input', () => {
      clearTimeout(dtv);
      if (!looksMintable($('wUrl').value)) return;
      dtv = setTimeout(() => detect(true), 700);
    });
    $('wUrl').addEventListener('paste', () => setTimeout(() => { clearTimeout(dtv); detect(true); }, 30));
    $('wUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(dtv); detect(false); } });
    $('wDetect').onclick = () => { clearTimeout(dtv); detect(false); };

    function renderPills() {
      const box = $('wWPills');
      box.innerHTML = '';
      const all = S.wallets.evm;
      if (!all.length) {
        box.innerHTML = emptyState({ icon: 'wallets', title: 'No EVM wallets', desc: 'Add wallets first.', action: { label: 'Open Wallets', onclick: "go('wallets')" } });
        WARSEL.clear(); syncBtns(); return;
      }
      const live = new Set(all.map((w) => w.id));
      [...WARSEL].forEach((id) => { if (!live.has(id)) WARSEL.delete(id); });
      box.appendChild(walletTree(WARSEL, { wallets: all, groups: S.wgroups.evm, onChange: syncBtns }));
      syncBtns();
    }
    function syncBtns() {
      const n = WARSEL.size;
      $('wWCount').textContent = `${n} selected`;
      gate('wGo', n > 0, 'Select at least one wallet');
      qGas();
    }
    renderPills();

    function cfgFor(mode) {
      if (!WRES) throw new Error('detect a collection first');
      if (!WARSEL.size) throw new Error('no wallets selected');
      const s = currentStage();
      const cfg = {
        profile: 'war', war: true,
        name: WRES.name || short(WRES.address || '', 6),
        chain: WRES.chain, address: WRES.address,
        amount: Number($('wAmt').value || 1),
        pricePerNft: $('wPrice').value || '0',
        walletIds: [...WARSEL],
        mode, maxRetries: 3, stopOnSoldOut: true,
        tipMultiplier: 6, spamCount: 1, fcfsLeadMs: 10000, leadMs: 0, warParallel: true,
      };
      if (WRES.mintMethod === 'opensea-api') {
        cfg.method = 'opensea-api';
        cfg.slug = WRES.slug;
        cfg.stageId = s.id;
      } else if (WRES.suggested && WRES.suggested.function) {
        cfg.method = 'abi';
        cfg.function = WRES.suggested.function;
        cfg.params = WRES.suggested.params || ['{amount}'];
        if (WRES.suggested.gasLimit) cfg.gasLimit = WRES.suggested.gasLimit;
      } else {
        cfg.method = 'abi';
        cfg.function = 'mint(uint256)';
        cfg.params = ['{amount}'];
      }
      if (s.startTime && s.startTime * 1000 > Date.now()) {
        cfg.startTimestamp = s.startTime;
        cfg.monitor = { mode: 'timestamp', pollMs: 250 };
      } else {
        cfg.monitor = { mode: 'off' };
      }
      return cfg;
    }

    async function launch(mode) {
      let cfg;
      try { cfg = cfgFor(mode); } catch (e) { return err('Cannot start', e.message); }
      $('wLive').style.display = '';
      $('wResults').innerHTML = '';
      try {
        const r = await api('/mint/start', cfg);
        warRunId = r.warRunId || r.id;
        $('wRunTag').textContent = `${warRunId} · ${mode}`;
        $('wStop').style.display = '';
        poll();
        ok('Running', warRunId);
      } catch (e) { err('Start failed', e.message); }
    }

    $('wGo').onclick = () => {
      let cfg;
      try { cfg = cfgFor('execute'); } catch (e) { return err('Cannot start', e.message); }
      const per = Number(cfg.pricePerNft || 0) * Number(cfg.amount || 1);
      const n = cfg.walletIds.length;
      const gasP = GW && GW.presets ? (GW.presets.find((x) => x.key === 'safe') || GW.presets[0]) : null;
      const gasPer = gasP ? Number(gasP.gasEth) : 0;
      const estPer = per + gasPer;
      const fiat = (eth) => {
        const usd = S.ethUsd ? ` $${num(eth * S.ethUsd, 2)}` : '';
        const rp = ethIdr(eth) != null ? ` · ${idr(ethIdr(eth))}` : '';
        return usd || rp ? ` <span class="mut">(${usd.trim()}${rp})</span>` : '';
      };
      confirmBox('Send real transactions?',
        `<b>${esc(cfg.name)}</b> on <b>${esc(cfg.chain)}</b> from <b>${n}</b> wallet(s).<br>`
        + `Value per wallet <b>${fx(per, 5)} ETH</b>${fiat(per)}`
        + (gasPer ? ` · gas ~<b>${fx(gasPer, 6)} ETH</b>${fiat(gasPer)}` : '')
        + ` · est <b>${fx(estPer, 5)} ETH</b>/wallet, <b>${fx(estPer * n, 4)} ETH</b> total${fiat(estPer * n)}.<br><br>`
        + 'Broadcast transactions cannot be undone. Check the collection and price above are the ones you want.',
        () => launch('execute'), 'Broadcast');
    };
    $('wStop').onclick = async () => { if (warRunId) await stopRun(warRunId, false); };

    let iv = null;
    function friendlyErr(e) {
      const s = String(e || '');
      if (/insufficient balance|insufficient funds|no balance/i.test(s)) return 'no balance';
      if (/already minted|limit reached|max mint|per wallet|ExceedsWalletLimit|minted out/i.test(s)) return 'already minted';
      if (/sold out|ExceedsMaxSupply|0xc30436e9|0xe12d2314/i.test(s)) return 'sold out';
      if (/allowlist|whitelist|0x06fb10a9|not allowlisted|not whitelisted/i.test(s)) return 'not on allowlist';
      if (/closed|not open|not active|0x13da22f2|not started/i.test(s)) return 'mint closed';
      if (/revert|execution reverted|failed/i.test(s)) return 'tx failed';
      return (s.match(/[^:]{2,60}$/) || [s]).join('').trim() || 'failed';
    }

    function poll() {
      clearInterval(iv);
      iv = setInterval(async () => {
        if (!warRunId || S.page !== 'war') return;
        try {
          const st = await api('/mint/status?runId=' + encodeURIComponent(warRunId));
          const c = st.counts || {};
          wGateInfo = st.gateMs ? { gateMs: st.gateMs, offsetMs: st.offsetMs || 0 } : null;
          const waiting = wGateInfo && ['armed', 'starting', 'running'].includes(st.status);
          $('wCounts').innerHTML = `
            <div class="tile"><div class="k">Status</div><div class="v ${['error', 'aborted'].includes(st.status) ? 'fail' : st.status === 'done' ? 'ok' : 'accent'}">${esc(st.status)}</div></div>
            ${waiting ? `<div class="tile"><div class="k">Fire in</div><div class="v accent" id="wFireIn">${esc(fmtCountdown(wGateInfo.gateMs + wGateInfo.offsetMs - Date.now()))}</div></div>` : ''}
            <div class="tile"><div class="k">Sent</div><div class="v">${c.sent ?? 0}/${c.total ?? 0}</div></div>
            <div class="tile"><div class="k">Minted</div><div class="v ok">${c.confirmed ?? 0}</div></div>
            <div class="tile"><div class="k">Failed</div><div class="v fail">${c.failed ?? 0}</div></div>
            ${st.fees && Number(st.fees.eth) > 0 ? `<div class="tile"><div class="k">Total fee</div><div class="v">${fx(st.fees.eth, 6)} ETH${S.ethUsd ? ` <span class="mut">$${num(Number(st.fees.eth) * S.ethUsd, 2)}</span>` : ''}</div></div>` : ''}`;
          if (st.results && st.results.length) {
            $('wResults').innerHTML = `<div class="tw" style="margin-top:var(--s3)"><table><thead><tr>
              <th>Wallet</th><th>Result</th><th>Detail</th><th>Tx / error</th></tr></thead><tbody>
              ${st.results.slice(-40).map((r) => `<tr>
                <td class="m sm">${esc(wname(r.address))}</td>
                <td><span class="tag ${r.ok ? 'ok' : 'fail'}">${esc(r.ok ? 'ok' : 'fail')}</span></td>
                <td class="sm">${r.ok ? esc('ok') : esc(friendlyErr(r.error))}</td>
                <td class="m sm">${r.hash ? `<a href="${explorerTx(WRES.chain, r.hash)}" target="_blank" rel="noopener">${esc(short(r.hash, 10))}</a>` : esc(r.error || '')}</td>
              </tr>`).join('')}</tbody></table></div>`;
          }
          if (['done', 'error', 'stopped', 'aborted'].includes(st.status)) {
            $('wStop').style.display = 'none';
            clearInterval(iv);
          }
        } catch { /* ignore */ }
      }, 1500);
    }

    syncBtns();
    const wGasIv = setInterval(() => { if (S.page === 'war' && WRES) qGas(); }, 20000);
    const wCdIv = setInterval(() => {
      if (S.page !== 'war') return;
      const si = $('wStageIn');
      if (si && stageGateMs) si.textContent = fmtCountdown(stageGateMs - Date.now());
      const fi = $('wFireIn');
      if (fi && wGateInfo && wGateInfo.gateMs) fi.textContent = fmtCountdown(wGateInfo.gateMs + wGateInfo.offsetMs - Date.now());
    }, 1000);
    el._cleanup = () => { clearInterval(iv); clearTimeout(dtv); clearInterval(wGasIv); clearInterval(wCdIv); };
  },
});
