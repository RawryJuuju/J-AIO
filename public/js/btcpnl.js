page('btc', {
  label: 'BTC Transfer', group: 'Infra', icon: 'tools',
  render(el) {
    el.innerHTML = `
      <div class="fit p12">
        <h2 class="m0 mb12">BTC & Taproot Transfer</h2>
        <div class="card p16 mb12">
          <div class="g2 col2">
            <div>
              <label class="lbl">From Address / WIF Key</label>
              <input id="btcWif" class="inp" type="password" placeholder="WIF private key / address">
            </div>
            <div>
              <label class="lbl">Recipient BTC Address</label>
              <input id="btcTo" class="inp" type="text" placeholder="bc1q... or 1...">
            </div>
            <div>
              <label class="lbl">Amount (Satoshis)</label>
              <input id="btcSat" class="inp" type="number" placeholder="10000">
            </div>
            <div>
              <label class="lbl">Fee Rate (sat/vB)</label>
              <input id="btcFee" class="inp" type="number" placeholder="Fetching recommended...">
            </div>
          </div>
          <div class="mt12">
            <button id="btcSendBtn" class="btn pri">Send BTC</button>
          </div>
        </div>
        <div id="btcRes" class="card p16 hide">
          <h3>Result</h3>
          <pre id="btcResPre" class="code"></pre>
        </div>
      </div>
    `;

    api('/api/btc/fee').then(r => {
      if (r && r.fastestFee) {
        $('btcFee').value = r.fastestFee;
      }
    }).catch(() => {});

    $('btcSendBtn').onclick = async () => {
      const fromWif = $('btcWif').value.trim();
      const toAddress = $('btcTo').value.trim();
      const amountSat = Number($('btcSat').value);
      const feeRate = Number($('btcFee').value);

      if (!fromWif || !toAddress || !amountSat) return warn('All fields are required');

      try {
        const res = await api('/api/btc/send', {
          method: 'POST',
          body: JSON.stringify({ fromWif, toAddress, amountSat, feeRate })
        });
        $('btcRes').classList.remove('hide');
        $('btcResPre').textContent = JSON.stringify(res, null, 2);
        ok('BTC send prepared');
      } catch (e) {
        err(e);
      }
    };
  }
});
