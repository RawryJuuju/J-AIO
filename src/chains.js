'use strict';

const CHAINS = {
  ethereum:  { id: 1,        name: 'Ethereum',   symbol: 'ETH',  explorer: 'https://etherscan.io',              alchemy: 'eth-mainnet',      osSlug: 'ethereum',  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', rpcs: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth', 'https://rpc.ankr.com/eth'] },
  base:      { id: 8453,     name: 'Base',       symbol: 'ETH',  explorer: 'https://basescan.org',               alchemy: 'base-mainnet',     osSlug: 'base',      weth: '0x4200000000000000000000000000000000000006', rpcs: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org', 'https://1rpc.io/base'] },
  arbitrum:  { id: 42161,    name: 'Arbitrum',   symbol: 'ETH',  explorer: 'https://arbiscan.io',                alchemy: 'arb-mainnet',      osSlug: 'arbitrum',  weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', rpcs: ['https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org', 'https://arb1.arbitrum.io/rpc'] },
  optimism:  { id: 10,       name: 'Optimism',   symbol: 'ETH',  explorer: 'https://optimistic.etherscan.io',    alchemy: 'opt-mainnet',      osSlug: 'optimism',  weth: '0x4200000000000000000000000000000000000006', rpcs: ['https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org', 'https://mainnet.optimism.io'] },
  polygon:   { id: 137,      name: 'Polygon',    symbol: 'POL',  explorer: 'https://polygonscan.com',            alchemy: 'polygon-mainnet',  osSlug: 'matic',     weth: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://polygon-rpc.com'] },
  bsc:       { id: 56,       name: 'BSC',        symbol: 'BNB',  explorer: 'https://bscscan.com',                alchemy: 'bnb-mainnet',      osSlug: 'bsc',       weth: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org', 'https://bsc-dataseed.binance.org'] },
  avalanche: { id: 43114,    name: 'Avalanche',  symbol: 'AVAX', explorer: 'https://snowtrace.io',               alchemy: 'avax-mainnet',     osSlug: 'avalanche', weth: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', rpcs: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://avalanche.drpc.org'] },
  linea:     { id: 59144,    name: 'Linea',      symbol: 'ETH',  explorer: 'https://lineascan.build',            alchemy: 'linea-mainnet',    osSlug: 'linea',     weth: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f', rpcs: ['https://linea-rpc.publicnode.com', 'https://linea.drpc.org', 'https://rpc.linea.build'] },
  opbnb:     { id: 204,      name: 'opBNB',      symbol: 'BNB',  explorer: 'https://opbnbscan.com',              alchemy: 'opbnb-mainnet',    osSlug: 'opbnb',     weth: null,                                       rpcs: ['https://opbnb-rpc.publicnode.com', 'https://opbnb-mainnet-rpc.bnbchain.org'] },
  ink:       { id: 57073,    name: 'Ink',        symbol: 'ETH',  explorer: 'https://explorer.inkonchain.com',    alchemy: 'ink-mainnet',      osSlug: 'ink',       weth: '0x4200000000000000000000000000000000000006', rpcs: ['https://rpc-gel.inkonchain.com', 'https://ink.drpc.org'] },
  shape:     { id: 360,      name: 'Shape',      symbol: 'ETH',  explorer: 'https://shapescan.xyz',              alchemy: 'shape-mainnet',    osSlug: 'shape',     weth: '0x4200000000000000000000000000000000000006', rpcs: ['https://mainnet.shape.network'] },
  apechain:  { id: 33139,    name: 'Apechain',   symbol: 'APE',  explorer: 'https://apescan.io',                 alchemy: 'apechain-mainnet', osSlug: 'ape_chain', weth: '0xcF800F4948D16F23333508191B1B1591daF70438', rpcs: ['https://rpc.apechain.com', 'https://apechain.drpc.org'] },
  abstract:  { id: 2741,     name: 'Abstract',   symbol: 'ETH',  explorer: 'https://abscan.org',                 alchemy: 'abstract-mainnet', osSlug: 'abstract',  weth: '0x3439153EB7AF838Ad19d56E1571FBD09333C2809', rpcs: ['https://api.mainnet.abs.xyz'] },
  hyperevm:  { id: 999,      name: 'HyperEVM',   symbol: 'HYPE', explorer: 'https://hyperevmscan.io',           alchemy: null,               osSlug: null,        weth: null,                                       rpcs: ['https://rpc.hyperliquid.xyz/evm'] },
  megaeth:   { id: 4326,     name: 'MegaETH',    symbol: 'ETH',  explorer: 'https://megaexplorer.xyz',          alchemy: null,               osSlug: null,        weth: null,                                       rpcs: ['https://carrot.megaeth.com/rpc'] },
  monad:     { id: 143,      name: 'Monad',      symbol: 'MON',  explorer: 'https://monadexplorer.com',         alchemy: 'monad-mainnet',    osSlug: null,        weth: null,                                       rpcs: ['https://rpc.monad.xyz'] },
  bittensor: { id: 964,      name: 'Bittensor',  symbol: 'TAO',  explorer: 'https://evm.taostats.io',           alchemy: null,               osSlug: null,        weth: null,                                       rpcs: ['https://lite.chain.opentensor.ai'] },
  robinhood:  { id: 4663,     name: 'Robinhood',  symbol: 'ETH',  explorer: 'https://robinhoodchain.blockscout.com', alchemy: 'robinhood-mainnet', osSlug: 'robinhood', weth: null, rpcs: ['https://rpc.mainnet.chain.robinhood.com'], conduit: '0x963f00d3ff000064ffcba824b800c0000000c300', hidden: false },
  zora:      { id: 7777777,  name: 'Zora',       symbol: 'ETH',  explorer: 'https://explorer.zora.energy',      alchemy: 'zora-mainnet',     osSlug: 'zora',      weth: '0x4200000000000000000000000000000000000006', rpcs: ['https://rpc.zora.energy'] },
  sepolia:   { id: 11155111, name: 'Sepolia',    symbol: 'ETH',  explorer: 'https://sepolia.etherscan.io',      alchemy: 'eth-sepolia',      osSlug: 'sepolia',   weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', rpcs: ['https://ethereum-sepolia-rpc.publicnode.com'], hidden: true, testnet: true },
};

function customChains() {
  try {
    const store = require('./store');
    const d = store.readPlain('custom_chains', { items: [] });
    const out = {};
    for (const c of d.items || []) {
      if (!c.key || !c.id) continue;
      out[String(c.key).toLowerCase()] = {
        id: Number(c.id), name: c.name || c.key, symbol: c.symbol || 'ETH',
        explorer: c.explorer || null, alchemy: null, osSlug: c.osSlug || null,
        weth: c.weth || null, rpcs: Array.isArray(c.rpcs) ? c.rpcs : String(c.rpcs || '').split(/[\s,]+/).filter(Boolean),
        custom: true,
      };
    }
    return out;
  } catch { return {}; }
}

function all() { return { ...CHAINS, ...customChains() }; }

function addCustom(c) {
  const store = require('./store');
  if (!c || !c.key || !c.id) throw new Error('key and id required');
  const key = String(c.key).toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (CHAINS[key]) throw new Error(`${key} is a built-in chain`);
  const rpcs = Array.isArray(c.rpcs) ? c.rpcs : String(c.rpcs || '').split(/[\s,]+/).filter(Boolean);
  if (!rpcs.length) throw new Error('at least one RPC URL required');
  const d = store.readPlain('custom_chains', { items: [] });
  d.items = (d.items || []).filter((x) => String(x.key).toLowerCase() !== key);
  d.items.push({ ...c, key, id: Number(c.id), rpcs });
  store.writePlain('custom_chains', d);
  return chain(key);
}

function removeCustom(key) {
  const store = require('./store');
  const d = store.readPlain('custom_chains', { items: [] });
  d.items = (d.items || []).filter((x) => String(x.key).toLowerCase() !== String(key).toLowerCase());
  store.writePlain('custom_chains', d);
  return true;
}

function chain(key) {
  const c = all()[String(key || '').toLowerCase()];
  if (!c) throw new Error(`unknown chain: ${key}`);
  return { key: String(key).toLowerCase(), ...c };
}

function byId(id) {
  const a = all();
  const k = Object.keys(a).find((k) => a[k].id === Number(id));
  return k ? chain(k) : null;
}

function list() { return Object.keys(all()).map(chain); }

module.exports = { CHAINS, chain, byId, list, addCustom, removeCustom, all };
