'use strict';
/* LaunchMyNFT Solana worker - FULL PARITY with launchmynft.io prod bundle (2026-08-09).
 * Sources: chunk 8242 mod 83413 (constants + PDA derivations), chunk 2238 (mint builders,
 * relay + priority-fee), chunk 2813 mod 82813 (compressed_minter IDL: account order + Option).
 * All strings verbatim from the bundle. SIMULATE-ONLY unless broadcast:true passed explicitly. */
const crypto = require('crypto');
const { PublicKey, Keypair, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } = require('@solana/web3.js');

/* ---------------- constants (verbatim) ---------------- */
const MINT_PROGRAM   = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf'; // compressed_minter: mintCore/mintCv3/mintV2/mintTm (bundle 8242 `M`, verified executable)
const FEE_KEY        = '33nQCgievSd3jJLSWFBefH3BJRN7h6sAoS82VFFdJGF5';   // wallet2 on every mint (bundle 8242 literal; on-chain = plain wallet ~750 SOL, NOT a program)
const LEGACY_CANDY   = 'ArAA6CZC123yMJLUe4uisBEgvfuw2WEvex9iFmFCYiXv';  // legacy nft_candy_machine program (bundle 5060 module 8361; verified executable on-chain)
const RELAY_SIGNER   = '8jjyTattFNWxizCenUe99U3nh9VHKELuFez2sn1RqhHv';
const RELAY_URL      = 'https://www.launchmynft.io/api/mint/required-signer';
const MPL_PROGRAM    = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
const BUBBLEGUM      = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
const COMPRESSION    = 'cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK'; // SPL account compression
const NOOP           = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';
const TOKEN_PROGRAM  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22        = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM    = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const AUTH_RULES     = 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9';
const TREE_MAINNET   = 'axkvaYVWWopHZJzPBsfLJcHQNecHy8L4vvMTYPjaY9N';
const CMT            = 'CMTQqjzH6Anr9XcPVt73EFDTjWkJWPzH7H6DtvhHcyzV';
const SITE_RPC       = 'https://annabelle-t1bcwh-fast-mainnet.helius-rpc.com/';
const JITO_URL       = 'https://mainnet.block-engine.jito.wtf/api/v1';
const SYSTEM         = SystemProgram.programId.toBase58();
const SYSVAR_I       = SYSVAR_INSTRUCTIONS_PUBKEY.toBase58();
const SYSVAR_SLOT    = SYSVAR_SLOT_HASHES_PUBKEY.toBase58();

/* ---------------- helpers ---------------- */
const enc = (s) => Buffer.from(String(s));
const k32 = (s) => enc(s).subarray(0, 32);
const pb = (s) => (s instanceof PublicKey ? s : new PublicKey(s)).toBuffer(); // pubkey seed = raw 32 bytes (bundle: e.toBuffer())
function pda(seeds, programId) {
  const [a] = PublicKey.findProgramAddressSync(seeds, new PublicKey(programId));
  return a.toBase58();
}
function discHex(name) { return crypto.createHash('sha256').update('global:' + name).digest('hex').slice(0, 16); }
function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n) || 1, 0); return b; }

/* ---------------- PDA derivations (seed-verified from bundle) ---------------- */
const derivations = {
  /* [TotalMints, buyerPub, machinePub, phaseName<=32] on MINT_PROGRAM (site getCmv2TotalMintsAddress: ef()) */
  totalMints: (wallet, machine, name, program = MINT_PROGRAM) => pda([enc('TotalMints'), pb(wallet), pb(machine), k32(name || 'Public')], program),
  /* [TotalMints, wallet, machine] older 3-seed */
  oldTotalMints: (wallet, machine, program = MINT_PROGRAM) => pda([enc('TotalMints'), pb(wallet), pb(machine)], program),
  /* [whitelist, machine] on-chain whitelist account */
  whitelist: (machine, program = MINT_PROGRAM) => pda([enc('whitelist'), pb(machine)], program),
  /* legacy candy PDAs */
  candyCreator: (machine) => pda([enc('candy_machine'), pb(machine)], LEGACY_CANDY),
  candyMachine: (owner, name) => pda([enc('candy_machine'), pb(owner), k32(name)], LEGACY_CANDY),
  extension: (machine) => pda([enc('extension'), pb(machine)], LEGACY_CANDY),
  /* metaplex metadata */
  metadata: (mint) => pda([enc('metadata'), pb(MPL_PROGRAM), pb(mint)], MPL_PROGRAM),
  masterEdition: (mint) => pda([enc('metadata'), pb(MPL_PROGRAM), pb(mint), enc('edition')], MPL_PROGRAM),
  collectionAuthorityRecord: (mint, authority) => pda([enc('metadata'), pb(MPL_PROGRAM), pb(mint), enc('collection_authority'), pb(authority)], MPL_PROGRAM),
  /* ATA */
  association: (owner, mint) => pda([pb(owner), pb(TOKEN_PROGRAM), pb(mint)], ATA_PROGRAM),
  /* core machine gallery markers */
  coreBank: (machine) => pda([enc('core_bank'), pb(machine)], MINT_PROGRAM),
  endowedBank: (machine) => pda([pb(machine), enc('edition_bank')], MINT_PROGRAM),
  choice: (machine, id) => pda([enc('choice'), pb(machine), u32le(id)], MINT_PROGRAM),
  treeAuthority: () => pda([enc('TreeDelegate')], MINT_PROGRAM),
  bubblegumSigner: () => pda([enc('collection_cpi')], BUBBLEGUM),
};

