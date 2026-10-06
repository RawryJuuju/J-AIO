'use strict';
/* Wallets & Fund Manager — EVM / SOL / BTC */

let WK = 'evm';                    // active kind
let WG = '';                       // active group id ('' = all)
let WQ = '';                       // search query
const WSEL = new Set();            // selected wallet ids
const WBAL = {};                   // `${kind}:${address}` -> { v, sym, token }

function wlist() { return S.wallets[WK] || []; }
function wgroups() { return S.wgroups[WK] || []; }
function wsym() {
  if (WK !== 'evm') return WK.toUpperCase();
  const sel = $('wChain') ? $('wChain').value : 'ethereum';
  return (S.chains.find((c) => c.key === sel) || {}).symbol || 'ETH';
}
function wbal(addr) { return WBAL[WK + ':' + addr]; }
function groupTotal(gid) {
  const rows = wlist().filter((w) => !gid || w.groupId === gid);
  let t = 0, seen = 0;
  rows.forEach((w) => { const b = wbal(w.address); if (b) { t += b.v; seen++; } });
  return seen ? t : null;
}
function explorerAddr(addr) {
  if (WK === 'sol') return `https://solscan.io/account/${addr}`;
  if (WK === 'btc') return `https://mempool.space/address/${addr}`;
  const c = S.chains.find((x) => x.key === ($('wChain') ? $('wChain').value : 'ethereum'));
  return c && c.explorer ? `${c.explorer}/address/${addr}` : null;
}

