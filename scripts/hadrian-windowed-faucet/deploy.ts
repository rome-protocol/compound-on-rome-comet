// Deploy the WINDOWED CompoundFaucet (adds claimTokens(start,count)) on Hadrian,
// register the 6 cache-fed comet collats, warm the faucet's cached-wrapper ATAs,
// and pre-fund a few claims. gasDrop=0 (Solana-lane synthetics pay their own SOL).
//
// Purpose: prove the Solana-native lane can claim all 6 tokens in 2 sequential
// DoTxUnsigned windows (claimTokens(0,3)+claimTokens(3,6)) each under Solana's
// 1.4M-CU per-tx cap — the old atomic claim() over-runs at ~1.3996M.
//
// CU is amount-independent (the cost is the cached-wrapper CPI + the recipient's
// ATA creation, not the value), so a small uniform DROP keeps funding cheap while
// preserving the worst-case CU (each window still creates 3 fresh synthetic ATAs).
//
// Run:
//   ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-windowed-faucet/deploy.ts --network hadrian
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import type { Contract } from 'ethers';
import { callTx, deployContract } from '../_lib/gas';

const OUT = path.resolve(__dirname, 'state.json');

// The 6 cache-fed comet collaterals (registry apps/compound/200010-hadrian.json), all 9-dec.
const COLLATS = [
  { symbol: 'wBTC', address: '0xa000137fFcB2808aB6D2094c6f7Db5830c437883' },
  { symbol: 'wJitoSOL', address: '0xD6C203B9dA334fFB0169801159A4aD0699D6FA21' },
  { symbol: 'wmSOL', address: '0xC829D19cf6B95F28Bc7dDa1e983154AE7be0ca60' },
  { symbol: 'wJUP', address: '0x8aeDa0c4e0D4D780A810E0f85163eE485E8A253E' },
  { symbol: 'wJTO', address: '0x3d8F5adc8f7181C8bBC83cc8e5FA108CeC1d8Be6' },
  { symbol: 'wBONK', address: '0x80007675665ffCa47d7DBEdD5Fb4F7AB2e135322' },
];
const DROP = 10n ** 9n;        // 1 token per claim (9-dec); CU is amount-independent
const FUND_CLAIMS = 5n;        // pre-fund 5 claims of each token

// Rome/Hadrian: legacy tx + gasPrice=0 short-circuits the preflight budget check;
// explicit gasLimit bypasses estimateGas (which returns ~block-limit on Rome). These
// are NORMAL EVM txs (deployer's real key → holder/iterative VM, NOT the 1.4M cap).
const LEGACY = { type: 0, gasPrice: 0n };
const DEPLOY_GAS = 30_000_000n;
const ADD_GAS = 5_000_000n;
const ENSURE_GAS = 30_000_000n;
const XFER_GAS = 30_000_000n;

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
];
const CACHED_ABI = ['function ensure_token_account(address owner) external'];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('deployer:', deployer.address);

  // 1. Deploy windowed faucet (gasDrop=0).
  const Faucet = await ethers.getContractFactory('CompoundFaucet', deployer);
  console.log('[1/4] deploy CompoundFaucet(gasDrop=0)…');
  const faucet = await deployContract<Contract>(Faucet, [0], { gasLimit: DEPLOY_GAS, ...LEGACY });
  console.log('   faucet:', faucet.address);

  for (const c of COLLATS) {
    // 2. Register the token with the uniform drop.
    console.log(`[2/4] addToken(${c.symbol}=${c.address}, drop=${DROP})`);
    await (await callTx(faucet, 'addToken', [c.address, DROP], { gasLimit: ADD_GAS, ...LEGACY })).wait();

    // 3. Warm the faucet's cached-wrapper ATA so the funding transfer (and later
    //    claims) don't revert on an uninitialized associated-token-account.
    const cached = new ethers.Contract(c.address, CACHED_ABI, deployer);
    console.log(`[3/4] ensure_token_account(faucet) on ${c.symbol}`);
    await (await callTx(cached, 'ensure_token_account', [faucet.address], { gasLimit: ENSURE_GAS, ...LEGACY })).wait();

    // 4. Fund FUND_CLAIMS worth from the deployer's inventory.
    const erc = new ethers.Contract(c.address, ERC20_ABI, deployer);
    const need = DROP * FUND_CLAIMS;
    console.log(`[4/4] transfer ${need} ${c.symbol} → faucet`);
    await (await callTx(erc, 'transfer', [faucet.address, need], { gasLimit: XFER_GAS, ...LEGACY })).wait();
    const bal: bigint = (await erc.balanceOf(faucet.address)).toBigInt();
    console.log(`      faucet ${c.symbol} balance = ${bal}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({
    faucet: faucet.address,
    gasDropWei: '0',
    drop: DROP.toString(),
    fundClaims: Number(FUND_CLAIMS),
    collats: COLLATS,
  }, null, 2));
  console.log('\nDONE. Windowed faucet deployed + funded.');
  console.log('  faucet:', faucet.address);
  console.log('  gasDrop: 0; drop/token:', DROP.toString(), `(${COLLATS.length} collats, ${FUND_CLAIMS} claims each)`);
}

main().catch((err) => { console.error(err); process.exit(1); });