/* ---------------- anchor discriminators ---------------- */
const DISCS = {
  mintV6: discHex('mintV6'),
  mintV2: discHex('mintV2'),
  mintCore: discHex('mintCore'),
  mintCv3: discHex('mintCv3'),
  mintTm: discHex('mintTm'),
};

/* ---------------- borsh encoders (anchor-compatible) ---------------- */
function encU64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n || 0), 0); return b; }
function encU32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(Number(n) || 0, 0); return b; }
function encProof(proof) {
  const w = [encU32((proof || []).length)];
  for (const p of proof || []) w.push(Buffer.from(p));
  return Buffer.concat(w);
}
function encOpt(fn, val) { return val == null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), fn(val)]); }
/* CNFTWhitelistEntry: root, dataHash, creatorHash, assetId, nonce u64, index u32, creators vec<{address,share,verified}> */
function encCnft(wl) {
  const c = Buffer.concat((wl.creators || []).map((cr) => Buffer.concat([
    new PublicKey(cr.address).toBuffer(), Buffer.from([cr.share || 0]), Buffer.from([cr.verified ? 1 : 0]),
  ])));
  return Buffer.concat([
    Buffer.from(wl.root), Buffer.from(wl.dataHash), Buffer.from(wl.creatorHash),
    new PublicKey(wl.assetId).toBuffer(), encU64(wl.nonce || 0), encU32(wl.index || 0),
    encU32((wl.creators || []).length), c,
  ]);
}
/* MachineMintInput: proof vec, expectedPrice u64, amount u32, cnftWlEntry?, targetPhase? */
function encMachineMintInput(args) {
  return Buffer.concat([
    encProof(args.proof || []), encU64(args.expectedPrice || 0), encU32(args.amount || 1),
    encOpt(encCnft, args.cnftWlEntry), encOpt((v) => Buffer.from([v]), args.targetPhase),
  ]);
}
/* MintInput (mintV2): proof, expectedPrice u64, amount u32 */
function encMintInput(args) {
  return Buffer.concat([encProof(args.proof || []), encU64(args.expectedPrice || 0), encU32(args.amount || 1)]);
}
function ixData(instHex, argBufs) { return Buffer.concat([Buffer.from(instHex, 'hex'), ...argBufs]); }

/* ---------------- machine account decode (anchor mintMachineV2, IDL 2813) ---------------- */
function decodeMachine(buf) {
  const r = { off: 8 };
  const u8 = () => { const v = buf.readUInt8(r.off); r.off += 1; return v; };
  const bool = () => u8() === 1;
  const u16 = () => { const v = buf.readUInt16LE(r.off); r.off += 2; return v; };
  const u32 = () => { const v = buf.readUInt32LE(r.off); r.off += 4; return v; };
  const u64 = () => { const v = buf.readBigUInt64LE(r.off); r.off += 8; return Number(v); };
  const i64 = () => { const v = buf.readBigInt64LE(r.off); r.off += 8; return Number(v); };
  const pubkey = () => { const v = buf.subarray(r.off, r.off + 32); r.off += 32; return new PublicKey(v).toBase58(); };
  const str = () => { const n = u32(); const v = buf.subarray(r.off, r.off + n).toString('utf8'); r.off += n; return v; };
  const opt = (fn) => (u8() ? fn() : null);
  const arr = (fn) => { const n = u32(); const out = []; for (let i = 0; i < n; i++) out.push(fn()); return out; };

  const disc8 = buf.subarray(0, 8).toString('hex');
  const bump = u8(); const seed = pubkey(); const tableSlot = u64();
  const data = {
    authority: pubkey(), ordered: bool(), name: str(), url: str(), symbol: str(),
    creators: arr(() => ({ address: pubkey(), share: u8() })),
    sellerFeeBasisPoints: u16(), supply: u32(),
  };
  const sold = u32();
  const mtTag = u8();
  let machineType = 'unknown', collection = null, revealLater = false, mule = null;
  if (mtTag === 0) { machineType = 'Compressed'; collection = pubkey(); bool(); }
  else if (mtTag === 1) { machineType = 'FairLaunch'; pubkey(); }
  else if (mtTag === 2) { machineType = 'Liquid'; pubkey(); str(); }
  else if (mtTag === 3) { machineType = 'Core'; collection = pubkey(); revealLater = opt(() => true); }
  else if (mtTag === 4) { machineType = 'TokenMetadata'; collection = pubkey(); revealLater = opt(() => true); }
  else if (mtTag === 5) { machineType = 'CoreMule'; collection = pubkey(); mule = pubkey(); }
  else if (mtTag === 6) { machineType = 'CompressedCore'; collection = pubkey(); }
  else { r.off = buf.length; }
  const royaltyEnforced = u8(); const frozen = u8();
  const priceLock = { active: bool(), value: u64() };
  const gallery = { galleryReady: bool(), blindMintOnly: bool(), editions: bool() };
  r.off += 50; // padding
  const phases = arr(() => {
    const start = i64(); const price = u64(); const currency = opt(() => pubkey());
    const wmTag = u8();
    let wm = { kind: 'unknown' };
    if (wmTag === 0) { wm = { kind: 'wallet', mintsPerUser: u32(), merkleRoot: buf.subarray(r.off, r.off + 32).toString('hex') }; r.off += 32; }
    else if (wmTag === 1) { wm = { kind: 'token', tokenMint: pubkey(), burn: bool() }; }
    else if (wmTag === 2) { wm = { kind: 'public', mintsPerUser: opt(() => u32()) }; }
    else if (wmTag === 3) { wm = { kind: 'nft', verifiedCreators: arr(pubkey), mintsPerNft: u32() }; }
    else if (wmTag === 4) { wm = { kind: 'dynamic', mintsPerUser: opt(() => u32()), delta: u32() }; }
    const end = opt(() => i64()); const globalLimit = opt(() => u32()); const mintsInPhase = u32();
    const requiredSigner = opt(() => pubkey());
    const name = str();
    r.off += 10; // padding
    return { start, price, currency, wm, end, globalLimit, mintsInPhase, requiredSigner, name };
  });
  const fundReceivers = arr(() => ({ address: pubkey(), share: u8() }));
  return { disc8, bump, seed, tableSlot, data, sold, machineType, collection, revealLater, mule,
           royaltyEnforced, frozen, priceLock, gallery, phases, fundReceivers };
}

