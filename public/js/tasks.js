'use strict';
/* Tasks Dashboard page — unified grid for all active and historical tasks. */

page('tasks', {
  label: 'Tasks', group: 'Minting', icon: 'tools',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Tasks Dashboard</h2>
      <p class="ps">Manage all active tasks (EVM Mint, Sniper) in one place.</p>
      
      <div class="card">
        <h3>Task Overview <span class="sub" id="tsCount"></span>
          <div style="margin-left:auto" class="row">
            <button class="btn sm danger" id="tsStopAll">Stop All Tasks</button>
            <button class="btn sm" id="tsRefresh">${icon('refresh')} Refresh</button>
          </div>
        </h3>
        <div id="tsGrid">${emptyState({ icon: 'tools', title: 'No active tasks', desc: 'Tasks from EVM Mint, Sol Mint, or Sniper will appear here.' })}</div>
      </div>`;

    async function poll() {
      try {
        const list = await api('/tasks');
        $('tsCount').textContent = `${list.length} task(s)`;
        if (!list.length) {
          $('tsGrid').innerHTML = emptyState({ icon: 'tools', title: 'No active tasks', desc: 'Tasks from EVM Mint, Sol Mint, or Sniper will appear here.' });
          return;
        }
        $('tsGrid').innerHTML = `<div class="tw"><table><thead><tr>
          <th>Kind</th><th>ID / Target</th><th>Status / Progress</th><th>Detail</th><th class="rt">Action</th>
        </tr></thead><tbody>
        ${list.map((t) => `<tr>
          <td><span class="tag ${t.kind === 'sniper' ? 'warn' : 'ok'}">${esc(t.kind)}</span></td>
          <td class="mono sm"><b>${esc(t.slug || t.name || t.id)}</b>${t.chain ? ` <span class="mut">(${esc(t.chain)})</span>` : ''}</td>
          <td><span class="tag ${t.status === 'running' || t.running ? 'ok' : 'mut'}">${esc(t.status || (t.running ? 'running' : 'done'))}</span></td>
          <td class="sm mut">${t.buys != null ? `${t.buys} buys` : (t.counts ? `${t.counts.sent || 0} sent` : '—')}</td>
          <td class="rt"><button class="btn xs danger" data-stop="${esc(t.id)}" data-kind="${esc(t.kind)}">Stop</button></td>
        </tr>`).join('')}
        </tbody></table></div>`;

        qa('#tsGrid [data-stop]').forEach((b) => {
          b.onclick = async () => {
            await api('/tasks/stop', { id: b.dataset.stop, kind: b.dataset.kind });
            ok('Task stopped'); poll();
          };
        });
      } catch { /* locked */ }
    }

    $('tsRefresh').onclick = poll;
    $('tsStopAll').onclick = async () => {
      try {
        await api('/mint/stop-all', {});
        ok('Stopped all tasks'); poll();
      } catch (e) { err('Stop failed', e.message); }
    };

    poll();
    let iv = setInterval(poll, 3000);
    el._hide = () => { clearInterval(iv); iv = null; };
    el._show = () => { if (!iv) { poll(); iv = setInterval(poll, 3000); } };
    el._cleanup = el._hide;
  },
});
