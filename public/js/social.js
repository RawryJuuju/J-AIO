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