/* ---------------- account orders (IDL 2813, exact) ---------------- */
const CORE_ACCOUNTS = [{"n": "buyer", "m": true, "s": true, "o": false}, {"n": "requiredSigner", "m": false, "s": true, "o": false}, {"n": "machine", "m": true, "s": false, "o": false}, {"n": "totalMints", "m": true, "s": false, "o": false}, {"n": "wallet", "m": true, "s": false, "o": false}, {"n": "wallet2", "m": true, "s": false, "o": false}, {"n": "referredBy", "m": true, "s": false, "o": true}, {"n": "systemProgram", "m": false, "s": false, "o": false}, {"n": "buyerWlTokenWallet", "m": true, "s": false, "o": true}, {"n": "wlNftMetadata", "m": false, "s": false, "o": true}, {"n": "mintsPerWlNft", "m": true, "s": false, "o": true}, {"n": "whitelistMint", "m": true, "s": false, "o": true}, {"n": "buyerPaymentTokenWallet", "m": true, "s": false, "o": true}, {"n": "currencyMint", "m": false, "s": false, "o": true}, {"n": "instructionSysvarAccount", "m": false, "s": false, "o": false}, {"n": "tokenProgram", "m": false, "s": false, "o": false}, {"n": "token22Program", "m": false, "s": false, "o": false}, {"n": "tokenMetadataProgram", "m": false, "s": false, "o": false}, {"n": "accountCompressionProgram", "m": false, "s": false, "o": false}, {"n": "noopProgram", "m": false, "s": false, "o": false}, {"n": "recentSlothashes", "m": false, "s": false, "o": false}, {"n": "bubblegumProgram", "m": false, "s": false, "o": false}, {"n": "wlNftTree", "m": false, "s": false, "o": true}, {"n": "wlNftTreeAuthority", "m": true, "s": false, "o": true}, {"n": "associatedTokenProgram", "m": false, "s": false, "o": false}, {"n": "coreProgram", "m": false, "s": false, "o": false}, {"n": "collection", "m": true, "s": false, "o": false}, {"n": "asset", "m": true, "s": true, "o": false}];
const CV3_ACCOUNTS = [{"n": "buyer", "m": true, "s": true, "o": false}, {"n": "requiredSigner", "m": false, "s": true, "o": false}, {"n": "machine", "m": true, "s": false, "o": false}, {"n": "nameBank", "m": true, "s": false, "o": false}, {"n": "totalMints", "m": true, "s": false, "o": false}, {"n": "treeAdmin", "m": false, "s": false, "o": false}, {"n": "wallet", "m": true, "s": false, "o": false}, {"n": "wallet2", "m": true, "s": false, "o": false}, {"n": "referredBy", "m": true, "s": false, "o": true}, {"n": "systemProgram", "m": false, "s": false, "o": false}, {"n": "buyerWlTokenWallet", "m": true, "s": false, "o": true}, {"n": "wlNftMetadata", "m": false, "s": false, "o": true}, {"n": "mintsPerWlNft", "m": true, "s": false, "o": true}, {"n": "whitelistMint", "m": true, "s": false, "o": true}, {"n": "buyerPaymentTokenWallet", "m": true, "s": false, "o": true}, {"n": "currencyMint", "m": false, "s": false, "o": true}, {"n": "instructionSysvarAccount", "m": false, "s": false, "o": false}, {"n": "bubblegumSigner", "m": false, "s": false, "o": false}, {"n": "treeAuthority", "m": true, "s": false, "o": false}, {"n": "tokenProgram", "m": false, "s": false, "o": false}, {"n": "tokenMetadataProgram", "m": false, "s": false, "o": false}, {"n": "accountCompressionProgram", "m": false, "s": false, "o": false}, {"n": "noopProgram", "m": false, "s": false, "o": false}, {"n": "recentSlothashes", "m": false, "s": false, "o": false}, {"n": "bubblegumProgram", "m": false, "s": false, "o": false}, {"n": "wlNftTree", "m": false, "s": false, "o": true}, {"n": "tree", "m": true, "s": false, "o": false}, {"n": "wlNftTreeAuthority", "m": true, "s": false, "o": true}, {"n": "collectionMint", "m": false, "s": false, "o": false}, {"n": "collectionMetadata", "m": true, "s": false, "o": false}, {"n": "collectionMasterEdition", "m": false, "s": false, "o": false}, {"n": "collectionAuthorityRecord", "m": false, "s": false, "o": false}];
const TM_ACCOUNTS = [{"n": "buyer", "m": true, "s": true, "o": false}, {"n": "buyerTokenAccount", "m": true, "s": false, "o": false}, {"n": "requiredSigner", "m": false, "s": true, "o": false}, {"n": "mint", "m": true, "s": true, "o": false}, {"n": "metadata", "m": true, "s": false, "o": false}, {"n": "masterEdition", "m": true, "s": false, "o": false}, {"n": "machine", "m": true, "s": false, "o": false}, {"n": "totalMints", "m": true, "s": false, "o": false}, {"n": "wallet", "m": true, "s": false, "o": false}, {"n": "wallet2", "m": true, "s": false, "o": false}, {"n": "referredBy", "m": true, "s": false, "o": true}, {"n": "systemProgram", "m": false, "s": false, "o": false}, {"n": "buyerWlTokenWallet", "m": true, "s": false, "o": true}, {"n": "wlNftMetadata", "m": false, "s": false, "o": true}, {"n": "mintsPerWlNft", "m": true, "s": false, "o": true}, {"n": "whitelistMint", "m": true, "s": false, "o": true}, {"n": "buyerPaymentTokenWallet", "m": true, "s": false, "o": true}, {"n": "currencyMint", "m": false, "s": false, "o": true}, {"n": "instructionSysvarAccount", "m": false, "s": false, "o": false}, {"n": "tokenProgram", "m": false, "s": false, "o": false}, {"n": "associatedTokenProgram", "m": false, "s": false, "o": false}, {"n": "tokenMetadataProgram", "m": false, "s": false, "o": false}, {"n": "accountCompressionProgram", "m": false, "s": false, "o": false}, {"n": "noopProgram", "m": false, "s": false, "o": false}, {"n": "recentSlothashes", "m": false, "s": false, "o": false}, {"n": "bubblegumProgram", "m": false, "s": false, "o": false}, {"n": "wlNftTree", "m": false, "s": false, "o": true}, {"n": "wlNftTreeAuthority", "m": true, "s": false, "o": true}, {"n": "collectionMint", "m": false, "s": false, "o": false}, {"n": "collectionMetadata", "m": true, "s": false, "o": false}, {"n": "collectionMasterEdition", "m": false, "s": false, "o": false}, {"n": "collectionAuthorityRecord", "m": false, "s": false, "o": false}, {"n": "tokenRecord", "m": true, "s": false, "o": true}, {"n": "authRulesProgram", "m": false, "s": false, "o": false}, {"n": "authRules", "m": false, "s": false, "o": false}];
const V2_ACCOUNTS = [{"n": "buyer", "m": true, "s": true, "o": false}, {"n": "requiredSigner", "m": false, "s": true, "o": false}, {"n": "minter", "m": true, "s": false, "o": false}, {"n": "nameBank", "m": true, "s": false, "o": false}, {"n": "fazeState", "m": false, "s": false, "o": false}, {"n": "extension", "m": false, "s": false, "o": false}, {"n": "totalMints", "m": true, "s": false, "o": false}, {"n": "treeAdmin", "m": false, "s": false, "o": false}, {"n": "wallet", "m": true, "s": false, "o": false}, {"n": "wallet2", "m": true, "s": false, "o": false}, {"n": "systemProgram", "m": false, "s": false, "o": false}, {"n": "buyerWlTokenWallet", "m": true, "s": false, "o": true}, {"n": "wlNftMetadata", "m": false, "s": false, "o": true}, {"n": "mintsPerWlNft", "m": true, "s": false, "o": true}, {"n": "whitelistMint", "m": true, "s": false, "o": true}, {"n": "buyerPaymentTokenWallet", "m": true, "s": false, "o": true}, {"n": "instructionSysvarAccount", "m": false, "s": false, "o": false}, {"n": "collectionMint", "m": false, "s": false, "o": false}, {"n": "collectionMetadata", "m": true, "s": false, "o": false}, {"n": "collectionMasterEdition", "m": false, "s": false, "o": false}, {"n": "collectionAuthorityRecord", "m": false, "s": false, "o": false}, {"n": "bubblegumSigner", "m": false, "s": false, "o": false}, {"n": "treeAuthority", "m": true, "s": false, "o": false}, {"n": "tokenProgram", "m": false, "s": false, "o": false}, {"n": "tokenMetadataProgram", "m": false, "s": false, "o": false}, {"n": "accountCompressionProgram", "m": false, "s": false, "o": false}, {"n": "noopProgram", "m": false, "s": false, "o": false}, {"n": "recentSlothashes", "m": false, "s": false, "o": false}, {"n": "bubblegumProgram", "m": false, "s": false, "o": false}, {"n": "wlNftTree", "m": false, "s": false, "o": true}, {"n": "tree", "m": true, "s": false, "o": false}, {"n": "wlNftTreeAuthority", "m": true, "s": false, "o": true}];
const LEGACY_ORDER = ['candyMachine', 'payer', 'wallet', 'wallet2', 'metadata', 'mint', 'associated', 'masterEdition', 'totalMints', 'associatedTokenProgram', 'tokenMetadataProgram', 'tokenProgram', 'systemProgram', 'instructionSysvarAccount'];

