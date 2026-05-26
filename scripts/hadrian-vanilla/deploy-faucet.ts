// Deploy CompoundFaucet on Hadrian, pre-funded with the 5 mock collats
// (wHEAT / wSALT / wMILK / wOIL / wGOLD) for the demo's /faucet page.
//
// Aave-parity drops per claim:
//   - 10 native gas (10e18 wei)
//   - 100 of each mock wrapper
//
// Pre-fund target: 1000 claims worth — operator can refill any time by
// transferring more native or wrapper balance to the faucet address.
//
// Idempotent re-runs: if state.json already has a faucet address, we
// reuse it and only top up balances. Skips addToken on an already-
// registered token (the contract would push duplicates; we don't want
// that). Writes back to state.json.
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import type { Contract } from 'ethers';
import { callTx, deployContract, sendTx } from '../_lib/gas';

const STATE_PATH = path.resolve(__dirname, 'state.json');

const MOCK_SYMBOLS = ['wHEAT', 'wSALT', 'wMILK', 'wOIL', 'wGOLD'] as const;
const TOKENS_PER_CLAIM = 100n;   // human units
const NATIVE_PER_CLAIM = 10n;    // 10 native (wei = 10e18)
// Tight initial seed — operator deployer wallet only has ~44 native at
// time of first deploy, so seeding 1000 claims would OutOfFund. The
// fresh-wallet chicken-and-egg is resolved upstream: users bridge
// SOL→Hadrian on rome-ui first, which mints them bootstrap native
// (paid in SOL, not in native), then they can call claim() to top up.
// Refill is a normal signer.sendTransaction away.
const RESERVE_CLAIMS = 4n;

// Hadrian quirk: estimateGas returns near the block gasLimit (4.8e13).
// Capping at ~30M (a fraction of the block) keeps the wallet's
// "balance >= gasLimit * gasPrice" preflight reasonable while leaving
// headroom for Rome's SBF-execution cost model (Compound's contracts
// can burn ~18M for a small deploy + ~6-10M per ERC20 transfer through
// the cached SPL wrapper because each ERC20 op CPIs into Solana).
// Tuned against Hadrian: deploy was empirically 18.6M, cached-wrapper
// transfer ~10M. Setting just over actual need so the wallet's
// budget-check multiplier (Rome appears to scale gas budget by a
// large factor for OutOfFund preflight) stays survivable against the
// deployer's ~150 native balance.
const DEPLOY_GAS_LIMIT = 20_000_000n;
const NATIVE_SEND_GAS_LIMIT = 1_000_000n;
const ADD_TOKEN_GAS_LIMIT = 2_000_000n;
const ERC20_TRANSFER_GAS_LIMIT = 12_000_000n;

