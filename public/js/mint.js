'use strict';

const MSEL = new Set();  // selected wallet ids for mint

page('mint', {
  label: 'EVM Mint', group: 'Minting', icon: 'mint',
  render(el) {
    el.classList.add('fit');
    el.innerHTML = `
      <div class="crumb">
        <b>MINT</b><span>/</span>EVM
        <span class="cnote">paste target · pick wallets · pick gas · fire</span>
      </div>

      <!-- Dense 12-col grid — one screen, no scroll. Hints ride on the label
           line, units sit inside the field, checkboxes hang off their label. -->
      <div class="card mint-form">
        <!-- Row 1: target + chain -->
        <div class="mfg">
          <div class="mfc9"><label class="f">Contract Address / Launchpad Link
            <span class="mf-btns"><button class="btn xs" id="mResolve">Resolve</button><button class="btn xs" id="mProbe">Probe</button></span></label>
            <input id="mUrl" class="mono" placeholder="https://opensea.io/collection/… or 0x…"></div>
          <div class="mfc3"><label class="f">Chain <span class="req">*</span></label>
            <div class="mfu" data-u="${esc(nativeSym('ethereum'))}" id="mChainU">
              <select id="mChain">${chainOpts('ethereum')}</select></div></div>
        </div>

        <!-- compact resolved line (fills after Resolve, one line only) -->
        <div id="mInfo" class="minfo"></div>

        <!-- Row 2: phase + method -->
        <div class="mfg">
          <div class="mfc7"><label class="f">Mint Phase <span class="mfh" id="mPhaseH">resolve to load</span></label>
            <select id="mStage"><option value="">—</option></select></div>
          <div class="mfc5"><label class="f">Method</label>
            <select id="mMethod">
              <option value="abi">ABI function</option>
              <option value="hex">Raw hex</option>
              <option value="seadrop-snipe">SeaDrop Snipe</option>
              <option value="opensea-api">OpenSea API (signed)</option>
            </select></div>
        </div>

        <!-- calldata: only renders for abi/hex methods. OpenSea (the common path)
             keeps these display:none, so the grid stays six rows tall. -->
        <div class="mfg" id="mFnWrap" style="display:none">
          <div class="mfc7"><label class="f">Function signature</label>
            <input id="mFn" class="mono" placeholder="mint(uint256)"></div>
          <div class="mfc5"><label class="f">Method <span class="mfh">detected</span></label>
            <select id="mFnSel" style="display:none"></select></div>
        </div>
        <div id="mParamsWrap" style="display:none"><label class="f">Params <span class="mfh">{wallet} {amount} {proof}, [] = empty</span></label>
          <textarea id="mParams" rows="2" class="mono" placeholder="{amount}"></textarea></div>
        <div id="mHexWrap" style="display:none"><label class="f">Raw calldata</label>
          <textarea id="mHex" rows="2" class="mono" placeholder="0xa0712d68…"></textarea></div>

        <!-- SeaDrop Snipe panel -->
        <div id="mSdWrap" style="display:none">
          <div class="mfg">
            <div class="mfc6"><label class="f">SeaDrop Contract</label>
              <input id="mSdAddr" class="mono" value="0x00005EA00Ac477B1030CE78506496e8C2dE24bf5"></div>
            <div class="mfc6"><label class="f">Fee Recipient <span class="mfh">default if unsure</span></label>
              <input id="mSdFee" class="mono" value="0x0000a26b00c1f0df003000390027140000faa719"></div>
          </div>
          <div class="mfg">
            <div class="mfc12"><label class="f">Hex Calldata <span class="mfh" id="mSdHexHint">auto-built from contract + qty</span></label>
              <textarea id="mSdHex" rows="2" class="mono" readonly></textarea></div>
          </div>
          <div class="mfg">
            <div class="mfc6"><label class="f">Window Start</label>
              <input id="mSdStart" class="mono" placeholder="auto from probe"></div>
            <div class="mfc6"><label class="f">Window End</label>
              <input id="mSdEnd" class="mono" placeholder="auto from probe"></div>
          </div>
          <div id="mSdInfo" class="infobox" style="margin-bottom:var(--s2)"></div>
        </div>

        <!-- Row 3: proxy + amount + price -->
        <div class="mfg">
          <div class="mfc5"><label class="f">Proxy Group <span class="mfh" id="mProxyH">optional · OpenSea API</span></label>
            <select id="mProxy"><option value="">(no proxy)</option></select></div>
          <div class="mfc3"><label class="f">NFT Amount <span class="mfh" id="mAmtH"></span></label>
            <input id="mAmt" type="number" value="1" min="1"></div>
          <div class="mfc4"><label class="f">Price per NFT</label>
            <div class="mfu" data-native data-u="ETH"><input id="mPrice" class="mono" value="0" placeholder="0"></div></div>
        </div>

        <!-- Row 4: wallets + rpc -->
        <div class="mfg">
          <div class="mfc6"><label class="f">Wallets <span class="mfh" id="mWCount">0</span>
            <span class="mf-btns"><label class="chk sm"><input type="checkbox" id="mWFunded"> Funded Only</label></span></label>
            <div id="mWGroup"></div></div>
          <div class="mfc6"><label class="f">RPC Endpoints
            <span class="mf-btns"><label class="chk sm"><input type="checkbox" id="mFlash"> Flashbots</label></span></label>
            <select id="mRpc"><option value="">Auto (all healthy)</option></select></div>
        </div>

        <!-- Row 5: gas -->
        <div class="mfg">
          <div class="mfc4"><label class="f">Gas Limit</label>
            <div class="mfu" data-u="units"><input id="mGasLimit" type="number" placeholder="auto"></div></div>
          <div class="mfc4"><label class="f">Max Fee</label>
            <div class="mfu" data-u="gwei"><input id="mMaxFee" class="mono" placeholder="auto"></div></div>
          <div class="mfc4"><label class="f">Priority Fee</label>
            <div class="mfu" data-u="gwei"><input id="mTip" class="mono" placeholder="auto"></div></div>
        </div>

        <!-- Row 6: nonce + timestamp + delay + spam -->
        <div class="mfg">
          <div class="mfc3"><label class="f">Nonce</label>
            <input id="mNonce" type="number" placeholder="auto"></div>
          <div class="mfc3"><label class="f">Timestamp <span class="mfh" id="mTsH"></span></label>
            <div class="mfu" data-u="s/ms"><input id="mTs" class="mono" placeholder="now"></div></div>
          <div class="mfc3"><label class="f">Delay</label>
            <div class="mfu" data-u="ms"><input id="mDelay" type="number" value="1000"></div></div>
          <div class="mfc3"><label class="f">Spam Count <span class="mfh">txs/wallet</span></label>
            <div class="mfu" data-u="txs"><input id="mSpamCount" type="number" value="20" min="1" max="200"></div></div>
        </div>

        <!-- Advanced panel — hidden until toggled (takes 0px closed, so the six
             rows above always clear the fold). Opened via the firebar button. -->
        <div id="mAdvPanel" style="display:none">
          <div class="mfg">
            <div class="mfc4" id="mOsWrap"><label class="f">OpenSea slug</label>
              <input id="mSlug" class="mono"></div>
            <div class="mfc4"><label class="f">Retries</label>
              <input id="mRetries" type="number" value="3"></div>
            <div class="mfc4"><label class="f">Poll <span class="mfh">gate-poll interval</span></label>
              <div class="mfu" data-u="ms"><input id="mPoll" type="number" value="150"></div></div>
          </div>
          <div class="mfg" id="mFcfsRow" style="display:none">
            <div class="mfc4"><label class="f">FCFS <span class="mfh">OpenSea timed mints</span></label>
              <label class="chk sm" style="margin-top:8px"><input type="checkbox" id="mFcfs" checked> FCFS bundle — warm conns + pre-gate calldata hammer + schedule guard</label></div>
            <div class="mfc4"><label class="f">Calldata path</label>
              <select id="mOsPath"><option value="auto">Auto (gql batch → v2 fallback)</option><option value="v2">v2 API only</option></select></div>
            <div class="mfc4"><label class="f">Hammer lead <span class="mfh">start before gate</span></label>
              <div class="mfu" data-u="ms"><input id="mFcfsLead" type="number" value="1500"></div></div>
          </div>
          <div class="mfg">
            <div class="mfc4"><label class="f">Fire mode <span class="mfh">timed starts</span></label>
              <select id="mFireMode"><option value="auto">Auto (chain-aware)</option><option value="lead">Lead (broadcast early)</option><option value="gate-poll">Gate-poll (fire on open)</option></select></div>
            <div class="mfc4"><label class="f">Lead <span class="mfh">lead mode only</span></label>
              <div class="mfu" data-u="ms"><input id="mLead" type="number" placeholder="auto"></div></div>
            <div class="mfc4"><label class="f">&nbsp;</label>
              <label class="chk sm" style="margin-top:8px"><input type="checkbox" id="mChainSync" checked> Sync to chain clock + verify gate onchain</label></div>
          </div>
          <div class="mfg">
            <div class="mfc12"><label class="f">Gas Preset <span class="mfh" id="mGasLive">—</span>
              <span class="mf-btns"><label class="chk sm"><input type="checkbox" id="mSoldOut" checked> Stop on sold-out</label><label class="chk sm"><input type="checkbox" id="mBundle"> Flashbots bundle</label></span></label>
              <div class="seg-row" id="mSeg">
                <button data-preset="safe" class="on">Safe <span class="sc" data-c="safe">—</span></button>
                <button data-preset="fast">Fast <span class="sc" data-c="fast">—</span></button>
                <button data-preset="gacor">Gacor <span class="sc" data-c="gacor">—</span></button>
              </div></div>
          </div>
          <div class="mfg">
            <div class="mfc6"><label class="f">On-chain trigger flag <span class="mfh">blank = disabled</span></label>
              <input id="mMonFn" class="mono" placeholder="saleActive()"></div>
            <div class="mfc6"><div id="mFundNote"></div><div id="mFlashNote"></div></div>
          </div>
        </div>

        <!-- Footer bar — mode picker left, fire right. Mirrors the reference modal. -->
        <div class="firebar">
          <div class="seg-row modes" id="mModeSeg">
            <button data-mode="instant">Instant</button>
            <button data-mode="spam">Spam</button>
            <button data-mode="simulate">Simulate</button>
            <button data-mode="execute" class="on">Execute</button>
          </div>
          <div class="est" id="mEst" title="">Select wallets to see cost</div>
          <div class="sp"></div>
          <div class="fwarn" id="mWarn"></div>
          <button class="btn" id="mAdvBtn">Advanced</button>
          <button class="btn pri" id="mFire">Arm &amp; Mint</button>
          <button class="btn danger" id="mStop" style="display:none">Stop</button>
        </div>
      </div>

      <!-- Live results — below the form card -->
      <div class="card"><h3>Live <span class="sub" id="mRunTag"></span></h3>
        <div id="mCounts" class="tiles sm"></div>
        <div id="mResults"></div>
      </div>`;

    let RES = null;      // resolve result
    let STAGES = [];     // phases from the last resolve
    let GAS = null;      // last /gas response (carries preset costs)
    let PRESET = 'safe';
    let runId = null;
    const wname = (addr) => {
      const w = S.wallets.evm.find((x) => x.address.toLowerCase() === String(addr || '').toLowerCase());
      return w ? w.name : short(addr, 6);
    };
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

    function syncMethod() {
      const m = $('mMethod').value;
      $('mFnWrap').style.display = m === 'abi' ? '' : 'none';
      $('mParamsWrap').style.display = m === 'abi' ? '' : 'none';
      $('mHexWrap').style.display = m === 'hex' ? '' : 'none';
      $('mOsWrap').style.display = m === 'opensea-api' ? '' : 'none';
      $('mFcfsRow').style.display = m === 'opensea-api' ? '' : 'none';
      $('mSdWrap').style.display = m === 'seadrop-snipe' ? '' : 'none';
      const px = m === 'opensea-api';
      $('mProxy').disabled = !px;
      $('mProxyH').textContent = px ? 'optional · OpenSea API' : 'OpenSea API only';
      syncWarn();
    }
    $('mMethod').onchange = syncMethod;

    function renderProxies() {
      const gs = S.proxies || [];
      $('mProxy').innerHTML = '<option value="">(no proxy)</option>'
        + gs.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${g.healthy}/${g.count})</option>`).join('');
    }
    function renderRpcs() {
      const ck = $('mChain').value;
      const gs = (S.rpcs || []).filter((g) => g.chain === ck);
      const sel = $('mRpc');
      sel.innerHTML = gs.length
        ? '<option value="">Auto (all healthy)</option>'
          + gs.map((g) => `<option value="${esc(g.id)}">${esc(g.name)} (${g.healthy}/${g.count})</option>`).join('')
        : '<option value="">No endpoints for this chain</option>';
      sel.disabled = !gs.length;
      syncWarn();
    }
    function syncWarn() {
      const ck = $('mChain').value;
      const gs = (S.rpcs || []).filter((g) => g.chain === ck);
      const healthy = gs.reduce((n, g) => n + g.healthy, 0);
      const c = S.chains.find((x) => x.key === ck);
      let msg = '';
      if (!gs.length) msg = 'No RPC — public RPC fallback';
      else if (!healthy) msg = 'No healthy RPC — public RPC fallback';
      else if ($('mFlash').checked && !(c && [1, 11155111].includes(c.id))) msg = `Flashbots unsupported on ${c ? c.name : 'chain'} — public mempool`;
      $('mWarn').innerHTML = msg ? `<span class="wtri">▲</span> ${esc(msg)}` : '';
    }

    function syncChain() {
      $('mChainU').dataset.u = nativeSym($('mChain').value);
      qa('.mfu[data-native]').forEach((e2) => { e2.dataset.u = nativeSym($('mChain').value); });
      renderRpcs();
      refreshGas();
    }
    $('mChain').addEventListener('change', syncChain);

    function parseTs() {
      const v = ($('mTs').value || '').trim();
      if (!v) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return NaN;
      return n < 1e12 ? n * 1000 : n; // -> ms
    }
    function syncTsHint() {
      const t = parseTs();
      if (t === null) { $('mTsH').textContent = ''; return; }
      if (Number.isNaN(t)) { $('mTsH').textContent = 'invalid'; return; }
      const secs = Math.floor((t - Date.now()) / 1000);
      const when = new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      $('mTsH').textContent = `${secs < 0 ? 'passed' : 'in ' + dur(secs)} · ${when}`;
    }
    $('mTs').addEventListener('input', syncTsHint);

    $('mFlash').onchange = () => {
      const c = S.chains.find((x) => x.key === $('mChain').value);
      $('mFlashNote').innerHTML = !$('mFlash').checked ? ''
        : (c && [1, 11155111].includes(c.id)
          ? '<div class="infobox">Flashbots Protect relay. Tx stays private, no failed-tx gas burn, but inclusion is not guaranteed for public mints.</div>'
          : `<div class="warnbox">Flashbots relay does not support ${esc(c ? c.name : 'this chain')}. Run will fall back to the public mempool.</div>`);
      syncWarn();
    };

    qa('#mSeg button').forEach((b) => {
      b.onclick = () => {
        PRESET = b.dataset.preset;
        qa('#mSeg button').forEach((x) => x.classList.toggle('on', x === b));
        syncEst();
      };
    });

    async function refreshGas() {
      try {
        GAS = await api('/gas', {
          chain: $('mChain').value,
          gasLimit: Number($('mGasLimit').value || 300000),
          nftCount: Number($('mAmt').value || 1),
          pricePerNft: $('mPrice').value || '0',
        });
        $('mGasLive').textContent = `base ${fx(GAS.currentGwei, 2)} gwei`;
        if (GAS.usdIdr) S.usdIdr = GAS.usdIdr;
        if (GAS.ethUsd) S.ethUsd = GAS.ethUsd;
        (GAS.presets || []).forEach((p) => {
          const t = q(`#mSeg .sc[data-c="${p.key}"]`);
          if (t) t.textContent = `≤ ${fx(p.maxTotalEth, 5)} ETH${p.maxTotalIdr != null ? ` · ${idr(p.maxTotalIdr)}` : (p.maxTotalUsd ? ` · $${p.maxTotalUsd}` : '')}`;
        });
        syncEst();
      } catch { /* locked or offline */ }
    }

    function presetRow() { return (GAS && GAS.presets || []).find((p) => p.key === PRESET) || null; }

    function syncEst() {
      const n = MSEL.size;
      const p = presetRow();
      const full = (html) => { $('mEst').innerHTML = html; $('mEst').title = html.replace(/<[^>]+>/g, ''); };
      if (!n) { full('Select wallets to see cost'); return; }
      if (!p) { full(`${n} wallet(s) · ${PRESET}`); return; }
      const per = Number(p.maxTotalEth);
      const totIdr = p.maxTotalIdr != null ? p.maxTotalIdr * n : ethIdr(per * n);
      const fiat = [
        p.maxTotalUsd ? `$${num(Number(p.maxTotalUsd) * n, 2)}` : null,
        totIdr != null ? idr(totIdr) : null,
      ].filter(Boolean).join(' · ');
      full(`<b>${n}</b> wallet(s) · <b>${esc(PRESET)}</b> · tip ${esc(p.tipGwei)} gwei`
        + ` · max <b>${fx(per, 5)}</b> ETH each, <b>${fx(per * n, 4)}</b> ETH total`
        + (fiat ? ` (${fiat})` : ''));
    }

    ['mAmt', 'mPrice', 'mGasLimit'].forEach((id) => {
      const e2 = $(id);
      if (e2) e2.addEventListener('change', refreshGas);
    });

    let BALCACHE = null; // { chain, balances: {addrLower: eth} }
    function candidateWallets() { return S.wallets.evm; }
    async function applyWallets() {
      let rows = candidateWallets();
      if (!rows.length) { MSEL.clear(); syncMintBtns(); return; }
      const fundedFilter = async (sel) => {
        const chain = $('mChain').value;
        if (!BALCACHE || BALCACHE.chain !== chain) {
          try {
            const r = await api('/wallets/balances', { kind: 'evm', chain, addresses: rows.map((w) => w.address) });
            const map = {};
            (r.balances || r).forEach((b) => { map[b.address.toLowerCase()] = Number(b.balance); });
            BALCACHE = { chain, map };
          } catch (e) { BALCACHE = null; warn('Balance check failed', e.message); }
        }
        if (BALCACHE) {
          if (!GAS) await refreshGas();
          const p = presetRow();
          const need = p ? Number(p.maxTotalEth) : Number((GAS && GAS.rows && GAS.rows[0] || {}).totalEth || 0);
          [...sel].forEach((id) => {
            const w = S.wallets.evm.find((x) => x.id === id);
            if (w && (BALCACHE.map[w.address.toLowerCase()] ?? 0) < need) sel.delete(id);
          });
        }
      };
      const box = $('mWGroup');
      box.innerHTML = '';
      box.appendChild(walletTree(MSEL, { wallets: rows, groups: S.wgroups.evm, onChange: async (sel) => { await fundedFilter(sel); syncMintBtns(); } }));
      if ($('mWFunded').checked) await fundedFilter(MSEL);
      syncMintBtns();
    }
    function syncMintBtns() {
      const n = MSEL.size;
      const total = candidateWallets().length;
      $('mWCount').textContent = $('mWFunded').checked ? `${n}/${total} funded` : `${n} selected`;
      gate('mFire', n > 0, 'Select at least one wallet');
      syncEst();
    }
    $('mWFunded').onchange = async () => {
      const box = $('mWGroup');
      box.innerHTML = '';
      box.appendChild(walletTree(MSEL, { wallets: candidateWallets(), groups: S.wgroups.evm, onChange: async (sel) => { if ($('mWFunded').checked) { const chain = $('mChain').value; if (!BALCACHE || BALCACHE.chain !== chain) { try { const r = await api('/wallets/balances', { kind: 'evm', chain, addresses: candidateWallets().map((w) => w.address) }); const map = {}; (r.balances || r).forEach((b) => { map[b.address.toLowerCase()] = Number(b.balance); }); BALCACHE = { chain, map }; } catch { BALCACHE = null; } } if (BALCACHE) { if (!GAS) await refreshGas(); const p = presetRow(); const need = p ? Number(p.maxTotalEth) : Number((GAS && GAS.rows && GAS.rows[0] || {}).totalEth || 0); [...sel].forEach((id) => { const w = S.wallets.evm.find((x) => x.id === id); if (w && (BALCACHE.map[w.address.toLowerCase()] ?? 0) < need) sel.delete(id); }); } } syncMintBtns(); } }));
      syncMintBtns();
    };
    applyWallets();
    renderProxies(); renderRpcs(); syncMethod(); syncChain();

    if (S.prefillMint) {
      const p = S.prefillMint;
      S.prefillMint = null;
      if (p.chain) $('mChain').value = p.chain;
      if (p.contract || p.slug) {
        $('mUrl').value = p.contract || `https://opensea.io/collection/${p.slug}`;
      }
      if (p.price != null) $('mPrice').value = String(p.price);
      if (p.qty) $('mAmt').value = String(p.qty);
      MSEL.clear();
      (p.walletIds || []).forEach((id) => { if (S.wallets.evm.some((w) => w.id === id)) MSEL.add(id); });
      syncMintBtns();
      ok('Prefilled', `${p.label || 'project'} · ${MSEL.size} wallet(s)`);
    }

    function looksMintable(v) {
      const s = String(v || '').trim();
      return /^0x[a-fA-F0-9]{40}$/.test(s) || /^https?:\/\/\S+\.\S+/.test(s);
    }

    let mDtv = null;
    async function doResolve(silent) {
      const raw = $('mUrl').value.trim();
      if (!looksMintable(raw)) {
        if (!silent) warn('Paste a link or a 0x contract address');
        return;
      }
      const b = $('mResolve'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        RES = await api('/resolve', { input: raw, chain: $('mChain').value });
        applyResolve(RES);
        $('mInfo').style.display = '';
        if (!silent) ok('Resolved', `${RES.platform} · ${RES.name || RES.address || ''}`);
        refreshGas();
      } catch (e) {
        $('mInfo').innerHTML = `<div class="failbox">${esc(e.message)}</div>`;
        if (!silent) err('Resolve failed', e.message);
      } finally { b.disabled = false; b.textContent = 'Resolve'; }
    }
    $('mResolve').onclick = () => doResolve(false);
    $('mUrl').addEventListener('input', () => { clearTimeout(mDtv); if (looksMintable($('mUrl').value)) mDtv = setTimeout(() => doResolve(true), 700); });
    $('mUrl').addEventListener('paste', () => setTimeout(() => { clearTimeout(mDtv); if (looksMintable($('mUrl').value)) doResolve(true); }, 30));
    $('mUrl').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { clearTimeout(mDtv); doResolve(false); } });

    function applyResolve(r) {
      if (r.chain && S.chains.some((c) => c.key === r.chain)) { $('mChain').value = r.chain; syncChain(); }
      if (r.address) $('mUrl').dataset.addr = r.address;
      STAGES = r.stages || [];
      const st = STAGES;
      const supply = r.supply ?? r.probe?.maxSupply;
      const minted = r.probe?.minted;
      $('mInfo').innerHTML = `<b>${esc(r.platform)}</b>`
        + (r.name ? ` · ${esc(r.name)}` : '')
        + (supply != null ? ` · supply ${esc(String(supply))}` : '')
        + (minted != null ? ` · minted ${esc(String(minted))}` : '')
        + (r.note ? ` · <span class="mut">${esc(r.note)}</span>` : '');

      $('mStage').innerHTML = st.length
        ? st.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}${s.price != null ? ` · ${esc(String(s.price))} ${esc(nativeSym($('mChain').value))}` : ''}</option>`).join('')
        : '<option value="">no phases found</option>';
      $('mStage').disabled = !st.length;
      const shortCa = r.address ? short(r.address, 4) : (r.collectionHash ? short(r.collectionHash, 4) : '');
      $('mPhaseH').textContent = st.length
        ? `${st.length} phase${st.length > 1 ? 's' : ''}${shortCa ? ` · nft ${shortCa}` : ''}`
        : (shortCa ? `nft ${shortCa}` : 'none');

      if (r.mintMethod === 'opensea-api') {
        $('mMethod').value = 'opensea-api'; syncMethod();
        $('mSlug').value = r.slug || '';
      } else if (r.suggested) {
        $('mMethod').value = 'abi'; syncMethod();
        $('mFn').value = r.suggested.function || '';
        $('mParams').value = (r.suggested.params || []).join('\n');
        if (r.suggested.gasLimit) $('mGasLimit').value = r.suggested.gasLimit;
        const cands = r.mintCandidates || [];
        const sel = $('mFnSel');
        if (cands.length > 1) {
          sel.innerHTML = cands.map((c) => `<option value="${esc(c.signature)}"${c.signature === r.suggested.function ? ' selected' : ''}>${esc(c.name)}(${esc(c.inputs.map((i) => i.type).join(','))})${c.payable ? ' · payable' : ''}</option>`).join('');
          sel.style.display = '';
          sel.onchange = () => {
            const c = cands.find((x) => x.signature === sel.value);
            if (!c) return;
            $('mFn').value = c.signature;
            $('mParams').value = c.inputs.map((i) => i.type === 'address' ? '{wallet}' : (i.type === 'uint256' ? '{amount}' : '')).join('\n');
          };
        } else { sel.style.display = 'none'; sel.innerHTML = ''; }
      }
      const openIdx = st.findIndex((s) => !s.startTime || s.startTime * 1000 <= Date.now());
      $('mStage').value = String(st[openIdx >= 0 ? openIdx : 0].id);
      applyStage(st[openIdx >= 0 ? openIdx : 0], r.probe);
      $('mStage').onchange = () => applyStage(st.find((x) => String(x.id) === $('mStage').value), r.probe);
    }

    function applyStage(s, probe) {
      const cap = (s && s.maxPerWallet) ?? (probe && probe.maxPerWallet);
      $('mAmtH').textContent = cap != null ? `max ${cap}` : '';
      if (cap != null) {
        $('mAmt').max = cap;
        if (Number($('mAmt').value || 1) > Number(cap)) $('mAmt').value = cap;
        if (Number($('mAmt').value) < 1) $('mAmt').value = 1;
      } else $('mAmt').removeAttribute('max');
      if (!s) { refreshGas(); return; }
      if (s.price != null) $('mPrice').value = s.price;
      if (s.startTime) {
        $('mTs').value = String(s.startTime); // epoch seconds
        syncTsHint();
      }
      refreshGas();
    }

    /* SeaDrop Snipe: auto-build hex + probe */
    function buildSdHex() {
      if ($('mMethod').value !== 'seadrop-snipe') return;
      const addr = ($('mUrl').dataset.addr) || ($('mUrl').value.match(/0x[a-fA-F0-9]{40}/) || [])[0];
      if (!addr) { $('mSdHex').value = ''; $('mSdHexHint').textContent = 'paste NFT contract first'; return; }
      const feeR = ($('mSdFee').value || '0x0000a26b00c1f0df003000390027140000faa719').toLowerCase().slice(2).padStart(64, '0');
      const qty = BigInt($('mAmt').value || 1);
      const nftPad = addr.toLowerCase().slice(2).padStart(64, '0');
      const hex = '0x161ac21f' + nftPad + feeR + '0000000000000000000000000000000000000000000000000000000000000000' + qty.toString(16).padStart(64, '0');
      $('mSdHex').value = hex;
      $('mSdHexHint').textContent = `qty ${qty} · ${hex.length / 2 - 1} bytes`;
    }
    ['mAmt', 'mSdFee'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('input', buildSdHex);
    });
    $('mUrl').addEventListener('input', () => { clearTimeout(mDtv); if ($('mMethod').value === 'seadrop-snipe' && looksMintable($('mUrl').value)) mDtv = setTimeout(buildSdHex, 700); });
    $('mUrl').addEventListener('paste', () => setTimeout(buildSdHex, 30));

    async function probeSeaDrop() {
      const addr = ($('mUrl').dataset.addr) || ($('mUrl').value.match(/0x[a-fA-F0-9]{40}/) || [])[0];
      if (!addr) return warn('Paste NFT contract address first');
      const weiToEth = (wei) => (Number(wei) / 1e18).toFixed(6);
      try {
        const r = await api('/mint/seadrop-probe', { chain: $('mChain').value, address: addr });
        $('mSdInfo').innerHTML = `<b>SeaDrop Snipe</b>`
          + (r.minted != null ? ` · minted ${esc(String(r.minted))}` : '')
          + (r.supply ? ` / ${esc(String(r.supply))}` : '')
          + (r.publicStart ? ` · opens <b>${esc(new Date(r.publicStart * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }))} WIB</b>` : '')
          + (r.publicEnd ? ` · closes <b>${esc(new Date(r.publicEnd * 1000).toLocaleString('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }))} WIB</b>` : '')
          + (r.priceWei ? ` · price <b>${esc(weiToEth(r.priceWei))} ETH</b>` : '')
          + (r.soldOut ? ' · <span class="fail">SOLD OUT</span>' : '')
          + (r.openNow ? ' · <span class="ok">OPEN NOW</span>' : '');
        if (r.publicStart) $('mSdStart').value = r.publicStart;
        if (r.publicEnd) $('mSdEnd').value = r.publicEnd;
        if (r.publicStart && !($('mTs').value)) {
          $('mTs').value = r.publicStart;
          syncTsHint();
        }
        if (r.priceWei) {
          $('mPrice').value = weiToEth(r.priceWei);
          refreshGas();
        }
        buildSdHex();
      } catch (e) { err('SeaDrop probe failed', e.message); }
    }

    $('mProbe').onclick = async () => {
      const addr = ($('mUrl').dataset.addr) || ($('mUrl').value.match(/0x[a-fA-F0-9]{40}/) || [])[0];
      if (!addr) return warn('No contract address', 'Resolve first');
      const b = $('mProbe'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        const p = await api('/probe', { chain: $('mChain').value, address: addr });
        modal(`<h3>Contract probe</h3><div class="kv">
          <div><span>Name</span><b>${esc(p.name || '—')}</b></div>
          <div><span>Price</span><b>${esc(String(p.price ?? '—'))}</b></div>
          <div><span>Max/wallet</span><b>${esc(String(p.maxPerWallet ?? '—'))}</b></div>
          <div><span>Supply</span><b>${esc(String(p.maxSupply ?? '—'))}</b></div>
          <div><span>Minted</span><b>${esc(String(p.minted ?? '—'))}</b></div>
          <div><span>Paused</span><b>${esc(String(p.paused ?? '—'))}</b></div>
          <div><span>Open</span><b>${esc(String(p.open ?? '—'))}</b></div>
        </div>${p.phases?.length ? `<div class="tw" style="margin-top:var(--s3)"><table><thead><tr><th>Phase</th><th class="rt">Price</th><th class="rt">Max</th></tr></thead><tbody>
          ${p.phases.map((ph) => `<tr><td>${esc(ph.name)}</td><td class="num">${esc(String(ph.price ?? '—'))}</td><td class="num">${esc(String(ph.maxPerWallet ?? '—'))}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
          <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
        if (p.price != null) { $('mPrice').value = p.price; refreshGas(); }
      } catch (e) { err('Probe failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Probe'; }
    };

    function selectedRpcUrls() {
      const id = $('mRpc').value;
      if (!id) return [];
      const g = (S.rpcs || []).find((x) => x.id === id);
      if (!g) return [];
      const urls = g.rpcs.filter((r) => r.healthy !== false).map((r) => r.url);
      return urls.length ? urls : g.rpcs.map((r) => r.url);
    }

    function buildCfg(mode) {
      const addr = ($('mUrl').dataset.addr) || ($('mUrl').value.match(/0x[a-fA-F0-9]{40}/) || [])[0] || (RES && RES.address);
      const method = $('mMethod').value;
      if (!addr && method !== 'opensea-api') throw new Error('no contract address');
      if (!MSEL.size) throw new Error('no wallets selected');
      const cfg = {
        name: (RES && RES.name) || (addr ? short(addr, 6) : $('mSlug').value),
        chain: $('mChain').value, address: addr, method,
        amount: Number($('mAmt').value || 1),
        pricePerNft: $('mPrice').value || '0',
        walletIds: [...MSEL],
        gasLimit: $('mGasLimit').value ? Number($('mGasLimit').value) : null,
        gasPreset: PRESET,
        maxFee: $('mMaxFee').value || null,
        priorityFee: $('mTip').value || null,
        mode, delayMs: Number($('mDelay').value || 0),
        spamCount: Number($('mSpamCount').value || 20),
        maxRetries: Number($('mRetries').value || 3),
        flashbots: $('mFlash').checked, flashbotsBundle: $('mBundle').checked,
        stopOnSoldOut: $('mSoldOut').checked,
        nonceOverride: $('mNonce').value !== '' ? Number($('mNonce').value) : null,
        proxyGroup: (method === 'opensea-api' && $('mProxy').value) || null,
        rpcs: selectedRpcUrls(),
      };
      if ($('mStage').value) cfg.stageId = $('mStage').value;
      if (method === 'abi') {
        cfg.function = $('mFn').value.trim();
        cfg.params = $('mParams').value.split('\n').map((s) => s.trim()).filter((s) => s !== '');
      } else if (method === 'hex') {
        cfg.hex = $('mHex').value.trim();
      } else if (method === 'seadrop-snipe') {
        cfg.seadropContract = $('mSdAddr').value.trim() || '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
        cfg.feeRecipient = $('mSdFee').value.trim() || '0x0000a26b00c1f0df003000390027140000faa719';
        const sdStart = $('mSdStart').value.trim();
        const sdEnd = $('mSdEnd').value.trim();
        if (sdStart) cfg.startTimestamp = Number(sdStart);
      } else {
        cfg.slug = $('mSlug').value.trim();
        cfg.fcfs = $('mFcfs').checked;
        cfg.osPath = $('mOsPath').value;
        if ($('mFcfsLead').value !== '') cfg.fcfsLeadMs = Number($('mFcfsLead').value);
      }
      const monFn = $('mMonFn').value.trim();
      const ts = parseTs();
      if (monFn) {
        cfg.monitor = { mode: 'onchain', fn: monFn, pollMs: Number($('mPoll').value || 250) };
      } else if (ts !== null && !Number.isNaN(ts)) {
        cfg.startTimestamp = Math.floor(ts / 1000);
        cfg.monitor = { mode: 'timestamp', pollMs: Number($('mPoll').value || 150) };
        cfg.fireMode = $('mFireMode').value;
        cfg.leadMs = $('mLead').value !== '' ? Number($('mLead').value) : null;
        cfg.chainSync = $('mChainSync').checked;
      } else {
        cfg.monitor = { mode: 'off' };
      }
      return cfg;
    }

    async function launch(mode) {
      let cfg;
      try { cfg = buildCfg(mode); } catch (e) { return err('Cannot start', e.message); }
      con.innerHTML = '';
      try {
        const r = await api('/mint/start', cfg);
        runId = r.runId || r.id;
        $('mRunTag').textContent = `${runId} · ${mode}`;
        $('mStop').style.display = '';
        pollRun();
        ok('Run armed', runId);
      } catch (e) { err('Start failed', e.message); }
    }

    let MODE = 'execute';
    qa('#mModeSeg button').forEach((b) => {
      b.onclick = () => {
        MODE = b.dataset.mode;
        qa('#mModeSeg button').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    $('mAdvBtn').onclick = () => {
      const p = $('mAdvPanel');
      const open = p.style.display !== 'none';
      p.style.display = open ? 'none' : '';
      $('mAdvBtn').classList.toggle('on', !open);
    };
    $('mFire').onclick = () => {
      const mode = MODE;
      const n = MSEL.size;
      const price = Number($('mPrice').value || 0) * Number($('mAmt').value || 1);
      const p = presetRow();
      const fiat = (eth) => {
        const usd = S.ethUsd ? ` $${num(eth * S.ethUsd, 2)}` : '';
        const rp = ethIdr(eth) != null ? ` · ${idr(ethIdr(eth))}` : '';
        return usd || rp ? ` <span class="mut">(${usd.trim()}${rp})</span>` : '';
      };
      confirmBox('Send real transactions?',
        `Mode <b>${esc(mode)}</b> on <b>${esc($('mChain').value)}</b> from <b>${n}</b> wallet(s).<br>`
        + `Gas preset <b>${esc(PRESET)}</b>${p ? ` — max fee ${esc(p.maxFeeGwei)} gwei, tip ${esc(p.tipGwei)} gwei` : ''}.<br>`
        + `Value per wallet: <b>${fx(price, 5)} ETH</b>${fiat(price)} · total up to <b>${fx(price * n, 5)} ETH</b>${fiat(price * n)} plus gas`
        + (p ? ` (ceiling <b>${fx(Number(p.maxTotalEth) * n, 4)} ETH</b>${fiat(Number(p.maxTotalEth) * n)} all-in)` : '') + '.<br><br>'
        + 'Broadcast transactions are irreversible. Verify the contract address and price are correct.',
        () => launch(mode), 'Broadcast');
    };
    $('mStop').onclick = async () => { if (runId) { await stopRun(runId, false); } };

    let pollIv = null;
    let gateInfo = null; // {gateMs, offsetMs} from the latest status poll → countdown
    function pollRun() {
      clearInterval(pollIv);
      pollIv = setInterval(async () => {
        if (!runId || S.page !== 'mint') return;
        try {
          const st = await api('/mint/status?runId=' + encodeURIComponent(runId));
          const c = st.counts || {};
          gateInfo = st.gateMs ? { gateMs: st.gateMs, offsetMs: st.offsetMs || 0 } : null;
          const waiting = gateInfo && ['armed', 'starting', 'running'].includes(st.status);
          $('mCounts').innerHTML = `
            <div class="tile"><div class="k">Status</div><div class="v ${['error', 'aborted'].includes(st.status) ? 'fail' : st.status === 'done' ? 'ok' : 'accent'}">${esc(st.status)}</div></div>
            ${waiting ? `<div class="tile"><div class="k">Fire in</div><div class="v accent" id="mFireIn">${esc(fmtCountdown(gateInfo.gateMs + gateInfo.offsetMs - Date.now()))}</div></div>` : ''}
            <div class="tile"><div class="k">Sent</div><div class="v">${c.sent ?? 0}/${c.total ?? 0}</div></div>
            <div class="tile"><div class="k">Confirmed</div><div class="v ok">${c.confirmed ?? 0}</div></div>
            <div class="tile"><div class="k">Failed</div><div class="v fail">${c.failed ?? 0}</div></div>`;
          if (st.results && st.results.length) {
            $('mResults').innerHTML = `<div class="tw" style="margin-top:var(--s3)"><table><thead><tr>
              <th>Wallet</th><th>Result</th><th>Detail</th><th>Tx / error</th></tr></thead><tbody>
              ${st.results.slice(-40).map((r) => `<tr>
                <td class="m">${esc(wname(r.address))}</td>
                <td><span class="tag ${r.ok || r.status === 'confirmed' ? 'ok' : 'fail'}">${esc(r.ok ? 'ok' : 'fail')}</span></td>
                <td class="sm">${(r.ok || r.status === 'confirmed') ? esc('ok') : esc(friendlyErr(r.error || r.returned))}</td>
                <td class="m sm">${r.hash ? `<a href="${explorerTx($('mChain').value, r.hash)}" target="_blank" rel="noopener">${esc(short(r.hash, 10))}</a>` : esc(r.error || r.returned || '')}</td>
              </tr>`).join('')}</tbody></table></div>`;
          }
          if (['done', 'error', 'stopped', 'aborted'].includes(st.status)) {
            $('mStop').style.display = 'none';
            clearInterval(pollIv);
          }
        } catch { /* ignore */ }
      }, 1500);
    }

    refreshGas();
    const gasIv = setInterval(() => { if (S.page === 'mint') refreshGas(); }, 20000);
    const cdIv = setInterval(() => {
      const fi = $('mFireIn');
      if (fi && gateInfo && gateInfo.gateMs) fi.textContent = fmtCountdown(gateInfo.gateMs + gateInfo.offsetMs - Date.now());
    }, 1000);

    el._cleanup = () => { clearInterval(pollIv); clearInterval(gasIv); clearInterval(cdIv); };
  },
});
