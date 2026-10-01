# Automation Progress

## 2026-08-09 scheduled run (mintV2 upgraded to CURRENT 32-account program — bundle-verified)

- Read `/home/ubuntu/Documents/ObsidianVault/NFT Minting Notes.md`; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint input supplied → nothing minted, no broadcast.
- **State audited first**: prior run's files intact (`planMintV6`/`planMintV2` present, selfCheck PASS). Highest-priority gap found: `planMintV2` targeted the OLD 14-account `nft_candy_machine` IDL on `LEGACY_CANDY` (ArAA6), but the LIVE site bundle 8242 (`eo`/`mintCompressed` + `es`) mints CV2/Candy machines via **`mintV2` on the CURRENT program `F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf` (MINT_PROGRAM) with 32 accounts** — the saved `V2_ACCOUNTS` order was verified 1:1 against the bundle `.accounts({...})` call.
- **Bundle-verified facts (chunk 8242, verbatim):**
  - `r.methods.mintV2({proof, amount:1, expectedPrice}, cnftWlEntry, targetPhase=1)` → args = MintInput (proof vec, expectedPrice u64, amount u32) + cnft + targetPhase (`encMachineMintInput` shape).
  - `wallet2` = literal `33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VFFdJGF5` (FEE_KEY) — **confirms wallet2 for mintV2** (was an open verification gap).
  - `requiredSigner` = `I` = caller wallet pubkey (public phases); sentinel relay only when phase.requiredSigner == `8jjyTattFNWxizCenUe99U3nh9VHKELuFez2sn1RqhHv` (zyper dump line 35858 verbatim).
  - `tree` = `axkvaYVWWopHZJzPBsfLJcHQNecHy8L4vvMTYPjaY9N` (mainnet const, `d.C` false branch), `treeAdmin` = PDA `["TreeDelegate"]` on MINT_PROGRAM, `treeAuthority` = PDA `[tree]` on BUBBLEGUM, `extension` = PDA `["extension", machine]` on MINT_PROGRAM, `totalMints` = `ef()` = PDA `["TotalMints", buyer, machine, name<=32]` on MINT_PROGRAM.
  - `remainingAccounts` = `[...canopy, {pubkey: m.sy}]` where `m.sy` = **TOKEN22** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`, module 85889).
  - Legacy `es` (old program mintV2, 14 accs, `mint` signer, wallet2=FEE_KEY) confirmed as distinct path; kept as `planMintV2Legacy`.
- **Changes (minimal):**
  - `src/lmnsol.js`: `planMintV2` rewritten to CURRENT 32-account mintV2 on MINT_PROGRAM (V2_ACCOUNTS order, optional-account filtering, remaining = canopy + TOKEN22 + currency ATAs); legacy 14-account kept as `planMintV2Legacy` (exported).
  - `src/solmint.js`: `lmn-candy-v2` branch now passes `phase {name,price,proof,qty}` + `collection` and uses `plan.keys` — still SIMULATE-ONLY (state.mode='simulate' hardcoded, no relay, no broadcast).
  - `src/launchpads.js`: LMN resolver stage now includes `maxSupply/totalMints/soldOut` from SSR (`hasSoldEnough`, `fractionMinted>=1`, totals) — read-only.
- Evidence: `node --check` PASS on lmnsol/solmint/launchpads/eligibility/server/submit/xmodule/wallets/rpc + `public/js/social.js`; `selfCheck` PASS (discs mintV2 `e2ce3924...`, all 5 PDA derivations valid); smoke: planV2 = 25 keys (32 minus 7 optionals), data disc `e2ce39243e4ec738` len 27, remaining=[TOKEN22]; `solmint.buildTx` builds legacy tx for BOTH lmn-candy-v2 and lmn-candy-v6 (no broadcast). Live GET probes: LMN `/mint/theconmen` HTTP 200 → SSR Core, stage soldOut=true (3333/3333, price 0.15), blueprint program F9Six..., machine `56vhrBzzvftnWEyYmdEgpEML58MAZa2nnqzGgz7isGAV`; Scatter invalid slug HTTP 404. `jaio.service` inactive. Repo not a Git worktree.
- Blockers: Core (`mintCore`) still platform-locked (needs verified Asset/Params accounts for theconmen-class machines); Firestore web key for whitelist/phase REST still redacted in bundle; no live Candy CV2 collection URL with open public phase to exercise simulate end-to-end; Scatter mint endpoint schema unverified (resolver stays read-only); Transient ERC1155TL platform-locked.
- No tx broadcast, signing, approval, transfer, mint POST, relay POST, social submission, deployment, push, or API-credit spend. Network probes GET-only (relay endpoint not POSTed).

## 2026-08-09 scheduled run (Candy builders RESTORED + program-id corrected — verified from bundles + on-chain)

- Read `/home/ubuntu/Documents/ObsidianVault/NFT Minting Notes.md` first; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint input supplied → nothing minted.
- **State audited first**: `src/solmint.js` branches `lmn-candy-v6`/`lmn-candy-v2` called `lmn.planMintV6`/`lmn.planMintV2` which were MISSING on disk (prior run's changes lost) → both branches would throw at runtime. Highest-priority unfinished item.
- **Major correction (was hidden bug):** `LEGACY_CANDY` was set to `33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VFFdJGF5` — on-chain check proves that address is a **plain wallet** (~750 SOL, executable=false). The REAL legacy `nft_candy_machine` program is **`ArAA6CZC123yMJLUe4uisBEgvfuw2WEvex9iFmFCYiXv`** — extracted from live site bundle (module 8361 in `5060-a410021a79d5c83b.js`: `new PublicKey("ArAA6CZC123yMJLUe4uisBEgvfuw2WEvex9iFmFCYiXv")` used as program id, verified executable=true on-chain). `FEE_KEY` (`33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VFFdJGF5`) stays = the fee wallet that appears as `wallet2` on every mint (bundle 8242 literal).
- **Plan builders restored + hardened:**
  - `planMintV6` (legacy 14 accounts, program corrected to ArAA6; payer & mint now signers per IDL; returns `data`/`accounts`/`discriminator` consumed by solmint).
  - `planMintV2` (legacy 14 accounts incl. rent+clock sysvars; `creatorBump`/`totalMintsBump` from `findProgramAddressSync`; proof `Option<vec<[u8;32]>>` = `encOpt(encProof)`) — SOL checks passed: creatorBump 254, totalMintsBump 255, data hex `e2ce3924...` (IDL discriminator e2ce is correct).
  - PDA derivations switched from ASCII-32 (`k32` of pubkeys) to raw pubkey bytes (`pb`) — matches site bundle (`e.toBuffer()`), incl `treeAuthority = pda([pb(TREE)], bubblegum)` in CV3.
  - Added resolver aliases (`CANDY_PROGRAM`, `REQUIRED_SIGNER`) and fixed `launchpads.js` to return `requiredSigner` (was accidentally the relay URL).
- Evidence: `node --check` on lmnsol/solmint/launchpads/eligibility/server/submit/xmodule + `public/js/social.js` all PASS; `selfCheck()` PASS (disc clean); plan smoke test PASS (14 accounts each, program ArAA6, wallet2==fee); `solmint.buildTx` for both methods builds a transaction (no broadcast; `state.mode='simulate'` is hardcoded; simulate PASS path reports "broadcast disabled").
- Live read-only probes: lmn home HTTP 200/0 redirects; relay endpoint GET → 400 (POST-only, no POST sent); Scatter invalid slug HTTP 404/0 redirects. `jaio.service` inactive. Repo not a Git worktree.
- Social audit: no Google Forms path in src//capture//public/js/; only generic UI POSTs. No changes.
- Blockers: exact on-chain mintV2 tx evidence still absent (program favors idle currently; no recent mintV6/mintV2 observed in ~320 recent sigs to ArAA6 — legacy machines largely migrated); Firestore web key for whitelist phases still redacted in bundle; Core still platform-locked (mintCore accounts need verified Asset/Params); Scatter mint POST schema unverified. All simulated paths remain simulate-only.
- No tx broadcast, signing, approval, transfer, mint POST, relay POST, social submission, deployment, push, or API-credit spend. Network probes GET-only.

- Read `/home/ubuntu/Documents/ObsidianVault/NFT Minting Notes.md` first; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint input supplied. No mint executed.
- New Zyper binary evidence (`/tmp/zyper_strings.txt`):
  - line 35941: `LaunchMyNFT version %q is not supported yet (Core and CV2 only)` ⇒ Zyper LMN gate = Core + Candy V2. Our prior Candy worker targeted live-site mintV6 (newer caches). For 1:1 parity added the CV2 path.
  - line 36027: `launchmynft: phase %q is %s; only public and wallet allowlist phases are supported` ⇒ phase kinds public|wallet; no proof API (line 35890 `whitelist root mismatch: got %s, on-chain %s` confirms client-built merkle root checked on-chain).
  - line 35889-90: `zyper diagnostics bundle`, `balance %s wei is not enough for gas reserve %s wei`, relay + `__NEXT_DATA__` markers reconfirmed.
  - Go type table confirms platform workers: mintbay/blever/scatter/transient (`*scatter.InviteList`, `*scatter.mintResponse`, `*transient.Phase`, `mintbayRPCURLs`, `transientRPCURLs`) — all resolvers already present in `src/launchpads.js`; scatter/transient/mintbay stay read-only.
- Changes (minimal):
  - `src/lmnsol.js`: added `planMintV2` (Candy V2 / CV2 path) — 14 accounts byte-for-byte from saved IDL `docs/launchmynft-nft-candy-idl.json` (`global:mintV2` discriminator `e2ce3924`), bumps computed via new `findPdaInfo` (`creatorBump`/`totalMintsBump`), relay shape same as mintV6, `verificationGaps: ['wallet2 pubkey: mintV6 uses programId; mintV2 NOT confirmed']`, simulate-only.
  - `src/lmnsol.js`: `selfCheck()` now also validates mintV2 discriminator + 14-account plan + bump range (SYSVAR_RENT/CLOCK imports added).
  - `src/solmint.js`: `buildTx` branch `lmn-candy-v2` (build+simulate only, same guardrail as v6; relay never called, proof arg optional, no broadcast path).
  - `src/launchpads.js`: LMN resolver comment/note updated with Zyper parity gate evidence; version gate unchanged (candy|core); Core still platform-locked.
- Evidence: `node --check` OK on lmnsol.js/solmint.js/launchpads.js; `selfCheck` PASSED (discriminatorV2 `e2ce3924`, bumps `{creatorBump:254,totalMintsBump:253}`, 14 accounts, 1 gap); live GET probes: LaunchMyNFT HTTP 200/0 redirects, Scatter invalid slug HTTP 404/0 redirects; `jaio.service` inactive. Repo NOT a git worktree.
- Blockers unchanged: Firestore web key for whitelist/phase REST (redacted in bundle); no live Candy CV2 collection URL to confirm `wallet2` slot for mintV2; no mintV2 tx observed on-chain; Core locked. Scatter mint endpoint schema unverified.
- No tx broadcast, signing, approval, transfer, mint POST, relay POST, social submission, deployment, push, or API-credit spend. All network probes GET-only.

## 2026-08-09 scheduled run (Zyper binary strings verification — Candy worker cross-checked)

- Read `/home/ubuntu/Documents/ObsidianVault/NFT Minting Notes.md` first; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint request, no mint input supplied.
- **Cross-verified the Candy worker against the Zyper binary strings dump (`/tmp/zyper_strings.txt`, 7,991,851 B):**
  - line 35858: required signer `8jjyTattFNWxizCenUe99U3nhVHKELuFez2sn1RqhHv` and candy program `33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VdJGF5` verbatim ⇒ matches `src/lmnsol.js` constants.
  - line 35890: `https://www.launchmynft.io/api/mint/required-signer` + SSR `__NEXT_DATA__` script marker (relay + page shape confirmed).
  - line 35760: `launchmynft: machine: %w` + `application/octet-stream` (relay request body type = raw serialized tx bytes).
  - line 35890: `whitelist root mismatch: got %s, on-chain %s` — whitelist list fetched, Merkle root built client-side, verified on-chain; no proof API (matches notes).
  - UI bundle (line 52741): drop resolve returns phases kind public|wallet with `{key,label,startUnix,defaultQty,maxPerWallet,requiredSigner,index,priceSol}`; Mint URL regex `(?:www\.)?launchmynft\.io\/(?:mint|sol)\/[a-z0-9_-]+`; task params `{machine,collection,nameBank,lookupTable,dropUrl,owner,documentId}`.
  - Scatter structs in binary: `scatter.inviteListResponse` fields `json:"token_price"`,`json:"wallet_limit"`,`json:"merkleRoot"` ⇒ live resolver field names confirmed.