/* ---------------- mint proposals (SIMULATE-ONLY) ---------------- */

/* Core machines -> mintCore. Mirrors site builder X (bundle 2238) + IDL account order. */
function planMintCore({ machine, name, wallet, collection, phase, fundReceivers, referral, assetKp }) {
  if (!machine || !wallet || !phase) throw new Error('machine + wallet + phase required');
  const asset = assetKp || Keypair.generate();
  const currency = phase.currency || null;
  const receivers = (fundReceivers && fundReceivers.length) ? fundReceivers : [{ address: wallet }];
  const id = referral || null;
  const values = {
    buyer: wallet,
    requiredSigner: phase.requiredSigner || wallet,
    machine,
    totalMints: derivations.totalMints(wallet, machine, phase.name),
    wallet: receivers[0].address,
    wallet2: FEE_KEY,
    referredBy: id,
    systemProgram: SYSTEM,
    buyerWlTokenWallet: null,
    wlNftMetadata: null,
    mintsPerWlNft: null,
    whitelistMint: null,
    buyerPaymentTokenWallet: null,
    currencyMint: currency,
    instructionSysvarAccount: SYSVAR_I,
    tokenProgram: TOKEN_PROGRAM,
    token22Program: TOKEN22,
    tokenMetadataProgram: MPL_PROGRAM,
    accountCompressionProgram: COMPRESSION,
    noopProgram: NOOP,
    recentSlothashes: SYSVAR_SLOT,
    bubblegumProgram: BUBBLEGUM,
    wlNftTree: null,
    wlNftTreeAuthority: null,
    associatedTokenProgram: ATA_PROGRAM,
    coreProgram: MINT_PROGRAM,
    collection,
    asset: asset.publicKey.toBase58(),
  };
  const keys = CORE_ACCOUNTS.filter((a) => !a.o || values[a.n]).map((a) => ({
    pubkey: values[a.n], isWritable: a.m, isSigner: a.s,
  }));
  const remaining = [
    { pubkey: TOKEN22, isWritable: false, isSigner: false },
    ...(currency && id ? [{ pubkey: derivations.association(currency, id), isWritable: true, isSigner: false }] : []),
    ...receivers.map((fr) => ({ pubkey: currency ? derivations.association(currency, fr.address) : fr.address, isWritable: true, isSigner: false })),
    { pubkey: derivations.coreBank(machine), isWritable: true, isSigner: false },
  ];
  const data = ixData(DISCS.mintCore, [encMachineMintInput({
    proof: phase.proof || [], expectedPrice: phase.price || 0, amount: 1, cnftWlEntry: phase.cnftWlEntry || null, targetPhase: phase.idx,
  })]);
  return {
    programId: MINT_PROGRAM, disc: DISCS.mintCore, data, keys, remaining,
    asset: asset.publicKey.toBase58(), assetKp: asset,
    plan: { version: 'core', phase: phase.name, recipient: values.wallet, currency },
  };
}

