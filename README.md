# J-AIO

Multi-wallet NFT automation suite — minting, encrypted wallet vault, whitelist eligibility checking, PnL analytics, and collection operations across **Robinhood Chain**, **EVM chains**, and **Solana**.

## Features

- **Mint engine** — SeaDrop / Manifold / Scatter / Transient / custom-contract mints, multi-wallet batch execution, FCFS mode, pre-flight simulation, per-wallet live progress
- **Encrypted vault** — AES-256-GCM wallet storage, scrypt KDF, session capability tokens, idle auto-lock
- **Whitelist checker** — batch eligibility checks against allowlist APIs / Merkle proofs, live per-wallet status matrix
- **Collection Manager** — holdings, transfers (disperse/consolidate), floor tracking, PnL report + PnL card generator
- **Sniper** — phase-open detection and automated execution
- **Solana mints** — candy machine (legacy + current program) support
- **Social / X module** — account management for raffle task flows
- **Infra pages** — RPC management, proxy management, gas presets

## Stack

Node.js (no framework), vanilla JS frontend, Python helpers. Single service on `localhost`.

## Setup

```bash
npm install
npm start        # runs src/server.js
```

All runtime state (wallets, secrets, settings) lives in `data/` — gitignored, never committed. This repository contains the system code only; no credentials are included.

## Structure

```
src/       backend modules (server, mint, vault, wl, pnl, chains, ...)
public/    frontend (vanilla JS + CSS)
contracts/ Solidity utilities (BatchNftSender)
scripts/   build helpers
capture/   browser extension for on-chain capture flows
docs/      reverse-engineering notes
```

## Security notes

- Vault master password is never stored; keys are derived at runtime (scrypt, N=131072)
- Mutating API routes require a per-session random capability token
- No private key ever leaves the vault except to sign locally at execution time