- **Changes (minimal):** `src/launchpads.js` — LMN URL regex now accepts `(?:www\.)?` + `/sol/<slug>` (Zyper-verified shape) while keeping `/collections|mint`; Scatter invite-list root now reads `l.root || l.merkleRoot`. `src/lmnsol.js` — header comment adds the Zyper binary evidence trail; no behavioral change. No mint relay, no POST.
- Evidence: `node --check` OK on launchpads/lmnsol/solmint/eligibility/server/xmodule + `public/js/social.js`; `lmnsol.selfCheck()` passed (`discriminator af327905`, 5 PDA derivations valid base58); live GET probes: LaunchMyNET homepage HTTP 200/0 redirects; Scatter invalid slug HTTP 404/0 redirects; `jaio.service` inactive.
- Social audit: no Google Forms/forms.gle path exists in `src/` or `capture/` (grep clean) — nothing to constrain; X actions only via `src/xmodule.js` direct API calls (read-only audit, no change). Transient ERC1155TL still platform-locked (no new evidence).
- Blockers unchanged: Firestore public web key for whitelist/phase REST fetch not extracted; no live Candy collection URL to exercise builder end-to-end; Scatter mint endpoint schema still unverified ⇒ no mint POST path.
- No tx broadcast, signing, approval, transfer, mint POST, relay POST, social submission, deployment, push, or API-credit spend. All network probes GET-only.