/* CandyV3 machines -> mintCv3. Mirrors site builder $ (bundle 2238) + IDL order. */
function planMintCv3({ machine, name, wallet, collection, nameBank, phase, fundReceivers, referral, assetKp }) {
  if (!machine || !wallet || !phase) throw new Error('machine + wallet + phase required');
  const currency = phase.currency || null;
  const receivers = (fundReceivers && fundReceivers.length) ? fundReceivers : [{ address: wallet }];
  const id = referral || null;
  const collectionMint = collection;
  const values = {
    buyer: wallet,
    requiredSigner: phase.requiredSigner || wallet,
    machine,
    nameBank: nameBank || wallet,
    totalMints: derivations.totalMints(wallet, machine, phase.name),
    treeAdmin: derivations.treeAuthority(),
    wallet: receivers[0].address,
    wallet2: FEE_KEY,
    referredBy: id,
    systemProgram: SYSTEM,
    buyerWlTokenWallet: null,
    wlNftMetadata: null,
    mintsPerWlNft: null,
    whitelistMint: null,
    buyerPaymentTokenWallet: null,
    currencyMint: currency,
    instructionSysvarAccount: SYSVAR_I,
    bubblegumSigner: derivations.bubblegumSigner(),
    treeAuthority: pda([pb(TREE_MAINNET)], BUBBLEGUM),
    tokenProgram: TOKEN_PROGRAM,
    tokenMetadataProgram: MPL_PROGRAM,
    accountCompressionProgram: COMPRESSION,
    noopProgram: NOOP,
    recentSlothashes: SYSVAR_SLOT,
    bubblegumProgram: BUBBLEGUM,
    wlNftTree: null,
    tree: TREE_MAINNET,
    wlNftTreeAuthority: null,
    collectionMint,
    collectionMetadata: derivations.metadata(collectionMint),
    collectionMasterEdition: derivations.masterEdition(collectionMint),
    collectionAuthorityRecord: derivations.collectionAuthorityRecord(collectionMint, machine),
  };
  const keys = CV3_ACCOUNTS.filter((a) => !a.o || values[a.n]).map((a) => ({
    pubkey: values[a.n], isWritable: a.m, isSigner: a.s,
  }));
  const remaining = [
    { pubkey: TOKEN22, isWritable: false, isSigner: false },
    ...(currency && id ? [{ pubkey: derivations.association(currency, id), isWritable: true, isSigner: false }] : []),
    ...receivers.map((fr) => ({ pubkey: currency ? derivations.association(currency, fr.address) : fr.address, isWritable: true, isSigner: false })),
  ];
  const data = ixData(DISCS.mintCv3, [encMachineMintInput({
    proof: phase.proof || [], expectedPrice: phase.price || 0, amount: 1, cnftWlEntry: phase.cnftWlEntry || null, targetPhase: phase.idx,
  })]);
  return {
    programId: MINT_PROGRAM, disc: DISCS.mintCv3, data, keys, remaining,
    plan: { version: 'cv3', phase: phase.name, recipient: values.wallet, currency },
  };
}

