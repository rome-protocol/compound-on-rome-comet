// Shared helpers for UnifiedToken tests.
//
// The contracts under test call Rome-specific precompiles
// (SystemProgram @ 0xFF...07, CpiProgram @ 0xFF...08). For Hardhat unit tests
// we deploy mock precompile contracts and overwrite the precompile addresses
// via `hre.network.provider.send('hardhat_setCode', [addr, bytecode])`.
//
// Real-world behavior (signed CPI semantics, ATA derivation against actual
// Solana programs) is exercised in the Marcus integration test in Phase 1.4.

import { ethers } from 'hardhat';
import { Contract, BigNumber, Signer } from 'ethers';
import { expect } from 'chai';

/** Solana devnet USDC mint pubkey, bytes32 form. */
export const USDC_MINT_DEVNET =
  '0x3c92cce8c0d8d5a3c1c9c19acc88f3afa635c2d3a06c81ba9b8a0d2cd62b4030';
// (placeholder — actual value bs58-decoded from 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
//  used at runtime in integration tests; for unit tests the value just has to be
//  non-zero and unique. Tests assert identity, not derivation correctness.)

/** A second mint so parameterized-mint tests can compare two instances. */
export const USDS_MINT_PLACEHOLDER =
  '0xff112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

/** A third mint for triple-instance isolation tests. */
export const JUPUSD_MINT_PLACEHOLDER =
  '0xff998877665544332211aabbccddeeff00112233445566778899aabbccddeeff';

export const SYSTEM_PROGRAM_ADDR = '0xfF00000000000000000000000000000000000007';
export const CPI_PROGRAM_ADDR = '0xFF00000000000000000000000000000000000008';

/**
 * Install MockPrecompile contracts at the canonical precompile addresses so
 * Solidity calls to SystemProgram / CpiProgram resolve to test logic.
 *
 * Returns the deployed mock contracts so the test can stub specific responses.
 */
export async function installMockPrecompiles() {
  const MockSystemProgram = await ethers.getContractFactory('MockSystemProgram');
  const MockCpiProgram = await ethers.getContractFactory('MockCpiProgram');

  const sysImpl = await MockSystemProgram.deploy();
  await sysImpl.deployed();
  const cpiImpl = await MockCpiProgram.deploy();
  await cpiImpl.deployed();

  // Copy bytecode from the deployed implementations into the precompile addresses.
  const sysCode = await ethers.provider.getCode(sysImpl.address);
  const cpiCode = await ethers.provider.getCode(cpiImpl.address);

  await ethers.provider.send('hardhat_setCode', [SYSTEM_PROGRAM_ADDR, sysCode]);
  await ethers.provider.send('hardhat_setCode', [CPI_PROGRAM_ADDR, cpiCode]);

  // Bind to the precompile address so tests can configure mock state.
  const sys = MockSystemProgram.attach(SYSTEM_PROGRAM_ADDR);
  const cpi = MockCpiProgram.attach(CPI_PROGRAM_ADDR);

  return { sys, cpi };
}

/** Convert a u64 amount into Borsh-encoded SPL Token Account data (165 bytes). */
export function encodeSplTokenAccountData(amount: bigint, owner?: string, mint?: string): string {
  // Layout (165 bytes total):
  //   mint:                 bytes32              (offset 0..32)
  //   owner:                bytes32              (offset 32..64)
  //   amount:               u64 LE               (offset 64..72)
  //   delegate:             COption<bytes32>     (offset 72..108)
  //   state:                u8                   (offset 108..109)
  //   is_native:            COption<u64>         (offset 109..121)
  //   delegated_amount:     u64 LE               (offset 121..129)
  //   close_authority:      COption<bytes32>     (offset 129..165)
  const buf = Buffer.alloc(165);
  if (mint) Buffer.from(mint.slice(2), 'hex').copy(buf, 0);
  if (owner) Buffer.from(owner.slice(2), 'hex').copy(buf, 32);
  // amount LE
  for (let i = 0; i < 8; i++) {
    buf[64 + i] = Number((amount >> BigInt(i * 8)) & 0xffn);
  }
  // delegate COption tag = 0 (None)
  // state = 1 (Initialized)
  buf[108] = 1;
  // is_native COption tag = 0 (None)
  // delegated_amount = 0
  // close_authority COption = 0
  return '0x' + buf.toString('hex');
}

/** Encode an SPL mint account (82 bytes). */
export function encodeSplMintData(supply: bigint, decimals: number): string {
  const buf = Buffer.alloc(82);
  // mint_authority COption tag = 1 + 32 bytes (use zero pubkey)
  buf[0] = 1;
  // supply (offset 36..44) — actually offset 36 because mint_authority is 36 bytes (4 tag + 32)
  for (let i = 0; i < 8; i++) {
    buf[36 + i] = Number((supply >> BigInt(i * 8)) & 0xffn);
  }
  // decimals (offset 44)
  buf[44] = decimals;
  // is_initialized = 1
  buf[45] = 1;
  // freeze_authority COption tag = 0
  return '0x' + buf.toString('hex');
}

/** Get an EIP-712 typed data signature for ERC-2612 permit. */
export async function signPermit(
  signer: Signer,
  token: Contract,
  owner: string,
  spender: string,
  value: BigNumber,
  nonce: BigNumber,
  deadline: number,
  chainId: number,
) {
  const name = await token.name();
  const verifyingContract = token.address;
  const domain = {
    name,
    version: '1',
    chainId,
    verifyingContract,
  };
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const message = { owner, spender, value, nonce, deadline };
  // @ts-ignore -- ethers v5 type narrowing on _signTypedData
  const signature = await signer._signTypedData(domain, types, message);
  return ethers.utils.splitSignature(signature);
}

export { expect, ethers };