## 2026-08-09 scheduled run (Candy builder verified — simulate-only worker built)

- Read `/home/ubuntu/Documents/ObsidianVault/NFT Minting Notes.md` first; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint request, no mint input supplied.
- **Resolved the missing-verification blocker: extracted live launchmynft.io client bundles** (static chunks 8242 + 2238, fetched read-only) and recovered the exact Candy mint path:
  - nft_candy_machine program `33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VFFdJGF5` (validated 32-byte).
  - `mintV6` account layout (14 accs, order verified): candyMachine, payer(signer), wallet, wallet2==programId(!), metadata, mint(signer), associated(ATA), masterEdition, totalMints, ATA-prog, MPL, token, system, sysvar.
  - PDA derivations (bundle fn ef/eU/eW/eG/ez/eJ): `["TotalMints",cm,name32]`, `["candy_machine",owner,name]`, `["candy_machine",cm]` (candyMachineCreator), `["whitelist",cm]`, `["metadata",mpl,mint](+["edition"])`, `[owner,TOKEN,mint]` ATA. Names: uuid6 = `machine.toBase58().slice(0,6)`.
  - Required-signer relay **byte-exact**: POST `/api/mint/required-signer`, body = raw serialized tx bytes (wallet-signed, legacy or V0+lookupTable), response = raw serialized tx bytes w/ server signature appended; sentinel signer pubkey `8jjyTattFNWxizCenUe99U3nh9VHKELuFez2sn1RqhHv`; relay invoked only when `phase.requiredSigner == sentinel`; chunk-bundle shows retries 5 retryOn[429].
  - Firestore whitelist paths: `Users/{owner}/Collections/{documentId}` (+ `/Extras/Whitelist` doc = `{phaseIdx: [wallets]}`, `/Extras/Whitelist/Phases` subcollection) — project `launch-my-nft`; public Firestore web key still redacted in bundle ⇒ NOT fetched.
  - Whitelist modes (fazeMode): public / publicDynamic / walletBased (list in doc) / tokenBased / nftBased(Multi).