/* Legacy "Candy" machines -> mintV6 (old nft_candy_machine). Exact IDL order (old bundle). */
function planMintV6({ machine, name, wallet, phase, assetKp }) {
  if (!machine || !wallet) throw new Error('machine + wallet required');
  const ph = phase || { name: name || 'Public', price: 0, proof: [] };
  const mint = assetKp || Keypair.generate();
  const values = {
    candyMachine: machine,
    payer: wallet,
    wallet: wallet,
    wallet2: FEE_KEY,
    metadata: derivations.metadata(mint.publicKey),
    mint: mint.publicKey.toBase58(),
    associated: derivations.association(wallet, mint.publicKey),
    masterEdition: derivations.masterEdition(mint.publicKey),
    totalMints: derivations.totalMints(wallet, machine, ph.name, LEGACY_CANDY),
    associatedTokenProgram: ATA_PROGRAM,
    tokenMetadataProgram: MPL_PROGRAM,
    tokenProgram: TOKEN_PROGRAM,
    systemProgram: SYSTEM,
    instructionSysvarAccount: SYSVAR_I,
  };
  const notWritable = new Set(['associatedTokenProgram', 'tokenMetadataProgram', 'tokenProgram', 'systemProgram', 'instructionSysvarAccount']);
  const signers = new Set(['payer', 'mint']);
  const keys = LEGACY_ORDER.map((k) => {
    const p = values[k];
    if (!p) throw new Error('mintV6 missing account ' + k);
    return { pubkey: p, isWritable: !notWritable.has(k), isSigner: signers.has(k) };
  });
  /* mintV6 args: proof vec, expect u64 (price), toggleState u8=1, expectedRefund u8 = price%10 */
  const args = Buffer.concat([encProof(ph.proof || []), encU64(ph.price || 0), Buffer.from([1, Number((ph.price || 0) % 10)])]);
  const data = ixData(DISCS.mintV6, [args]);
  return { programId: LEGACY_CANDY, disc: DISCS.mintV6, discriminator: DISCS.mintV6, data, keys, accounts: keys, mint: mint.publicKey.toBase58(), assetKp: mint, plan: { version: 'legacy-v6', phase: ph.name } };
}

