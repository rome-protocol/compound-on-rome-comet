// Fund the MARTIUS faucet's token inventory FROM HADRIAN.
//
// The exotic collat wrappers on both chains wrap the same underlying test
// mints, and the whole minted inventory lives with the hadrian deployer's
// authority PDA. Each wrapper balance is plain SPL in the holder's ATA, so
// funding the martius faucet = HelperProgram.transfer_spl(bytes32 to_ata,
// uint64 tokens, bytes32 mint) ON HADRIAN, signed by the hadrian deployer,
// destination = the martius faucet's raw ATA (already created by
// martius-faucet/deploy.ts via ensure_token_account; pubkeys in state.json).
//
// Idempotent: reads the destination ATA's current SPL amount and tops up to
// TARGET (skips tokens already at/above it).
//
// Run:
//   ETH_PK=<hadrian deployer pk (faucet-owner 0x1f4946Be…)> \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/martius-faucet/fund-from-hadrian.ts --network hadrian
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import type { Contract } from 'ethers';
import { callTx } from '../_lib/gas';

const STATE = path.resolve(__dirname, 'state.json');

const DROP = 10n ** 9n;
const FUND_CLAIMS = 5n; // hadrian-windowed-faucet precedent
const TARGET = DROP * FUND_CLAIMS;

const LEGACY = { type: 0, gasPrice: 0n };
const XFER_GAS = 30_000_000n;

const HELPER = '0xff00000000000000000000000000000000000009';
const HELPER_ABI = ['function transfer_spl(bytes32 to_ata, uint64 tokens, bytes32 mint) external'];
const CPI = '0xff00000000000000000000000000000000000008';
const CPI_ABI = ['function account_u64_at(bytes32 pubkey, uint16 offset) external view returns (uint64)'];
const CPI_INFO_ABI = ['function account_lamports(bytes32 pubkey) external view returns (uint64)'];

async function ataAmount(cpi: Contract, cpiInfo: Contract, ata: string): Promise<bigint> {
  // SPL TokenAccount.amount is u64 LE at offset 64; a missing ATA has 0 lamports.
  const lamports: bigint = (await cpiInfo.account_lamports(ata)).toBigInt();
  if (lamports === 0n) return 0n;
  return (await cpi.account_u64_at(ata, 64)).toBigInt();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('funding signer (hadrian deployer):', deployer.address);

  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const helper = new ethers.Contract(HELPER, HELPER_ABI, deployer);
  const cpi = new ethers.Contract(CPI, CPI_ABI, deployer);
  const cpiInfo = new ethers.Contract(CPI, CPI_INFO_ABI, deployer);

  for (const f of state.funding) {
    const have = await ataAmount(cpi, cpiInfo, f.faucetAta);
    if (have >= TARGET) {
      console.log(`${f.symbol}: faucet ATA already holds ${have} (>= ${TARGET}) — skip`);
      continue;
    }
    const need = TARGET - have;
    console.log(`${f.symbol}: transfer_spl(${f.faucetAta}, ${need}, ${f.mintId})`);
    await (await callTx(helper, 'transfer_spl', [f.faucetAta, need, f.mintId], { gasLimit: XFER_GAS, ...LEGACY })).wait();
    const now = await ataAmount(cpi, cpiInfo, f.faucetAta);
    console.log(`   faucet ATA now holds ${now}`);
    if (now < TARGET) throw new Error(`${f.symbol}: funding landed but ATA holds ${now} < ${TARGET}`);
  }
  console.log('\nDONE. Martius faucet funded from hadrian inventory.');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
