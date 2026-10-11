'use strict';
const store = require('./store');

const NAME = 'proxies';

function load() { return store.readSealed(NAME, { groups: [] }); }
function save(d) { return store.writeSealed(NAME, d); }
function nid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function addGroup(name) {
  const d = load();
  const g = { id: nid('pg'), name, proxies: [] };
  d.groups.push(g); save(d); return g;
}

function removeGroup(id) {
  const d = load();
  d.groups = d.groups.filter((g) => g.id !== id);
  save(d); return true;
}

function parseProxy(line) {
  const s = line.trim();
  if (!s) return null;
  if (/^(https?|socks5h?):\/\//i.test(s)) {
    const u = new URL(s);
    return {
      protocol: u.protocol.replace(':', ''), host: u.hostname, port: Number(u.port),
      user: decodeURIComponent(u.username) || null, pass: decodeURIComponent(u.password) || null,
    };
  }
  const p = s.split(':');
  if (p.length === 2) return { protocol: 'http', host: p[0], port: Number(p[1]), user: null, pass: null };
  if (p.length === 4) return { protocol: 'http', host: p[0], port: Number(p[1]), user: p[2], pass: p[3] };
  if (p.length === 5) return { protocol: p[0], host: p[1], port: Number(p[2]), user: p[3], pass: p[4] };
  throw new Error(`bad proxy format: ${s.slice(0, 30)}`);
}

function toUrl(p) {
  const auth = p.user ? `${encodeURIComponent(p.user)}:${encodeURIComponent(p.pass || '')}@` : '';
  return `${p.protocol}://${auth}${p.host}:${p.port}`;
}

async function probe(p, testUrl) {
  const { ProxyAgent, fetch } = require('undici');
  const url = testUrl || (store.readSettings().proxyTestUrl) || 'https://api.ipify.org?format=json';
  const t0 = Date.now();
  try {
    const agent = new ProxyAgent(toUrl(p));
    const r = await fetch(url, { dispatcher: agent, signal: AbortSignal.timeout(10000) });
    const body = await r.text();
    let ip = null;
    try { ip = JSON.parse(body).ip; } catch { ip = body.trim().slice(0, 40); }
    return { healthy: r.ok, latency: Date.now() - t0, ip };
  } catch (e) {
    return { healthy: false, latency: Date.now() - t0, error: String(e.message || e).slice(0, 100) };
  }
}

async function addProxies(groupId, text) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = [];
  for (const l of lines) {
    try {
      const p = parseProxy(l);
      if (!g.proxies.some((x) => x.host === p.host && x.port === p.port && x.user === p.user)) parsed.push(p);
    } catch { /* skip bad line */ }
  }
  const CONC = 15;
  for (let i = 0; i < parsed.length; i += CONC) {
    const batch = parsed.slice(i, i + CONC);
    const res = await Promise.all(batch.map((p) => probe(p)));
    batch.forEach((p, j) => {
      g.proxies.push({ id: nid('px'), ...p, healthy: res[j].healthy, latency: res[j].latency, ip: res[j].ip || null, error: res[j].error || null });
    });
  }
  save(d);
  return { added: parsed.length, total: g.proxies.length };
}

function removeProxy(groupId, proxyId) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  g.proxies = g.proxies.filter((p) => p.id !== proxyId);
  save(d); return true;
}

async function reprobeGroup(groupId, testUrl) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g) throw new Error('group not found');
  const CONC = 15;
  for (let i = 0; i < g.proxies.length; i += CONC) {
    const batch = g.proxies.slice(i, i + CONC);
    const res = await Promise.all(batch.map((p) => probe(p, testUrl)));
    batch.forEach((p, j) => { p.healthy = res[j].healthy; p.latency = res[j].latency; p.ip = res[j].ip || null; p.error = res[j].error || null; });
  }
  save(d);
  return g.proxies.map((p) => ({ id: p.id, host: p.host, port: p.port, healthy: p.healthy, latency: p.latency, ip: p.ip }));
}

function listSafe() {
  const d = load();
  return d.groups.map((g) => ({
    id: g.id, name: g.name, count: g.proxies.length,
    healthy: g.proxies.filter((p) => p.healthy).length,
    proxies: g.proxies.map((p) => ({ id: p.id, host: p.host, port: p.port, protocol: p.protocol, hasAuth: !!p.user, healthy: p.healthy, latency: p.latency, ip: p.ip })),
  }));
}

function getById(proxyId) {
  const d = load();
  for (const g of d.groups) {
    const p = g.proxies.find((x) => x.id === proxyId);
    if (p) return p;
  }
  return null;
}

function agentFor(proxyId) {
  if (!proxyId) return undefined;
  const p = getById(proxyId);
  if (!p) return undefined;
  const { ProxyAgent } = require('undici');
  return new ProxyAgent(toUrl(p));
}

let rr = 0;
function pickFromGroup(groupId) {
  const d = load();
  const g = d.groups.find((x) => x.id === groupId);
  if (!g || !g.proxies.length) return null;
  const healthy = g.proxies.filter((p) => p.healthy);
  const pool = healthy.length ? healthy : g.proxies;
  return pool[rr++ % pool.length];
}

module.exports = { load, save, addGroup, removeGroup, addProxies, removeProxy, reprobeGroup, listSafe, getById, agentFor, parseProxy, toUrl, probe, pickFromGroup };
