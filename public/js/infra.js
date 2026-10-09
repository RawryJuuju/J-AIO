'use strict';
/* Infra pages: Proxies, RPC groups, Chains, Settings, Logs */

/* =========================================================
   PROXIES
   ========================================================= */
page('proxies', {
  label: 'Proxies', group: 'Infra', icon: 'proxy',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Proxies</h2>
      <p class="ps">Groups of HTTP/SOCKS proxies. Assigned round-robin to accounts for X and Discord.</p>
      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:180px"><label class="f">Group</label><select id="pxG"></select></div>
          <button class="btn sm" id="pxNewG">New group</button>
          <button class="btn sm pri" id="pxAdd">Add proxies</button>
          <button class="btn sm" id="pxProbe">Re-probe</button>
          <button class="btn sm danger" id="pxDelG">Delete group</button>
        </div>
      </div>
      <div class="tiles" id="pxTiles"></div>
      <div class="card"><h3>Proxies <span class="sub" id="pxCount"></span></h3>
        <div class="tw" id="pxTable">${emptyState({ icon: 'proxy', title: 'No proxies', desc: 'Import a proxy list to spread requests across IPs.' })}</div>
      </div>`;

    let groups = [];

    async function reload() {
      groups = await api('/proxies');
      S.proxies = groups;
      const cur = $('pxG').value;
      $('pxG').innerHTML = groups.length
        ? groups.map((g) => `<option value="${g.id}"${g.id === cur ? ' selected' : ''}>${esc(g.name)} (${g.count})</option>`).join('')
        : '<option value="">— none —</option>';
      render();
    }

    function cg() { return groups.find((g) => g.id === $('pxG').value) || null; }

    function render() {
      const g = cg();
      const total = groups.reduce((a, x) => a + x.count, 0);
      const healthy = groups.reduce((a, x) => a + x.healthy, 0);
      $('pxTiles').innerHTML = `
        <div class="tile"><div class="k">Groups</div><div class="v">${groups.length}</div></div>
        <div class="tile"><div class="k">Total proxies</div><div class="v">${total}</div></div>
        <div class="tile"><div class="k">Healthy</div><div class="v ${healthy === total && total ? 'ok' : healthy ? '' : 'fail'}">${healthy}</div></div>
        <div class="tile"><div class="k">In group</div><div class="v">${g ? g.count : 0}</div></div>`;

      if (!g || !g.proxies.length) { $('pxCount').textContent = ''; $('pxTable').innerHTML = emptyState({ icon: 'proxy', title: 'No proxies in this group', desc: 'Import proxies into this group to use them.' }); return; }
      $('pxCount').textContent = `${g.healthy}/${g.count} healthy`;
      $('pxTable').innerHTML = `<table><thead><tr>
        <th>Host</th><th>Port</th><th>Proto</th><th>Auth</th><th>Status</th><th class="rt">Latency</th><th>Exit IP</th><th></th></tr></thead><tbody>
        ${g.proxies.map((p) => `<tr>
          <td class="mono sm">${esc(p.host)}</td>
          <td class="num">${p.port}</td>
          <td class="sm mut">${esc(p.protocol || 'http')}</td>
          <td class="sm">${p.hasAuth ? '<span class="tag ok">yes</span>' : '<span class="mut">—</span>'}</td>
          <td><span class="tag ${p.healthy === true ? 'ok' : p.healthy === false ? 'fail' : 'mut'}">${p.healthy === true ? 'live' : p.healthy === false ? 'dead' : 'untested'}</span></td>
          <td class="num">${p.latency == null ? '—' : p.latency + 'ms'}</td>
          <td class="mono sm mut">${esc(p.ip || '—')}</td>
          <td class="rt"><button class="btn xs danger" data-rm="${p.id}">×</button></td>
        </tr>`).join('')}</tbody></table>`;
      qa('#pxTable button[data-rm]').forEach((b) => {
        b.onclick = async () => {
          try { await del('/proxies', { groupId: g.id, proxyId: b.dataset.rm }); await reload(); warn('Removed'); }
          catch (e) { err('Failed', e.message); }
        };
      });
    }

    $('pxG').onchange = render;

    $('pxNewG').onclick = () => {
      modal(`<h3>New proxy group</h3>
        <label class="f">Name</label><input id="pgN" placeholder="webshare rotating">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="pgGo">Create</button></div>`);
      $('pgGo').onclick = async () => {
        try { await api('/proxies/group', { name: $('pgN').value.trim() || 'group' }); closeModal(); await reload(); ok('Group created'); }
        catch (e) { err('Failed', e.message); }
      };
    };

    $('pxAdd').onclick = () => {
      const g = cg(); if (!g) return warn('Create a group first');
      modal(`<h3>Add proxies to ${esc(g.name)}</h3>
        <label class="f">One per line <span class="opt">— host:port · host:port:user:pass · user:pass@host:port · socks5://…</span></label>
        <textarea id="paT" rows="10" class="mono" placeholder="p.webshare.io:80:user:pass
socks5://user:pass@1.2.3.4:1080"></textarea>
        <div class="infobox">Each proxy is probed on add against the test URL in Settings. Duplicates are skipped.</div>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="paGo">Add &amp; probe</button></div>`);
      $('paGo').onclick = async () => {
        const b = $('paGo'); b.disabled = true; b.innerHTML = '<span class="spin"></span> Probing';
        try {
          const r = await api('/proxies/add', { groupId: g.id, text: $('paT').value });
          closeModal(); await reload(); ok('Added', `${r.added} proxies · ${r.total} total`);
        } catch (e) { err('Failed', e.message); b.disabled = false; b.textContent = 'Add & probe'; }
      };
    };

    $('pxProbe').onclick = async () => {
      const g = cg(); if (!g) return;
      const b = $('pxProbe'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try { const r = await api('/proxies/probe', { groupId: g.id }); const live = (r || []).filter((x) => x.healthy).length; await reload(); ok('Probed', `${live}/${(r || []).length} healthy`); }
      catch (e) { err('Probe failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Re-probe'; }
    };

    $('pxDelG').onclick = () => {
      const g = cg(); if (!g) return;
      confirmBox('Delete proxy group?', `${esc(g.name)} and its ${g.count} proxies are removed. Accounts pointing at them lose their proxy.`, async () => {
        try { await del('/proxies/group', { id: g.id }); await reload(); warn('Deleted'); } catch (e) { err('Failed', e.message); }
      }, 'Delete group');
    };

    reload();
  },
});

/* =========================================================
   RPC
   ========================================================= */
page('rpc', {
  label: 'RPC Endpoints', group: 'Infra', icon: 'rpc',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">RPC endpoints</h2>
      <p class="ps">Mints race every healthy RPC in the chain's groups. More good endpoints means faster inclusion.</p>
      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:180px"><label class="f">Group</label><select id="rpG"></select></div>
          <button class="btn sm" id="rpNewG">New group</button>
          <button class="btn sm pri" id="rpAdd">Add RPCs</button>
          <button class="btn sm" id="rpProbe">Probe</button>
          <button class="btn sm" id="rpSeed">Seed public</button>
          <button class="btn sm danger" id="rpDelG">Delete group</button>
        </div>
      </div>
      <div class="tiles" id="rpTiles"></div>
      <div class="card"><h3>Endpoints <span class="sub" id="rpCount"></span></h3>
        <div class="tw" id="rpTable">${emptyState({ icon: 'rpc', title: 'No endpoints', desc: 'Add RPC URLs so mints do not depend on public nodes.' })}</div>
      </div>`;

    let groups = [];

    async function reload() {
      groups = await api('/rpc');
      S.rpcs = groups;
      const cur = $('rpG').value;
      $('rpG').innerHTML = groups.length
        ? groups.map((g) => `<option value="${g.id}"${g.id === cur ? ' selected' : ''}>${esc(g.name)} · ${esc(g.chain)} (${g.count})</option>`).join('')
        : '<option value="">— none —</option>';
      render();
    }
    function cg() { return groups.find((g) => g.id === $('rpG').value) || null; }

    function render() {
      const g = cg();
      const total = groups.reduce((a, x) => a + x.count, 0);
      const healthy = groups.reduce((a, x) => a + x.healthy, 0);
      $('rpTiles').innerHTML = `
        <div class="tile"><div class="k">Groups</div><div class="v">${groups.length}</div></div>
        <div class="tile"><div class="k">Endpoints</div><div class="v">${total}</div></div>
        <div class="tile"><div class="k">Healthy</div><div class="v ${healthy ? 'ok' : 'fail'}">${healthy}</div></div>
        <div class="tile"><div class="k">Chains covered</div><div class="v">${new Set(groups.map((x) => x.chain)).size}</div></div>`;

      if (!g || !g.rpcs.length) { $('rpCount').textContent = ''; $('rpTable').innerHTML = emptyState({ icon: 'rpc', title: 'No endpoints in this group', desc: 'Add an RPC URL to this group.' }); return; }
      $('rpCount').textContent = `${g.healthy}/${g.count} healthy`;
      const sorted = g.rpcs.slice().sort((a, b) => (a.latency ?? 9e9) - (b.latency ?? 9e9));
      $('rpTable').innerHTML = `<table><thead><tr><th>URL</th><th>Status</th><th class="rt">Latency</th><th>Error</th><th></th></tr></thead><tbody>
        ${sorted.map((r) => `<tr>
          <td class="mono sm">${esc(r.url)}</td>
          <td><span class="tag ${r.healthy === true ? 'ok' : r.healthy === false ? 'fail' : 'mut'}">${r.healthy === true ? 'live' : r.healthy === false ? 'dead' : 'untested'}</span></td>
          <td class="num">${r.latency == null ? '—' : r.latency + 'ms'}</td>
          <td class="sm fail">${esc((r.error || '').slice(0, 60))}</td>
          <td class="rt"><button class="btn xs danger" data-rm="${esc(r.url)}">×</button></td>
        </tr>`).join('')}</tbody></table>`;
      qa('#rpTable button[data-rm]').forEach((b) => {
        b.onclick = async () => {
          try { await del('/rpc', { groupId: g.id, rpcId: b.dataset.rm, url: b.dataset.rm }); await reload(); warn('Removed'); }
          catch (e) { err('Failed', e.message); }
        };
      });
    }
    $('rpG').onchange = render;

    $('rpNewG').onclick = () => {
      modal(`<h3>New RPC group</h3>
        <label class="f">Name</label><input id="rgN" placeholder="alchemy mainnet">
        <label class="f" style="margin-top:var(--s3)">Chain</label><select id="rgC">${chainOpts('ethereum')}</select>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="rgGo">Create</button></div>`);
      $('rgGo').onclick = async () => {
        try { await api('/rpc/group', { name: $('rgN').value.trim() || 'group', chain: $('rgC').value }); closeModal(); await reload(); ok('Group created'); }
        catch (e) { err('Failed', e.message); }
      };
    };

    $('rpAdd').onclick = () => {
      const g = cg(); if (!g) return warn('Create a group first');
      modal(`<h3>Add RPCs to ${esc(g.name)}</h3>
        <label class="f">One URL per line</label>
        <textarea id="raT" rows="9" class="mono" placeholder="https://eth-mainnet.g.alchemy.com/v2/KEY
https://rpc.ankr.com/eth"></textarea>
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="raGo">Add</button></div>`);
      $('raGo').onclick = async () => {
        try { const r = await api('/rpc/add', { groupId: g.id, text: $('raT').value }); closeModal(); await reload(); ok('Added', `${r.added ?? ''} endpoints`); }
        catch (e) { err('Failed', e.message); }
      };
    };

    $('rpProbe').onclick = async () => {
      const g = cg(); if (!g) return;
      const b = $('rpProbe'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try { const r = await api('/rpc/probe', { groupId: g.id }); const live = (r || []).filter((x) => x.healthy).length; await reload(); ok('Probed', `${live}/${(r || []).length} healthy`); }
      catch (e) { err('Probe failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Probe'; }
    };

    $('rpSeed').onclick = async () => {
      const b = $('rpSeed'); b.disabled = true; b.innerHTML = '<span class="spin"></span>';
      try { const r = await api('/rpc/seed', {}); await reload(); ok('Seeded', `${r.created} groups · ${r.added} endpoints`); }
      catch (e) { err('Failed', e.message); }
      finally { b.disabled = false; b.textContent = 'Seed public'; }
    };

    $('rpDelG').onclick = () => {
      const g = cg(); if (!g) return;
      confirmBox('Delete RPC group?', `${esc(g.name)} and its ${g.count} endpoints are removed.`, async () => {
        try { await del('/rpc/group', { id: g.id }); await reload(); warn('Deleted'); } catch (e) { err('Failed', e.message); }
      }, 'Delete group');
    };

    reload();
  },
});

/* =========================================================
   CHAINS
   ========================================================= */
page('chains', {
  label: 'Chains', group: 'Infra', icon: 'chains',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Chains</h2>
      <p class="ps">Built-in chains plus any custom EVM network you add.</p>
      <div class="card"><h3>Networks <span class="sub" id="chCount"></span>
        <div style="margin-left:auto"><button class="btn sm pri" id="chAdd">Add custom chain</button></div></h3>
        <div class="tw" id="chTable"></div>
      </div>`;

    function render() {
      $('chCount').textContent = `${S.chains.length}`;
      $('chTable').innerHTML = `<table><thead><tr>
        <th>Name</th><th>Key</th><th class="rt">Chain ID</th><th>Symbol</th><th class="rt">RPCs</th><th>Explorer</th><th>Disperse</th><th>Private RPC</th></tr></thead><tbody>
        ${S.chains.map((c) => `<tr>
          <td>${esc(c.name)}${c.custom ? ' <span class="tag">custom</span>' : ''}</td>
          <td class="mono sm mut">${esc(c.key)}</td>
          <td class="num">${c.id}</td>
          <td class="sm">${esc(c.symbol || 'ETH')}</td>
          <td class="num">${(c.rpcs || []).length}</td>
          <td class="sm mut">${c.explorer ? `<a href="${esc(c.explorer)}" target="_blank" rel="noopener">${esc(c.explorer.replace(/^https?:\/\//, ''))}</a>` : '—'}</td>
          <td class="sm">${c.disperse ? '<span class="tag ok">yes</span>' : '<span class="mut">—</span>'}</td>
          <td class="sm"><button class="btn xs" data-priv="${esc(c.key)}">${(S.settings.privateRpc || {})[c.key]?.length ? `<span class="tag ok">${(S.settings.privateRpc[c.key]).length} set</span>` : 'set'}</button></td>
        </tr>`).join('')}</tbody></table>`;
    qa('#chTable [data-priv]').forEach((b) => { b.onclick = () => privModal(b.dataset.priv); });

      function privModal(key) {
        const cur = (S.settings.privateRpc || {})[key] || [];
        modal(`<h3>Private broadcast RPC — ${esc(key)}</h3>
          <div class="infobox">Broadcast to these URLs FIRST (parallel, first-accept) before the normal RPC pool. Use Flashbots / private-mempool / builder endpoints to skip the public mempool. Blank clears the list.</div>
          <label class="f" style="margin-top:var(--s3)">Private RPC URLs <span class="opt">— one per line</span></label>
          <textarea id="prUrls" rows="4" class="mono" placeholder="https://rpc.titanbuilder.xyz">${cur.join('\n')}</textarea>
          <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="prGo">Save</button></div>`);
        $('prGo').onclick = async () => {
          try {
            const r = await api('/chains/private-rpc', { chain: key, urls: $('prUrls').value });
            S.settings.privateRpc = S.settings.privateRpc || {};
            if (r.privateRpc.length) S.settings.privateRpc[key] = r.privateRpc; else delete S.settings.privateRpc[key];
            closeModal(); render();
            ok('Private RPC saved', `${r.privateRpc.length || 0} URL(s) for ${key}`);
          } catch (e) { err('Failed', e.message); }
        };
      }
    }

    $('chAdd').onclick = () => {
      modal(`<h3>Add custom EVM chain</h3>
        <div class="grid g2">
          <div><label class="f">Key <span class="opt">— lowercase id</span></label><input id="ccK" placeholder="apechain"></div>
          <div><label class="f">Name</label><input id="ccN" placeholder="ApeChain"></div>
          <div><label class="f">Chain ID</label><input id="ccI" type="number" placeholder="33139"></div>
          <div><label class="f">Symbol</label><input id="ccS" placeholder="APE"></div>
        </div>
        <label class="f" style="margin-top:var(--s3)">RPC URLs <span class="opt">— one per line</span></label>
        <textarea id="ccR" rows="4" class="mono" placeholder="https://rpc.apechain.com/http"></textarea>
        <label class="f" style="margin-top:var(--s3)">Explorer base URL <span class="opt">— optional</span></label>
        <input id="ccE" placeholder="https://apescan.io">
        <div class="acts"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn pri" id="ccGo">Add chain</button></div>`);
      $('ccGo').onclick = async () => {
        try {
          const body = {
            key: $('ccK').value.trim().toLowerCase(), name: $('ccN').value.trim(),
            id: Number($('ccI').value), symbol: $('ccS').value.trim() || 'ETH',
            rpcs: $('ccR').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
            explorer: $('ccE').value.trim() || null,
          };
          if (!body.key || !body.id) throw new Error('key and chain ID required');
          await api('/chains/custom', body);
          closeModal();
          const st = await api('/state'); S.chains = st.chains;
          render(); ok('Chain added', body.name);
        } catch (e) { err('Failed', e.message); }
      };
    };

    render();
  },
});

/* =========================================================
   SETTINGS
   ========================================================= */
page('settings', {
  label: 'Settings', group: 'Infra', icon: 'settings',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Settings</h2>
      <p class="ps">API keys, wallet keys, and account tokens are all AES-256-GCM encrypted in the vault.</p>

      <div class="card"><h3>Appearance</h3>
        <div class="row" style="align-items:center;gap:var(--s4)">
          <div style="min-width:150px"><label class="f" style="margin-bottom:2px">Theme</label><span class="sm mut">Applies instantly · saved on this device</span></div>
          <div class="seg-row" id="thSeg" style="max-width:380px;flex:1">
            <button type="button" data-th="night">${icon('moon')} Night <span class="sc">dark · low glare</span></button>
            <button type="button" data-th="light">${icon('sun')} Light <span class="sc">bright workspace</span></button>
          </div>
        </div>
      </div>

      <div class="card"><h3>API keys
        <div style="margin-left:auto" class="row">
          <span class="sm mut" id="stKeysDirty"></span>
          <button class="btn xs" id="stProbe">Test all</button>
          <button class="btn pri xs" id="stSaveKeys">Save keys</button>
        </div></h3>
        <div class="ksp" id="stKeys"></div>
        <div class="infobox" style="margin-top:var(--s3)">Existing keys show as <span class="mono">***</span>. Leave a field untouched to keep it. Type a new value to replace it, or blank it to clear.<br>
        Paste several keys separated by newlines or commas to build a pool: requests rotate round-robin, and any key that returns 429 or 401 is skipped for 60s.</div>
      </div>

      <div class="card"><h3>Other keys</h3>
        <div class="grid g2">
          <div><label class="f">Flashbots signer key <span class="opt">— reputation, optional</span></label><input id="stFb" placeholder="unset"></div>
          <div><label class="f">Discord webhook URL <span class="opt">— J-AIO parity</span></label><input id="stWebhook" class="mono" placeholder="https://discord.com/api/webhooks/…"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)"><button class="btn xs" id="stWebhookTest">Test webhook</button><span class="sm mut" id="stWebhookOut" style="align-self:center"></span></div>
      </div>

      <div class="card"><h3>Behaviour</h3>
        <div class="grid g2">
          <div><label class="f">Auto tip multiplier <span class="opt">— priority fee ×</span></label><input id="stTip" type="number" step="0.05" placeholder="1.25"></div>
          <div><label class="f">ETH price override (USD) <span class="opt">— blank = live</span></label><input id="stEth" type="number" step="1" placeholder="live"></div>
          <div><label class="f">Proxy test URL</label><input id="stPTest" placeholder="https://api.ipify.org?format=json"></div>

          <div><label class="f">Idle auto-lock (minutes) <span class="opt">— 0 disables</span></label><input id="stIdle" type="number" step="1" min="0" placeholder="0"></div>
        </div>
        <div class="row" style="margin-top:var(--s3)">
          <label class="chk"><input type="checkbox" id="stPubRpc" checked> Reads use public RPC only <span class="opt">— Collection Manager, balances &amp; scans never touch your private/Alchemy endpoints (saves quota). Tx broadcast still uses your RPC groups.</span></label>
        </div>
        <div class="acts" style="justify-content:flex-start;margin-top:var(--s3)">
          <button class="btn pri" id="stSave">Save settings</button>
          <button class="btn" id="stReload">Reload</button>
        </div>
      </div>

      <div class="card"><h3>Vault</h3>
        <div class="warnbox">Keys never leave this machine. The server binds to <span class="mono">127.0.0.1</span> only and has no authentication beyond the master password, so do not expose the port or run it behind a tunnel.<br><br>
        Requests are rejected unless the <span class="mono">Host</span> header is loopback, the <span class="mono">Origin</span> is this app, and the <span class="mono">X-JAIO-App</span> header is present. That blocks other web pages in your browser from driving this API, and blocks DNS rebinding.</div>
        <div class="row" style="margin-top:var(--s3)">
          <button class="btn danger" id="stLock">Lock vault now</button>
          <button class="btn ghost" id="stSecLog">Security log</button>
        </div>
      </div>`;

    /* Key pool panel. Each provider gets one textarea (a pool, newline or comma
       separated) plus a live per-key latency badge from /api/keyprobe. */
    const POOLS = [
      { field: 'openseaKey', label: 'OpenSea', hint: 'floor, offers, listings, rarity', why: 'Rate limits at ~4 rps per key. Add several for bulk PnL and WL sweeps.' },
      { field: 'etherscanKey', label: 'Etherscan V2', hint: 'ABI fetch, all chains', why: 'Optional. Without a key ABI fetch falls back to a shared quota.' },
      { field: 'alchemyKey', label: 'Alchemy', hint: 'NFT inventory, EVM RPC', why: 'Used when OpenSea inventory is incomplete.' },
      { field: 'heliusKey', label: 'Helius', hint: 'Solana RPC', why: 'Rotated per Solana wallet so a 429 on one does not stall the batch.' },
    ];

    const BADGE = { good: 'ok', slow: 'warn', limited: 'warn', bad: 'fail', dead: 'fail', unknown: 'mut' };

    /* Count keys straight from a textarea's text. /api/keystatus only knows what
       is saved, so before this the pill read "undefined keys" whenever a field
       held an unsaved value. Now the pill always reflects the visible text. */
    function countKeys(raw) {
      return String(raw || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean).length;
    }
    function keyLabel(n) { return `${n} key${n === 1 ? '' : 's'}`; }

    /* Unsaved-changes tracking. Keys used to save only via the Behaviour card's
       "Save settings" button further down the page, which is not discoverable
       from the API keys card, so pasted keys were silently lost on reload. */
    let keysSnapshot = '';
    let keysAutoTimer = null;   // debounce for paste-to-save-and-probe
    function keysNow() { return POOLS.map((p) => ($('kv-' + p.field) || {}).value || '').join('\u0000'); }
    function syncKeysDirty() {
      const dirty = keysNow() !== keysSnapshot;
      const b = $('stSaveKeys'); const t = $('stKeysDirty');
      if (t) t.textContent = dirty ? 'unsaved' : '';
      if (b) b.classList.toggle('pri', dirty);
      return dirty;
    }

    /* Persist only the key-pool textareas that the user actually touched since
       the last render. Untouched fields stay out of the request body, so a
       saved (masked, '***') key is never wiped by an unrelated edit — which is
       exactly what "Save keys" used to do to every untouched pool. */
    let keysDirtyFields = new Set();
    async function saveKeysFields() {
      const body = {};
      POOLS.forEach((p) => {
        if (!keysDirtyFields.has(p.field)) return;   // untouched — keep as-is
        const raw = $('kv-' + p.field).value;
        if (raw.trim() === '***') return;
        const list = raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
        body[p.field] = list.length === 1 ? list[0] : '';
        body[p.field + 's'] = list.length > 1 ? list.join('\n') : '';
      });
      if (Object.keys(body).length) {
        S.settings = await api('/settings', body);
        keysDirtyFields.clear();
        await load();
      }
    }

    function renderPools(s, probe) {
      $('stKeys').innerHTML = POOLS.map((p) => {
        const pr = probe && probe[p.field];
        const single = s[p.field] ? String(s[p.field]) : '';   // saved single key arrives redacted as '***'
        const many = s[p.field + 's'] ? String(s[p.field + 's']) : '';
        const val = [single, many].filter(Boolean).join('\n');
        return `<div class="kp">
          <div class="kp-h">
            <div><b>${esc(p.label)}</b> <span class="sm mut">${esc(p.hint)}</span></div>
            <span class="tag mut" id="kc-${p.field}">${keyLabel(pr ? pr.total : countKeys(val))}</span>
            <div class="kp-b" id="kb-${p.field}">${pr ? (pr.keys || []).map((k) => `<span class="tag ${BADGE[k.state] || 'mut'}" title="${esc(k.key)}${k.note ? ' · ' + esc(k.note) : ''}">${k.ms != null ? k.ms + 'ms' : esc(k.state)}</span>`).join('') : ''}</div>
            <button class="btn xs" data-probe="${p.field}">Test</button>
          </div>
          <textarea id="kv-${p.field}" rows="2" class="mono" placeholder="unset — one key per line for a pool">${esc(val)}</textarea>
          <div class="sm mut">${esc(p.why)}</div>
        </div>`;
      }).join('');
      qa('#stKeys [data-probe]').forEach((b) => { b.onclick = () => probeFields([b.dataset.probe]); });
      /* Live pill count + dirty flag as you type, and Ctrl/Cmd+Enter saves from
         inside the textarea. */
      POOLS.forEach((p) => {
        const ta = $('kv-' + p.field);
        if (!ta) return;
        ta.addEventListener('input', () => {
          keysDirtyFields.add(p.field);   // mark touched so saveKeysFields persists it
          const c = $('kc-' + p.field);
          if (c) c.textContent = keyLabel(countKeys(ta.value));
          syncKeysDirty();
          /* Paste-to-save-and-probe: 700ms after the last keystroke the pool is
             persisted and the fresh keys are tested immediately. */
          clearTimeout(keysAutoTimer);
          keysAutoTimer = setTimeout(async () => {
            if (!syncKeysDirty()) return;   // nothing changed since last save
            try {
              await saveKeysFields();
              probeFields([p.field]);
            } catch (e) { err('Auto-save failed', e.message); }
          }, 700);
        });
        ta.addEventListener('keydown', (ev) => {
          if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); $('stSaveKeys').click(); }
        });
      });
      keysSnapshot = keysNow();
      syncKeysDirty();
    }

    async function probeFields(fields) {
      const targets = fields || POOLS.map((p) => p.field);
      targets.forEach((f) => { const el = $('kb-' + f); if (el) el.innerHTML = '<span class="spin"></span>'; });
      try {
        const r = await api('/keyprobe', { fields: targets });
        Object.entries(r).forEach(([f, pr]) => {
          const b = $('kb-' + f); const c = $('kc-' + f);
          if (c) c.textContent = `${pr.total} key${pr.total === 1 ? '' : 's'}${pr.cooling ? ` · ${pr.cooling} cooling` : ''}`;
          if (b) {
            b.innerHTML = (pr.keys || []).map((k) => `<span class="tag ${BADGE[k.state] || 'mut'}" title="${esc(k.key)}${k.note ? ' · ' + esc(k.note) : ''}">${k.ms != null ? k.ms + 'ms' : esc(k.state)}</span>`).join('')
              || '<span class="sm mut">no keys</span>';
          }
        });
      } catch (e) {
        err('Probe failed', e.message);
        targets.forEach((f) => { const el = $('kb-' + f); if (el) el.innerHTML = ''; });
      }
    }

    const FIELDS = [
      ['stFb', 'flashbotsAuthKey'],
      ['stWebhook', 'webhookUrl'],
      ['stTip', 'autoTipMultiplier'], ['stEth', 'ethUsd'], ['stPTest', 'proxyTestUrl'],
      ['stIdle', 'idleLockMinutes'],
    ];

    async function load() {
      const s = await api('/settings');
      S.settings = s;
      /* Server-stored theme applies only when this browser has no local choice yet */
      try {
        if (!localStorage.getItem('jaio_theme') && (s.theme === 'light' || s.theme === 'night')) applyTheme(s.theme);
      } catch (e) { /* private mode */ }
      syncThemeSeg();
      FIELDS.forEach(([id, key]) => { $(id).value = s[key] == null ? '' : s[key]; });
      $('stPubRpc').checked = s.publicRpcOnly !== false;
      renderPools(s, null);
      api('/keystatus').then((st) => {
        POOLS.forEach((p) => {
          const short = p.field.replace(/Key$/, '');
          const info = st[short] || st[p.field];
          const c = $('kc-' + p.field);
          if (c && info) c.textContent = `${info.total} key${info.total === 1 ? '' : 's'}${info.cooling ? ` · ${info.cooling} cooling` : ''}`;
        });
      }).catch(() => { /* locked */ });
    }

    $('stProbe').onclick = () => probeFields(null);

    $('stWebhookTest').onclick = async () => {
      const b = $('stWebhookTest'); b.disabled = true;
      try {
        const r = await api('/webhook/test', { url: $('stWebhook').value.trim() || undefined });
        $('stWebhookOut').textContent = r.ok ? `ok in ${r.ms}ms` : `fail: ${r.error}`;
      } catch (e) { $('stWebhookOut').textContent = 'fail: ' + e.message; }
      b.disabled = false;
    };

    /* Save keys button in the API keys card — was never wired, so pasted keys
       could only be persisted from the Behaviour card below. */
    $('stSaveKeys').onclick = async () => {
      try { await saveKeysFields(); ok('Keys saved'); }
      catch (e) { err('Save failed', e.message); }
    };

    $('stSave').onclick = async () => {
      const body = {};
      body.publicRpcOnly = $('stPubRpc').checked;
      FIELDS.forEach(([id, key]) => {
        const v = $(id).value.trim();
        if (v === '') { body[key] = ''; return; }   // explicit clear
        if (v === '***') return;                   // untouched redacted secret
        body[key] = ['autoTipMultiplier', 'ethUsd', 'idleLockMinutes'].includes(key) ? Number(v) : v;
      });
      /* Pool textareas write the plural field and clear the legacy singular, so
         a key is never stored twice under two names. */
      POOLS.forEach((p) => {
        const raw = $('kv-' + p.field).value;
        if (raw.trim() === '***') return;
        const list = raw.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
        body[p.field] = list.length === 1 ? list[0] : '';
        body[p.field + 's'] = list.length > 1 ? list.join('\n') : '';
      });
      try { S.settings = await api('/settings', body); await load(); ok('Settings saved'); }
      catch (e) { err('Save failed', e.message); }
    };
    $('stReload').onclick = () => load().then(() => ok('Reloaded'));
    $('stSecLog').onclick = async () => {
      try {
        const r = await api('/logs?name=security.log&n=300');
        modal(`<h3>Security log</h3><div class="con" style="max-height:60vh">${
          r.lines.length ? r.lines.map((l) => `<div class="l">${esc(l)}</div>`).join('') : '<div class="empty">Empty</div>'
        }</div><div class="acts"><button class="btn" onclick="closeModal()">Close</button></div>`, true);
      } catch (e) { err('Failed', e.message); }
    };
    $('stLock').onclick = () => confirmBox('Lock the vault?',
      'All decrypted keys are dropped from memory. Active runs keep going but new signing will fail until you unlock again.',
      async () => { await api('/lock', {}); showLock('Locked. Enter password to unlock.'); }, 'Lock now');

    /* Theme switcher (night / light) — instant apply, localStorage primary,
       mirrored to server settings as a backup. */
    function syncThemeSeg() {
      const cur = currentTheme();
      qa('#thSeg button').forEach((b) => b.classList.toggle('on', b.dataset.th === cur));
    }
    qa('#thSeg button').forEach((b) => {
      b.onclick = () => {
        applyTheme(b.dataset.th);
        syncThemeSeg();
        api('/settings', { theme: b.dataset.th }).catch(() => { /* localStorage already updated */ });
      };
    });
    syncThemeSeg();

    load();
  },
});

/* =========================================================
   LOGS
   ========================================================= */
page('logs', {
  label: 'Logs', group: 'Infra', icon: 'logs',
  render(el) {
    el.innerHTML = `
      <h2 class="pt">Logs</h2>
      <p class="ps">Append-only run logs from the data dir.</p>
      <div class="card">
        <div class="row">
          <div style="flex:1;min-width:180px"><label class="f">File</label>
            <select id="lgF">
              <option value="mint-runs.log">mint-runs.log</option>
              <option value="sol-runs.log">sol-runs.log</option>
              <option value="x-runs.log">x-runs.log</option>
              <option value="submit-runs.log">submit-runs.log</option>
              <option value="nft-ops.log">nft-ops.log</option>
            </select>
          </div>
          <div><label class="f">Lines</label><input id="lgN" type="number" value="300" style="width:90px"></div>
          <button class="btn sm" id="lgGo">Load</button>
          <button class="btn sm" id="lgDl">Download</button>
          <label class="chk"><input type="checkbox" id="lgAuto"> auto-refresh</label>
        </div>
      </div>
      <div class="card"><h3>Output <span class="sub" id="lgCount"></span></h3>
        <div class="con" id="lgOut" style="max-height:60vh"></div>
      </div>`;

    let lines = [];

    async function load() {
      try {
        const r = await api(`/logs?name=${encodeURIComponent($('lgF').value)}&n=${Number($('lgN').value) || 300}`);
        lines = r.lines || [];
        $('lgCount').textContent = `${lines.length} lines`;
        $('lgOut').innerHTML = lines.length
          ? lines.map((l) => `<div class="l ${/fail|error/i.test(l) ? 'fail' : /ok|confirmed/i.test(l) ? 'ok' : 'info'}"><span class="m">${esc(l)}</span></div>`).join('')
          : '<div class="empty">Empty</div>';
        $('lgOut').scrollTop = $('lgOut').scrollHeight;
      } catch (e) { $('lgOut').innerHTML = `<div class="failbox">${esc(e.message)}</div>`; }
    }

    $('lgGo').onclick = load;
    $('lgF').onchange = load;
    $('lgDl').onclick = () => dl($('lgF').value, lines.join('\n'));

    let iv = null;
    $('lgAuto').onchange = (e) => {
      if (iv) { clearInterval(iv); iv = null; }
      if (e.target.checked) iv = setInterval(load, 3000);
    };
    el._cleanup = () => { if (iv) clearInterval(iv); };

    load();
  },
});
