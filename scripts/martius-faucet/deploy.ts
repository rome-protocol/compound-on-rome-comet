// Deploy the windowed CompoundFaucet on MARTIUS (121214) for the 6 exotic
// collaterals of the 8-collat comet 0x2fD2C964…, register each with the uniform
// 1-token drop, and warm the faucet's cached-wrapper ATAs. gasDrop=0 (same as
// the hadrian faucet — claims don't drip native gas).
//
// FUNDING IS A SEPARATE, CROSS-CHAIN STEP — unlike hadrian-windowed-faucet.
// The martius wrappers wrap the SAME underlying test mints as hadrian's, and
// the entire minted inventory sits with the hadrian deployer's authority PDA.
// A per-chain wrapper balance is just SPL in the holder's per-chain-program
// ATA, so the faucet is funded by an SPL transfer FROM hadrian TO the martius
// faucet's raw ATAs (fund-from-hadrian.ts) — no martius-side inventory exists.
// This script prints the destination ATA per token for that step.
//
// Run:
//   ETH_PK=<martius deployer pk> \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/martius-faucet/deploy.ts --network martius
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import type { Contract } from 'ethers';
import { callTx, deployContract } from '../_lib/gas';

const OUT = path.resolve(__dirname, 'state.json');

// The 6 exotic collats of the martius 8-collat comet (registry
// apps/compound/121214-martius.json, v0.19.21), all 9-dec.
const COLLATS = [
  { symbol: 'wBTC', address: '0x34AE37cFA1f41F5E69d8F042F7455A63a4F048B8' },
  { symbol: 'wJitoSOL', address: '0x8a27E495CEAd6EcBBe25B537DBF666FD6bfE01E3' },
  { symbol: 'wmSOL', address: '0xe6fD55A93cAecF0F9cF60FBC4D2CbE0d71b54491' },
  { symbol: 'wJUP', address: '0x71dC1C088E17cCD67058c626A358E02F6EbAAc69' },
  { symbol: 'wJTO', address: '0xCb1e4CD61704C9fcc196Ce98619E85A241383Fd8' },
  { symbol: 'wBONK', address: '0x2c71373725C59B3F1D47a0D425B7050D02e014b4' },
];
const DROP = 10n ** 9n; // 1 token per claim (9-dec); CU is amount-independent

const LEGACY = { type: 0, gasPrice: 0n };
const DEPLOY_GAS = 30_000_000n;
const ADD_GAS = 5_000_000n;
const ENSURE_GAS = 30_000_000n;

const CACHED_ABI = [
  'function ensure_token_account(address owner) external',
  'function mint_id() external view returns (bytes32)',
];
const HELPER = '0xff00000000000000000000000000000000000009';
const HELPER_ABI = ['function ata(address user, bytes32 mint) external view returns (bytes32)'];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('deployer:', deployer.address);

  const Faucet = await ethers.getContractFactory('CompoundFaucet', deployer);
  console.log('[1/3] deploy CompoundFaucet(gasDrop=0)…');
  const faucet = await deployContract<Contract>(Faucet, [0], { gasLimit: DEPLOY_GAS, ...LEGACY });
  console.log('   faucet:', faucet.address);

  const helper = new ethers.Contract(HELPER, HELPER_ABI, deployer);
  const funding: Array<{ symbol: string; wrapper: string; mintId: string; faucetAta: string }> = [];

  for (const c of COLLATS) {
    console.log(`[2/3] addToken(${c.symbol}=${c.address}, drop=${DROP})`);
    await (await callTx(faucet, 'addToken', [c.address, DROP], { gasLimit: ADD_GAS, ...LEGACY })).wait();

    const cached = new ethers.Contract(c.address, CACHED_ABI, deployer);
    console.log(`[3/3] ensure_token_account(faucet) on ${c.symbol}`);
    await (await callTx(cached, 'ensure_token_account', [faucet.address], { gasLimit: ENSURE_GAS, ...LEGACY })).wait();

    const mintId: string = await cached.mint_id();
    const faucetAta: string = await helper.ata(faucet.address, mintId);
    console.log(`      ${c.symbol} mint=${mintId} faucetAta=${faucetAta}`);
    funding.push({ symbol: c.symbol, wrapper: c.address, mintId, faucetAta });
  }

  fs.writeFileSync(OUT, JSON.stringify({
    faucet: faucet.address,
    gasDropWei: '0',
    drop: DROP.toString(),
    funding,
  }, null, 2));
  console.log('\nDONE. Faucet deployed + ATAs warmed. Fund via fund-from-hadrian.ts (see state.json).');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
