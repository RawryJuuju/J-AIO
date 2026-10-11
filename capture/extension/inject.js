(() => {
  const JAIOCAP = '__jaio_capture__';
  if (window[JAIOCAP] || !window.ethereum) {
    if (!window.ethereum) {
      const boot = () => setTimeout(() => { if (window.ethereum) hook(); }, 100);
      if (window.addEventListener) window.addEventListener('ethereum#initialized', boot, { once: true });
      boot();
      return;
    }
    hook();
  }
  function hook() {
    if (window[JAIOCAP]) return;
    window[JAIOCAP] = true;
    const eth = window.ethereum;
    const orig = eth.request && eth.request.bind(eth);
    if (!orig) return;
    eth.request = async (args) => {
      try {
        if (args && args.method === 'eth_sendTransaction') {
          window.postMessage({
            __jaio: true,
            method: 'eth_sendTransaction',
            params: args.params || [],
            chainId: eth.chainId || null,
            url: location.href,
          }, '*');
        }
        if (args && args.method === 'personal_sign') {
          window.postMessage({
            __jaio: true,
            method: 'personal_sign',
            params: args.params || [],
            chainId: eth.chainId || null,
            url: location.href,
          }, '*');
        }
      } catch (e) { /* never break the dapp */ }
      return orig(args);
    };
    if (eth.send) {
      const origSend = eth.send.bind(eth);
      eth.send = (payload, cb) => {
        try {
          if (payload && payload.method === 'eth_sendTransaction') {
            window.postMessage({ __jaio: true, method: 'eth_sendTransaction', params: payload.params || [], chainId: eth.chainId || null, url: location.href }, '*');
          }
        } catch (e) { /* noop */ }
        return origSend(payload, cb);
      };
    }
  }
  hook();
})();