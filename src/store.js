'use strict';
/* Encrypted local store. AES-256-GCM, key derived from master password via scrypt.
 * Linux equivalent of J-AIO's DPAPI-sealed .dat files. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(__dirname, '..', 'logs');
for (const d of [DATA_DIR, LOG_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  else { try { fs.chmodSync(d, 0o700); } catch { /* best effort */ } }
}

const MAGIC = 'JAIO1';
let MASTER_KEY = null;          // Buffer(32) once unlocked
let SESSION_TOKEN = null;
const cache = new Map();        // name -> parsed object

/* KDF params. v1 = legacy (weak), v2 = current. Params are read from the
 * verify file so old vaults keep opening while new ones get the strong cost. */
const KDF = {
  1: { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
  2: { N: 1 << 17, r: 8, p: 1, maxmem: 320 * 1024 * 1024 },
};
const KDF_CURRENT = 2;

function deriveKey(password, salt, v) {
  const o = KDF[v] || KDF[KDF_CURRENT];
  return crypto.scryptSync(password, salt, 32, o);
}

function sealPath(name) { return path.join(DATA_DIR, name + '.dat'); }
function plainPath(name) { return path.join(DATA_DIR, name + '.json'); }

/* ---------- idle auto-lock ---------- */

let lastActivity = Date.now();
let idleMs = 15 * 60 * 1000;    // 0 disables
function touch() { lastActivity = Date.now(); }
function setIdleTimeout(minutes) {
  const n = Number(minutes);
  idleMs = !Number.isFinite(n) || n <= 0 ? 0 : Math.min(n, 24 * 60) * 60 * 1000;
  return idleMs / 60000;
}
function getIdleTimeout() { return idleMs / 60000; }
/* Returns true if it just locked the vault. */
function idleCheck() {
  if (!MASTER_KEY || !idleMs) return false;
  if (Date.now() - lastActivity < idleMs) return false;
  lock();
  return true;
}

/* ---------- master password lifecycle ---------- */

const VERIFY_FILE = path.join(DATA_DIR, 'vault.verify');

function isInitialized() { return fs.existsSync(VERIFY_FILE); }

function initMaster(password) {
  if (isInitialized()) throw new Error('vault already initialized');
  const salt = crypto.randomBytes(16);
  const key = deriveKey(password, salt, KDF_CURRENT);
  const check = crypto.createHmac('sha256', key).update('jaio-verify').digest();
  fs.writeFileSync(VERIFY_FILE, JSON.stringify({
    v: KDF_CURRENT, salt: salt.toString('base64'), check: check.toString('base64'),
  }), { mode: 0o600 });
  try { fs.chmodSync(VERIFY_FILE, 0o600); } catch { /* best effort */ }
  MASTER_KEY = key;
  SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');
  touch();
  return true;
}

/* ---------- unlock throttle ---------- */

let failCount = 0;
let lockoutUntil = 0;

function unlock(password) {
  if (!isInitialized()) throw new Error('vault not initialized');
  const now = Date.now();
  if (now < lockoutUntil) {
    throw new Error(`too many failed attempts — wait ${Math.ceil((lockoutUntil - now) / 1000)}s`);
  }
  const meta = JSON.parse(fs.readFileSync(VERIFY_FILE, 'utf8'));
  const key = deriveKey(password, Buffer.from(meta.salt, 'base64'), meta.v || 1);
  const check = crypto.createHmac('sha256', key).update('jaio-verify').digest();
  const stored = Buffer.from(meta.check, 'base64');
  const good = check.length === stored.length && crypto.timingSafeEqual(check, stored);
  if (!good) {
    failCount += 1;
    if (failCount >= 5) { lockoutUntil = now + Math.min(300, 5 * 2 ** (failCount - 5)) * 1000; }
    return false;
  }
  failCount = 0; lockoutUntil = 0;
  MASTER_KEY = key;
  SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');
  cache.clear();
  touch();
  migrateSettings();
  return true;
}

/* Verify a password without changing session state — used to gate key export.
 * Shares the same lockout counter so it cannot be used as a brute-force oracle. */
function verifyPassword(password) {
  if (!isInitialized() || !password) return false;
  const now = Date.now();
  if (now < lockoutUntil) throw new Error(`too many failed attempts — wait ${Math.ceil((lockoutUntil - now) / 1000)}s`);
  const meta = JSON.parse(fs.readFileSync(VERIFY_FILE, 'utf8'));
  const key = deriveKey(password, Buffer.from(meta.salt, 'base64'), meta.v || 1);
  const check = crypto.createHmac('sha256', key).update('jaio-verify').digest();
  const stored = Buffer.from(meta.check, 'base64');
  const good = check.length === stored.length && crypto.timingSafeEqual(check, stored);
  key.fill(0);
  if (!good) {
    failCount += 1;
    if (failCount >= 5) lockoutUntil = now + Math.min(300, 5 * 2 ** (failCount - 5)) * 1000;
  } else { failCount = 0; lockoutUntil = 0; }
  return good;
}

function lock() {
  if (MASTER_KEY) MASTER_KEY.fill(0);
  MASTER_KEY = null;
  SESSION_TOKEN = null;
  cache.clear();
}
function isUnlocked() { return MASTER_KEY !== null; }
function sessionToken() { return SESSION_TOKEN; }
function hasSessionToken(token) {
  if (!SESSION_TOKEN || typeof token !== 'string') return false;
  const a = Buffer.from(token); const b = Buffer.from(SESSION_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireUnlocked() { if (!MASTER_KEY) throw new Error('LOCKED'); }

/* ---------- sealed (encrypted) stores ---------- */

function readSealed(name, fallback) {
  requireUnlocked();
  if (cache.has(name)) return cache.get(name);
  const p = sealPath(name);
  if (!fs.existsSync(p)) { cache.set(name, fallback); return fallback; }
  const raw = fs.readFileSync(p);
  const magic = raw.subarray(0, 5).toString();
  if (magic !== MAGIC) throw new Error(`corrupt store ${name}`);
  const iv = raw.subarray(5, 17);
  const tag = raw.subarray(17, 33);
  const ct = raw.subarray(33);
  const d = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  d.setAuthTag(tag);
  const json = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  const obj = JSON.parse(json);
  cache.set(name, obj);
  return obj;
}

function writeSealed(name, obj) {
  requireUnlocked();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const out = Buffer.concat([Buffer.from(MAGIC), iv, c.getAuthTag(), ct]);
  const p = sealPath(name);
  fs.writeFileSync(p + '.tmp', out, { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
  cache.set(name, obj);
  return true;
}

/* ---------- plain stores (no secrets inside) ---------- */

function readPlain(name, fallback) {
  const p = plainPath(name);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writePlain(name, obj) {
  const p = plainPath(name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(p + '.tmp', p);
  return true;
}

/* ---------- settings: secrets sealed, rest plain ---------- */

const SECRET_FIELDS = [
  'etherscanKey', 'openseaKey', 'heliusKey', 'alchemyKey', 'flashbotsAuthKey',
  // plural = multi-key pools (newline/comma separated), same secrecy as singular
  'etherscanKeys', 'openseaKeys', 'heliusKeys', 'alchemyKeys',
];
const SECRET_SETTING_KEYS = new Set(SECRET_FIELDS);

function isSecretSetting(k) { return SECRET_SETTING_KEYS.has(k); }

/* Merged view. Secrets only present when unlocked. */
function readSettings() {
  const plain = readPlain('settings', {});
  for (const k of Object.keys(plain)) if (SECRET_SETTING_KEYS.has(k)) delete plain[k];
  if (!MASTER_KEY) return plain;
  let sec = {};
  try { sec = readSealed('settings_secrets', {}); } catch { sec = {}; }
  return { ...plain, ...sec };
}

function writeSettings(next) {
  requireUnlocked();
  const plain = {}; const sec = {};
  for (const [k, v] of Object.entries(next || {})) {
    if (SECRET_SETTING_KEYS.has(k)) sec[k] = v; else plain[k] = v;
  }
  writePlain('settings', plain);
  writeSealed('settings_secrets', sec);
  return readSettings();
}

/* One-time: pull any API keys that were left in plaintext settings.json
 * into the sealed store and scrub the plaintext copy. */
function migrateSettings() {
  if (!MASTER_KEY) return;
  const plain = readPlain('settings', null);
  if (!plain) return;
  const found = Object.keys(plain).filter((k) => SECRET_SETTING_KEYS.has(k) && plain[k]);
  if (!found.length) return;
  const sec = { ...(() => { try { return readSealed('settings_secrets', {}); } catch { return {}; } })() };
  for (const k of found) { sec[k] = plain[k]; delete plain[k]; }
  writePlain('settings', plain);
  writeSealed('settings_secrets', sec);
  appendLog('security.log', `migrated ${found.length} plaintext API key(s) into sealed store`);
}

/* ---------- append-only log ---------- */

/* Logs grow forever otherwise, and tailLog() reads the whole file into memory.
 * Rotate at 5 MB, keep one .1 generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfBig(p) {
  try {
    if (fs.statSync(p).size < MAX_LOG_BYTES) return;
    fs.renameSync(p, p + '.1');
  } catch { /* missing file or race — nothing to rotate */ }
}

function appendLog(file, line) {
  const stamp = new Date().toISOString();
  const p = path.join(LOG_DIR, path.basename(file));
  rotateIfBig(p);
  fs.appendFileSync(p, `[${stamp}] ${line}\n`, { mode: 0o600 });
}

function tailLog(file, n = 200) {
  const p = path.join(LOG_DIR, path.basename(file));
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  return lines.slice(-Math.max(1, Math.min(2000, n)));
}

/* ---------- server-facing aliases ---------- */

function isLocked() { return MASTER_KEY === null; }

/* First run: create the vault. Later runs: verify + unlock (throws on bad password). */
function initVault(password) {
  if (!password || String(password).length < 8) throw new Error('master password must be at least 8 characters');
  if (!isInitialized()) return initMaster(password);
  if (!unlock(password)) throw new Error('wrong master password');
  return true;
}

module.exports = {
  DATA_DIR, LOG_DIR,
  isInitialized, initMaster, initVault, unlock: (pw) => {
    if (!unlock(pw)) throw new Error('wrong master password');
    return true;
  },
  verifyPassword,
  sessionToken, hasSessionToken,
  lock, isUnlocked, isLocked, requireUnlocked,
  readSealed, writeSealed, readPlain, writePlain, appendLog, tailLog,
  readSettings, writeSettings, isSecretSetting, SECRET_SETTING_KEYS,
  touch, idleCheck, setIdleTimeout, getIdleTimeout,
};