page('wallets', {
  label: 'Wallets', group: 'Wallets', icon: 'wallets',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Wallets & Fund Manager</h2>
      <p class="ps">Keys are encrypted at rest with your master password. Never leave this machine.</p>
      <div class="tabs" id="wTabs">
        <button data-k="evm" class="on">EVM</button>
        <button data-k="sol">Solana</button>
        <button data-k="btc">Bitcoin</button>
      </div>

      <div class="gcards" id="wCards"></div>

      <div class="wtb">
        <div class="ctx">
          <span class="gi">${icon('wallets')}</span>
          <b id="wCtxName">All wallets</b>
          <span class="cnt" id="wCtxCount"></span>
        </div>
        <div class="sp"></div>
        <div class="wsearch">${icon('search')}<input id="wQ" placeholder="Search name or address" autocomplete="off"></div>
        <select id="wChain" title="Chain">${chainOpts('ethereum')}</select>
        <button class="btn ico" id="wTools" title="Wallet tools" aria-label="Wallet tools">${icon('tools')}</button>
        <button class="btn" id="wFunds">${icon('funds')} Manage Funds</button>
        <button class="btn pri" id="wAdd" title="Add wallets">${icon('plus')} Add</button>
      </div>

      <div class="card">
        <h3>${icon('wallets')} Wallets <span class="sub" id="wCount"></span>
          <div style="margin-left:auto" class="row">
            <button class="btn xs" id="wBal">${icon('refresh')} Balances</button>
          </div>
        </h3>
        <div class="wtable-wrap" id="wTable"></div>
        <div class="selbar hide" id="wSelBar">
          <span class="n" id="wSelCount">0 selected</span>
          <div class="sp"></div>
          <button class="btn" id="wRename">${icon('edit')} Bulk Rename</button>
          <button class="btn" id="wCopyAddr">${icon('copy')} Copy Addresses</button>
          <button class="btn warnb" id="wCopyKeys">${icon('key')} Copy Private Keys</button>
          <button class="btn" id="wExp">${icon('submit')} Export CSV</button>
          <button class="btn danger" id="wDel">${icon('trash')} Delete</button>
          <button class="iact x" id="wSelClear" title="Clear selection">${icon('close')}</button>
        </div>
      </div>`;

    /* ---------- kind tabs ---------- */
    qa('#wTabs button').forEach((b) => {
      b.onclick = () => {
        qa('#wTabs button').forEach((x) => x.classList.toggle('on', x === b));
        WK = b.dataset.k; WSEL.clear(); WG = ''; WQ = ''; $('wQ').value = '';
        $('wChain').style.display = WK === 'evm' ? '' : 'none';
        gate('wFunds', WK !== 'btc', 'Fund tools are EVM / Solana only');
        gate('wTools', WK === 'evm', 'Wallet tools are EVM only');
        renderCards(); renderTable();
      };
    });

    /* ---------- group cards ---------- */
    function renderCards() {
      const gs = wgroups();
      const all = wlist().length;
      const card = (id, name, count) => {
        const t = groupTotal(id);
        return `<div class="gcard${WG === id ? ' on' : ''}" data-g="${esc(id)}" tabindex="0" role="button" aria-pressed="${WG === id}">
          <div class="gn">${esc(name)}</div>
          <div class="gm">${icon('eth')}<b>${t == null ? '—' : fx(t, 4)}</b> ${esc(wsym())}
            <span class="sep">·</span><b>${count}</b> ${count === 1 ? 'Wallet' : 'Wallets'}</div>
          ${id ? `<div class="ga">
            <button data-act="gren" data-g="${esc(id)}" title="Rename group" aria-label="Rename group">${icon('edit')}</button>
            <button class="d" data-act="gdel" data-g="${esc(id)}" title="Delete group" aria-label="Delete group">${icon('trash')}</button>
          </div>` : ''}
        </div>`;
      };
      $('wCards').innerHTML = card('', 'All wallets', all)
        + gs.map((g) => card(g.id, g.name, g.count)).join('')
        + `<div class="gcard add" id="wNewGrp" tabindex="0" role="button">${icon('plus')} New Group</div>`;

      qa('#wCards .gcard').forEach((c) => {
        if (c.id === 'wNewGrp') { c.onclick = newGroup; c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); newGroup(); } }; return; }
        const pick = () => { WG = c.dataset.g; renderCards(); renderTable(); };
        c.onclick = (e) => {
          const a = e.target.closest('[data-act]');
          if (a) { e.stopPropagation(); return a.dataset.act === 'gren' ? renameGroup(a.dataset.g) : delGroup(a.dataset.g); }
          pick();
        };
        c.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } };
      });
    }

    /* ---------- table ---------- */
    function visible() {
      const q = WQ.trim().toLowerCase();
      return wlist().filter((w) => (!WG || w.groupId === WG)
        && (!q || w.name.toLowerCase().includes(q) || w.address.toLowerCase().includes(q)));
    }

    function renderTable() {
      const rows = visible();
      const gname = WG ? ((wgroups().find((g) => g.id === WG) || {}).name || '—') : 'All wallets';
      $('wCtxName').textContent = gname;
      $('wCtxCount').textContent = `· ${rows.length}${WQ ? ` of ${wlist().filter((w) => !WG || w.groupId === WG).length}` : ''} ${rows.length === 1 ? 'wallet' : 'wallets'}`;
      $('wCount').textContent = `${rows.length} shown`;
      setSelCount();

      if (!rows.length) {
        $('wTable').innerHTML = emptyState(WQ
          ? { icon: 'search', title: 'No matches', desc: `Nothing matches "${WQ}" in this group.` }
          : { icon: 'wallets', title: 'No wallets yet', desc: 'Generate fresh wallets or import existing keys to start.' });
        return;
      }

      const sym = wsym();
      $('wTable').innerHTML = `<table><thead><tr>
        <th style="width:34px"><input type="checkbox" id="wSelHdr" aria-label="Select all wallets in view" title="Select all in view"></th>
        <th style="width:15%">Name</th><th style="width:32%">Address</th>
        <th class="rt" style="width:15%"><span class="hi">Balance <button class="iact" id="wBalHdr" title="Refresh balances" aria-label="Refresh balances">${icon('refresh')}</button></span></th>

        <th style="width:13%">Group</th>
        <th style="width:78px"><span class="sr">Actions</span></th></tr></thead><tbody>
        ${rows.map((w) => {
    const b = wbal(w.address);
    const ex = explorerAddr(w.address);
    return `<tr class="wrow">
          <td><input type="checkbox" data-id="${w.id}" ${WSEL.has(w.id) ? 'checked' : ''} aria-label="Select ${esc(w.name)}"></td>
          <td class="nm">${esc(w.name)}</td>
          <td><div class="ad"><span class="a" title="${esc(w.address)}">${esc(short(w.address, 10))}</span>
            <button class="iact" data-act="copy" data-v="${esc(w.address)}" title="Copy address" aria-label="Copy address">${icon('copy')}</button>
            ${ex ? `<a class="iact" href="${esc(ex)}" target="_blank" rel="noopener" title="Open in explorer" aria-label="Open in explorer">${icon('external')}</a>` : ''}
          </div></td>
          <td class="num" id="bal-${w.id}">${b ? `${fx(b.v, 4)} ${esc(sym)}${b.usd != null ? `<span class=\"usd\"> · $${num(b.usd, 2)}</span>` : ''}` : '—'}</td>

          <td class="sm mut lt">${esc(w.groupName || '—')}</td>
          <td class="rt"><div class="racts">
            <button class="iact" data-act="ren" data-id="${w.id}" data-n="${esc(w.name)}" title="Rename" aria-label="Rename">${icon('edit')}</button>
            <button class="iact" data-act="send" data-id="${w.id}" title="Send from this wallet" aria-label="Send from this wallet">${icon('send')}</button>
            <button class="iact d" data-act="del" data-id="${w.id}" data-n="${esc(w.name)}" title="Remove" aria-label="Remove">${icon('trash')}</button>
          </div></td>
        </tr>`;
  }).join('')}</tbody></table>`;

      $('wTable').onclick = (e) => {
        const a = e.target.closest('button[data-act]');
        if (!a) return;
        const { act } = a.dataset;
        if (act === 'copy') return copy(a.dataset.v);
        if (act === 'ren') return wRenameOne(a.dataset.id, a.dataset.n);
        if (act === 'send') return sendModal(a.dataset.id);
        if (act === 'del') return delOne(a.dataset.id, a.dataset.n);
      };

      qa('#wTable input[type=checkbox]').forEach((c) => {
        if (!c.dataset.id) return;
        c.onchange = () => {
          if (c.checked) WSEL.add(c.dataset.id); else WSEL.delete(c.dataset.id);
          setSelCount(); syncSelHdr();
        };
      });
      const hdr = $('wSelHdr');
      if (hdr) hdr.onchange = () => { rows.forEach((w) => { if (hdr.checked) WSEL.add(w.id); else WSEL.delete(w.id); }); renderTable(); };
      $('wBalHdr').onclick = () => $('wBal').click();
      syncSelHdr();

      function syncSelHdr() {
        const h = $('wSelHdr');
        if (!h) return;
        const n = rows.filter((w) => WSEL.has(w.id)).length;
        h.checked = n > 0 && n === rows.length;
        h.indeterminate = n > 0 && n < rows.length;
      }
    }

    function setSelCount() {
      const n = WSEL.size;
      $('wSelBar').classList.toggle('hide', n === 0);
      $('wSelCount').textContent = `${n} selected`;
      const m = document.querySelector('main');
      if (m) m.classList.toggle('has-selbar', n > 0);
    }

    $('wSelClear').onclick = () => { WSEL.clear(); renderTable(); };
    $('wQ').oninput = () => { WQ = $('wQ').value; renderTable(); };
    $('wChain').onchange = () => {
      Object.keys(WBAL).forEach((k) => { if (k.startsWith('evm:')) delete WBAL[k]; });
      renderCards(); renderTable();
    };

    /* ---------- group ops ---------- */
    function newGroup() {
      modal(`<h3>New ${WK.toUpperCase()} group</h3><label class="f">Name</label><input id="ngName" placeholder="main">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="ngGo">Create</button></div>`);
      $('ngName').focus();
      $('ngGo').onclick = async () => {
        try { const g = await api('/wallets/group', { kind: WK, name: $('ngName').value || 'group' }); closeModal(); await reload(); WG = g.id; renderCards(); renderTable(); ok('Group created'); }
        catch (e) { err('Failed', e.message); }
      };
    }
    function renameGroup(id) {
      const g = wgroups().find((x) => x.id === id);
      if (!g) return;
      modal(`<h3>Rename group</h3><label class="f">Name</label><input id="rgName" value="${esc(g.name)}">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="rgGo">Save</button></div>`);
      $('rgName').focus();
      $('rgGo').onclick = async () => {
        try { await api('/wallets/group/rename', { kind: WK, id, name: $('rgName').value }); closeModal(); await reload(); ok('Renamed'); }
        catch (e) { err('Failed', e.message); }
      };
    }
    function delGroup(id) {
      const g = wgroups().find((x) => x.id === id);
      if (!g) return;
      confirmBox('Delete group?', `<b>${esc(g.name)}</b> and its <b>${g.count}</b> wallet(s) will be permanently removed from the vault.<br><br>Private keys will be <b>unrecoverable</b>. Export first if you still need them.`,
        async () => {
          try { await del('/wallets/group', { kind: WK, id }); if (WG === id) WG = ''; await reload(); warn('Group deleted'); }
          catch (e) { err('Failed', e.message); }
        }, 'Delete group');
    }

    /* ---------- add menu ---------- */
    $('wAdd').onclick = () => {
      modal(`<h3>Add ${WK.toUpperCase()} wallets</h3>
        <div class="grid g2">
          <button class="btn" id="amGen" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('plus')}<b>Generate new</b><span class="sm mut">Fresh random keys</span></button>
          <button class="btn" id="amImp" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('key')}<b>Import keys</b><span class="sm mut">Paste existing keys</span></button>
        </div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button></div>`);
      $('amGen').onclick = () => { closeModal(); genModal(); };
      $('amImp').onclick = () => { closeModal(); impModal(); };
    };

    function genModal() {
      const gs = wgroups();
      if (!gs.length) return warn('Create a group first');
      modal(`<h3>Generate ${WK.toUpperCase()} wallets</h3>
        <div class="grid g2">
          <div><label class="f">Group</label><select id="gwG">${gs.map((g) => `<option value="${g.id}"${g.id === WG ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>
          <div><label class="f">Count</label><input id="gwN" type="number" value="10" min="1" max="500"></div>
        </div>
        <label class="f" style="margin-top:var(--s3)">Name prefix</label><input id="gwP" placeholder="w" value="w">
        <div class="infobox" style="margin-top:var(--s3)">Fresh random keys generated locally and sealed into the vault.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="gwGo">Generate</button></div>`);
      $('gwGo').onclick = async () => {
        const b = $('gwGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const r = await api('/wallets/generate', { kind: WK, groupId: $('gwG').value, count: Number($('gwN').value), prefix: $('gwP').value });
          await showGeneratedKeys(r);
          await reload();
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = 'Generate'; }
      };
    }

    async function showGeneratedKeys(rows) {
      const list = Array.isArray(rows) ? rows : [];
      const csv = list.map((w) => `${w.name},${w.address},${w.pk}`).join('\\n');
      modal(`<h3>Save private keys now</h3>
        <div class="warnbox"><b>Shown once only.</b> Save this file or copy keys now. After closing, J-AIO will not show these private keys again.</div>
        <div class="keyonce"><div class="sm mut">${list.length} wallet(s) generated</div>${list.map((w) => `<div class="keyrow"><b>${esc(w.name)}</b><code>${esc(w.pk)}</code></div>`).join('')}</div>
        <div class="acts"><button class="btn" id="gkCopy">Copy CSV</button><button class="btn" id="gkSave">Save CSV</button><button class="btn pri" id="gkDone">I saved it</button></div>`);
      $('gkCopy').onclick = async () => { await navigator.clipboard.writeText(csv); ok('Copied', 'Private keys copied. Clear clipboard after use.'); };
      $('gkSave').onclick = () => { dl(`jaio-${WK}-generated-${Date.now()}.csv`, `name,address,private_key\\n${csv}\\n`); ok('Saved', 'Delete downloaded file after backup.'); };
      $('gkDone').onclick = () => { closeModal(); ok('Generated', `${list.length} wallets`); };
    }

    function impModal() {
      const gs = wgroups();
      if (!gs.length) return warn('Create a group first');
      const ph = WK === 'evm' ? '0xabc…  or  name,0xabc…\nmnemonic words here'
        : WK === 'sol' ? 'base58 secret key per line\nor name,base58key'
          : 'WIF or hex privkey per line';
      modal(`<h3>Import ${WK.toUpperCase()} keys</h3>
        <label class="f">Group</label><select id="iwG">${gs.map((g) => `<option value="${g.id}"${g.id === WG ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
        <label class="f" style="margin-top:var(--s3)">One per line <span class="opt">— optional "name,key" format</span></label>
        <textarea id="iwT" rows="9" placeholder="${esc(ph)}"></textarea>
        <div class="warnbox">Keys are written to the encrypted vault on this machine only. Nothing is transmitted.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="iwGo">Import</button></div>`);
      $('iwGo').onclick = async () => {
        const b = $('iwGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const r = await api('/wallets/import', { kind: WK, groupId: $('iwG').value, text: $('iwT').value });
          closeModal(); await reload();
          ok('Imported', `${r.added} added${r.skipped ? `, ${r.skipped} skipped` : ''}`);
          if (r.errors && r.errors.length) warn('Some lines failed', r.errors.slice(0, 3).join('; '));
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = 'Import'; }
      };
    }

    /* ---------- funds menu ---------- */
    $('wFunds').onclick = () => {
      modal(`<h3>Manage funds</h3>
        <div class="grid g3">
          <button class="btn" id="fmSend" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('send')}<b>Send</b><span class="sm mut">One wallet → address</span></button>
          <button class="btn" id="fmDis" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('proxy')}<b>Disperse</b><span class="sm mut">1 → many</span></button>
          <button class="btn" id="fmCon" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('funds')}<b>Consolidate</b><span class="sm mut">Many → 1</span></button>
        </div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button></div>`);
      $('fmSend').onclick = () => { closeModal(); sendModal(); };
      $('fmDis').onclick = () => { closeModal(); disperseModal(); };
      $('fmCon').onclick = () => { closeModal(); consolidateModal(); };
    };

    /* ---------- tools menu (EVM) ---------- */
    $('wTools').onclick = () => {
      modal(`<h3>Wallet tools</h3>
        <div class="grid g2">
          <button class="btn" id="tlDeleg" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('key')}<b>Check EIP-7702</b><span class="sm mut">Delegation scan</span></button>
          <button class="btn" id="tlUnwrap" style="height:auto;padding:var(--s4);flex-direction:column;gap:6px">${icon('chains')}<b>Unwrap WETH</b><span class="sm mut">1 selected wallet</span></button>
        </div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button></div>`);
      $('tlDeleg').onclick = () => { closeModal(); checkDelegation(); };
      $('tlUnwrap').onclick = () => { closeModal(); unwrapModal(); };
    };

    async function checkDelegation() {
      const rows = visible();
      if (!rows.length) return warn('No wallets in view');
      try {
        const r = await api('/wallets/delegation', { chain: $('wChain').value, addresses: rows.map((w) => w.address) });
        const bad = r.filter((x) => x.delegated);
        modal(`<h3>EIP-7702 delegation</h3>${bad.length
          ? `<div class="warnbox">${bad.length} wallet(s) have code delegated. A malicious delegate can drain funds.</div>
             <div class="tw"><table><thead><tr><th>Address</th><th>Delegate</th></tr></thead><tbody>
             ${bad.map((x) => `<tr><td class="m">${esc(short(x.address, 8))}</td><td class="m">${esc(x.delegate || '')}</td></tr>`).join('')}</tbody></table></div>`
          : `<div class="infobox">No delegation found on any of the ${rows.length} checked wallet(s).</div>`}
          <div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
      } catch (e) { err('Check failed', e.message); }
    }

    function unwrapModal() {
      if (WSEL.size !== 1) return warn('Select exactly one wallet');
      const w = wlist().find((x) => x.id === [...WSEL][0]);
      modal(`<h3>Unwrap WETH → ETH</h3><div class="sm mut">${esc(w.name)} · ${esc(short(w.address, 8))}</div>
        <label class="f" style="margin-top:var(--s3)">Amount <span class="opt">— blank = full balance</span></label><input id="uwA" placeholder="0.05">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="uwGo">Unwrap</button></div>`);
      $('uwGo').onclick = async () => {
        try { const r = await api('/wallets/unwrap', { chain: $('wChain').value, walletId: w.id, amount: $('uwA').value || null }); closeModal(); ok('Unwrapped', r.hash); }
        catch (e) { err('Failed', e.message); }
      };
    }

    /* ---------- selection actions ---------- */
    $('wCopyAddr').onclick = () => {
      const list = wlist().filter((w) => WSEL.has(w.id)).map((w) => w.address);
      if (!list.length) return;
      navigator.clipboard.writeText(list.join('\n')).then(() => ok('Copied', `${list.length} addresses`));
    };

    $('wCopyKeys').onclick = () => keyReveal('clipboard');
    $('wExp').onclick = () => keyReveal('file');

    function keyReveal(mode) {
      if (!WSEL.size) return warn('Select wallets first');
      const toClip = mode === 'clipboard';
      modal(`<h3>${toClip ? 'Copy private keys?' : 'Export private keys?'}</h3>
        <div class="failbox"><b>${WSEL.size}</b> private key(s) will be exposed in plaintext${toClip
    ? '. Your clipboard is readable by other apps and may sync across devices. Clear it right after pasting.'
    : ' as a file in your downloads. Anyone with that file controls those wallets. Delete it after use.'}</div>
        <label class="f">Master password</label>
        <input id="wExpPw" type="password" autocomplete="off" placeholder="re-enter master password">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn danger" id="wExpGo">${toClip ? 'Copy keys' : 'Export file'}</button></div>`);
      $('wExpPw').focus();
      $('wExpGo').onclick = async () => {
        const pw = $('wExpPw').value;
        if (!pw) return warn('Master password required');
        const b = $('wExpGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
        try {
          const r = await api('/wallets/export', { kind: WK, ids: [...WSEL], password: pw });
          closeModal();
          if (toClip) {
            await navigator.clipboard.writeText(r.csv);
            const n = WSEL.size;
            warn('Keys on clipboard', `${n} key(s) — auto-clearing in 60s`);
            // best-effort auto-wipe; only fires while this tab stays focused
            clearTimeout(window.__jaioClipTimer);
            window.__jaioClipTimer = setTimeout(() => {
              navigator.clipboard.writeText('').then(
                () => ok('Clipboard cleared', 'private keys wiped'),
                () => warn('Clipboard not cleared', 'clear it manually'),
              );
            }, 60000);
          } else {
            dl(`jaio-${WK}-keys-${Date.now()}.csv`, r.csv);
            warn('Exported', 'Plaintext keys in your downloads folder');
          }
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = toClip ? 'Copy keys' : 'Export file'; }
      };
      $('wExpPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('wExpGo').click(); });
    }

    $('wRename').onclick = () => {
      if (!WSEL.size) return warn('Select wallets first');
      modal(`<h3>Bulk rename ${WSEL.size} wallets</h3>
        <label class="f">Pattern <span class="opt">— {i} = index, {n} = old name</span></label>
        <input id="brP" value="aw{i}">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="brGo">Rename</button></div>`);
      $('brGo').onclick = async () => {
        try { const r = await api('/wallets/bulk-rename', { kind: WK, ids: [...WSEL], pattern: $('brP').value }); closeModal(); await reload(); ok('Renamed', `${r.updated} wallets`); }
        catch (e) { err('Failed', e.message); }
      };
    };

    $('wDel').onclick = () => {
      if (!WSEL.size) return warn('Select wallets first');
      const n = WSEL.size;
      const body = `<b>${n}</b> wallet(s) will be deleted from the vault. Private keys are <b>unrecoverable</b> unless you exported them.`;
      const run = async () => {
        let done = 0;
        for (const id of [...WSEL]) { try { await del('/wallets', { kind: WK, id }); done++; } catch { /* skip */ } }
        WSEL.clear(); await reload(); warn('Removed', `${done} wallets`);
      };
      // bulk deletes are irreversible, so make large ones require typing
      if (n >= 10) confirmTyped('Remove wallets?', body, `delete ${n}`, run, `Remove ${n} wallets`);
      else confirmBox('Remove wallets?', body, run, 'Remove');
    };

    function delOne(id, name) {
      confirmBox('Remove wallet?', `<b>${esc(name)}</b> will be deleted from the vault. Its private key is <b>unrecoverable</b> unless you exported it.`,
        async () => {
          try { await del('/wallets', { kind: WK, id }); WSEL.delete(id); await reload(); warn('Removed', name); }
          catch (e) { err('Failed', e.message); }
        }, 'Remove');
    }

    /* ---------- balances ---------- */
    $('wBal').onclick = async () => {
      const rows = visible();
      if (!rows.length) return;
      const b = $('wBal'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try {
        const body = { kind: WK, addresses: rows.map((w) => w.address), chain: $('wChain').value };

        const r = await api('/wallets/balances', body);
        const byAddr = {};
        (r.balances || r).forEach((x) => { byAddr[x.address] = x; });
        const sym = wsym();
        let total = 0, totalTok = 0;
        rows.forEach((w) => {
          const x = byAddr[w.address];
          if (!x) return;
          const v = Number(x.balance ?? x.sol ?? x.btc ?? 0);
          total += v;
          WBAL[WK + ':' + w.address] = { v, sym, usd: v && S.ethUsd && sym === 'ETH' ? v * S.ethUsd : null };
        });
        renderCards(); renderTable();
        const usd = S.ethUsd && sym === 'ETH' ? ` · $${num(total * S.ethUsd, 2)}` : '';
        const rp = sym === 'ETH' && ethIdr(total) != null ? ` · ${idr(ethIdr(total))}` : '';
        ok('Balances', `${fx(total, 5)} ${sym}${usd}${rp}`);
      } catch (e) { err('Balance failed', e.message); }
      finally { b.disabled = false; b.innerHTML = `${icon('refresh')} Balances`; }
    };

    async function reload() { await loadAll(); renderCards(); renderTable(); }

    gate('wTools', WK === 'evm', 'Wallet tools are EVM only');
    renderCards(); renderTable();
    setTimeout(() => { if ($('wBal')) $('wBal').click(); }, 0);
    el._reload = reload;
  },
});

