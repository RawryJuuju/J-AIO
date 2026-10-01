'use strict';
/* One-shot: compile contracts/BatchNftSender.sol -> src/batchSender.artifact.json */
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'BatchNftSender.sol'), 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'BatchNftSender.sol': { content: src } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
if (out.errors) {
  const fatal = out.errors.filter((e) => e.severity === 'error');
  if (fatal.length) { console.error(JSON.stringify(fatal, null, 2)); process.exit(1); }
}
const c = out.contracts['BatchNftSender.sol']['BatchNftSender'];
const artifact = {
  contract: 'BatchNftSender',
  solc: solc.version(),
  abi: c.abi,
  bytecode: '0x' + c.evm.bytecode.object,
};
fs.writeFileSync(path.join(__dirname, '..', 'src', 'batchSender.artifact.json'), JSON.stringify(artifact, null, 2));
console.log('compiled OK — solc', solc.version(), 'bytecode', artifact.bytecode.length / 2 - 1, 'bytes');
