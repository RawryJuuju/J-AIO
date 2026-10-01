'use strict';
/* Social page — X batch actions + custom form submit engine */

page('xmod', {
  label: 'X Engagement', group: 'Identity', icon: 'x',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">X Engagement</h2>
      <p class="ps">Batch follow, like, retweet, reply, quote, tweet across accounts.</p>
      <div class="card">
        <div class="row">
          <div style="width:150px"><label class="f">Action</label>
            <select id="xAct">
              <option value="follow">Follow</option><option value="unfollow">Unfollow</option>
              <option value="like">Like</option><option value="retweet">Retweet</option>
              <option value="reply">Reply</option><option value="quote">Quote</option>
              <option value="tweet">Tweet</option>
            </select></div>
          <div style="flex:1;min-width:220px"><label class="f">Account group</label><select id="xG"></select>
            <div class="accpick" id="xAccPanel" style="display:none">
              <div class="accpick-head">
                <label class="chk"><input type="checkbox" id="xSelAll" checked> Select all</label>
                <span class="accpick-count" id="xSelCount"></span>
              </div>
              <div class="accpick-list" id="xAccList"></div>
            </div></div>

        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="flex:1"><label class="f">Min delay ms</label><input id="xMin" type="number" value="8000"></div>
          <div style="flex:1"><label class="f">Max delay ms</label><input id="xMax" type="number" value="10000"></div>
        </div>
        <div class="infobox">Delay randomized 8-10 seconds between actions.</div>
      </div>
      <div class="card">
        <div id="xTargWrap"><label class="f">Targets <span class="opt">— one per line, @handle or tweet URL</span></label>
          <textarea id="xTarg" rows="2" class="mono"></textarea></div>
        <div id="xTextWrap" style="display:none"><label class="f">Text <span class="opt">— {wallet} {handle} {name} expand per account</span></label>
          <textarea id="xText" rows="3"></textarea></div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="flex:1"></div>
          <button class="btn pri lg" id="xGo">Run</button>
          <button class="btn danger" id="xStop" style="display:none">Stop</button>
        </div>
      </div>
      <div class="card"><h3>Live <span class="sub" id="xTag"></span></h3>
        <div id="xCounts" class="tiles sm"></div>
        <div class="con" id="xCon"></div></div>`;

    let runId = null;
    const con = $('xCon');
    const off = onEvent((e) => { if (!runId || e.runId === runId) conLine(con, e); });

    function sync() {
      const a = $('xAct').value;
      $('xTextWrap').style.display = ['reply', 'quote', 'tweet'].includes(a) ? '' : 'none';
      $('xTargWrap').style.display = a === 'tweet' ? 'none' : '';
    }
    $('xAct').onchange = sync; sync();

    let xAccs = [];
    const xSelIds = () => [...$('xAccList').querySelectorAll('input[data-id]:checked')].map((c) => c.dataset.id);
    function xSyncCount() {
      const n = xSelIds().length;
      $('xSelCount').textContent = n + ' / ' + xAccs.length + ' selected';
      $('xSelAll').checked = xAccs.length > 0 && n === xAccs.length;
    }
    function xRenderAccs() {
      $('xAccPanel').style.display = $('xG').value ? '' : 'none';
      $('xAccList').innerHTML = xAccs.length
        ? xAccs.map((a) => {
            const label = a.xHandle ? '@' + a.xHandle : (a.name || a.gmail || short(a.address, 6));
            return `<label class="accpick-item${a.hasXToken ? '' : ' noauth'}">`
              + `<input type="checkbox" data-id="${a.id}" checked>`
              + `<span class="h">${esc(label)}</span>`
              + `<span class="w">${esc(short(a.address, 5) || '')}</span>`
              + (a.hasXToken ? '' : '<span class="tagx">no X</span>') + '</label>';
          }).join('')
        : '<div class="accpick-empty">No accounts in this group</div>';
      $('xAccList').querySelectorAll('input[data-id]').forEach((c) => { c.onchange = xSyncCount; });
      xSyncCount();
    }
    async function xLoadAccs() {
      const g = $('xG').value;
      if (!g) { xAccs = []; return xRenderAccs(); }
      try {
        xAccs = g === '__all__' ? (await api('/accounts')).accounts : await api('/accounts?group=' + encodeURIComponent(g));
      } catch { xAccs = []; }
      xRenderAccs();
    }
    $('xSelAll').onchange = () => {
      $('xAccList').querySelectorAll('input[data-id]').forEach((c) => { c.checked = $('xSelAll').checked; });
      xSyncCount();
    };

    (async () => {
      const gs = S.agroups && S.agroups.length ? S.agroups : await api('/accounts/groups');
      S.agroups = gs;
      const total = gs.reduce((s, g) => s + (g.count || 0), 0);
      $('xG').innerHTML = gs.length
        ? `<option value="__all__">All groups (${total})</option>` + gs.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('')
        : '<option value="">— none —</option>';
      $('xG').onchange = xLoadAccs;
      await xLoadAccs();
    })();

    $('xGo').onclick = async () => {
      const ids = xSelIds();
      const cfg = {
        action: $('xAct').value, accountIds: ids,
        targets: $('xTarg').value.split('\n').map((s) => s.trim()).filter(Boolean),
        text: $('xText').value || null,
        minDelayMs: Number($('xMin').value || 8000), maxDelayMs: Number($('xMax').value || 10000), concurrency: 1,
      };
      if (!ids.length) return warn('No accounts selected');
      if (cfg.action !== 'tweet' && !cfg.targets.length) return warn('No targets');
      con.innerHTML = '';
      try {
        const r = await api('/x/start', cfg);
        runId = r.runId; $('xTag').textContent = runId; $('xStop').style.display = '';
        poll(); ok('Running', cfg.action);
      } catch (e) { err('Failed', e.message); }
    };
    $('xStop').onclick = async () => { if (runId) { await api('/x/stop', { runId }); warn('Stopped'); } };

    let iv = null;
    function poll() {
      clearInterval(iv);
      iv = setInterval(async () => {
        if (!runId || S.page !== 'xmod') return;
        try {
          const st = await api('/x/status?runId=' + encodeURIComponent(runId));
          const c = st.counts || {};
          $('xCounts').innerHTML = `
            <div class="tile"><div class="k">Status</div><div class="v accent">${esc(st.status)}</div></div>
            <div class="tile"><div class="k">OK</div><div class="v ok">${c.ok ?? 0}</div></div>
            <div class="tile"><div class="k">Fail</div><div class="v fail">${c.fail ?? 0}</div></div>
            <div class="tile"><div class="k">Accounts</div><div class="v">${c.total ?? 0}</div></div>`;
          if (['done', 'stopped', 'error'].includes(st.status)) { $('xStop').style.display = 'none'; clearInterval(iv); }
        } catch { /* */ }
      }, 2000);
    }
    el._cleanup = () => { off(); clearInterval(iv); };
  },
});

page('submit', {
  label: 'Form Submit', group: 'Identity', icon: 'submit',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Form Submit</h2>
      <p class="ps">Submit wallets to whitelist forms per account: nonce fetch, captcha, SIWE signing, proxy rotation.</p>
      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:180px"><label class="f">Template</label><select id="sbTpl"><option value="">— new —</option></select></div>
          <button class="btn sm" id="sbSave">Save template</button>
          <button class="btn sm danger" id="sbDel">Delete</button>
        </div>
      </div>
      <div class="card"><h3>Request</h3>
        <div class="row">
          <div style="width:110px"><label class="f">Method</label><select id="sbM"><option>POST</option><option>GET</option><option>PUT</option></select></div>
          <div style="flex:1;min-width:260px"><label class="f">URL</label><input id="sbU" class="mono" placeholder="https://site.com/api/submit"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="width:140px"><label class="f">Body type</label><select id="sbBT"><option value="json">JSON</option><option value="form">form-urlencoded</option><option value="raw">Raw</option></select></div>
          <div style="flex:1"><label class="f">Page URL <span class="opt">— for captcha sitekey context</span></label><input id="sbPU" class="mono"></div>
        </div>
        <label class="f" style="margin-top:var(--s3)">Headers JSON</label>
        <textarea id="sbH" rows="3" class="mono" placeholder='{"origin":"https://site.com","referer":"https://site.com/"}'></textarea>
        <label class="f" style="margin-top:var(--s3)">Body <span class="opt">— {wallet} {handle} {gmail} {signature} {message} {nonce} {captcha} {name}</span></label>
        <textarea id="sbB" rows="5" class="mono" placeholder='{"address":"{wallet}","twitter":"{handle}"}'></textarea>
      </div>
      <div class="card"><h3>Pre-steps</h3>
        <div class="row">
          <div style="flex:1"><label class="f">Nonce URL <span class="opt">— optional</span></label><input id="sbNU" class="mono"></div>
          <div style="width:160px"><label class="f">Nonce JSON path</label><input id="sbNP" class="mono" placeholder="data.nonce"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="width:160px"><label class="f">Sign mode</label><select id="sbSM"><option value="none">None</option><option value="siwe">SIWE</option><option value="text">Plain text</option></select></div>
          <div style="flex:1" id="sbSTWrap" style="display:none"><label class="f">Text to sign</label><input id="sbST" class="mono" placeholder="I claim {wallet}"></div>
          <div style="flex:1;display:none" id="sbSWrap"><label class="f">SIWE statement</label><input id="sbSS" class="mono"></div>
          <div style="width:110px;display:none" id="sbCidWrap"><label class="f">Chain ID</label><input id="sbCid" type="number" value="1"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="width:170px"><label class="f">Captcha</label>
            <select id="sbCT"><option value="none">None</option><option value="recaptchaV2">reCAPTCHA v2</option><option value="recaptchaV3">reCAPTCHA v3</option><option value="hcaptcha">hCaptcha</option><option value="turnstile">Turnstile</option></select></div>
          <div style="width:170px"><label class="f">Provider</label>
            <select id="sbCP"><option value="2captcha">2captcha</option><option value="capmonster">CapMonster</option><option value="capsolver">CapSolver</option><option value="anticaptcha">AntiCaptcha</option></select></div>
          <div style="flex:1;display:none" id="sbSKWrap"><label class="f">Sitekey</label><input id="sbSK" class="mono"></div>
          <div style="width:150px;display:none" id="sbActWrap"><label class="f">v3 action</label><input id="sbAct" class="mono" placeholder="submit"></div>
        </div>
        <div id="sbCapNote"></div>
      </div>
      <div class="card"><h3>Run</h3>
        <div class="row">
          <div style="flex:1;min-width:180px"><label class="f">Account group</label><select id="sbG"></select></div>
          <div style="width:120px"><label class="f">Concurrency</label><input id="sbC" type="number" value="3" min="1"></div>
          <div style="width:130px"><label class="f">Min delay ms</label><input id="sbMin" type="number" value="500"></div>
          <div style="width:130px"><label class="f">Max delay ms</label><input id="sbMax" type="number" value="2000"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <div style="flex:1"><label class="f">Success regex <span class="opt">— optional, overrides HTTP status</span></label><input id="sbSR" class="mono" placeholder="success|registered"></div>
          <div style="flex:1"><label class="f">Fail regex</label><input id="sbFR" class="mono" placeholder="already|invalid"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <label class="chk"><input type="checkbox" id="sbDry" checked> Dry run (first account only, no repeat)</label>
          <div style="flex:1"></div>
          <button class="btn" id="sbTest">Test one</button>
          <button class="btn pri lg" id="sbGo">Run batch</button>
          <button class="btn danger" id="sbStop" style="display:none">Stop</button>
        </div>
      </div>
      <div class="card"><h3>Live <span class="sub" id="sbTag"></span></h3>
        <div id="sbCounts" class="tiles sm"></div>
        <div class="con" id="sbCon"></div>
        <div id="sbRes"></div></div>`;

    let runId = null; let tpls = [];
    const con = $('sbCon');
    const off = onEvent((e) => { if (!runId || e.runId === runId) conLine(con, e); });

    $('sbSM').onchange = () => {
      const v = $('sbSM').value;
      $('sbSTWrap').style.display = v === 'text' ? '' : 'none';
      $('sbSWrap').style.display = v === 'siwe' ? '' : 'none';
      $('sbCidWrap').style.display = v === 'siwe' ? '' : 'none';
    };
    $('sbCT').onchange = () => {
      const v = $('sbCT').value;
      const on = v !== 'none';
      $('sbSKWrap').style.display = on ? '' : 'none';
      $('sbActWrap').style.display = v === 'recaptchaV3' ? '' : 'none';
      $('sbCapNote').innerHTML = on ? '<div class="infobox">Needs a 2captcha key in Settings. Each solve costs credit and adds 15-60s.</div>' : '';
    };

    (async () => {
      const gs = S.agroups && S.agroups.length ? S.agroups : await api('/accounts/groups');
      S.agroups = gs;
      $('sbG').innerHTML = gs.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('') || '<option value="">— none —</option>';
      await loadTpls();
    })();

    async function loadTpls() {
      tpls = await api('/submit/templates');
      $('sbTpl').innerHTML = '<option value="">— new —</option>' + tpls.map((t) => `<option value="${t.id}">${esc(t.name || t.url)}</option>`).join('');
    }
    $('sbTpl').onchange = () => {
      const t = tpls.find((x) => x.id === $('sbTpl').value);
      if (!t) return;
      $('sbM').value = t.method || 'POST'; $('sbU').value = t.url || '';
      $('sbBT').value = t.bodyType || 'json'; $('sbPU').value = t.pageUrl || '';
      $('sbH').value = t.headers ? JSON.stringify(t.headers, null, 2) : '';
      $('sbB').value = t.bodyType === 'raw' ? (t.bodyRaw || '') : (t.body ? JSON.stringify(t.body, null, 2) : '');
      $('sbNU').value = t.nonceUrl || ''; $('sbNP').value = t.noncePath || '';
      $('sbSM').value = t.signMode || 'none'; $('sbSM').onchange();
      $('sbST').value = t.signText || ''; $('sbSS').value = t.siweStatement || ''; $('sbCid').value = t.siweChainId || 1;
      $('sbCT').value = t.captchaType || 'none'; $('sbCT').onchange();
      if ($('sbCP')) $('sbCP').value = t.captchaProvider || '2captcha';
      $('sbSK').value = t.sitekey || ''; $('sbAct').value = t.captchaAction || '';
      $('sbSR').value = t.successRegex || ''; $('sbFR').value = t.failRegex || '';
      ok('Template loaded', t.name || t.url);
    };

    function buildCfg() {
      const bt = $('sbBT').value;
      const cfg = {
        method: $('sbM').value, url: $('sbU').value.trim(), bodyType: bt,
        pageUrl: $('sbPU').value.trim() || null,
        headers: $('sbH').value.trim() ? JSON.parse($('sbH').value) : {},
        nonceUrl: $('sbNU').value.trim() || null, noncePath: $('sbNP').value.trim() || null,
        signMode: $('sbSM').value, signText: $('sbST').value || null,
        siweStatement: $('sbSS').value || null, siweChainId: Number($('sbCid').value || 1),
        captchaType: $('sbCT').value, sitekey: $('sbSK').value.trim() || null, captchaAction: $('sbAct').value.trim() || null,
        captchaProvider: $('sbCP') ? $('sbCP').value : '2captcha',
        successRegex: $('sbSR').value.trim() || null, failRegex: $('sbFR').value.trim() || null,
        accountGroup: $('sbG').value, concurrency: Number($('sbC').value || 3),
        minDelayMs: Number($('sbMin').value || 0), maxDelayMs: Number($('sbMax').value || 0),
      };
      if (!cfg.url) throw new Error('URL required');
      if (bt === 'raw') cfg.bodyRaw = $('sbB').value;
      else if ($('sbB').value.trim()) cfg.body = JSON.parse($('sbB').value);
      return cfg;
    }

    $('sbSave').onclick = async () => {
      try {
        const cfg = buildCfg();
        const name = prompt('Template name', (tpls.find((x) => x.id === $('sbTpl').value) || {}).name || new URL(cfg.url).hostname);
        if (!name) return;
        await api('/submit/templates/save', { ...cfg, id: $('sbTpl').value || undefined, name });
        await loadTpls(); ok('Template saved', name);
      } catch (e) { err('Save failed', e.message); }
    };
    $('sbDel').onclick = async () => {
      const id = $('sbTpl').value; if (!id) return;
      await api('/submit/templates/delete', { id }); await loadTpls(); warn('Deleted');
    };

    $('sbTest').onclick = async () => {
      con.innerHTML = '';
      try {
        const cfg = buildCfg();
        const accs = await api('/accounts?group=' + encodeURIComponent(cfg.accountGroup));
        if (!accs.length) return warn('No accounts');
        const r = await api('/submit/test', { ...cfg, accountId: accs[0].id });
        conLine(con, { level: r.ok ? 'ok' : 'fail', msg: `HTTP ${r.status} · ${String(r.body || '').slice(0, 200)}` });
        toast(r.ok ? 'Test passed' : 'Test failed', `HTTP ${r.status}`, r.ok ? 'ok' : 'fail');
      } catch (e) { err('Test error', e.message); }
    };

    $('sbGo').onclick = async () => {
      let cfg; try { cfg = buildCfg(); } catch (e) { return err('Bad config', e.message); }
      const gname = (S.agroups.find((g) => g.id === cfg.accountGroup) || {}).name || cfg.accountGroup;
      const n = (S.agroups.find((g) => g.id === cfg.accountGroup) || {}).count || '?';
      confirmBox('Submit for real?',
        `POSTing <b>${n}</b> account(s) from <b>${esc(gname)}</b> to<br><span class="m">${esc(cfg.url)}</span><br><br>`
        + 'Submissions cannot be recalled. Run "Test one" first if you have not.',
        async () => {
          con.innerHTML = '';
          try {
            const r = await api('/submit/start', cfg);
            runId = r.runId; $('sbTag').textContent = runId; $('sbStop').style.display = '';
            poll(); ok('Batch running');
          } catch (e) { err('Failed', e.message); }
        }, 'Submit all');
    };
    $('sbStop').onclick = async () => { if (runId) { await api('/submit/stop', { runId }); warn('Stopped'); } };

    let iv = null;
    function poll() {
      clearInterval(iv);
      iv = setInterval(async () => {
        if (!runId || S.page !== 'submit') return;
        try {
          const st = await api('/submit/status?runId=' + encodeURIComponent(runId));
          const c = st.counts || {};
          $('sbCounts').innerHTML = `
            <div class="tile"><div class="k">Status</div><div class="v accent">${esc(st.status)}</div></div>
            <div class="tile"><div class="k">OK</div><div class="v ok">${c.ok ?? 0}</div></div>
            <div class="tile"><div class="k">Fail</div><div class="v fail">${c.fail ?? 0}</div></div>
            <div class="tile"><div class="k">Total</div><div class="v">${c.total ?? 0}</div></div>`;
          if (st.results?.length) {
            $('sbRes').innerHTML = `<div class="tw" style="margin-top:var(--s3)"><table><thead><tr><th>Account</th><th>Wallet</th><th>HTTP</th><th>Response</th></tr></thead><tbody>
              ${st.results.slice(-50).map((r) => `<tr><td>${esc(r.account || '')}</td><td class="m sm">${esc(short(r.wallet, 6))}</td>
                <td><span class="tag ${r.ok ? 'ok' : 'fail'}">${esc(String(r.status || ''))}</span></td>
                <td class="sm mut">${esc(String(r.body || r.error || '').slice(0, 90))}</td></tr>`).join('')}
              </tbody></table></div>`;
          }
          if (['done', 'stopped', 'error'].includes(st.status)) { $('sbStop').style.display = 'none'; clearInterval(iv); }
        } catch { /* */ }
      }, 2000);
    }
    el._cleanup = () => { off(); clearInterval(iv); };
  },
});