- Delivered: new `src/lmnsol.js` (simulate-only Candy worker: verified derivations, planMintV6, selfCheck), wired `src/solmint.js` method `lmn-candy-v6` (build only, simulate only; relay NOT callable), resolver `src/launchpads.js` LaunchMyNET adds verified blueprint to SSR result.
- Evidence: `node --check` OK on lmnsol/solmint/launchpads/eligibility/server/submit/xmodule + `public/js/social.js`; `selfCheck` passed (discriminator `af327905` for `global:mintV6`); plan built with the real SSR machine pubkey from the saved The Conmen SSR snapshot (`56vhrBzzvftnWEYyYmdEgpEML58MAZa2nnqzGgz7isGAV` from /tmp/lmn_collection.json), 14 accounts, all derivations computed.
- Live read-only probes: `GET /api/mint/required-signer` → HTTP 400 (endpoint exists, POST-only; no POST sent); homepage HTTP 200/0 redirects; scatter invalid slug → HTTP 429 (rate-limited; prev run 404) — no change.
- `jaio.service` inactive. Repo NOT a git worktree — independent review/commit unavailable.
- Blockers this run: Firestore public web key needed for phase/whitelist REST fetch (redacted in bundle); theconmen is a **Core** (`mintMachine`) collection ⇒ Core path remains platform-locked; no live Candy (V2/V3/V4/V6) collection URL to exercise the builder end-to-end with real machine account.
- No tx broadcast, signing, approval, transfer, mint POST, relay POST, social submission, deployment, push, or API-credit spend. All network activity was GET-only.