// ERC20 minimal ABI for transfer + balanceOf + decimals (decimals already in state.json)
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  const collats = state.collateralAssets.filter((c: { symbol: string }) =>
    (MOCK_SYMBOLS as readonly string[]).includes(c.symbol),
  );
  if (collats.length !== MOCK_SYMBOLS.length) {
    throw new Error(
      `state.json missing one of ${MOCK_SYMBOLS.join(',')}; found only ${collats.map((c: any) => c.symbol).join(',')}`,
    );
  }

  // ── 1. Deploy or reuse Faucet ───────────────────────────────────────
  const Faucet = await ethers.getContractFactory('CompoundFaucet', deployer);
  const gasDropWei = NATIVE_PER_CLAIM * 10n ** 18n;
  const seedNative = gasDropWei * RESERVE_CLAIMS;

  let faucetAddress: string | undefined = state.faucet?.address;
  if (!faucetAddress) {
    // Deploy WITHOUT a value transfer. Rome's preflight rejects deploy
    // txs with non-zero value (chain-side OutOfFund check is too tight
    // when combined with the EIP-1559 gas budget). Fund the contract
    // separately below via signer.sendTransaction.
    // Hadrian: baseFee=0, priorityFee=0 — explicitly pass legacy tx +
    // gasPrice=0 to short-circuit Rome's preflight budget calculation
    // (which seems to scale gas with a multiplier we can't see). Same
    // for the other txs below.
    const legacyZero = { gasLimit: DEPLOY_GAS_LIMIT, type: 0, gasPrice: 0n };
    console.log(`[1/4] Deploying CompoundFaucet (gasDrop=${NATIVE_PER_CLAIM} native, seed later)...`);
    const faucet = await deployContract<Contract>(Faucet, [gasDropWei], legacyZero);
    faucetAddress = faucet.address;
    console.log(`    Faucet: ${faucetAddress}`);
  } else {
    console.log(`[1/4] Reusing existing Faucet at ${faucetAddress}`);
  }

  // ── 1b. Top up native reserve via raw sendTransaction ──────────────
  const currentReserve = (await ethers.provider.getBalance(faucetAddress!)).toBigInt();
  if (currentReserve < seedNative) {
    const need = seedNative - currentReserve;
    console.log(`[1b/4] Funding faucet with ${need} wei native (current=${currentReserve}, target=${seedNative})`);
    await sendTx(deployer, { to: faucetAddress, value: need, gasLimit: NATIVE_SEND_GAS_LIMIT, type: 0, gasPrice: 0n });
  } else {
    console.log(`[1b/4] Native reserve already ${currentReserve} ≥ target ${seedNative}, skipping`);
  }

  const faucet = new ethers.Contract(
    faucetAddress!,
    [
      'function addToken(address token, uint256 amount) external',
      'function tokenDrop(address) external view returns (uint256)',
      'function tokenList() external view returns (address[])',
      'function owner() external view returns (address)',
    ],
    deployer,
  );

  // ── 2. Register tokens (skip already-registered) ────────────────────
  const existing: string[] = (await faucet.tokenList()).map((a: string) => a.toLowerCase());
  for (const c of collats) {
    const drop = TOKENS_PER_CLAIM * 10n ** BigInt(c.decimals);
    if (existing.includes(c.address.toLowerCase())) {
      console.log(`[3/4] ${c.symbol} already registered, skipping`);
      continue;
    }
    console.log(`[3/4] addToken(${c.symbol}=${c.address}, drop=${drop})...`);
    await callTx(faucet, 'addToken', [c.address, drop], { gasLimit: ADD_TOKEN_GAS_LIMIT, type: 0, gasPrice: 0n });
  }

  // ── 3. Pre-fund each token to RESERVE_CLAIMS × drop ─────────────────
  for (const c of collats) {
    const drop = TOKENS_PER_CLAIM * 10n ** BigInt(c.decimals);
    const target = drop * RESERVE_CLAIMS;
    const token = new ethers.Contract(c.address, ERC20_ABI, deployer);
    const current: bigint = (await token.balanceOf(faucetAddress!)).toBigInt();
    if (current >= target) {
      console.log(`[4/4] ${c.symbol} reserve already ${current} ≥ target ${target}, skipping`);
      continue;
    }
    const need = target - current;
    console.log(`[4/4] Transferring ${need} ${c.symbol} to faucet (current=${current}, target=${target})`);
    await callTx(token, 'transfer', [faucetAddress!, need], { gasLimit: ERC20_TRANSFER_GAS_LIMIT, type: 0, gasPrice: 0n });
  }

  // ── Write back to state.json ────────────────────────────────────────
  state.faucet = {
    address: faucetAddress,
    gasDropWei: gasDropWei.toString(),
    tokens: collats.map((c: { symbol: string; address: string; decimals: number }) => ({
      symbol: c.symbol,
      address: c.address,
      decimals: c.decimals,
      dropAmountWei: (TOKENS_PER_CLAIM * 10n ** BigInt(c.decimals)).toString(),
    })),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`\nFaucet deployed + funded. state.json updated.`);
  console.log(`  faucet: ${faucetAddress}`);
  console.log(`  gasDrop: ${NATIVE_PER_CLAIM} native (${gasDropWei} wei)`);
  for (const c of collats) {
    console.log(`  ${c.symbol}: ${TOKENS_PER_CLAIM} per claim (${c.address})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
