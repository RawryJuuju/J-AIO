# Zyper clone RE notes — dumpstr / launchmynft (2026-08-08)

**STATUS 2026-08-08: dumpstr.party = SKIP (user confirmed dead product; dashboard shows totalDrops=0, spins=0, all paused; site renders no collections). Do not build a dumpstr worker.**

Artifacts: probes under /home/ubuntu/probe/ (kept for reference only).

## dumpstr.party — mint instruction (EXACT, from 0xlekpucb0i4d.js)

Programs:
- host mintProgramAddress = 2zYn7CaP74GrL1xihLnw74dMxXy2DnAzu5MmnocRfmHD
- MPL Core mplCoreAddress = CoREENxT6tW1HoK8ypY1SxRMZTcVMSh79LMKKJ4PZ208x7d
- mintCollection program = 3RxiT9p6PiNffpxCKWXzpb5pNU9g6pj7o1D8BzZHTw3h
- RPC (site default): https://solana-mainnet.g.alchemy.com/v2/VzXQYzqtYxn0ODMTOHDQ

PDAs (seeds, program = mintProgramAddress):
- mint_config:  ["mint_config", collection]
- guard_group:  ["guard_group", mintConfig, label8]        // per guard label
- mint_count:   ["mint_count", mintConfig, label8, minter]
- allocation:   ["allocation",   mintConfig, label8]
- mint_authority: ["mint_authority", mintConfig]
label8 = first 8 bytes of ascii label ("VIP","GTD","FCFS","PUBLIC"), right-padded implicit
(encoder: 8-byte fixed array of string bytes).

Mint instruction (host program):
- data = borsh: discriminator [51,57,225,47,182,146,137,166] (8) ++ label(8) ++ allowedAmount(u16) ++ proof(array<[u8;32]>, u32 len)
- accounts in order:
  1 mintConfig            WRITABLE
  2 guard_group           READONLY
  3 mint_count            WRITABLE
  4 allocation            WRITABLE
  5 treasury              WRITABLE
  6 asset (new NFT asset) WRITABLE_SIGNER
  7 collection            WRITABLE
  8 mint_authority        READONLY
  9 minter (payer)        WRITABLE_SIGNER
  10 mplCoreAddress       READONLY
  11 systemProgram        READONLY
  12 Sysvar1nstructions   READONLY

Guard account struct (decode on-chain, base64): config(pubkey) ++ label(8) ++ guards:
  startDate Option<i64>, endDate Option<i64>,
  solPayment Option<lamports u64, destination>,
  mintLimit Option<id u8, limit u16>,
  allocation Option<id u8, limit u32>,
  allowList Option<merkleRoot [u8;32]>,
  tax Option<lamports u64, lastInstruction bool> (botTax),
  programGate Option<additional[]>
Mint config struct: admin, pendingAdmin, collection, treasury, unrevealedUri(string, u32 len prefix), mintAuthorityBump u8,
totalSupply u32, itemsMinted u32, tierCommitment [32], revealSeed [32], revealState u8, paused bool, bump u8, version u8.
mint_count account: count u16 + bump u8.

Allowlist proof: GET https://api.dumpstr.party/bags-mint-allowlist/<label>/<wallet>.json
  → {"amount": N, "root": "hex64", "proof": ["hex32", ...]} ; HTTP 403/404 = not allowed.
Allowed per phase = min(allowlist amount, mintLimit.limit, allocation.limit); public group = no proof, cap = mintLimit.

Mint tx: legacy VersionedTransaction; instruction per quantity; payer = minter; blockhash from getLatestBlockhash.
Missing piece: exact derivation of the `asset` pubkey for MPL Core (the site passes the asset account; a
"create asset" step happens elsewhere — see bundles with "mpl_core"/"assetV1"/"createAsset" — NOT YET EXTRACTED;
do not broadcast anything until asset derivation is resolved).

## launchmynft.io

Collection SSR: __NEXT_DATA__.props.pageProps.collection:
  collectionMint, newCandyMachineAccountId, lookupTableKey, collectionName, cost(str SOL), type "Solana",
  version "Core"|"Candy", maxSupply, totalMints, soldOut, owner, documentId, url.

Mint flow: tx is built client-side; serialized Transaction bytes (c.from(e.serialize())) POSTed to
  https://www.launchmynft.io/api/mint/required-signer  (retries 5, retryOn 429)
  → server adds their required signer → presumably returns the final tx → client broadcasts.
Whitelist: client-side MerkleTree from a fetched whitelist list (fetchWhitelist/getAssetProof in bundle),
  NO public proof endpoint.
Missing piece: the client tx builder (candy-machine v2 mintV2 / MPL Core mintV2 instruction + accounts,
  phase fetch URL "api/.../phases") — NOT yet extracted (bundle: 40657522f9.js, 2d9d66bb9e.js).
## launchmynft.io — RE Stage 1 (EXTRACTED, worker buildable)

- Program (nft_candy_machine custom): `33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VFFdJGF5`
- IDL full: docs/launchmynft-nft-candy-idl.json (extracted from lmnjs/ec6e2ae64b.js JSON.parse literal)
- mintV2 accounts: candyMachine, payer, candyMachineCreator, wallet, wallet2, metadata, mint, masterEdition, totalMints, tokenMetadataProgram, tokenProgram, systemProgram, rent, clock | args: creatorBump u8, totalMintsBump u8, proof vec<[u8;32]>
- mintV6 accounts: candyMachine, payer, wallet, wallet2, metadata, mint, associated, masterEdition, totalMints, associatedTokenProgram, tokenMetadataProgram, tokenProgram, systemProgram, instructionSysvarAccount | args: proof, expect, toggleState, expectedRefund
- Whitelist modes: public / merkle (proof from client-built MerkleTree of fetched whitelist list — no proof endpoint; list doc is in their Firestore, project `launch-my-nft` / `lmnft-pages`; site API keys are REDACTED in bundle "AIzaSy…" so Firestore REST needs the public web key from the live site later) / tokenBased / nftGate (wlNftTree)
- Required signer relay: POST https://www.launchmynft.io/api/mint/required-signer, body = serialized tx byte buffer (content-type application/octet-stream), retries 5 → the returned payload is the signed tx to broadcast (flow confirmed in lmnjs/40657522f9.js); collection config: __NEXT_DATA__.props.pageProps.collection (collectionMint, machineId ≥ col, type Solana, version Core|Candy, cost, soldOut...)
- STILL MISSING: (a) exact required-signer request/response shape (probe with UA+same-origin headers), (b) phases/whitelist list fetch (Firestore public key), (c) per-collection candyMachineCreator derivation (candymachine programAuthority = PDA ["candy_machine", candy] — verify), (d) Asset/Params for "Core" version mints (mintCore accounts NOT in this IDL — separate program).
