(() => {
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.__jaio !== true) return;
    if (ev.source !== window) return;
    const { method, params, chainId, url } = ev.data;
    try {
      if (!params || !params.length) return;
      const tx = params[0] || {};
      fetch('http://127.0.0.1:8899/api/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-JAIO-App': '1' },
        body: JSON.stringify({
          method,
          from: tx.from || null,
          to: tx.to || null,
          value: tx.value || null,
          data: tx.data || null,
          gas: tx.gas || null,
          chainId: chainId || null,
          url,
        }),
      }).catch(() => { /* J-AIO offline — drop silently */ });
    } catch (e) { /* noop */ }
  });
})();