/* CV2 "Candy" machines on the CURRENT program (MINT_PROGRAM) -> mintV2.
 * Bundle 8242 module 83413 `eo`/`mintCompressed` call, VERBATIM:
 *   r.methods.mintV2({proof, amount:1, expectedPrice}, cnftWlEntry, targetPhase)
 *   .accounts(collectionMint,collectionMasterEdition,requiredSigner,wlNftTree,fazeState,
 *             wlNftTreeAuthority,extension,collectionMetadata,systemProgram,minter,nameBank,
 *             collectionAuthorityRecord,totalMints,tokenMetadataProgram,tokenProgram,
 *             wallet,wallet2(33nQC...=FEE_KEY),accountCompressionProgram,bubblegumProgram,
 *             bubblegumSigner,buyer,instructionSysvarAccount,tree,noopProgram,
 *             recentSlothashes,treeAuthority,treeAdmin,treeAuthority,wlNftTreeAuthority,
 *             whitelistMint,mintsPerWlNft,buyerWlTokenWallet,wlNftMetadata,buyerPaymentTokenWallet)
 *   .remainingAccounts([...canopy, {pubkey: TOKEN2022, isSigner:false, isWritable:false}])
 * Args = MintInput {proof, expectedPrice, amount} + cnft + targetPhase. SIMULATE-ONLY. */
function planMintV2({ machine, name, wallet, collection, nameBank, phase, fundReceivers, referral, assetKp }) {
  if (!machine || !wallet || !phase) throw new Error('machine + wallet + phase required for mintV2');
  const ph = phase || { name: name || 'Public', price: 0 };
  const currency = ph.currency || null;
  const receivers = (fundReceivers && fundReceivers.length) ? fundReceivers : [{ address: wallet }];
  const id = referral || null;
  const collectionMint = collection;
  const values = {
    buyer: wallet,
    requiredSigner: ph.requiredSigner || wallet,
    minter: machine,
    nameBank: nameBank || wallet,
    fazeState: SYSTEM,                          // bundle passes SystemProgram here
    extension: pda([enc('extension'), pb(machine)], MINT_PROGRAM),
    totalMints: derivations.totalMints(wallet, machine, ph.name),
    treeAdmin: derivations.treeAuthority(),
    wallet: receivers[0].address,
    wallet2: FEE_KEY,
    systemProgram: SYSTEM,
    buyerWlTokenWallet: null,
    wlNftMetadata: null,
    mintsPerWlNft: null,
    whitelistMint: null,
    buyerPaymentTokenWallet: null,
    instructionSysvarAccount: SYSVAR_I,
    collectionMint,
    collectionMetadata: collectionMint ? derivations.metadata(collectionMint) : null,
    collectionMasterEdition: collectionMint ? derivations.masterEdition(collectionMint) : null,
    collectionAuthorityRecord: collectionMint ? derivations.collectionAuthorityRecord(collectionMint, machine) : null,
    bubblegumSigner: derivations.bubblegumSigner(),
    treeAuthority: pda([pb(TREE_MAINNET)], BUBBLEGUM),
    tokenProgram: TOKEN_PROGRAM,
    tokenMetadataProgram: MPL_PROGRAM,
    accountCompressionProgram: COMPRESSION,
    noopProgram: NOOP,
    recentSlothashes: SYSVAR_SLOT,
    bubblegumProgram: BUBBLEGUM,
    wlNftTree: null,
    tree: TREE_MAINNET,
    wlNftTreeAuthority: null,
  };
  const keys = V2_ACCOUNTS.filter((a) => !a.o || values[a.n]).map((a) => ({ pubkey: values[a.n], isWritable: a.m, isSigner: a.s }));
  const remaining = [];
  if (Array.isArray(ph.canopy) && ph.canopy.length) remaining.push(...ph.canopy.map((c) => ({ pubkey: c, isWritable: false, isSigner: false })));
  remaining.push({ pubkey: TOKEN22, isWritable: false, isSigner: false });
  if (currency && id) remaining.push({ pubkey: derivations.association(currency, id), isWritable: true, isSigner: false });
  if (currency) remaining.push(...receivers.map((fr) => ({ pubkey: derivations.association(currency, fr.address), isWritable: true, isSigner: false })));
  const data = ixData(DISCS.mintV2, [encMachineMintInput({
    proof: ph.proof || [], expectedPrice: ph.price || 0, amount: ph.qty || 1,
    cnftWlEntry: ph.cnftWlEntry || null, targetPhase: ph.idx == null ? 1 : ph.idx,   // bundle passes 1
  })]);
  return {
    programId: MINT_PROGRAM, disc: DISCS.mintV2, discriminator: DISCS.mintV2, data, keys, remaining,
    plan: { version: 'cv2', phase: ph.name, recipient: values.wallet, currency },
  };
}