## 2026-08-09 scheduled run

- Read `/home/ubuntu/Documents/ObsidianVault/NFT Minting Notes.md` first.
- Audited LaunchMyNFT resolver against `/tmp/zyper_strings.txt` and `docs/dumpstr-launchmynft-re.md`.
- Hardened LaunchMyNFT SSR schema: requires `owner`, `documentId`, `collectionMint`, `version`, `type`; rejects non-Solana/unknown versions.
- Candy path remains simulate-only; Core remains platform-locked pending exact client accounts/instruction verification.
- Evidence: `node --check src/launchpads.js`, `node --check src/eligibility.js`, `node --check src/solmint.js` passed.
- Service status: checked; no activation performed.
- Blockers: exact Candy client builder, PDA/account derivations, required-signer response shape, Firestore whitelist schema remain unverified. No live mint input supplied.
- Scatter resolver hardened: validated collection/chain schema, exact numeric chain ID, read-only invite-list schema, checksum address, explicit malformed-entry rejection; unavailable eligibility remains distinct from empty lists.
- Evidence: syntax checks passed; host allowlist probe passed (`scatter.art.evil` rejected, HTTP rejected); Scatter API invalid-slug probe returned HTTP 404.
- No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (parity audit)

- Re-read NFT Minting Notes; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint input/request.
- Audited current LaunchMyNFT resolver plus saved IDL/RE notes and `/tmp/zyper_strings.txt`; exact Candy client builder, PDA/account derivations, whitelist schema, and required-signer response remain unverified. No speculative implementation.
- Verified resolver exports and syntax: `node --check src/launchpads.js`, `src/eligibility.js`, `src/solmint.js` passed; LaunchMyNFT and Scatter adapters present.
- Live read-only probes: LaunchMyNFT homepage HTTP 200; Scatter invalid-slug API HTTP 404.
- Service status: `jaio.service` = `inactive`.
- Repository remains outside Git worktree; independent code-review/commit unavailable. No code changes this run.
- No live mint input. No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (latest audit)

- Re-read NFT Minting Notes; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint request.
- Audited LaunchMyNFT against `/tmp/zyper_strings.txt`, saved RE notes, and Candy IDL. Exact client builder, phase/whitelist fetch schema, `candyMachineCreator` derivation, asset/account construction, and required-signer response remain unverified; no implementation.
- Scatter remains read-only; no verified mint POST/calldata path. Transient ERC1155TL remains platform-locked.
- Evidence: `node --check src/launchpads.js`, `src/eligibility.js`, `src/solmint.js`, `src/server.js` passed; LaunchMyNFT HTTP 200/0 redirects; Scatter invalid-slug HTTP 404/0 redirects; `jaio.service` inactive.
- Repository is not a Git worktree; independent review/commit unavailable. No code changes.
- No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (latest)