async function wRenameOne(id, name) {
  modal(`<h3>Rename wallet</h3><label class="f">Name</label><input id="rwN" value="${esc(name)}">
    <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="rwGo">Save</button></div>`);
  $('rwN').focus();
  $('rwGo').onclick = async () => {
    try { await api('/wallets/rename', { kind: WK, id, name: $('rwN').value }); closeModal(); await loadAll(); go('wallets'); ok('Renamed'); }
    catch (e) { err('Failed', e.message); }
  };
}

/* ---------- fund manager modals ---------- */

function walletSelect(id, kind, selId) {
  return `<select id="${id}">${(S.wallets[kind || WK] || []).map((w) => `<option value="${w.id}"${w.id === selId ? ' selected' : ''}>${esc(w.name)} · ${esc(short(w.address, 8))}</option>`).join('')}</select>`;
}
function wChainVal() { return $('wChain') ? $('wChain').value : 'ethereum'; }

function sendModal(fromId) {
  modal(`<h3>Send funds</h3>
    <div class="grid g2">
      <div><label class="f">From</label>${walletSelect('sfFrom', null, fromId)}</div>
      ${WK === 'evm' ? `<div><label class="f">Chain</label><select id="sfChain">${chainOpts(wChainVal())}</select></div>` : '<div></div>'}
    </div>
    <label class="f" style="margin-top:var(--s3)">To address</label><input id="sfTo" class="mono" placeholder="0x…">
    <div class="grid g2" style="margin-top:var(--s3)">
      <div><label class="f">Amount mode</label><select id="sfMode"><option value="fixed">Fixed</option><option value="max">Max (all)</option><option value="random">Random</option></select></div>
      <div><label class="f">Amount <span class="opt">— blank = max</span></label><input id="sfAmt" placeholder="0.01"></div>
      ${WK === 'evm' ? '<div><label class="f">ERC-20 token <span class="opt">— blank = native</span></label><input id="sfTok" class="mono" placeholder="0x…"></div>' : '<div></div>'}
    </div>
    <div id="sfRngWrap" style="display:none;margin-top:var(--s3)"><label class="f">Random range <span class="opt">— min max</span></label><input id="sfRng" class="mono" placeholder="0.02 - 0.03"></div>
    <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="sfGo">Send</button></div>`);
  $('sfTo').focus();
  const sfMode = $('sfMode');
  sfMode.onchange = () => { $('sfRngWrap').style.display = sfMode.value === 'random' ? '' : 'none'; if (sfMode.value !== 'fixed') $('sfAmt').value = ''; };
  $('sfGo').onclick = async () => {
    const b = $('sfGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const amtStr = $('sfAmt').value.trim();
      const tok = $('sfTok') ? ($('sfTok').value.trim() || null) : null;
      let randomMin, randomMax, max = false;
      if (sfMode.value === 'random') {
        const m = String($('sfRng').value.trim() || '').split(/\s*-\s*/);
        if (m.length !== 2 || !isFinite(+m[0]) || !isFinite(+m[1]) || +m[0] < 0 || +m[1] <= 0 || +m[0] > +m[1]) throw new Error('random range: min max invalid (e.g. 0.02 - 0.03)');
        randomMin = m[0]; randomMax = m[1];
      } else max = sfMode.value === 'max' || (!amtStr && !tok);
      const r = await api('/wallets/send', {
        kind: WK, chain: $('sfChain') ? $('sfChain').value : undefined,
        walletId: $('sfFrom').value, to: $('sfTo').value.trim(),
        amount: amtStr || null, max, token: tok, randomMin, randomMax,
      });
      closeModal(); ok('Sent', r.hash || r.signature);
    } catch (e) { err('Send failed', e.message); b.disabled = false; b.textContent = 'Send'; }
  };
}

