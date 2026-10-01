'use strict';
/* Quick Mint — the beginner path.
 *
 * One input. Paste an OpenSea/launchpad URL or a bare 0x contract address and
 * everything else fills itself in: chain, platform, mint phase, price, amount
 * cap, mint method, calldata and start time. The old EVM Mint page is still
 * there for manual control; this page never asks for a function signature.
 *
 * Flow: paste -> auto-detect -> pick wallets -> Check -> Simulate -> Mint.
 */

const QSEL = new Set();     // selected wallet ids

page('quick', {
  label: 'Quick Mint', group: 'Minting', icon: 'mint',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Quick Mint</h2>
      <p class="ps">Paste a link or contract address. Everything else is detected for you.</p>

      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:280px">
            <label class="f">OpenSea link, launchpad link, or contract address</label>
            <input id="qUrl" class="mono" placeholder="https://opensea.io/collection/… or 0x…" autocomplete="off">
          </div>
          <button class="btn pri" id="qDetect" style="align-self:flex-end">Detect</button>
        </div>
        <div id="qStatus"></div>
      </div>

      <div class="card" id="qCard" style="display:none">
        <h3>Detected <span class="sub" id="qTag"></span></h3>
        <div id="qInfo"></div>
        <div class="grid g3" style="margin-top:var(--s4)">
          <div><label class="f">Mint phase</label><select id="qStage"></select></div>
          <div><label class="f">How many <span class="opt" id="qMaxHint"></span></label><input id="qAmt" type="number" value="1" min="1"></div>
          <div><label class="f">Price each <span class="opt">— ETH, auto</span></label><input id="qPrice" class="mono" value="0"></div>
        </div>
        <div id="qTime"></div>
      </div>

      <div class="card" id="qWCard" style="display:none">
        <h3>Wallets <span class="sub" id="qWCount">0 selected</span></h3>
        <div class="row">
          <div style="flex:1;min-width:170px"><label class="f">Group</label><select id="qWGroup"></select></div>
          <button class="btn sm" id="qWAll">Select all</button>
          <button class="btn sm" id="qWNone">Clear</button>
        </div>
        <div id="qWPills"></div>
      </div>

      <div class="card" id="qActCard" style="display:none">
        <div class="row">
          <button class="btn" id="qCheck">Check eligible</button>
          <div style="flex:1"></div>
          <button class="btn pri lg" id="qGo">Mint now</button>
        </div>
        <div class="sm mut" id="qGasEst" style="margin-top:var(--s2)">—</div>
        <div id="qCheckOut"></div>
      </div>

      <div class="card" id="qLive" style="display:none"><h3>Live <span class="sub" id="qRunTag"></span>
        <div style="margin-left:auto"><button class="btn xs danger" id="qStop" style="display:none">Stop</button></div></h3>
        <div id="qCounts" class="tiles sm"></div>
        <div id="qResults"></div>
      </div>`;

    let RES = null;
    let GQ = null;      // last /gas response (used by the confirm dialog)
    let runId = null;
    let detectSeq = 0;
    const wname = (addr) => {
      const w = S.wallets.evm.find((x) => x.address.toLowerCase() === String(addr || '').toLowerCase());
      return w ? w.name : short(addr, 6);
    };

    /* ---------- detection ---------- */

    /* Anything that looks like a URL or a 40-hex address is enough to try. */
    function looksMintable(v) {
      const s = v.trim();
      return /^0x[a-fA-F0-9]{40}$/.test(s) || /^https?:\/\/\S+\.\S+/.test(s);
    }

    async function detect(silent) {
      const raw = $('qUrl').value.trim();
      if (!looksMintable(raw)) {
        if (!silent) warn('Paste a link or a 0x contract address');
        return;
      }
      const seq = ++detectSeq;
      const b = $('qDetect');
      b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      $('qStatus').innerHTML = '<div class="infobox">Detecting…</div>';
      try {
        const r = await api('/resolve', { input: raw });
        if (seq !== detectSeq) return;          // a newer paste won the race
        RES = r;
        apply(r);
        $('qStatus').innerHTML = '';
        if (!silent) ok('Detected', `${r.platform} · ${r.name || short(r.address || '', 6)}`);
      } catch (e) {
        if (seq !== detectSeq) return;
        RES = null;
        $('qCard').style.display = 'none';
        $('qWCard').style.display = 'none';
        $('qActCard').style.display = 'none';
        $('qStatus').innerHTML = `<div class="failbox">${esc(e.message)}</div>`;
      } finally {
        if (seq === detectSeq) { b.disabled = false; b.textContent = 'Detect'; }
      }
    }

    function stages() {
      const st = (RES && RES.stages) || [];
      return st.length ? st : [{ id: '0', name: 'Public', price: (RES && RES.probe && RES.probe.price) || '0' }];
    }

    function currentStage() {
      const st = stages();
      return st.find((s) => String(s.id) === $('qStage').value) || st[0];
    }

    function apply(r) {
      const st = stages();
      const chainName = (S.chains.find((c) => c.key === r.chain) || {}).name || r.chain || '—';

      $('qTag').textContent = `${r.platform} · ${chainName}`;
      $('qInfo').innerHTML = `<div class="kv">
        <div><span>Collection</span><b>${esc(r.name || '—')}</b></div>
        <div><span>Chain</span><b>${esc(chainName)}</b></div>
        <div><span>Contract</span><b class="m">${esc(r.address || r.collectionHash || '—')}</b></div>
        <div><span>Supply</span><b>${esc(String(r.supply ?? r.probe?.maxSupply ?? '—'))}</b></div>
        <div><span>Minted</span><b>${esc(String(r.probe?.minted ?? '—'))}</b></div>
        <div><span>Phases</span><b>${st.length}</b></div>
      </div>`;

      $('qStage').innerHTML = st.map((s) => {
        const price = s.price != null && Number(s.price) > 0 ? `${fx(s.price, 4)} ETH` : 'free';
        return `<option value="${esc(String(s.id))}">${esc(s.name)} · ${price}</option>`;
      }).join('');

      $('qCard').style.display = '';
      $('qWCard').style.display = '';
      $('qActCard').style.display = '';
      syncStage();
      renderWG(); renderPills();
    }

    /* countdown sources: stageGateMs = selected phase start (wall clock),
       qGateInfo = armed run gate from status polls (chain-synced) */
    let stageGateMs = null, qGateInfo = null;

    function syncStage() {
      const s = currentStage();
      if (s.price != null) $('qPrice').value = s.price;
      const cap = Number(s.maxPerWallet || RES?.probe?.maxPerWallet || 0);
      $('qMaxHint').textContent = cap > 0 ? `— max ${cap} per wallet` : '';
      $('qAmt').max = cap > 0 ? cap : '';
      if (cap > 0 && Number($('qAmt').value) > cap) $('qAmt').value = cap;

      if (s.startTime) {
        const when = new Date(s.startTime * 1000).toLocaleString('en-GB');
        const inSec = s.startTime - Math.floor(Date.now() / 1000);
        if (inSec > 0) {
          stageGateMs = s.startTime * 1000;
          $('qTime').innerHTML = `<div class="infobox">Opens in <b id="qStageIn">${esc(fmtCountdown(stageGateMs - Date.now()))}</b> · ${esc(when)} — press Mint now and it waits, then fires on the second.</div>`;
        } else {
          stageGateMs = null;
          $('qTime').innerHTML = `<div class="infobox">Phase opened ${esc(when)}.</div>`;
        }
      } else {
        stageGateMs = null;
        $('qTime').innerHTML = '';
      }
      qGas();
    }
    $('qStage').onchange = syncStage;

    /* ---------- gas estimate ---------- */
    async function qGas() {
      if (!RES) return;
      try {
        const g = await api('/gas', {
          chain: RES.chain,
          gasLimit: null,
          nftCount: Number($('qAmt').value || 1),
          pricePerNft: $('qPrice').value || '0',
        });
        GQ = g;
        if (g.usdIdr) S.usdIdr = g.usdIdr;
        if (g.ethUsd) S.ethUsd = g.ethUsd;
        const p = (g.presets || []).find((x) => x.key === 'safe') || (g.presets || [])[0];
        const n = QSEL.size;
        if (!p) { $('qGasEst').textContent = `Gas ${fx(g.currentGwei, 2)} gwei`; return; }
        const per = Number(p.gasEth);
        const tot = per * n;
        const fiat = [S.ethUsd ? `$${num(tot * S.ethUsd, 2)}` : null, ethIdr(tot) != null ? idr(ethIdr(tot)) : null].filter(Boolean).join(' · ');
        $('qGasEst').innerHTML = `Gas <b>${fx(g.currentGwei, 2)} gwei</b> (base ${fx(g.baseGwei, 2)}) · ~<b>${fx(per, 5)} ETH</b>/wallet`
          + (n > 1 ? ` · <b>${fx(tot, 4)} ETH</b> total` : '')
          + (fiat ? ` <span class="mut">(${fiat})</span>` : '');
      } catch { /* locked or offline */ }
    }
    $('qAmt').addEventListener('change', qGas);
    $('qPrice').addEventListener('change', qGas);

    function humanIn(s) {
      if (s < 60) return `${s}s`;
      if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
      return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
    }

    /* auto-detect on paste, and on typing once it stops for 700ms */
    let dtv = null;
    $('qUrl').addEventListener('input', () => {
      clearTimeout(dtv);
      if (!looksMintable($('qUrl').value)) return;
      dtv = setTimeout(() => detect(true), 700);
    });
    $('qUrl').addEventListener('paste', () => setTimeout(() => { clearTimeout(dtv); detect(true); }, 30));
    $('qUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(dtv); detect(false); } });
    $('qDetect').onclick = () => { clearTimeout(dtv); detect(false); };

    /* ---------- wallets ---------- */
    function renderWG() {
      const cur = $('qWGroup').value;
      $('qWGroup').innerHTML = '<option value="">All groups</option>'
        + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');
      if (cur) $('qWGroup').value = cur;
    }
    function renderPills() {
      const gsel = $('qWGroup').value;
      const rows = S.wallets.evm.filter((w) => !gsel || w.groupId === gsel);
      const box = $('qWPills');
      box.innerHTML = '';
      if (!rows.length) {
        box.innerHTML = emptyState({ icon: 'wallets', title: 'No EVM wallets', desc: 'Add wallets first.', action: { label: 'Open Wallets', onclick: "go('wallets')" } });
        QSEL.clear(); syncBtns(); return;
      }
      // drop stale ids so a deleted wallet cannot end up in a run
      const live = new Set(rows.map((w) => w.id));
      [...QSEL].forEach((id) => { if (!live.has(id)) QSEL.delete(id); });
      box.appendChild(pillList(rows.map((w) => ({ id: w.id, label: w.name })), QSEL, syncBtns));
      syncBtns();
    }
    function syncBtns() {
      const n = QSEL.size;
      $('qWCount').textContent = `${n} selected`;
      ['qCheck', 'qGo'].forEach((id) => gate(id, n > 0, 'Select at least one wallet'));
      qGas();
    }
    $('qWGroup').onchange = renderPills;
    $('qWAll').onclick = () => { const g = $('qWGroup').value; S.wallets.evm.filter((w) => !g || w.groupId === g).forEach((w) => QSEL.add(w.id)); renderPills(); };
    $('qWNone').onclick = () => { QSEL.clear(); renderPills(); };

    /* ---------- eligibility ---------- */
    const VERDICT = {
      eligible: ['ok', 'Eligible'],
      not_eligible: ['fail', 'Not eligible'],
      underfunded: ['warn', 'Underfunded'],
      limit_reached: ['warn', 'Limit reached'],
      closed: ['mut', 'Closed'],
      unknown: ['mut', 'Unknown'],
    };

    $('qCheck').onclick = async () => {
      if (!RES) return warn('Detect a collection first');
      const b = $('qCheck'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Checking';
      try {
        const r = await api('/eligibility', {
          input: $('qUrl').value.trim(), chain: RES.chain,
          stageId: currentStage().id, quantity: Number($('qAmt').value || 1),
          price: $('qPrice').value || '0', walletIds: [...QSEL],
        });
        const c = r.counts || {};
        $('qCheckOut').innerHTML = `<div class="tiles sm" style="margin-top:var(--s3)">
            ${Object.entries(VERDICT).filter(([k]) => c[k]).map(([k, v]) => `<div class="tile"><div class="k">${esc(v[1])}</div><div class="v ${v[0]}">${c[k]}</div></div>`).join('')}
          </div>
          <div class="tw" style="margin-top:var(--s3)"><table><thead><tr>
            <th>Wallet</th><th>Address</th><th>Status</th><th>Reason</th><th class="rt">Balance</th></tr></thead><tbody>
            ${r.rows.map((x) => {
    const v = VERDICT[x.verdict] || VERDICT.unknown;
    return `<tr><td>${esc(x.name || '—')}</td><td class="m sm">${esc(short(x.address, 6))}</td>
                <td><span class="tag ${v[0]}">${esc(v[1])}</span></td>
                <td class="sm mut">${esc(x.reason || '')}</td>
                <td class="num">${x.balance != null ? fx(x.balance, 4) : '—'}</td></tr>`;
  }).join('')}
          </tbody></table></div>
          ${r.eligible.length ? `<div class="row" style="margin-top:var(--s3)"><button class="btn sm" id="qKeepElig">Keep only the ${r.eligible.length} eligible</button></div>` : ''}`;
        if (r.eligible.length) {
          $('qKeepElig').onclick = () => {
            QSEL.clear(); r.eligible.forEach((id) => QSEL.add(id));
            renderPills(); ok('Selection trimmed', `${r.eligible.length} wallet(s)`);
          };
        }
      } catch (e) { err('Check failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Check eligible'; }
    };

    /* ---------- build + run ---------- */
    function cfgFor(mode) {
      if (!RES) throw new Error('detect a collection first');
      if (!QSEL.size) throw new Error('no wallets selected');
      const s = currentStage();
      const cfg = {
        name: RES.name || short(RES.address || '', 6),
        chain: RES.chain, address: RES.address,
        amount: Number($('qAmt').value || 1),
        pricePerNft: $('qPrice').value || '0',
        walletIds: [...QSEL],
        mode, maxRetries: 3, stopOnSoldOut: true,
        tipMultiplier: 2,
      };
      // method + calldata straight from detection — no manual ABI work
      if (RES.mintMethod === 'opensea-api') {
        cfg.method = 'opensea-api';
        cfg.slug = RES.slug;
        cfg.stageId = s.id;
      } else if (RES.suggested && RES.suggested.function) {
        cfg.method = 'abi';
        cfg.function = RES.suggested.function;
        cfg.params = RES.suggested.params || ['{amount}'];
        if (RES.suggested.gasLimit) cfg.gasLimit = RES.suggested.gasLimit;
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
      $('qLive').style.display = '';
      $('qResults').innerHTML = '';
      try {
        const r = await api('/mint/start', cfg);
        runId = r.runId || r.id;
        $('qRunTag').textContent = `${runId} · ${mode}`;
        $('qStop').style.display = '';
        poll();
        ok('Running', runId);
      } catch (e) { err('Start failed', e.message); }
    }

    $('qGo').onclick = () => {
      let cfg;
      try { cfg = cfgFor('execute'); } catch (e) { return err('Cannot start', e.message); }
      const per = Number(cfg.pricePerNft || 0) * Number(cfg.amount || 1);
      const n = cfg.walletIds.length;
      const gasP = GQ && GQ.presets ? (GQ.presets.find((x) => x.key === 'safe') || GQ.presets[0]) : null;
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
    $('qStop').onclick = async () => { if (runId) await stopRun(runId, false); };

    let iv = null;
    /* Human-friendly reason — normies don't read raw revert hex. */
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
        if (!runId || S.page !== 'quick') return;
        try {
          const st = await api('/mint/status?runId=' + encodeURIComponent(runId));
          const c = st.counts || {};
          qGateInfo = st.gateMs ? { gateMs: st.gateMs, offsetMs: st.offsetMs || 0 } : null;
          const waiting = qGateInfo && ['armed', 'starting', 'running'].includes(st.status);
          $('qCounts').innerHTML = `
            <div class="tile"><div class="k">Status</div><div class="v ${['error', 'aborted'].includes(st.status) ? 'fail' : st.status === 'done' ? 'ok' : 'accent'}">${esc(st.status)}</div></div>
            ${waiting ? `<div class="tile"><div class="k">Fire in</div><div class="v accent" id="qFireIn">${esc(fmtCountdown(qGateInfo.gateMs + qGateInfo.offsetMs - Date.now()))}</div></div>` : ''}
            <div class="tile"><div class="k">Sent</div><div class="v">${c.sent ?? 0}/${c.total ?? 0}</div></div>
            <div class="tile"><div class="k">Minted</div><div class="v ok">${c.confirmed ?? 0}</div></div>
            <div class="tile"><div class="k">Failed</div><div class="v fail">${c.failed ?? 0}</div></div>`;
          if (st.results && st.results.length) {
            $('qResults').innerHTML = `<div class="tw" style="margin-top:var(--s3)"><table><thead><tr>
              <th>Wallet</th><th>Result</th><th>Detail</th><th>Tx / error</th></tr></thead><tbody>
              ${st.results.slice(-40).map((r) => `<tr>
                <td class="m sm">${esc(wname(r.address))}</td>
                <td><span class="tag ${r.ok ? 'ok' : 'fail'}">${esc(r.ok ? 'ok' : 'fail')}</span></td>
                <td class="sm">${r.ok ? esc('ok') : esc(friendlyErr(r.error))}</td>
                <td class="m sm">${r.hash ? `<a href="${explorerTx(RES.chain, r.hash)}" target="_blank" rel="noopener">${esc(short(r.hash, 10))}</a>` : esc(r.error || '')}</td>
              </tr>`).join('')}</tbody></table></div>`;
          }
          if (['done', 'error', 'stopped', 'aborted'].includes(st.status)) {
            $('qStop').style.display = 'none';
            clearInterval(iv);
          }
        } catch { /* ignore */ }
      }, 1500);
    }

    syncBtns();
    const qGasIv = setInterval(() => { if (S.page === 'quick' && RES) qGas(); }, 20000);
    /* smooth 1s countdown: phase "Opens in" + armed run "Fire in" */
    const qCdIv = setInterval(() => {
      if (S.page !== 'quick') return;
      const si = $('qStageIn');
      if (si && stageGateMs) si.textContent = fmtCountdown(stageGateMs - Date.now());
      const fi = $('qFireIn');
      if (fi && qGateInfo && qGateInfo.gateMs) fi.textContent = fmtCountdown(qGateInfo.gateMs + qGateInfo.offsetMs - Date.now());
    }, 1000);
    el._cleanup = () => { clearInterval(iv); clearTimeout(dtv); clearInterval(qGasIv); clearInterval(qCdIv); };
  },
});

/* =========================================================
   ELIGIBILITY — standalone sweep across many wallets
   ========================================================= */
page('eligible', {
  label: 'Check Eligible', group: 'Minting', icon: 'check',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Check Eligible</h2>
      <p class="ps">Which of your wallets can actually mint this drop right now.</p>

      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:260px"><label class="f">Link or contract address</label>
            <input id="eUrl" class="mono" placeholder="https://opensea.io/collection/… or 0x…" autocomplete="off"></div>
          <div style="width:170px"><label class="f">Wallet group</label><select id="eGroup"></select></div>
          <button class="btn pri" id="eGo" style="align-self:flex-end">Check</button>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="width:150px"><label class="f">Phase</label><select id="eStage"><option value="">auto (all phases)</option></select></div>
          <div style="width:110px"><label class="f">Amount</label><input id="eAmt" type="number" value="1" min="1"></div>
          <button class="btn sm" id="eDetect" style="align-self:flex-end">Load phases</button>
        </div>
        <div class="sm mut" style="margin-top:var(--s2)">Checks every phase in one pass. ✅ = can mint that phase right now.</div>
      </div>

      <div class="card"><h3>Result <span class="sub" id="eTag"></span></h3>
        <div id="eOut">${emptyState({ icon: 'check', title: 'Nothing checked yet', desc: 'Paste a drop link and press Check.' })}</div>
      </div>`;

    let INFO = null;

    function groups() {
      $('eGroup').innerHTML = '<option value="">All wallets</option>'
        + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');
    }
    groups();

    $('eDetect').onclick = async () => {
      const v = $('eUrl').value.trim();
      if (!v) return warn('Paste a link first');
      const b = $('eDetect'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        INFO = await api('/resolve', { input: v });
        const st = INFO.stages || [];
        $('eStage').innerHTML = st.length
          ? st.map((s) => `<option value="${esc(String(s.id))}">${esc(s.name)} · ${s.price != null && Number(s.price) > 0 ? fx(s.price, 4) + ' ETH' : 'free'}</option>`).join('')
          : '<option value="">auto</option>';
        ok('Loaded', `${INFO.platform} · ${st.length} phase(s)`);
      } catch (e) { err('Detect failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Load phases'; }
    };

    const V = {
      eligible: ['ok', 'Eligible'], not_eligible: ['fail', 'Not eligible'],
      underfunded: ['warn', 'Underfunded'], limit_reached: ['warn', 'Limit reached'],
      closed: ['mut', 'Closed'], unknown: ['mut', 'Unknown'],
    };

    $('eGo').onclick = async () => {
      const v = $('eUrl').value.trim();
      if (!v) return warn('Paste a link first');
      const g = $('eGroup').value;
      const ws = S.wallets.evm.filter((w) => !g || w.groupId === g);
      if (!ws.length) return warn('No wallets in that group');
      const b = $('eGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Checking';
      try {
        const info = await api('/resolve', { input: v });
        const st = (info.stages && info.stages.length ? info.stages : [{ id: '0', name: 'Public', price: '0' }]);
        const r = await api('/eligibility', {
          input: v, allStages: true, quantity: Number($('eAmt').value || 1), walletIds: ws.map((w) => w.id),
        });

        const ph = (n) => esc(String(n || '').replace(/stage/i, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 10) || 'PUBLIC');
        const phaseCols = r.stages.map((s) =>
          `<th title="${esc(s.name)} · ${s.price != null && Number(s.price) > 0 ? fx(s.price, 4) + ' ETH' : 'free'}${s.maxPerWallet ? ' · max ' + s.maxPerWallet + '/wallet' : ''}">${ph(s.name)}</th>`).join('');
        const foot = r.stages.map((s, i) => {
          const c = (r.stageCounts[i] && r.stageCounts[i].counts) || {};
          const n = c.eligible || 0;
          const caps = r.rows.reduce((a, w) => a + ((w.stages[String(s.id)] || {}).verdict === 'eligible' ? (s.maxPerWallet || 1) : 0), 0);
          return `<th class="num mut">${n} ✓${s.maxPerWallet ? ' · ' + caps + ' cap' : ''}</th>`;
        }).join('');

        const tile = (k, label, cls, n) => `<div class="tile"><div class="k">${label}</div><div class="v ${cls}">${n}</div></div>`;
        const overall = (w) => {
          const vs = Object.values(w.stages).map((x) => x.verdict);
          if (vs.includes('eligible')) return 'eligible';
          if (vs.includes('underfunded')) return 'underfunded';
          if (vs.includes('not_eligible')) return 'not_eligible';
          if (vs.includes('closed')) return 'closed';
          return 'unknown';
        };
        const ocounts = r.rows.reduce((a, w) => { a[overall(w)] = (a[overall(w)] || 0) + 1; return a; }, {});
        const tileRow = [
          tile('eligible', 'ELIGIBLE', 'ok', ocounts.eligible || 0),
          tile('underfunded', 'UNDERFUNDED', 'warn', ocounts.underfunded || 0),
          tile('not_eligible', 'NOT ELIGIBLE', 'fail', ocounts.not_eligible || 0),
          tile('closed', 'CLOSED', 'mut', ocounts.closed || 0),
          tile('unknown', 'UNKNOWN', 'mut', ocounts.unknown || 0),
        ].join('');

        $('eTag').textContent = `${r.name || r.address || ''} · ${r.rows.length} wallet(s) · ${r.stages.length} phase(s)`;
        $('eOut').innerHTML = `<div class="tiles sm">${tileRow}</div>
          <div class="tw" style="margin-top:var(--s3)"><table><thead><tr>
            <th>Wallet</th><th>Address</th>${phaseCols}</tr></thead><tbody>
            ${r.rows.map((w) => `<tr><td>${esc(w.name || '—')}</td><td class="m sm">${esc(short(w.address, 6))}</td>
              ${r.stages.map((s) => {
                const x = (w.stages || {})[String(s.id)];
                const ok = x && x.verdict === 'eligible';
                return `<td class="ctr" title="${esc((x && x.reason) || '')}">${ok ? '<span class="ok" style="font-size:14px">✅</span>' : '<span class="mut">—</span>'}</td>`;
              }).join('')}</tr>`).join('')}
          </tbody><tfoot><tr><th colspan="2" class="sm mut">eligible by phase</th>${foot}</tr></tfoot></table></div>
          <div class="sm mut" style="margin-top:var(--s2)">✅ number = eligible wallets in that phase${r.stages.some((s) => s.maxPerWallet) ? ', cap = cumulative mints the eligible wallets can make' : ''}.</div>
          <div class="row" style="margin-top:var(--s3)">
            <button class="btn sm" id="eCopy">Copy eligible addresses</button>
          </div>`;
        const elig = r.rows.filter((w) => Object.values(w.stages).some((x) => x.verdict === 'eligible')).map((w) => w.address);
        $('eCopy').onclick = () => (elig.length ? copy(elig.join('\n')) : warn('None eligible'));
      } catch (e) { err('Check failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Check'; }
    };
  },
});
