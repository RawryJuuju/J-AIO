'use strict';
/* Accounts — group cards, searchable table, bulk connect / check / unlink, proxies */

let AG = '';                 // active group id ('' = all)
let AQ = '';                 // search query
const ASEL = new Set();      // selected account ids

page('accounts', {
  label: 'Accounts', group: 'Identity', icon: 'accounts',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Accounts</h2>
      <p class="ps">One account = wallet + Google + X token + Discord token + proxy. Tokens are encrypted at rest.</p>

      <div class="gcards" id="aCards"></div>

      <div class="wtb">
        <div class="ctx">
          <span class="gi">${icon('accounts')}</span>
          <b id="aCtxName">All</b>
          <span class="cnt" id="aCtxCount"></span>
        </div>
        <div class="sp"></div>
        <div class="wsearch">${icon('search')}<input id="aQ" placeholder="Search name, handle, email" autocomplete="off"></div>
        <button class="btn ico" id="aTools" title="Account tools" aria-label="Account tools">${icon('tools')}</button>
        <button class="btn" id="aProxy">${icon('proxy')} Assign Proxies</button>
        <button class="btn pri" id="aAdd" title="Add account">${icon('plus')} Add Account</button>
      </div>

      <div class="card">
        <h3>${icon('accounts')} <span id="aHdrName">ALL</span> <span class="sub" id="aCount"></span>
          <div style="margin-left:auto" class="row">
            <button class="btn xs" id="aTestAll">${icon('check')} Test All Auth</button>
          </div>
        </h3>
        <div class="wtable-wrap" id="aTable"></div>
        <div class="selbar hide" id="aSelBar">
          <span class="n" id="aSelCount">0 selected</span>
          <div class="sp"></div>
          <button class="btn" id="aBulkCheck">${icon('check')} Bulk Check</button>
          <button class="btn" id="aBulkConn">${icon('link')} Bulk Connect</button>
          <button class="btn warnb" id="aBulkDisc">${icon('unlink')} Bulk Remove</button>
          <button class="btn danger" id="aDel">${icon('trash')} Delete</button>
          <span class="vsep"></span>
          <button class="iact x" id="aSelClear" title="Clear selection">${icon('close')}</button>
        </div>
      </div>`;

    /* ---------- data ---------- */
    function groups() { return S.agroups || []; }
    function all() { return S.accounts || []; }
    function inGroup() { return all().filter((a) => !AG || a.group === AG); }
    function visible() {
      const q = AQ.trim().toLowerCase();
      if (!q) return inGroup();
      return inGroup().filter((a) => [a.name, a.xHandle, a.discordUsername, a.gmail, a.address]
        .some((v) => v && String(v).toLowerCase().includes(q)));
    }
    function sel() { return visible().filter((a) => ASEL.has(a.id)); }

    async function reload() {
      const r = await api('/accounts');
      S.accounts = r.accounts; S.agroups = r.groups;
      // drop selections that no longer exist
      const live = new Set(S.accounts.map((a) => a.id));
      [...ASEL].forEach((id) => { if (!live.has(id)) ASEL.delete(id); });
      if (AG && !S.agroups.some((g) => g.id === AG)) AG = '';
      renderCards(); renderTable();
    }

    /* ---------- group cards ---------- */
    function renderCards() {
      const card = (id, name, count) => `<div class="gcard${AG === id ? ' on' : ''}" data-g="${esc(id)}" tabindex="0" role="button" aria-pressed="${AG === id}">
        <div class="gn">${esc(name)}</div>
        <div class="gm">${icon('accounts')}<b>${count}</b> ${count === 1 ? 'Account' : 'Accounts'}</div>
        ${id ? `<div class="ga">
          <button data-act="gren" data-g="${esc(id)}" title="Rename group" aria-label="Rename group">${icon('edit')}</button>
          <button class="d" data-act="gdel" data-g="${esc(id)}" title="Delete group" aria-label="Delete group">${icon('trash')}</button>
        </div>` : ''}
      </div>`;

      $('aCards').innerHTML = card('', 'ALL', all().length)
        + groups().map((g) => card(g.id, g.name, g.count)).join('')
        + `<div class="gcard add" id="aNewGrp" tabindex="0" role="button">${icon('plus')} New Group</div>`;

      qa('#aCards .gcard').forEach((c) => {
        if (c.id === 'aNewGrp') {
          c.onclick = newGroup;
          c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newGroup(); } };
          return;
        }
        const pick = () => { AG = c.dataset.g; renderCards(); renderTable(); };
        c.onclick = (e) => {
          const a = e.target.closest('[data-act]');
          if (a) { e.stopPropagation(); return a.dataset.act === 'gren' ? renameGroup(a.dataset.g) : delGroup(a.dataset.g); }
          pick();
        };
        c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      });
    }

    /* ---------- table ---------- */
    function chainChips(a) {
      const c = (label, on) => `<span class="chip ${on ? 'on' : 'off'}" title="${label} ${on ? 'linked' : 'not linked'}">${label}</span>`;
      return `<span class="chips">${c('EVM', !!a.address)}<span class="s">/</span>${c('SOL', !!a.solAddress)}<span class="s">/</span>${c('BTC', !!a.btcAddress)}</span>`;
    }
    /* Probe state -> colour + label. Green only for a verified-live account.
       Red covers suspended / locked / dead token. Amber = probed but inconclusive
       (rate limit, network) so a temporary blip is not read as a dead account. */
    const STATE_META = {
      ok: { cls: 'ok', dot: 'ok', tag: '', tip: 'Live' },
      suspended: { cls: 'bad', dot: 'fail', tag: 'SUSPENDED', tip: 'Account suspended' },
      locked: { cls: 'bad', dot: 'fail', tag: 'LOCKED', tip: 'Account locked, needs manual unlock' },
      bad_token: { cls: 'bad', dot: 'fail', tag: 'BAD TOKEN', tip: 'Token invalid or expired' },
      rate_limit: { cls: 'warn', dot: 'warn', tag: 'RATE', tip: 'Rate limited, re-test later' },
      error: { cls: 'warn', dot: 'warn', tag: 'ERR', tip: 'Probe failed' },
      no_token: { cls: 'idle', dot: '', tag: '', tip: 'No token' },
    };
    function stOf(s) {
      if (!s) return null;
      return s.state || (s.ok ? 'ok' : 'error');
    }
    /* handle + probe state cell. `s` is the raw status object for that service. */
    function credCell(handle, hasToken, s, extra) {
      if (!handle && !hasToken) return '<span class="cred"><span class="none">—</span></span>';
      const state = stOf(s);
      const m = STATE_META[state] || STATE_META.no_token;
      const tip = state
        ? `${m.tip}${s && s.error ? ': ' + s.error : ''}${s && s.at ? ' · ' + new Date(s.at).toLocaleString() : ''}`
        : (hasToken ? 'Token stored, not tested' : 'No token');
      const cls = state ? m.cls : 'idle';
      const shown = esc(handle || '(token only)');
      const identity = /^@[A-Za-z0-9_]+$/.test(handle || '') ? `<a href="https://x.com/${encodeURIComponent(handle.slice(1))}" target="_blank" rel="noopener">${shown}</a>` : shown;
      return `<span class="cred ${cls}" title="${esc(tip)}">
        <span class="h">${identity}</span>
        ${hasToken ? `<span class="dot ${m.dot}"></span>` : ''}
        ${m.tag ? `<span class="stag ${cls}">${m.tag}</span>` : ''}
        ${extra ? `<span class="xmeta">${esc(extra)}</span>` : ''}
      </span>`;
    }
    /* follower count next to a live X handle, compacted (12.4k) */
    function fmtK(n) {
      if (n == null) return '';
      return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n);
    }
    function pname(id) {
      if (!id) return null;
      for (const g of (S.proxies || [])) {
        const p = (g.proxies || []).find((x) => x.id === id);
        if (p) return `${p.host}:${p.port}`;
      }
      return null;
    }

    function renderTable() {
      const rows = visible();
      const gname = AG ? ((groups().find((g) => g.id === AG) || {}).name || '—') : 'ALL';
      $('aCtxName').textContent = gname;
      $('aHdrName').textContent = gname;
      $('aCtxCount').textContent = `· ${rows.length}${AQ ? ` of ${inGroup().length}` : ''} ${rows.length === 1 ? 'Account' : 'Accounts'}`;
      $('aCount').textContent = `${rows.length} shown`;
      setSelCount();
      syncBtns();

      if (!rows.length) {
        $('aTable').innerHTML = emptyState(AQ
          ? { icon: 'search', title: 'No matches', desc: `Nothing matches "${AQ}".` }
          : {
            icon: 'accounts',
            title: groups().length ? 'No accounts here' : 'No accounts yet',
            desc: groups().length
              ? 'Add an account, or create them from a wallet group.'
              : 'Create a group first, then add accounts or derive them from a wallet group.',
            action: groups().length
              ? { label: 'Add account', onclick: "document.getElementById('aAdd').click()" }
              : { label: 'New group', onclick: "document.getElementById('aNewGrp').click()" },
          });
        return;
      }

      $('aTable').innerHTML = `<table><thead><tr>
        <th style="width:34px"><input type="checkbox" id="aSelHdr" aria-label="Select all accounts in view" title="Select all in view"></th>
        <th style="width:15%">Name</th>
        <th style="width:17%">Wallet</th>
        <th style="width:19%">Google</th>
        <th style="width:17%">X</th>
        <th style="width:15%">Discord</th>
        <th style="width:84px"><span class="sr">Actions</span></th></tr></thead><tbody>
        ${rows.map((a) => {
    const px = pname(a.proxyId);
    return `<tr class="wrow">
          <td><input type="checkbox" data-id="${a.id}" ${ASEL.has(a.id) ? 'checked' : ''} aria-label="Select ${esc(a.name)}"></td>
          <td class="nm">${esc(a.name)}${px ? `<div class="sm mut" title="Proxy ${esc(px)}">${esc(px)}</div>` : ''}</td>
          <td>${chainChips(a)}</td>
          <td>${credCell(a.gmail, a.hasGmailPass, (a.status || {}).gmail)}</td>
          <td>${credCell(a.xHandle ? '@' + a.xHandle : '', a.hasXToken, (a.status || {}).x, ((a.status || {}).x && (a.status || {}).x.ok && (a.status || {}).x.followers != null) ? fmtK((a.status || {}).x.followers) + ' followers' : '')}</td>
          <td>${credCell(a.discordUsername, a.hasDiscordToken, (a.status || {}).discord)}</td>
          <td class="rt"><div class="racts">
            <button class="iact" data-act="probe" data-id="${a.id}" title="Re-test this account's auth" aria-label="Re-test auth">${icon('refresh')}</button>
            <button class="iact" data-act="edit" data-id="${a.id}" title="Edit" aria-label="Edit">${icon('edit')}</button>
            <button class="iact d" data-act="del" data-id="${a.id}" data-n="${esc(a.name)}" title="Remove" aria-label="Remove">${icon('trash')}</button>
          </div></td>
        </tr>`;
  }).join('')}</tbody></table>`;

      $('aTable').onclick = (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const { act, id } = b.dataset;
        if (act === 'edit') return editAcc(all().find((x) => x.id === id));
        if (act === 'del') return delOne(id, b.dataset.n);
        if (act === 'probe') return probeOne(id, b);
      };

      qa('#aTable input[type=checkbox]').forEach((c) => {
        if (!c.dataset.id) return;
        c.onchange = () => {
          if (c.checked) ASEL.add(c.dataset.id); else ASEL.delete(c.dataset.id);
          setSelCount(); syncSelHdr();
        };
      });
      const hdr = $('aSelHdr');
      if (hdr) hdr.onchange = () => { rows.forEach((a) => { if (hdr.checked) ASEL.add(a.id); else ASEL.delete(a.id); }); renderTable(); };
      syncSelHdr();

      function syncSelHdr() {
        const h = $('aSelHdr');
        if (!h) return;
        const n = rows.filter((a) => ASEL.has(a.id)).length;
        h.checked = n > 0 && n === rows.length;
        h.indeterminate = n > 0 && n < rows.length;
      }
    }

    function setSelCount() {
      const n = sel().length;
      $('aSelBar').classList.toggle('hide', n === 0);
      $('aSelCount').textContent = `${n} selected`;
      // count on the destructive buttons so the blast radius is visible before the click
      $('aBulkDisc').innerHTML = `${icon('unlink')} Bulk Remove${n ? ` (${n})` : ''}`;
      $('aDel').innerHTML = `${icon('trash')} Delete${n ? ` (${n})` : ''}`;
      const m = document.querySelector('main');
      if (m) m.classList.toggle('has-selbar', n > 0);
    }

    function syncBtns() {
      const hasG = groups().length > 0;
      const n = inGroup().length;
      gate('aAdd', hasG, 'Create a group first');
      gate('aTools', hasG, 'Create a group first');
      gate('aProxy', n > 0 && (S.proxies || []).length > 0, (S.proxies || []).length ? 'No accounts in view' : 'Add proxies on the Proxies page first');
      gate('aTestAll', n > 0, 'No accounts to test');
    }

    $('aSelClear').onclick = () => { ASEL.clear(); renderTable(); };
    $('aQ').oninput = () => { AQ = $('aQ').value; renderTable(); };

    /* ---------- groups ---------- */
    function newGroup() {
      modal(`<h3>New account group</h3>
        <label class="f">Name</label><input id="ngN" placeholder="main-105">
        <label class="f" style="margin-top:var(--s3)">Derive accounts from wallet group <span class="opt">— optional</span></label>
        <select id="ngW"><option value="">— none —</option><option value="__all__">All wallets (${S.wgroups.evm.reduce((n, g) => n + (g.count || 0), 0)})</option>${S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('')}</select>
        <div class="infobox">One account per wallet, named after the wallet.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="agNgGo">Create</button></div>`);
      $('ngN').focus();
      $('agNgGo').onclick = async () => {
        try {
          const g = await api('/accounts/groups/add', { name: $('ngN').value.trim() || 'group', walletGroup: $('ngW').value || null });
          closeModal(); AG = g.id; await reload(); ok('Group created');
        } catch (e) { err('Failed', e.message); }
      };
    }
    function renameGroup(id) {
      const g = groups().find((x) => x.id === id);
      if (!g) return;
      modal(`<h3>Rename group</h3><label class="f">Name</label><input id="agRgN" value="${esc(g.name)}">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="agRgGo">Save</button></div>`);
      $('agRgN').focus();
      $('agRgGo').onclick = async () => {
        try { await api('/accounts/groups/rename', { id, name: $('agRgN').value }); closeModal(); await reload(); ok('Renamed'); }
        catch (e) { err('Failed', e.message); }
      };
    }
    function delGroup(id) {
      const g = groups().find((x) => x.id === id);
      if (!g) return;
      confirmTyped('Delete account group?',
        `<b>${esc(g.name)}</b> and its <b>${g.count}</b> account(s) are removed, along with every stored Google password, X token and Discord token in them. Wallets are not touched. This cannot be undone.`,
        'delete', async () => {
          try { await api('/accounts/groups/remove', { id }); if (AG === id) AG = ''; await reload(); warn('Group deleted'); }
          catch (e) { err('Failed', e.message); }
        }, 'Delete group');
    }

    /* ---------- row ops ---------- */
    function delOne(id, name) {
      confirmBox('Remove account?', `Stored credentials for <b>${esc(name)}</b> are deleted. The wallet itself stays.`, async () => {
        try { await api('/accounts/remove', { id }); ASEL.delete(id); await reload(); warn('Removed'); }
        catch (e) { err('Failed', e.message); }
      }, 'Remove');
    }

    /* Turn a probe result map ({x:{...},discord:{...}}) into one toast.
       Severity: any suspended/locked/bad_token -> error, any warn -> warn, else ok. */
    function reportProbe(probe) {
      const LBL = { x: 'X', discord: 'Discord', gmail: 'Gmail' };
      const keys = Object.keys(probe || {});
      if (!keys.length) return ok('Saved');
      let worst = 'ok';
      const bits = keys.map((k) => {
        const r = probe[k] || {};
        const state = r.state || (r.ok ? 'ok' : 'error');
        const m = STATE_META[state] || STATE_META.error;
        if (m.cls === 'bad') worst = 'bad';
        else if (m.cls === 'warn' && worst !== 'bad') worst = 'warn';
        const who = r.handle ? '@' + r.handle : r.username || '';
        return `${LBL[k] || k}: ${state === 'ok' ? (who || 'live') : (r.error || state)}`;
      });
      const kind = worst === 'bad' ? 'fail' : worst === 'warn' ? 'warn' : 'ok';
      toast(worst === 'ok' ? 'Verified' : 'Check failed', bits.join(' · '), kind);
    }

    async function probeOne(id, btn) {
      btn.innerHTML = '<span class="spin"></span>';
      try {
        const r = await api('/accounts/test', { ids: [id], which: 'all' });
        const row = (Array.isArray(r) ? r[0] : r) || {};
        const probe = {};
        ['x', 'discord', 'gmail'].forEach((k) => { if (row[k]) probe[k] = row[k]; });
        await reload();
        if (Object.keys(probe).length) reportProbe(probe);
        else toast('Auth probe', 'nothing to test', 'warn');
      } catch (e) { err('Probe failed', e.message); btn.innerHTML = icon('refresh'); }
    }

    function editAcc(a) {
      if (!a) return;
      const wopt = (kind, cur) => S.wallets[kind].map((w) => `<option value="${w.id}"${w.id === cur ? ' selected' : ''}>${esc(w.name)} ${esc(short(w.address, 4))}</option>`).join('');
      modal(`<h3>Edit ${esc(a.name)}</h3>
        <div class="grid g2">
          <div><label class="f">Name</label><input id="eN" value="${esc(a.name)}"></div>
          <div><label class="f">EVM wallet</label><select id="eW"><option value="">— none —</option>${wopt('evm', a.walletId)}</select></div>
        </div>
        <div class="grid g2" style="margin-top:var(--s3)">
          <div><label class="f">Google account</label><input id="eG" class="mono" value="${esc(a.gmail || '')}" placeholder="name@gmail.com"></div>
          <div><label class="f">Google app password</label><input id="eGP" type="password" autocomplete="off" placeholder="${a.hasGmailPass ? '•••• stored' : ''}"></div>
        </div>
        <div class="grid g2" style="margin-top:var(--s3)">
          <div><label class="f">X handle</label><input id="eXH" class="mono" value="${esc(a.xHandle || '')}" placeholder="without @"></div>
          <div><label class="f">X auth_token</label><input id="eXT" type="password" autocomplete="off" placeholder="${a.hasXToken ? '•••• stored' : ''}"></div>
        </div>
        <div class="grid g2" style="margin-top:var(--s3)">
          <div><label class="f">Discord username</label><input id="eDU" class="mono" value="${esc(a.discordUsername || '')}"></div>
          <div><label class="f">Discord token</label><input id="eDT" type="password" autocomplete="off" placeholder="${a.hasDiscordToken ? '•••• stored' : ''}"></div>
        </div>
        <label class="f" style="margin-top:var(--s3)">Proxy</label>
        <select id="eP"><option value="">— direct —</option>
          ${(S.proxies || []).flatMap((g) => (g.proxies || []).map((p) => `<option value="${p.id}"${p.id === a.proxyId ? ' selected' : ''}>${esc(g.name)} · ${esc(p.host)}:${esc(p.port)}</option>`)).join('')}</select>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="agEGo">Save</button></div>`);
      $('agEGo').onclick = async () => {
        const f = {
          name: $('eN').value.trim() || a.name,
          walletId: $('eW').value || null,
          gmail: $('eG').value.trim(),
          xHandle: $('eXH').value.trim().replace(/^@/, ''),
          discordUsername: $('eDU').value.trim(),
          proxyId: $('eP').value || null,
        };
        const w = S.wallets.evm.find((x) => x.id === $('eW').value);
        f.address = w ? w.address : null;
        if ($('eGP').value) f.gmailAppPass = $('eGP').value;
        if ($('eXT').value) f.xToken = $('eXT').value.trim();
        if ($('eDT').value) f.discordToken = $('eDT').value.trim();
        const willProbe = !!(f.xToken || f.discordToken || f.gmailAppPass);
        const btn = $('agEGo');
        if (willProbe) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Verifying'; }
        try {
          const r = await api('/accounts/update', { id: a.id, fields: f });
          closeModal(); await reload();
          if (r && r.probe) reportProbe(r.probe);
          else ok('Saved');
        } catch (e) { err('Failed', e.message); if (willProbe) { btn.disabled = false; btn.textContent = 'Save'; } }
      };
    }

    /* ---------- toolbar ---------- */
    $('aAdd').onclick = async () => {
      const g = AG || (groups()[0] || {}).id;
      if (!g) return warn('Create a group first');
      try { const a = await api('/accounts/add', { groupId: g, fields: {} }); await reload(); editAcc(all().find((x) => x.id === a.id)); }
      catch (e) { err('Failed', e.message); }
    };

    $('aTools').onclick = () => {
      modal(`<h3>Account tools</h3>
        <div class="row" style="flex-direction:column;align-items:stretch;gap:var(--s2)">
          <button class="btn" id="atFromW">${icon('wallets')} Create accounts from a wallet group</button>
          <button class="btn" id="atExport">${icon('submit')} Export handles CSV (no secrets)</button>
        </div>
        <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`);
      $('atFromW').onclick = () => {
        const g = AG || (groups()[0] || {}).id;
        modal(`<h3>Create accounts from wallet group</h3>
          <label class="f">Target account group</label>
          <select id="fwG">${groups().map((x) => `<option value="${x.id}"${x.id === g ? ' selected' : ''}>${esc(x.name)} (${x.count})</option>`).join('')}</select>
          <label class="f" style="margin-top:var(--s3)">EVM wallet group</label>
          <select id="agFwW"><option value="__all__">All wallets (${S.wgroups.evm.reduce((n, g) => n + (g.count || 0), 0)})</option>${S.wgroups.evm.map((x) => `<option value="${x.id}">${esc(x.name)} (${x.count})</option>`).join('')}</select>
          <div class="infobox">One account per wallet, named after the wallet. Wallets already linked are skipped.</div>
          <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="agFwGo">Create</button></div>`);
        $('agFwGo').onclick = async () => {
          try {
            const r = await api('/accounts/from-wallets', { groupId: $('fwG').value, walletGroup: $('agFwW').value });
            closeModal(); AG = $('fwG').value; await reload(); ok('Created', `${r.added} new account(s)`);
          } catch (e) { err('Failed', e.message); }
        };
      };
      $('atExport').onclick = () => {
        const rows = visible();
        const csv = 'name,address,gmail,x_handle,discord\n'
          + rows.map((a) => [a.name, a.address || '', a.gmail || '', a.xHandle || '', a.discordUsername || ''].join(',')).join('\n');
        dl(`accounts-${Date.now()}.csv`, csv);
        closeModal(); ok('Exported', `${rows.length} row(s), no secrets`);
      };
    };

    $('aProxy').onclick = () => {
      const rows = visible();
      const groupsWithProxies = (S.proxies || []).filter((p) => p.count > 0);
      if (!groupsWithProxies.length) return warn('No proxies', 'Add a proxy group first');
      modal(`<h3>Assign proxies round-robin</h3>
        <label class="f">Proxy group</label>
        <select id="apG">${groupsWithProxies.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.count})</option>`).join('')}</select>
        <div class="infobox">Applies to every account in <b>${esc(AG ? (groups().find((g) => g.id === AG) || {}).name : 'ALL')}</b> (${rows.length}), overwriting existing proxy bindings.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="apGo">Assign</button></div>`);
      $('apGo').onclick = async () => {
        const targets = AG ? [AG] : groups().map((g) => g.id);
        try {
          let n = 0;
          for (const gid of targets) {
            const r = await api('/accounts/assign-proxies', { groupId: gid, proxyGroupId: $('apG').value });
            n += r.assigned || 0;
          }
          closeModal(); await reload(); ok('Assigned', `${n} account(s)`);
        } catch (e) { err('Failed', e.message); }
      };
    };

    /* ---------- auth probes ---------- */
    async function runProbe(ids, which, label, btn) {
      const old = btn.innerHTML;
      btn.innerHTML = '<span class="spin"></span>';
      gate(btn, false, 'Running');
      try {
        const r = await api('/accounts/test', { ids, which });
        const list = Array.isArray(r) ? r : [r];
        const good = list.filter((x) => x.ok).length;
        toast(label, `${good}/${list.length} valid`, good === list.length ? 'ok' : 'warn');
        const bad = list.filter((x) => !x.ok);
        if (bad.length) {
          const reason = (row) => ['x', 'discord', 'gmail'].filter((k) => row[k] && !row[k].ok)
            .map((k) => `${k}: ${row[k].error || 'invalid'}`).join(' · ') || row.error || 'invalid';
          modal(`<h3>${esc(label)} — ${bad.length} failing</h3>
            <div class="tw"><table><thead><tr><th>Account</th><th>Error</th></tr></thead><tbody>
            ${bad.map((b) => `<tr><td>${esc(b.name || b.id)}</td><td class="sm fail">${esc(reason(b))}</td></tr>`).join('')}
            </tbody></table></div>
            <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
        }
        await reload();
      } catch (e) { err('Test failed', e.message); }
      finally { btn.innerHTML = old; gate(btn, true); syncBtns(); }
    }

    $('aTestAll').onclick = () => {
      const ids = inGroup().map((a) => a.id);
      if (!ids.length) return warn('Nothing to test');
      runProbe(ids, 'all', 'Auth test', $('aTestAll'));
    };
    $('aBulkCheck').onclick = () => {
      const ids = sel().map((a) => a.id);
      if (!ids.length) return warn('Select accounts first');
      runProbe(ids, 'all', 'Bulk check', $('aBulkCheck'));
    };

    /* ---------- bulk connect ---------- */
    $('aBulkConn').onclick = () => {
      const rows = sel();
      if (!rows.length) return warn('Select accounts first');
      modal(`<h3>Bulk Connect · ${rows.length} account${rows.length === 1 ? '' : 's'}</h3>
        <label class="f">Column order</label>
        <select id="bcOrder">
          <option value="xToken">X auth_token</option>
          <option value="xHandle,xToken">X handle, X auth_token</option>
          <option value="discordToken">Discord token</option>
          <option value="gmail,gmailAppPass">Google, app password</option>
          <option value="gmail,xToken,discordToken">Google, X token, Discord token</option>
          <option value="gmail,gmailAppPass,xHandle,xToken,discordToken">Google, app password, X handle, X token, Discord token</option>
        </select>
        <label class="f" style="margin-top:var(--s3)">Paste <span class="opt">— one line per account, comma / tab / pipe separated</span></label>
        <textarea id="bcT" rows="10" class="mono" placeholder="handle,abc123authtoken"></textarea>
        <div class="infobox">Lines map onto the <b>${rows.length}</b> selected row(s) top to bottom, in the order shown in the table. Extra lines are ignored, blank cells leave the stored value alone. Pasted tokens are verified right away: username auto-detected, live rows go green, suspended / locked / dead go red.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="bcGo">Apply</button></div>`);
      $('bcGo').onclick = async () => {
        const text = $('bcT').value;
        if (!text.trim()) return warn('Nothing pasted');
        const btn = $('bcGo');
        btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Verifying';
        try {
          const r = await api('/accounts/bulk-connect', { ids: rows.map((a) => a.id), text, order: $('bcOrder').value.split(',') });
          closeModal(); await reload();
          const res = r.results || [];
          if (!res.length) return ok('Connected', `${r.updated} row(s)`);
          // Roll the per-row verdicts into one line: live / suspended / locked / bad / warn.
          const tally = { ok: 0, suspended: 0, locked: 0, bad_token: 0, other: 0 };
          res.forEach((row) => {
            const states = ['x', 'discord', 'gmail'].filter((k) => row[k]).map((k) => row[k].state || (row[k].ok ? 'ok' : 'error'));
            const s = states.find((x) => x === 'suspended') || states.find((x) => x === 'locked')
              || states.find((x) => x === 'bad_token') || (states.every((x) => x === 'ok') ? 'ok' : 'other');
            tally[s in tally ? s : 'other']++;
          });
          const bits = [`${tally.ok} live`];
          if (tally.suspended) bits.push(`${tally.suspended} suspended`);
          if (tally.locked) bits.push(`${tally.locked} locked`);
          if (tally.bad_token) bits.push(`${tally.bad_token} bad token`);
          if (tally.other) bits.push(`${tally.other} unverified`);
          const bad = tally.suspended + tally.locked + tally.bad_token;
          toast(`Connected · ${r.updated} row(s)`, bits.join(' · '), bad ? 'fail' : tally.other ? 'warn' : 'ok');
        } catch (e) { err('Failed', e.message); btn.disabled = false; btn.textContent = 'Apply'; }
      };
    };

    /* ---------- bulk unlink / delete ---------- */
    $('aBulkDisc').onclick = () => {
      const rows = sel();
      if (!rows.length) return warn('Select accounts first');
      modal(`<h3>Remove credentials · ${rows.length} account${rows.length === 1 ? '' : 's'}</h3>
        <label class="f">What to clear</label>
        <select id="bdW">
          <option value="all">Everything (Google + X + Discord)</option>
          <option value="x">X token only</option>
          <option value="discord">Discord token only</option>
          <option value="gmail">Google only</option>
        </select>
        <div class="failbox">Stored secrets are erased from the vault. Account rows, names and wallet links stay. Not reversible.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="bdGo">Clear credentials</button></div>`);
      $('bdGo').onclick = async () => {
        try {
          const r = await api('/accounts/bulk-disconnect', { ids: rows.map((a) => a.id), which: $('bdW').value });
          closeModal(); await reload(); warn('Cleared', `${r.cleared} account(s)`);
        } catch (e) { err('Failed', e.message); }
      };
    };

    $('aDel').onclick = () => {
      const rows = sel();
      if (!rows.length) return warn('Select accounts first');
      confirmTyped('Delete accounts?',
        `<b>${rows.length}</b> account row(s) and every credential stored on them are removed. Wallets and private keys are not touched. This cannot be undone.`,
        'delete', async () => {
          try {
            const r = await api('/accounts/bulk-remove', { ids: rows.map((a) => a.id) });
            ASEL.clear(); await reload(); warn('Deleted', `${r.removed} account(s)`);
          } catch (e) { err('Failed', e.message); }
        }, `Delete ${rows.length}`);
    };

    reload();
  },
});