function disperseModal() {
  const gs = (S.wgroups[WK] || []);
  const toks = WK === 'evm' ? (S.chains || []).find((c) => c.key === wChainVal()) : null;
  const picks = WK === 'evm' ? `<div class="grid g2" style="margin-top:var(--s2)">
      <div><label class="f">Token <span class="opt">— empty = native</span></label>
        <input id="dsTok" class="mono" placeholder="${toks && toks.weth ? toks.weth.slice(0, 6) + '… (WETH)' : '0x… (erc20)'}">
        <div class="chiprow" style="margin-top:5px">${['weth', 'usdc', 'usdt'].filter((k) => toks && toks[k]).map((k) => `<button class="chip" data-t="${toks[k]}">${k.toUpperCase()}</button>`).join('')}</div>
      </div>
      <div><label class="f">Amount mode</label><select id="dsAmtMode"><option value="fixed">Fixed</option><option value="random">Random</option><option value="max">Max</option></select></div>
    </div>` : `<div class="grid g2" style="margin-top:var(--sp2)"><div><label class="f">Amount mode</label><select id="dsAmtMode"><option value="fixed">Fixed</option><option value="random">Random</option><option value="max">Max</option></select></div></div>`;
  modal(`<h3>Disperse — one wallet to many</h3>
    <div class="grid g2">
      <div><label class="f">Source</label>${walletSelect('dsFrom')}</div>
      ${WK === 'evm' ? `<div><label class="f">Chain</label><select id="dsChain">${chainOpts(wChainVal())}</select></div>` : '<div></div>'}
    </div>
    <div class="grid g2" style="margin-top:var(--s3)">
      <div><label class="f">Target group</label><select id="dsG"><option value="">— use list below —</option>${gs.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('')}</select></div>
      <div><label class="f">Amount each</label><input id="dsAmt" placeholder="0.005"></div>
    </div>
    <div id="dsRngWrap" style="display:none;margin-top:var(--s3)"><label class="f">Random range <span class="opt">— min max</span></label><input id="dsRng" class="mono" placeholder="0.02 - 0.03"></div>
    <label class="f" style="margin-top:var(--s3)">Or explicit targets <span class="opt">— address,amount per line</span></label>
    <textarea id="dsT" rows="6" placeholder="0xabc…,0.01"></textarea>
    ${picks}
    ${WK === 'evm' ? '<label class="chk" style="margin-top:var(--s2)"><input type="checkbox" id="dsMulti" checked> Use Disperse contract (1 tx, cheaper)</label>' : ''}
    <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="dsGo">Disperse</button></div>`);
  const amtSel = $('dsAmtMode');
  const syncAmt = () => { $('dsRngWrap').style.display = amtSel.value === 'random' ? '' : 'none'; if (amtSel.value !== 'fixed') $('dsAmt').value = ''; };
  amtSel.onchange = syncAmt;
  document.querySelectorAll('.chiprow .chip').forEach((b) => b.onclick = () => { $('dsTok').value = b.dataset.t; });
  /* Zyper defaultDisperse setting: checkbox remembers last choice across modals */
  api('/settings').then((s) => { const c = $('dsMulti'); if (c) c.checked = s.defaultDisperse !== false; }).catch(() => {});
  const dmChk = $('dsMulti');
  if (dmChk) dmChk.onchange = () => { api('/settings', { defaultDisperse: dmChk.checked }).catch(() => {}); };
  $('dsGo').onclick = async () => {
    const b = $('dsGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      let targets = [];
      const txt = $('dsT').value.trim();
      if (txt) {
        targets = txt.split('\n').map((l) => { const [a, m] = l.split(/[,\s]+/); return { address: a, amount: m || $('dsAmt').value }; }).filter((x) => x.address);
      } else if ($('dsG').value) {
        targets = (S.wallets[WK] || []).filter((w) => w.groupId === $('dsG').value && w.id !== $('dsFrom').value)
          .map((w) => ({ address: w.address, amount: $('dsAmt').value }));
      }
      if (!targets.length) throw new Error('no targets');
      if (WK === 'evm') {
        const known = new Set((S.wallets.evm || []).map((w) => w.address.toLowerCase()));
        const bad = targets.filter((t) => !known.has(String(t.address).toLowerCase()));
        if (bad.length) throw new Error('target not found in current wallet list');
      }
      const amountMode = amtSel.value;
      let amount = $('dsAmt').value.trim(), randomMin, randomMax;
      if (amountMode === 'random') {
        const m = String($('dsRng').value.trim() || '').split(/\s*-\s*/);
        if (m.length !== 2 || !isFinite(+m[0]) || !isFinite(+m[1]) || +m[0] < 0 || +m[1] <= 0 || +m[0] > +m[1]) throw new Error('random range: min max invalid (e.g. 0.02 - 0.03)');
        randomMin = m[0]; randomMax = m[1]; amount = '';
      } else if (amountMode === 'max') amount = '';
      if (amountMode === 'fixed') {
        targets.forEach((t) => { if (!isFinite(+t.amount) || +t.amount <= 0) throw new Error('amount must be > 0'); });
      }
      const summary = targets.map((t) => `${t.address} = ${randomMin != null ? randomMin + '–' + randomMax : amountMode === 'max' ? 'max' : t.amount}`).join('\n');
      if (!confirm(`Confirm EXACT recipients (${targets.length}) and amount:\n\n${summary}`)) throw new Error('cancelled');
      let r = await api('/wallets/disperse', {
        kind: WK, chain: $('dsChain') ? $('dsChain').value : undefined,
        sourceId: $('dsFrom').value, targets,
        useContract: $('dsMulti') ? $('dsMulti').checked : false,
        amountMode, strategy: 'amount', amount, token: $('dsTok') ? $('dsTok').value.trim() || undefined : undefined,
        randomMin, randomMax,
      });
      if (r && r.mode === 'needs-confirm-fallback') {
        const n = (r.plan || []).length;
        if (!confirm(`The disperse contract transaction failed.\n\nThis will create ${n} individual transfer transactions from the same source wallet.\n\nSend individually?`)) throw new Error('cancelled fallback');
        r = await api('/wallets/disperse', {
          kind: WK, chain: $('dsChain') ? $('dsChain').value : undefined,
          sourceId: $('dsFrom').value, targets,
          useContract: $('dsMulti') ? $('dsMulti').checked : false,
          amountMode, strategy: 'amount', token: $('dsTok') ? $('dsTok').value.trim() || undefined : undefined,
          randomMin, randomMax, confirmFallback: true,
        });
      }
      closeModal();
      const done = Array.isArray(r.sent) ? r.sent.filter((x) => x.hash).length : (r.hash ? 1 : 0);
      ok('Dispersed', `${done}/${Array.isArray(r.sent) ? r.sent.length : r.count} sent${r.verified ? ' · verified' : ''}` + (r.hash ? ` · ${r.hash.slice(0, 10)}…` : ''));
    } catch (e) { err('Disperse failed', e.message); b.disabled = false; b.textContent = 'Disperse'; }
  };
}

