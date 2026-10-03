# J-AIO

**Multi-wallet NFT automation suite** — minting, encrypted wallet vault, whitelist eligibility checking, PnL analytics, and collection operations across **Robinhood Chain**, **EVM chains**, and **Solana**.

Single self-hosted service: plain Node.js backend (no framework) + vanilla JS single-page frontend, bound to `localhost`.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Browser (SPA, vanilla JS)                      │
│  nav: Overview · Minting · NFT · Wallets ·      │
│       Identity · Infra                          │
└───────────────┬─────────────────────────────────┘
                │ JSON API + session capability token
┌───────────────┴─────────────────────────────────┐
│  Node.js HTTP server (src/server.js)            │
│  - vault-locked by default (423 until unlock)   │
│  - mutating routes require session token        │
│  - module registry (mint, wallets, wl, ...)     │
└───────┬──────────────┬──────────────┬───────────┘
        │              │              │
   EVM RPCs       Solana RPC      Marketplace APIs
 (Robinhood 4663, (candy machine) (Blockscout,
  ETH, Base, ...)                  OpenSea, Scatter)
```

- **No framework** — raw `http` server, module-based route registry (`src/*.js` each export their routes)
- **State** lives entirely in `data/` (gitignored): vault, wallets, settings, projects, caches
- **Keep-alive SPA routing** — every page renders once into its own container and is hidden (not destroyed) on navigation, so inputs, loaded NFTs and scroll position survive

### Security model

| Layer | Mechanism |
|---|---|
| Wallet storage | AES-256-GCM encrypted vault; key derived from master password via **scrypt** (KDF v2, N=131072; legacy v1 N=16384 auto-migrated) |
| Master password | Never stored — derived at runtime; vault files `0600`, dir `0700` |
| Session auth | Random 32-byte `base64url` capability token per session, constant-time comparison, invalidated on lock / idle timeout / shutdown |
| API surface | All mutating routes require the session token; vault-locked state returns `423` for everything except open routes (`state`, `unlock`, `chains`, `capture`) |
| Network | Binds to `127.0.0.1` only — not exposed through reverse proxies |
| Key handling | Private keys leave the vault only to sign locally at execution time; generated keys are shown **once** in a one-time export modal |
| Reads | Optional "public RPC only" mode so read calls never burn paid API quota |

---

## UI Modules

### Overview

| Page | Description |
|---|---|
| **Home** | Dashboard: portfolio overview, ETH/BTC ticker, recent activity feed |

### Minting

| Page | Description |
|---|---|
| **EVM Mint** | Full multi-wallet mint engine (see [Mint engine](#mint-engine) below) |
| **Quick Mint** | Streamlined single-collection mint flow with minimal configuration |
| **Solana Mint** | Candy machine mints: legacy 14-account path and current 32-account `mintV2` program (compressed NFTs, bubblegum tree accounts), per-wallet execution |
| **Check Eligible** | Batch eligibility checks for OpenSea drops / Scatter collections |
| **Tasks** | Task manager: queued and scheduled automation runs |

### NFT

| Page | Description |
|---|---|
| **Collection Manager** | Holdings per collection, PnL report generation, **PnL card PNG generator** (800×420, custom background/logo with automatic 16:9 center-crop, dark/light themes) |
| **Inventory & Transfer** | Token inventory across wallets; single & batch transfers, disperse and consolidate modes |
| **WL Checker** | Batch allowlist eligibility checking against a drop link: per-wallet live status (`Queued → Checking → Eligible / Not eligible / Error`), phase matrix, stop control, CSV export |
| **NFT Sniper** | Watches collections for phase opens / supply changes; alerts and optional automated execution |
| **Floor War & Offers** | Floor monitoring, batch listing, offer preview/accept, sweep, approvals |
| **Projects** | Saved project & phase configurations (per-collection mint presets) |

### Wallets

| Page | Description |
|---|---|
| **Wallets** | Vault management: generate, import, export, rename, bulk rename, groups, balance refresh |
| **Delegation Scan** | Scans all wallets for active token approvals/delegations; one-click revoke |

### Identity

| Page | Description |
|---|---|
| **Accounts** | X/Twitter account pool: add/remove, groups, proxy assignment, bulk connect/disconnect, connectivity tests |
| **X Engagement** | Engagement task execution (follow/like/reply flows) for raffle-style whitelists |
| **Form Submit** | Generic templated form-submission engine with saved templates and run history |

### Infra

| Page | Description |
|---|---|
| **RPC Endpoints** | RPC registry per chain: add, group, probe latency, seed defaults |
| **Proxies** | Proxy pool management: add, group, probe |
| **Chains** | Chain registry (Robinhood 4663, ETH, Base, Arbitrum, Polygon, ...), custom chains, private RPC overrides |
| **BTC Transfer** | Bitcoin transfers with fee estimation |
| **Gas Calculator** | EIP-1559 gas math helpers |
| **Settings** | Behaviour toggles (e.g. public-RPC-only reads), key management |
| **Logs** | Live log viewer (mint runs, WL checks, NFT ops, security, audit) |

---

## Mint engine

The EVM mint pipeline (`src/mint.js` + `src/launchpads.js`):

1. **Collection resolve** — contract/URL in → launchpad detection:
   - **SeaDrop / OpenSea drops** (`mintPublic` / `mintSigned`, payment-token aware)
   - **Manifold / Archetype** (merkle-gated `mint(auth, qty, affiliate, sig)`)
   - **Scatter** (EIP-1167 clones, `mint((bytes32,bytes32[]),uint256,address,bytes)`)
   - **Transient** (ERC-1155TL stacks, presale merkle + public phases)
   - **Custom ABI mode** — any contract, any function signature (auto-derived from selector when ABI is unavailable)
2. **Pre-flight per wallet** — `eth_call` simulation from each wallet before anything is broadcast: catches sold-out, per-wallet caps, wrong value, inactive phases
3. **Value guard** — tx value is locked to the verified phase price; mismatches abort
4. **Throttle handling** — two broadcast strategies:
   - *Parallel*: all nonces fetched up-front, single base fee, sign + send in one burst
   - *Sequential*: per-block throttled mints, retry with bumped priority
5. **Gas presets** — `ultra / low / normal / fast` (base-fee multiples + priority tiers)
6. **Live progress** — per-wallet status streamed to the UI (`/api/mint/events`)

Supporting modules: `src/abi.js` (ABI resolution: Etherscan/Blockscout/Sourcify + selector fallback), `src/chains.js` (chain registry), `src/rpc.js` (RPC groups + failover), `src/eligibility.js` (allowlist/drop eligibility), `src/submit.js` (generic signed-request submission).

---

## Repository structure

```
src/                 backend modules
  server.js          HTTP server, route registry, session guard, CSP
  store.js           encrypted vault (AES-256-GCM + scrypt), session capabilities
  wallets.js         wallet CRUD, generation, disperse/consolidate
  mint.js            EVM mint engine (preflight, broadcast, throttle modes)
  launchpads.js      launchpad resolvers (SeaDrop/Manifold/Scatter/Transient/OpenSea)
  solmint.js         Solana candy-machine mint planner
  wl.js              whitelist checker engine
  nftview.js         inventory, transfers
  nftops.js          listings, offers, sweep, floor war
  sniper.js          phase/supply watchdog
  pnl.js             multi-wallet PnL scanner (Blockscout public API)
  pnl_card.py        PnL card PNG renderer
  accounts.js        X/Twitter account pool
  xmodule.js         X engagement flows
  submit.js          generic form-submit engine
  taskmgr.js         task queue/scheduler
  chains.js          chain registry (Robinhood 4663, ETH, Base, ...)
  rpc.js / proxies.js  infra registries + probing
  btc.js / fxrate.js   BTC transfer + FX rates
  keys.js / abi.js     key probing + ABI resolution
  notify.js / activity.js  notifications + audit trail
public/              frontend (vanilla JS SPA, Poppins, light-blue theme)
contracts/           Solidity utilities (BatchNftSender)
scripts/             build helpers (batch sender artifact)
capture/             browser extension for on-chain capture flows
docs/                reverse-engineering notes
```

---

## Setup

```bash
npm install
npm start            # serves on http://127.0.0.1:8899
```

First run: open the UI, set a master password to initialize the vault, then generate or import wallets.

Runtime state (wallets, secrets, settings, logs) is created under `data/` and `logs/` — both gitignored. **This repository contains system code only; no credentials are included.**

## Requirements

- Node.js ≥ 18
- Python 3 (optional, only for `pnl_card.py` rendering — needs `pillow`)
