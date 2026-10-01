'use strict';
/* Discord webhook notifications — Zyper parity (webhookUrl setting). */

const store = require('./store');

async function notify(title, fields) {
  try {
    const s = store.readSettings();
    const url = s.webhookUrl;
    if (!url) return false;
    const lines = Array.isArray(fields) ? fields.map(([k, v]) => `**${k}:** ${v}`).join('\n') : String(fields || '');
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: `**${title}**${lines ? '\n' + lines : ''}` }),
      signal: AbortSignal.timeout(10000),
    });
    return true;
  } catch { return false; }
}

module.exports = { notify };