// Deploy SelfServeFaucet on Hadrian + fund its reserve + set per-mint drop sizes.
//
// SelfServeFaucet is USER-SIGNED: a Solana-native user's own DoTxUnsigned
// (msg.sender = their synthetic) calls claim(recipient, toAta, mint), and the
// contract drops the configured amount from ITS OWN reserve (external_auth(this),
// reached via HELPER.call) to the user's Phantom wallet ATA. No backend key.
//
// This script (operator-run) deploys the contract, funds its reserve by
// transferring each faucet token from the deployer, and registers the per-mint
// drop size. Idempotent via state.json.
//
// Run (operator supplies ETH_PK):
//   ETH_PK=<deployer-pk> ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub \
//     MAINNET_QUICKNODE_LINK=stub UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/selfserve-faucet/deploy.ts --network hadrian
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import type { Contract } from 'ethers';
import { callTx, deployContract } from '../_lib/gas';

const STATE_PATH = path.resolve(__dirname, 'state.json');

// Rome inflates gas (SBF cost model); gasPrice is 0 so a high limit is free.
const DEPLOY_GAS = 28_000_000n;
const SET_GAS = 10_000_000n;
const ENSURE_GAS = 10_000_000n;
const XFER_GAS = 14_000_000n;

// The 6 Hadrian (200010) faucet tokens — cached SPL_ERC20 collateral wrappers,
// 9 decimals. Drop = 1.0 token/claim; reserve = RESERVE_CLAIMS claims' worth
// (capped at the deployer's balance; tokens it doesn't hold are reported, not funded).
const TOKENS = [
  { symbol: 'wBTC', address: '0xa000137fFcB2808aB6D2094c6f7Db5830c437883' },
  { symbol: 'wJitoSOL', address: '0xD6C203B9dA334fFB0169801159A4aD0699D6FA21' },
  { symbol: 'wmSOL', address: '0xC829D19cf6B95F28Bc7dDa1e983154AE7be0ca60' },
  { symbol: 'wJUP', address: '0x8aeDa0c4e0D4D780A810E0f85163eE485E8A253E' },
  { symbol: 'wJTO', address: '0x3d8F5adc8f7181C8bBC83cc8e5FA108CeC1d8Be6' },
  { symbol: 'wBONK', address: '0x80007675665ffCa47d7DBEdD5Fb4F7AB2e135322' },
];
const DROP = 1_000_000_000n; // 1.0 token @ 9 decimals
const RESERVE_CLAIMS = 200n;

const WRAP_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function mint_id() external view returns (bytes32)',
  'function ensure_token_account(address account) external',
];
const FAUCET_ABI = [
  'function setDrops(bytes32[] mints, uint64[] amounts) external',
  'function dropAmount(bytes32) external view returns (uint64)',
  'function admin() external view returns (address)',
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const me = await deployer.getAddress();
  console.log('deployer:', me);

  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    /* fresh */
  }

  // 1. Deploy (idempotent).
  let faucetAddr = state.selfServeFaucet as string | undefined;
  if (faucetAddr) {
    console.log('reusing SelfServeFaucet', faucetAddr);
  } else {
    const Factory = await ethers.getContractFactory('SelfServeFaucet');
    const f = await deployContract<Contract>(Factory, [], { gasLimit: DEPLOY_GAS, type: 0, gasPrice: 0n });
    faucetAddr = f.address;
    state.selfServeFaucet = faucetAddr;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log('deployed SelfServeFaucet', faucetAddr);
  }
  const faucet = new ethers.Contract(faucetAddr, FAUCET_ABI, deployer);

  // 2. Per token: read its SPL mint, ensure the faucet's reserve ATA exists
  //    (cached-wrapper gotcha), and fund the reserve from the deployer.
  const mints: string[] = [];
  const amounts: bigint[] = [];
  for (const t of TOKENS) {
    const token = new ethers.Contract(t.address, WRAP_ABI, deployer);
    const mint: string = await token.mint_id();
    mints.push(mint);
    amounts.push(DROP);

    try {
      await callTx(token, 'ensure_token_account', [faucetAddr], { gasLimit: ENSURE_GAS, type: 0, gasPrice: 0n });
    } catch (e) {
      console.log(`  ${t.symbol} ensure_token_account skipped: ${(e as Error).message.slice(0, 70)}`);
    }

    const cur: bigint = (await token.balanceOf(faucetAddr)).toBigInt();
    const target = DROP * RESERVE_CLAIMS;
    if (cur >= target) {
      console.log(`  ${t.symbol} reserve ${cur} ≥ target ${target}, skip`);
      continue;
    }
    const bal: bigint = (await token.balanceOf(me)).toBigInt();
    const need = target - cur;
    const send = bal < need ? bal : need;
    if (send > 0n) {
      await callTx(token, 'transfer', [faucetAddr, send], { gasLimit: XFER_GAS, type: 0, gasPrice: 0n });
      console.log(`  funded ${t.symbol} +${send} (deployer held ${bal}, target ${target})`);
    } else {
      console.log(`  ⚠️  ${t.symbol}: deployer holds 0 — reserve NOT funded (top up later)`);
    }
  }

  // 3. Register per-mint drop sizes (contract policy — caller can't over-draw).
  await callTx(faucet, 'setDrops', [mints, amounts], { gasLimit: SET_GAS, type: 0, gasPrice: 0n });
  console.log('setDrops done for', mints.length, 'mints');

  // 4. Report + persist.
  const reserve: Record<string, string> = {};
  for (const t of TOKENS) {
    const token = new ethers.Contract(t.address, WRAP_ABI, deployer);
    reserve[t.symbol] = (await token.balanceOf(faucetAddr)).toString();
  }
  state.selfServeReserve = reserve;
  state.selfServeMints = Object.fromEntries(TOKENS.map((t, i) => [t.symbol, mints[i]]));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log('\n✅ SelfServeFaucet', faucetAddr);
  console.log('admin:', await faucet.admin());
  console.log('reserve:', reserve);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
