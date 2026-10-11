const fetch = require('node-fetch');
const store = require('./store');

function getMempoolUrl(network = 'mainnet') {
  return network === 'testnet' ? 'https://mempool.space/testnet/api' : 'https://mempool.space/api';
}

async function getUtxos(address, network = 'mainnet') {
  const res = await fetch(`${getMempoolUrl(network)}/address/${address}/utxo`);
  if (!res.ok) throw new Error(`Failed to fetch UTXOs: ${res.statusText}`);
  return res.json();
}

async function getFeeRates(network = 'mainnet') {
  const res = await fetch(`${getMempoolUrl(network)}/v1/fees/recommended`);
  if (!res.ok) return { fastestFee: 15, halfHourFee: 10, hourFee: 5, minimumFee: 1 };
  return res.json();
}

async function broadcastTx(txHex, network = 'mainnet') {
  const res = await fetch(`${getMempoolUrl(network)}/tx`, {
    method: 'POST',
    body: txHex,
    headers: { 'Content-Type': 'text/plain' }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Broadcast failed: ${errText}`);
  }
  return res.text(); // Returns txid
}

async function sendBtc({ fromWif, toAddress, amountSat, feeRate, network = 'mainnet' }) {
  if (!fromWif || !toAddress || !amountSat) {
    throw new Error('fromWif, toAddress, and amountSat are required');
  }
  const utxos = await getUtxos(fromWif.address || fromWif, network);
  const totalIn = utxos.reduce((acc, u) => acc + u.value, 0);
  if (totalIn < amountSat) {
    throw new Error(`Insufficient UTXO balance: have ${totalIn} sat, need ${amountSat} sat`);
  }
  return { status: 'prepared', utxosCount: utxos.length, totalSat: totalIn, toAddress, amountSat };
}

module.exports = {
  getUtxos,
  getFeeRates,
  broadcastTx,
  sendBtc
};
