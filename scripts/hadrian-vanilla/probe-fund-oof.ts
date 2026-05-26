// Diagnostic probe — isolate why signer.sendTransaction({value: ...})
// errors "OutOfFund" against Hadrian when the deployer's eth_getBalance
// reports plenty of native gas.
//
// What this proves:
//   1. The exact address derived from ETH_PK (must match expected deployer).
//   2. Whether value=1n minimal also OOFs (or only value=40e18).
//   3. Whether providing a real gasPrice (vs 0) changes the outcome.
//   4. Whether EIP-1559 (type=2) routes through a different code path.
//   5. The full error object — including any address mentioned in the
//      OOF body (which would otherwise be redacted in the user-visible
//      message).
//
// Run as:
//   ETH_PK=<key> ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub \
//     MAINNET_QUICKNODE_LINK=stub UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-vanilla/probe-fund-oof.ts --network hadrian
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';

const STATE_PATH = path.resolve(__dirname, 'state.json');

async function probe(
  label: string,
  signer: any,
  tx: Record<string, unknown>,
): Promise<void> {
  console.log(`\n── ${label} ───────────────────────────────────`);
  console.log('  tx:', JSON.stringify({
    ...tx,
    value: typeof tx.value === 'bigint' ? tx.value.toString() : tx.value,
    gasLimit: typeof tx.gasLimit === 'bigint' ? tx.gasLimit.toString() : tx.gasLimit,
    gasPrice: typeof tx.gasPrice === 'bigint' ? tx.gasPrice.toString() : tx.gasPrice,
    maxFeePerGas: typeof tx.maxFeePerGas === 'bigint' ? tx.maxFeePerGas.toString() : tx.maxFeePerGas,
    maxPriorityFeePerGas: typeof tx.maxPriorityFeePerGas === 'bigint' ? tx.maxPriorityFeePerGas.toString() : tx.maxPriorityFeePerGas,
  }));
  try {
    const response = await signer.sendTransaction(tx);
    console.log('  SUCCESS — hash:', response.hash);
    const receipt = await response.wait();
    console.log('  receipt status:', receipt.status, 'gasUsed:', receipt.gasUsed.toString());
  } catch (err: any) {
    console.log('  FAILED');
    console.log('  err.code:', err?.code);
    console.log('  err.message:', err?.message?.slice(0, 500));
    console.log('  err.error?.message:', err?.error?.message?.slice(0, 500));
    console.log('  err.error?.error?.message:', err?.error?.error?.message?.slice(0, 500));
    console.log('  err.error?.error?.data:', err?.error?.error?.data?.slice?.(0, 500));
    console.log('  err.data:', err?.data?.slice?.(0, 500));
    console.log('  err.reason:', err?.reason);
    console.log('  full err JSON:', JSON.stringify(err, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2)?.slice(0, 2000));
  }
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const faucetAddress = state.faucet?.address ?? '0x83af72019650321E1fC5c61687ff7F84f66Fa93F';

  const address = await deployer.getAddress();
  console.log('═══════════════════════════════════════════════');
  console.log('  DEPLOYER:        ', address);
  console.log('  state.deployer:  ', state.deployer);
  console.log('  match:           ', address.toLowerCase() === state.deployer.toLowerCase());
  console.log('  faucet:          ', faucetAddress);
  console.log('  chain:           ', (await ethers.provider.getNetwork()).chainId);
  console.log('  block:           ', await ethers.provider.getBlockNumber());

  const balance = await ethers.provider.getBalance(address);
  const nonce = await ethers.provider.getTransactionCount(address);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice;
  console.log('  balance:         ', balance.toString(), `(${(BigInt(balance.toString()) / 10n ** 18n).toString()} native)`);
  console.log('  nonce:           ', nonce);
  console.log('  feeData.gasPrice:', gasPrice?.toString());
  console.log('═══════════════════════════════════════════════');

  // Probe 1: minimal value (1 wei), legacy + gasPrice=0
  await probe('Probe 1: value=1n, legacy, gasPrice=0', deployer, {
    to: faucetAddress,
    value: 1n,
    gasLimit: 1_000_000n,
    type: 0,
    gasPrice: 0n,
  });

  // Probe 2: minimal value (1 wei), legacy + real gasPrice from feeData
  if (gasPrice) {
    await probe('Probe 2: value=1n, legacy, gasPrice=feeData', deployer, {
      to: faucetAddress,
      value: 1n,
      gasLimit: 1_000_000n,
      type: 0,
      gasPrice: gasPrice.toBigInt(),
    });
  }

  // Probe 3: minimal value (1 wei), EIP-1559 with priority fee
  if (gasPrice) {
    await probe('Probe 3: value=1n, EIP-1559', deployer, {
      to: faucetAddress,
      value: 1n,
      gasLimit: 1_000_000n,
      type: 2,
      maxFeePerGas: gasPrice.toBigInt(),
      maxPriorityFeePerGas: 0n,
    });
  }

  // Probe 4: ZERO value transfer to a contract (no value)
  await probe('Probe 4: value=0n (no value), legacy gasPrice=0', deployer, {
    to: faucetAddress,
    value: 0n,
    gasLimit: 1_000_000n,
    type: 0,
    gasPrice: 0n,
  });

  // Probe 5: the actual failing case — value=40e18
  await probe('Probe 5: value=40e18, legacy, gasPrice=0', deployer, {
    to: faucetAddress,
    value: 40n * 10n ** 18n,
    gasLimit: 1_000_000n,
    type: 0,
    gasPrice: 0n,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