- Re-read NFT Minting Notes; no mint request. ETH SeaDrop CA unchanged.
- Highest-priority blocker unchanged: exact LaunchMyNFT Candy builder, PDA/account derivations, required-signer relay shape, whitelist schema unavailable. Core remains unimplemented.
- Resolver audit: LaunchMyNFT/Scatter paths remain read-only; SSRF/HTTPS/redirect/size guards present; no speculative edits.
- Evidence: `node --check src/launchpads.js`, `src/eligibility.js`, `src/solmint.js` passed. Live probes: LaunchMyNFT HTTP 200; Scatter invalid slug HTTP 404.
- Service: `jaio.service` inactive.
- No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (latest)

- Re-read NFT Minting Notes; no mint request. ETH SeaDrop CA unchanged.
- No safe implementation available: exact Candy builder/PDA/accounts/required-signer response remain unverified in `/tmp/zyper_strings.txt` and saved artifacts.
- No code changes. Syntax checks passed. Live read-only probes passed: LaunchMyNFT HTTP 200; Scatter invalid slug HTTP 404.
- Service inactive. No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (verification)

- Re-read NFT Minting Notes; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint instruction.
- Audited LaunchMyNFT evidence against `/tmp/zyper_strings.txt`, `docs/dumpstr-launchmynft-re.md`, and `docs/launchmynft-nft-candy-idl.json`.
- Candy builder remains unsafe to implement: exact phase/whitelist fetch schema, `candyMachineCreator` derivation, asset/account construction, and required-signer response shape remain unverified. Core remains platform-locked.
- Scatter schema remains read-only; no verified mint POST path.
- Evidence: `node --check src/launchpads.js`, `src/eligibility.js`, `src/solmint.js` passed; `jaio.service` inactive; repository is not a Git worktree, so independent review/commit unavailable.
- No code changes. No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (latest audit)

- Re-read NFT Minting Notes; target remains ETH SeaDrop CA `0xfc72fac274644d026290979bb7fde3b54c5f3c90`; no mint instruction.
- Audited LaunchMyNFT/Scatter resolver against `/tmp/zyper_strings.txt` and saved RE/IDL artifacts. Candy exact builder, PDA/account derivations, whitelist/phase schema, required-signer response remain unverified; Core remains platform-locked. No speculative edit.
- Live read-only probes: LaunchMyNFT HTTP 200; Scatter invalid slug HTTP 404; redirects 0. `jaio.service` inactive.
- Evidence: `node --check src/launchpads.js`, `src/eligibility.js`, `src/solmint.js`, `src/server.js` passed.
- Repository is not a Git worktree; independent code review/commit unavailable. No code changes.
- No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (audit)

- Re-read NFT Minting Notes; no mint request. ETH SeaDrop CA unchanged.
- LaunchMyNFT Candy remains blocked: `/tmp/zyper_strings.txt` confirms `requiredSigner` and `newCandyMachineAccountId`, but no verified `candyMachineCreator`/`mintV2`/`mintV6` strings. Existing IDL/RE still lacks exact client builder, PDA/account derivation, whitelist fetch schema, relay response shape.
- No speculative implementation. Core remains platform-locked.
- Live read-only probes: LaunchMyNFT HTTP 200; Scatter invalid-slug HTTP 404. Service `jaio.service` inactive.
- Evidence: `node --check src/launchpads.js`, `src/eligibility.js`, `src/solmint.js`, `src/server.js` passed.
- Repository is not a Git worktree; independent code review/commit unavailable.
- No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.

## 2026-08-09 scheduled run (latest parity audit)

- Audited LaunchMyNFT against `/tmp/zyper_strings.txt`, saved JS/IDL/RE artifacts. Exact Candy builder, phase/whitelist schema, `candyMachineCreator`, PDA/accounts, signer relay response remain unverified. No implementation.
- LaunchMyNFT simulate-only; Scatter read-only; Transient platform-locked.
- Live probes: LaunchMyNFT HTTP 200/0 redirects; Scatter invalid-slug HTTP 404/0 redirects. Service inactive.
- Evidence: all four `node --check` targets passed. Repository not Git worktree; independent review unavailable.
- Blocker: exact client artifacts or live collection URL plus verified phase/whitelist response. No guessed credentials/calldata.
- No tx broadcast, signing, approval, transfer, mint POST, social submission, deployment, push, or API-credit spend.
