'use strict';
/* Delegation scan — EIP-7702 inventory across wallet groups.
 * Read-only: which wallets carry code, and for designated-delegation code
 * (0xef0100 + 20-byte target) who the target is. Send paths already handle
 * the gas edge (see the vault 0xe455…16d1 intrinsic-gas case); this screen
 * just answers "who is delegated" in one shot. */

page('deleg', {
  label: 'Delegation Scan', group: 'Wallets', icon: 'rpc',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Delegation Scan</h2>
      <p class="ps">EIP-7702 scan: a wallet whose address has code <code>0xef0100 + target</code> runs delegated code, so a plain 21000-gas send gets rejected with "intrinsic gas too low".</p>
      <div class="card">
        <div class="row">
          <div style="width:190px"><label class="f">Chain</label><select id="dgChain">${chainOpts('ethereum')}</select></div>
          <div style="width:230px"><label class="f">Wallet group</label><select id="dgGroup"></select></div>
          <button class="btn pri" id="dgGo" style="align-self:flex-end">Scan</button>
        </div>
      </div>
      <div class="card"><h3>Result <span class="sub" id="dgSum"></span></h3><div id="dgOut">${emptyState({ icon: 'rpc', title: 'No scan yet', desc: 'Pick a chain + group then Scan. Reads getCode per wallet, 4 at a time.' })}</div></div>`;

    $('dgGroup').innerHTML = '<option value="">All groups</option>'
      + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');

    const KIND_LABEL = { eoa: 'EOA', delegated: 'delegated', contract: 'contract', error: 'error' };

    $('dgGo').onclick = async () => {
      const b = $('dgGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Scanning';
      try {
        const groupIds = $('dgGroup').value ? [$('dgGroup').value] : null;
        const rows = await api('/wallets/delegation-scan', { chain: $('dgChain').value, groupIds });
        const nDel = rows.filter((r) => r.kind === 'delegated').length;
        const nCtr = rows.filter((r) => r.kind === 'contract').length;
        const nErr = rows.filter((r) => r.kind === 'error').length;
        $('dgSum').textContent = `${rows.length} wallets · ${nDel} delegated · ${nCtr} contract${nErr ? ` · ${nErr} error` : ''}`;
        if (!rows.length) { $('dgOut').innerHTML = emptyState({ icon: 'rpc', title: 'No wallets', desc: 'Nothing in that group.' }); return; }
        $('dgOut').innerHTML = `<div class="tw"><table><thead><tr>
          <th>Wallet</th><th>Address</th><th>Kind</th><th>Delegation target</th></tr></thead><tbody>
          ${rows.map((r) => `<tr>
            <td>${esc(r.name)}</td>
            <td class="mono sm mut">${esc(short(r.address, 6))}</td>
            <td><span class="tag ${r.kind === 'delegated' ? 'warn' : r.kind === 'error' ? 'fail' : r.kind === 'eoa' ? 'mut' : 'ok'}">${KIND_LABEL[r.kind] || r.kind}</span>${r.error ? `<div class="sm mut">${esc(r.error)}</div>` : ''}</td>
            <td class="mono sm">${r.target ? `${esc(short(r.target, 6))} <button class="lnk" data-copy="${esc(r.target)}">${icon('copy')}</button>` : '—'}</td>
          </tr>`).join('')}</tbody></table></div>`;
        qa('#dgOut [data-copy]').forEach((x) => { x.onclick = () => copy(x.dataset.copy); });
      } catch (e) { err('Failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Scan'; }
    };
  },
});