function consolidateModal() {
  const gs = (S.wgroups[WK] || []);
  modal(`<h3>Consolidate — many wallets to one</h3>
    <div class="grid g2">
      <div><label class="f">Source group</label><select id="csG"><option value="">— all wallets —</option>${gs.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('')}</select></div>
      ${WK === 'evm' ? `<div><label class="f">Chain</label><select id="csChain">${chainOpts(wChainVal())}</select></div>` : '<div></div>'}
    </div>
    <label class="f" style="margin-top:var(--s3)">Destination address</label><input id="csTo" class="mono" placeholder="0x…">
    ${WK === 'evm' ? `<label class="f" style="margin-top:var(--s3)">ERC-20 token <span class="opt">— blank = sweep native</span></label><input id="csTok" class="mono" placeholder="0x…">` : ''}
    <div class="grid g2" style="margin-top:var(--s3)">
      <div><label class="f">Leave behind <span class="opt">— dust buffer (native)</span></label><input id="csKeep" placeholder="0"></div>
    </div>
    <div class="infobox" style="margin-top:var(--s3)">Sends the full balance minus gas from every wallet in the group. Token mode sweeps the whole token balance (gas still paid in native).</div>
    <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="csGo">Consolidate</button></div>`);
  $('csGo').onclick = async () => {
    const b = $('csGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
    try {
      const ids = $('csG').value
        ? (S.wallets[WK] || []).filter((w) => w.groupId === $('csG').value).map((w) => w.id)
        : (S.wallets[WK] || []).map((w) => w.id);
      const r = await api('/wallets/consolidate', {
        kind: WK, chain: $('csChain') ? $('csChain').value : undefined,
        walletIds: ids, destination: $('csTo').value.trim(),
        leave: $('csKeep').value || null,
        token: $('csTok') ? ($('csTok').value.trim() || undefined) : undefined,
      });
      closeModal();
      const sent = (r || []).filter((x) => x.hash || x.signature).length;
      ok('Consolidated', `${sent}/${ids.length} wallets swept`);
    } catch (e) { err('Consolidate failed', e.message); b.disabled = false; b.textContent = 'Consolidate'; }
  };
}
