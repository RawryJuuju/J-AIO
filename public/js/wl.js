'use strict';
/* Whitelist Checker + Projects.
 *
 * Two pages that share one backend. The checker sweeps every wallet against
 * every stage of a drop at once and streams progress; the projects page is the
 * saved book of those results, so a check done weeks ago is still actionable
 * (fund exactly those wallets, spin up mint tasks from the eligible list).
 */

/* ---------------- checker ---------------- */

page('wlcheck', {
  label: 'WL Checker', group: 'NFT', icon: 'check',
  render(el) {
    el.innerHTML = `
      <div class="wl-crumb">SUITE / WHITELISTS / CHECKER - MANAGER</div>
      <div class="wl-title"><div><h2 class="pt">Whitelist checker</h2><p class="ps">Live phase eligibility across selected wallets.</p></div><div class="wl-count" id="wcCount">0 / 0</div></div>

      <div class="card wl-controls">
        <div class="wl-field wl-link"><label class="f">Drop link</label><input id="wcIn" class="mono" placeholder="https://opensea.io/collection/…" autocomplete="off"></div>
        <div class="wl-field"><label class="f">Wallets</label><select id="wcGroup"></select></div>
        <button class="btn pri" id="wcGo">Check</button>
        <button class="btn danger wl-stop" id="wcStop" aria-disabled="true" data-gated="1" title="No check running">Stop - 0/0</button>
      </div>

      <div class="card"><h3>Result <span class="sub" id="wcSub"></span>
        <div style="margin-left:auto" class="row">
          <button class="btn xs" id="wcSave" aria-disabled="true" data-gated="1" title="Run a check first">Save as project</button>
          <button class="btn xs" id="wcCsv" aria-disabled="true" data-gated="1" title="Run a check first">Export CSV</button>
          <button class="btn xs" id="wcOnly">Eligible only</button>
        </div></h3>
        <div class="bar" id="wcBarWrap" style="display:none"><i id="wcBar" style="width:0%"></i></div>
        <div class="tw" id="wcTable">${emptyState({ icon: 'check', title: 'No check run', desc: 'Paste a drop link, pick your wallets, then Check.' })}</div>
      </div>

      <div class="card"><h3>${icon('logs')} Live log</h3><div class="con" id="wcCon"></div></div>`;

    let runId = null, st = null, onlyElig = false, poll = null;

    $('wcGroup').innerHTML = '<option value="">All wallets</option>'
      + S.wgroups.evm.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.count})</option>`).join('');

    function walletIds() {
      const g = $('wcGroup').value;
      return S.wallets.evm.filter((w) => !g || w.groupId === g).map((w) => w.id);
    }

    /* One column per phase. The cell is the wallet's ceiling by that phase —
       a ✓N read, not a raw boolean, because the number is what you fund for. */
    function cell(c) {
      if (!c) return '<td class="wcx"><span class="mut">—</span></td>';
      if (c.verdict === 'eligible') {
        return `<td class="wcx" title="${esc(c.reason || 'eligible')}">
          <span class="wtick yes">${c.cap ? `✓${c.cap}` : '✓'}</span></td>`;
      }
      if (c.verdict === 'unknown') return `<td class="wcx" title="${esc(c.reason || '')}"><span class="wtick unk">?</span></td>`;
      return `<td class="wcx" title="${esc(c.reason || 'not eligible')}"><span class="wtick no">✕</span></td>`;
    }

    function render() {
      if (!st) return;
      const done = st.status !== 'running';
      $('wcSub').textContent = `${st.name} · ${st.done}/${st.total} checked · ${st.eligible} eligible${done ? '' : ' · running'}`;
      $('wcCount').textContent = `${st.done} / ${st.total}`;
      $('wcStop').textContent = done ? `Stopped - ${st.done}/${st.total}` : `Stop - ${st.done}/${st.total}`;
      $('wcBarWrap').style.display = done ? 'none' : 'block';
      $('wcBar').style.width = `${st.total ? (st.done / st.total) * 100 : 0}%`;
      gate('wcStop', !done, done ? 'No check running' : '');
      gate('wcSave', done && st.eligible > 0, st.eligible ? '' : 'No eligible wallets to save');
      gate('wcCsv', st.rows.length > 0, st.rows.length ? '' : 'Run a check first');

      const rows = onlyElig ? st.rows.filter((r) => r.eligible) : st.rows;
      if (!rows.length) {
        $('wcTable').innerHTML = st.status === 'running'
          ? '<div class="empty"><span class="spin"></span><div class="et" style="margin-top:8px">Checking…</div></div>'
          : emptyState({ icon: 'check', title: onlyElig ? 'No eligible wallets' : 'No results', desc: 'None of the selected wallets passed any phase.' });
        return;
      }
      $('wcTable').innerHTML = `<table class="wltab"><thead><tr>
        <th>Wallet</th>
        ${st.stages.filter((s) => !s.isPublic).map((s) => `<th style="text-align:center" title="${esc(s.name)} · ${esc(s.price)} ETH${s.cap ? ` · cap ${s.cap}` : ''}">
          <div class="phn">${esc(s.name)}</div>
          <div class="sm mut">MP ${esc(s.price)} ETH${S.ethUsd ? ` · $${num(Number(s.price) * S.ethUsd, 2)}` : ''}${s.cap ? ` · ${s.cap}` : ''}</div></th>`).join('')}
        <th class="rt">Total</th>
      </tr></thead><tbody>
      ${rows.map((r) => {
    const caps = st.stages.map((s) => (r.cells[s.id] && r.cells[s.id].verdict === 'eligible' ? (r.cells[s.id].cap || 1) : 0));
    const total = Math.max(0, ...caps);
    return `<tr class="${r.eligible ? '' : 'dim'}">
          <td><div class="ownc"><span class="n">${esc(r.name)}</span><span class="a">${esc(short(r.address, 5))}</span></div></td>
          ${st.stages.filter((s) => !s.isPublic).map((s) => cell(r.cells[s.id])).join('')}
          <td class="rt num"><b class="${total ? 'ok' : 'mut'}">${total || '—'}</b></td>
        </tr>`;
  }).join('')}
      </tbody></table>`;
    }

    async function refresh() {
      if (!runId) return;
      try {
        st = await api(`/wl/status?runId=${encodeURIComponent(runId)}`);
        render();
        if (st.status !== 'running' && poll) { clearInterval(poll); poll = null; }
      } catch { /* locked */ }
    }

    $('wcGo').onclick = async () => {
      const input = $('wcIn').value.trim();
      if (!input) return warn('Paste a drop link or contract');
      const ids = walletIds();
      if (!ids.length) return warn('No wallets in that group');
      const b = $('wcGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Resolving';
      $('wcCon').innerHTML = '';
      try {
        const r = await api('/wl/check', { chain: 'ethereum', input, walletIds: ids });
        runId = r.runId;
        ok('Checking', `${r.total} wallets · ${r.stages.length} phase(s)`);
        await refresh();
        if (poll) clearInterval(poll);
        poll = setInterval(refresh, 1500);
      } catch (e) { err('Failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Check'; }
    };

    $('wcStop').onclick = async () => {
      try { await api('/wl/stop', { runId }); warn('Stopped'); refresh(); } catch (e) { err('Failed', e.message); }
    };

    $('wcOnly').onclick = () => {
      onlyElig = !onlyElig;
      $('wcOnly').classList.toggle('on', onlyElig);
      $('wcOnly').textContent = onlyElig ? 'Show all' : 'Eligible only';
      render();
    };

    $('wcCsv').onclick = () => {
      if (!st) return;
      const head = ['wallet', 'address', ...st.stages.map((s) => s.name)];
      const rows = [head].concat(st.rows.map((r) => [
        r.name, r.address,
        ...st.stages.map((s) => {
          const c = r.cells[s.id];
          return c && c.verdict === 'eligible' ? (c.cap || 1) : 0;
        }),
      ]));
      dl(`${st.slug || 'wl'}-check.csv`, rows.map((x) => x.join(',')).join('\n'));
    };

    $('wcSave').onclick = () => {
      modal(`<h3>Save as project</h3>
        <label class="f">Project name</label><input id="wsName" value="${esc(st.name)}">
        <label class="f" style="margin-top:var(--s3)">Status</label>
        <select id="wsStatus">
          <option value="whitelist">Whitelist won</option>
          <option value="ongoing">Mint ongoing</option>
          <option value="minted">Minted</option>
        </select>
        <label class="f" style="margin-top:var(--s3)">Notes <span class="opt">— optional</span></label>
        <input id="wsNotes" placeholder="phase times, discord, anything">
        <div class="infobox">Only eligible wallets are stored, grouped by phase, so the saved list is ready to fund and mint from.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="wsGo">Save</button></div>`);
      $('wsGo').onclick = async () => {
        try {
          await api('/wl/save', { runId, name: $('wsName').value.trim(), status: $('wsStatus').value, notes: $('wsNotes').value.trim() });
          closeModal(); ok('Saved to Projects');
        } catch (e) { err('Failed', e.message); }
      };
    };

    const off = onEvent((e) => {
      if (e.kind !== 'wl' || e.runId !== runId) return;
      conLine($('wcCon'), e);
      if (e.progress) $('wcSub').textContent = `${st ? st.name + ' · ' : ''}${e.progress} checked`;
    });

    el._cleanup = () => { off(); if (poll) clearInterval(poll); };
  },
});

/* ---------------- projects ---------------- */

page('projects', {
  label: 'Projects', group: 'NFT', icon: 'book',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Projects</h2>
      <p class="ps">Saved whitelist results. Expand a project to see phases, the wallets that won each, and act on them.</p>
      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:200px"><label class="f">Search</label><input id="prQ" placeholder="name or slug"></div>
          <div style="width:170px"><label class="f">Status</label><select id="prS">
            <option value="">All</option><option value="whitelist">Whitelist won</option>
            <option value="ongoing">Mint ongoing</option><option value="minted">Minted</option><option value="dead">Dead</option>
          </select></div>
          <button class="btn" id="prNew">${icon('plus')} Add manually</button>
          <button class="btn ghost" id="prRefresh">${icon('refresh')}</button>
        </div>
      </div>
      <div id="prList"></div>`;

    let all = [];
    const open = new Set();

    const STATUS_TAG = {
      whitelist: ['ok', 'WL won'], ongoing: ['warn', 'minting'],
      minted: ['mut', 'minted'], dead: ['fail', 'dead'],
    };

    function phasePanel(p) {
      return `<div class="ph">
        ${(p.phases || []).map((ph) => `<div class="php">
          <div class="ph-h">
            <div><span class="phn">${esc(ph.name)}</span>
              <span class="sm mut">${esc(ph.price)} Ξ${ph.maxPerWallet ? ` · cap ${ph.maxPerWallet}` : ''}</span></div>
            <span class="tag ok">${ph.wallets.length} wallet${ph.wallets.length === 1 ? '' : 's'}</span>
            <span class="tag mut">${ph.wallets.reduce((a, w) => a + (w.cap || 0), 0)} mints</span>
            ${ph.startTime ? `<span class="sm mut tb-end">${new Date(ph.startTime * 1000).toLocaleString('en-GB')}</span>` : ''}
          </div>
          <div class="phw">${ph.wallets.map((w) => `<span class="chip" title="${esc(w.address)}">${esc(w.name)}${w.cap > 1 ? `<b>×${w.cap}</b>` : ''}</span>`).join('') || '<span class="mut sm">none</span>'}</div>
          <div class="row" style="margin-top:var(--s2)">
            <button class="btn xs" data-fund="${esc(p.id)}|${esc(ph.id)}">${icon('funds')} Fund wallets</button>
            <button class="btn xs" data-task="${esc(p.id)}|${esc(ph.id)}">${icon('mint')} Create mint tasks</button>
            <button class="btn xs" data-addrs="${esc(p.id)}|${esc(ph.id)}">${icon('copy')} Copy addresses</button>
            <button class="btn xs" data-csv="${esc(p.id)}|${esc(ph.id)}">Export</button>
          </div>
        </div>`).join('') || '<div class="mut sm">No phases stored.</div>'}
      </div>`;
    }

    function render() {
      const qv = $('prQ').value.trim().toLowerCase();
      const sv = $('prS').value;
      const list = all.filter((p) => (!sv || p.status === sv)
        && (!qv || `${p.name} ${p.slug || ''}`.toLowerCase().includes(qv)));

      if (!list.length) {
        $('prList').innerHTML = `<div class="card">${emptyState({
          icon: 'book', title: all.length ? 'Nothing matches' : 'No projects saved',
          desc: all.length ? 'Clear the filters to see everything.' : 'Run a WL check and save the result, or add a project manually.',
          action: all.length ? null : { label: 'Go to WL Checker', onclick: "go('wlcheck')" },
        })}</div>`;
        return;
      }

      $('prList').innerHTML = list.map((p) => {
        const [tone, label] = STATUS_TAG[p.status] || ['mut', p.status];
        const isOpen = open.has(p.id);
        return `<div class="card prow ${isOpen ? 'open' : ''}">
          <div class="pr-h" data-tog="${esc(p.id)}">
            <span class="pr-chev">${icon('chev')}</span>
            <div class="pr-img">${p.image ? `<img src="${esc(p.image)}" alt="">` : icon('book')}</div>
            <div class="pr-id">
              <div class="pr-n">${esc(p.name)} <span class="tag ${tone}">${esc(label)}</span></div>
              <div class="pr-s">${p.slug ? esc(p.slug) : esc(short(p.address, 6))} · ${esc(p.chain)}${p.notes ? ` · ${esc(p.notes)}` : ''}</div>
            </div>
            <div class="pr-num"><div class="k">Phases</div><div class="v">${(p.phases || []).length}</div></div>
            <div class="pr-num"><div class="k">Wallets</div><div class="v accent">${num(p.walletCount, 0)}</div></div>
            <div class="pr-num"><div class="k">Mints</div><div class="v ok">${num(p.mintCount, 0)}</div></div>
            <div class="pr-a">
              <button class="btn xs" data-recheck="${esc(p.id)}" title="Re-run the check">${icon('refresh')}</button>
              <button class="btn xs" data-edit="${esc(p.id)}" title="Edit">${icon('edit')}</button>
              <button class="btn xs danger" data-del="${esc(p.id)}" title="Delete">${icon('trash')}</button>
            </div>
          </div>
          ${isOpen ? phasePanel(p) : ''}
        </div>`;
      }).join('');

      qa('#prList [data-tog]').forEach((h) => {
        h.onclick = (e) => {
          if (e.target.closest('button')) return;
          const id = h.dataset.tog;
          if (open.has(id)) open.delete(id); else open.add(id);
          render();
        };
      });
      qa('#prList [data-del]').forEach((b) => {
        b.onclick = () => {
          const p = all.find((x) => x.id === b.dataset.del);
          confirmBox('Delete project?', `<b>${esc(p.name)}</b> and its saved phase/wallet lists are removed. Wallets themselves are untouched.`,
            async () => { await api('/projects/remove', { id: p.id }); ok('Deleted'); load(); }, 'Delete');
        };
      });
      qa('#prList [data-edit]').forEach((b) => { b.onclick = () => editModal(all.find((x) => x.id === b.dataset.edit)); });
      qa('#prList [data-recheck]').forEach((b) => {
        b.onclick = () => {
          const p = all.find((x) => x.id === b.dataset.recheck);
          go('wlcheck');
          setTimeout(() => {
            const inp = $('wcIn');
            if (!inp) return;
            inp.value = p.slug ? `https://opensea.io/collection/${p.slug}` : p.address;
            const ch = $('wcChain'); if (ch) ch.value = p.chain;
          }, 60);
        };
      });

      qa('#prList [data-addrs]').forEach((b) => {
        b.onclick = () => {
          const { phase } = pick(b.dataset.addrs);
          copy(phase.wallets.map((w) => w.address).join('\n'));
        };
      });
      qa('#prList [data-csv]').forEach((b) => {
        b.onclick = () => {
          const { project, phase } = pick(b.dataset.csv);
          dl(`${project.name}-${phase.name}.csv`,
            [['wallet', 'address', 'cap']].concat(phase.wallets.map((w) => [w.name, w.address, w.cap]))
              .map((r) => r.join(',')).join('\n'));
        };
      });
      qa('#prList [data-fund]').forEach((b) => { b.onclick = () => fundModal(pick(b.dataset.fund)); });
      qa('#prList [data-task]').forEach((b) => { b.onclick = () => taskModal(pick(b.dataset.task)); });
    }

    function pick(key) {
      const [pid, phid] = key.split('|');
      const project = all.find((x) => x.id === pid);
      const phase = (project.phases || []).find((x) => String(x.id) === String(phid));
      return { project, phase };
    }

    /* Fund: the numbers the phase already knows (price × cap) plus gas headroom
       become the suggested per-wallet amount, so the common case is one click. */
    function fundModal({ project, phase }) {
      const need = Number(phase.price || 0);
      const perWallet = phase.wallets.map((w) => need * (w.cap || 1));
      const maxNeed = Math.max(0, ...perWallet);
      const suggested = (maxNeed + 0.0025).toFixed(5);
      modal(`<h3>Fund ${phase.wallets.length} wallet(s)</h3>
        <div class="sm mut">${esc(project.name)} · ${esc(phase.name)} · ${esc(phase.price)} Ξ per mint</div>
        <div class="grid g2" style="margin-top:var(--s3)">
          <div><label class="f">From wallet</label><select id="pfFrom">${S.wallets.evm.map((w) => `<option value="${w.id}">${esc(w.name)} — ${esc(short(w.address, 5))}</option>`).join('')}</select></div>
          <div><label class="f">Amount each (ETH)</label><input id="pfAmt" class="mono" value="${suggested}"></div>
        </div>
        <div class="infobox">Mint cost is ${fx(maxNeed, 5)} Ξ at the largest cap in this phase. The default adds ~0.0025 Ξ for gas.</div>
        <div class="warnbox">Sends real ETH from the source wallet to ${phase.wallets.length} address(es). Transfers cannot be reversed.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn danger" id="pfGo">Send</button></div>`);
      $('pfGo').onclick = async () => {
        const b = $('pfGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Sending';
        try {
          const r = await api('/wallets/disperse', {
            chain: project.chain, sourceId: $('pfFrom').value,
            targets: phase.wallets.map((w) => ({ address: w.address, amount: $('pfAmt').value })),
          });
          closeModal();
          ok('Funded', `${(r && (r.sent || (r.results || []).length)) || phase.wallets.length} transfer(s)`);
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = 'Send'; }
      };
    }

    /* Create tasks: hand the phase straight to the mint page rather than
       duplicating the mint form here. */
    function taskModal({ project, phase }) {
      modal(`<h3>Create mint tasks</h3>
        <div class="sm mut">${esc(project.name)} · ${esc(phase.name)}</div>
        <div class="infobox" style="margin-top:var(--s3)">${phase.wallets.length} wallet(s), ${phase.wallets.reduce((a, w) => a + (w.cap || 0), 0)} mint(s) total at ${esc(phase.price)} Ξ each.
        The mint page opens pre-filled with this contract, chain, and wallet set.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="ptGo">Open mint page</button></div>`);
      $('ptGo').onclick = () => {
        S.prefillMint = {
          chain: project.chain, contract: project.address, slug: project.slug,
          price: phase.price, qty: Math.max(1, ...phase.wallets.map((w) => w.cap || 1)),
          walletIds: phase.wallets.map((w) => w.id),
          label: `${project.name} — ${phase.name}`,
        };
        closeModal();
        go('mint');
      };
    }

    function editModal(p) {
      modal(`<h3>Edit project</h3>
        <label class="f">Name</label><input id="peName" value="${esc(p.name)}">
        <label class="f" style="margin-top:var(--s3)">Status</label>
        <select id="peStatus">${['whitelist', 'ongoing', 'minted', 'dead'].map((s) => `<option value="${s}"${p.status === s ? ' selected' : ''}>${esc((STATUS_TAG[s] || [, s])[1])}</option>`).join('')}</select>
        <label class="f" style="margin-top:var(--s3)">Notes</label><input id="peNotes" value="${esc(p.notes || '')}">
        <label class="f" style="margin-top:var(--s3)">Link</label><input id="peLink" value="${esc(p.link || '')}" placeholder="https://">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="peGo">Save</button></div>`);
      $('peGo').onclick = async () => {
        try {
          await api('/projects/update', {
            id: p.id,
            fields: { name: $('peName').value.trim(), status: $('peStatus').value, notes: $('peNotes').value.trim(), link: $('peLink').value.trim() },
          });
          closeModal(); ok('Saved'); load();
        } catch (e) { err('Failed', e.message); }
      };
    }

    $('prNew').onclick = () => {
      modal(`<h3>Add project</h3>
        <div class="grid g2">
          <div><label class="f">Name</label><input id="pnName" placeholder="Collection name"></div>
          <div><label class="f">Chain</label><select id="pnChain">${chainOpts('ethereum')}</select></div>
        </div>
        <label class="f" style="margin-top:var(--s3)">Contract or OpenSea slug</label><input id="pnAddr" class="mono" placeholder="0x… or slug">
        <label class="f" style="margin-top:var(--s3)">Notes</label><input id="pnNotes" placeholder="optional">
        <div class="infobox">A manual entry has no phase data. Run a WL check on it later to fill in phases and eligible wallets.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="pnGo">Add</button></div>`);
      $('pnGo').onclick = async () => {
        const v = $('pnAddr').value.trim();
        try {
          await api('/projects/save', {
            name: $('pnName').value.trim() || 'Untitled',
            chain: $('pnChain').value,
            address: /^0x[a-fA-F0-9]{40}$/.test(v) ? v : null,
            slug: /^0x/.test(v) ? null : (v || null),
            notes: $('pnNotes').value.trim(), phases: [],
          });
          closeModal(); ok('Added'); load();
        } catch (e) { err('Failed', e.message); }
      };
    };

    async function load() {
      try {
        const r = await api('/projects');
        all = r.projects || [];
        render();
      } catch (e) { $('prList').innerHTML = `<div class="card"><div class="failbox">${esc(e.message)}</div></div>`; }
    }

    $('prQ').oninput = render;
    $('prS').onchange = render;
    $('prRefresh').onclick = () => load().then(() => ok('Reloaded'));
    load();
  },
});