/* Legacy nft_candy_machine mintV2 (old program, 14 accounts, creatorBump+totalMintsBump). */
function planMintV2Legacy({ machine, name, wallet, proof, phase, assetKp }) {
  if (!machine || !wallet) throw new Error('machine + wallet required for mintV2');
  const ph = phase || { name: name || 'Public', price: 0 };
  const mintKp = assetKp || Keypair.generate();
  const [creatorPub, creatorBump] = PublicKey.findProgramAddressSync([enc('candy_machine'), pb(machine)], new PublicKey(LEGACY_CANDY));
  const [totalPub, totalBump] = PublicKey.findProgramAddressSync([enc('TotalMints'), pb(wallet), pb(machine), k32(ph.name || 'Public')], new PublicKey(LEGACY_CANDY));
  const values = {
    candyMachine: machine,
    payer: wallet,
    candyMachineCreator: creatorPub.toBase58(),
    wallet: wallet,
    wallet2: FEE_KEY,
    metadata: derivations.metadata(mintKp.publicKey),
    mint: mintKp.publicKey.toBase58(),
    masterEdition: derivations.masterEdition(mintKp.publicKey),
    totalMints: totalPub.toBase58(),
    tokenMetadataProgram: MPL_PROGRAM,
    tokenProgram: TOKEN_PROGRAM,
    systemProgram: SYSTEM,
    rent: SYSVAR_RENT_PUBKEY.toBase58(),
    clock: SYSVAR_CLOCK_PUBKEY.toBase58(),
  };
  const keyDef = [
    ['candyMachine', true, false], ['payer', true, true], ['candyMachineCreator', false, false], ['wallet', true, false], ['wallet2', true, false], ['metadata', true, false], ['mint', true, true], ['masterEdition', true, false], ['totalMints', true, false], ['tokenMetadataProgram', false, false], ['tokenProgram', false, false], ['systemProgram', false, false], ['rent', false, false], ['clock', false, false],
  ];
  const keys = keyDef.map(([k, w, s]) => ({ pubkey: values[k], isWritable: w, isSigner: s }));
  const proofArg = (ph.proof && ph.proof.length) ? ph.proof : null;
  const args = Buffer.concat([Buffer.from([creatorBump, totalBump]), encOpt(encProof, proofArg)]);
  const data = ixData(DISCS.mintV2, [args]);
  return { programId: LEGACY_CANDY, disc: DISCS.mintV2, discriminator: DISCS.mintV2, data, keys, accounts: keys, mint: mintKp.publicKey.toBase58(), assetKp: mintKp, plan: { version: 'legacy-v2', phase: ph.name, creatorBump, totalMintsBump: totalBump } };
}

/* Alias for older callers. */
const planMintLegacy = planMintV6;

/* ---------------- relay + fee (site semantics) ---------------- */
async function estimateFee(rpcUrl, accountKeys) {
  const { fetch } = require('undici');
  const r = await fetch(rpcUrl || SITE_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'getPriorityFeeEstimate', params: [{ accountKeys, options: { includeAllPriorityFeeLevels: true } }] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error('fee estimate HTTP ' + r.status);
  const j = await r.json();
  const v = j && j.result && j.result.priorityFeeLevels && j.result.priorityFeeLevels.high;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('fee estimate missing');
  return Math.min(Math.max(Math.floor(v), 40000), 1000000);
}

async function relaySign(txBytes) {
  const { fetch } = require('undici');
  const r = await fetch(RELAY_URL, {
    method: 'POST', headers: {}, body: Buffer.from(txBytes), redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('relay HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

/* ---------------- selfcheck ---------------- */
function selfCheck() {
  const KEYS = ['MINT_PROGRAM', 'FEE_KEY', 'LEGACY_CANDY', 'RELAY_SIGNER', 'MPL_PROGRAM', 'BUBBLEGUM',
                'COMPRESSION', 'NOOP', 'TOKEN_PROGRAM', 'TOKEN22', 'ATA_PROGRAM', 'AUTH_RULES', 'TREE_MAINNET', 'CMT'];
  for (const k of KEYS) {
    const v = eval(k);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) throw new Error('selfCheck ' + k);
  }
  const dummy = Keypair.generate().publicKey.toBase58();
  return {
    ok: true,
    discs: DISCS,
    totalMints: derivations.totalMints(dummy, dummy, 'Public'),
    whitelist: derivations.whitelist(dummy),
    coreBank: derivations.coreBank(dummy),
    treeAuthority: derivations.treeAuthority(),
    bubblegumSigner: derivations.bubblegumSigner(),
  };
}

module.exports = {
  MINT_PROGRAM, FEE_KEY, LEGACY_CANDY, RELAY_SIGNER, RELAY_URL, DISCS,
  CANDY_PROGRAM: MINT_PROGRAM, REQUIRED_SIGNER: RELAY_SIGNER,   // resolver aliases
  derivations, decodeMachine, planMintCore, planMintCv3, planMintV6, planMintV2, planMintV2Legacy, planMintLegacy,
  estimateFee, relaySign, selfCheck,
};
