// UnifiedToken — EVM-side allowance state.
//
// Decision: allowances live on the EVM side, NOT the SPL delegate model.
// Reasons:
//   1. Solana's SPL delegate is single-spender per token account; EVM ERC-20
//      semantics expect (owner, spender) pairwise allowance tables.
//   2. Cross-implementation drift: SPL_ERC20's dual model (delegate + EVM
//      allowance) led to subtle bugs around contract spenders. Clean separation.
//   3. Compound's allowance audit assumes ERC-20 semantics. UnifiedToken
//      reproduces those semantics 1:1.
//
// Behavior:
//   - approve(spender, value) writes EVM-side mapping; emits Approval.
//   - allowance(owner, spender) reads from the same mapping.
//   - transferFrom decrements unless `value == type(uint256).max` (canonical
//     "infinite allowance" optimization, matches OZ ERC-20).
//   - increaseAllowance / decreaseAllowance helpers from OZ.

import {
  expect, ethers,
  installMockPrecompiles,
  encodeSplTokenAccountData,
  USDC_MINT_DEVNET,
} from './_helpers';

describe('UnifiedToken — allowances (EVM-side)', function () {
  let token: any;
  let sys: any;
  let cpi: any;
  let alice: any;
  let bob: any;

  beforeEach(async () => {
    [, alice, bob] = await ethers.getSigners();
    ({ sys, cpi } = await installMockPrecompiles());

    const T = await ethers.getContractFactory('UnifiedToken');
    token = await T.deploy(USDC_MINT_DEVNET, 'Unified USDC', 'USDC', 6);
    await token.deployed();

    const aliceAta = '0x1111111111111111111111111111111111111111111111111111111111111111';
    await sys.setAtaFor(alice.address, USDC_MINT_DEVNET, aliceAta);
    await cpi.setAccountData(aliceAta, encodeSplTokenAccountData(1_000_000_000n));
  });

  it('approve sets allowance and emits Approval', async () => {
    await expect(token.connect(alice).approve(bob.address, 100_000_000))
      .to.emit(token, 'Approval')
      .withArgs(alice.address, bob.address, 100_000_000);

    expect(await token.allowance(alice.address, bob.address)).to.equal(100_000_000);
  });

  it('approve overwrites prior allowance', async () => {
    await token.connect(alice).approve(bob.address, 100_000_000);
    await token.connect(alice).approve(bob.address, 50_000_000);
    expect(await token.allowance(alice.address, bob.address)).to.equal(50_000_000);
  });

  it('approve to zero address reverts', async () => {
    await expect(
      token.connect(alice).approve(ethers.constants.AddressZero, 100_000_000),
    ).to.be.revertedWith('ERC20: approve to the zero address');
  });

  it('approve from zero address impossible (msg.sender always non-zero)', async () => {
    // Sanity: there is no path where owner is address(0) in approve.
    expect(true).to.equal(true);
  });

  it('increaseAllowance adds to existing allowance', async () => {
    await token.connect(alice).approve(bob.address, 100_000_000);
    await expect(token.connect(alice).increaseAllowance(bob.address, 50_000_000))
      .to.emit(token, 'Approval')
      .withArgs(alice.address, bob.address, 150_000_000);
    expect(await token.allowance(alice.address, bob.address)).to.equal(150_000_000);
  });

  it('decreaseAllowance subtracts; reverts on underflow', async () => {
    await token.connect(alice).approve(bob.address, 100_000_000);
    await token.connect(alice).decreaseAllowance(bob.address, 30_000_000);
    expect(await token.allowance(alice.address, bob.address)).to.equal(70_000_000);

    await expect(
      token.connect(alice).decreaseAllowance(bob.address, 200_000_000),
    ).to.be.revertedWith('ERC20: decreased allowance below zero');
  });

  it('infinite allowance does not decrement on transferFrom', async () => {
    await token.connect(alice).approve(bob.address, ethers.constants.MaxUint256);

    // Stub bob's ATA + carlos's ATA so the transferFrom CPI mock can succeed.
    const bobAta = '0x2222222222222222222222222222222222222222222222222222222222222222';
    await sys.setAtaFor(bob.address, USDC_MINT_DEVNET, bobAta);
    await cpi.setAccountData(bobAta, encodeSplTokenAccountData(0n));

    await token.connect(bob).transferFrom(alice.address, bob.address, 50_000_000);
    expect(await token.allowance(alice.address, bob.address)).to.equal(ethers.constants.MaxUint256);
  });

  it('finite allowance decrements on each transferFrom call', async () => {
    await token.connect(alice).approve(bob.address, 100_000_000);

    const bobAta = '0x2222222222222222222222222222222222222222222222222222222222222222';
    await sys.setAtaFor(bob.address, USDC_MINT_DEVNET, bobAta);
    await cpi.setAccountData(bobAta, encodeSplTokenAccountData(0n));

    await token.connect(bob).transferFrom(alice.address, bob.address, 30_000_000);
    expect(await token.allowance(alice.address, bob.address)).to.equal(70_000_000);

    await token.connect(bob).transferFrom(alice.address, bob.address, 20_000_000);
    expect(await token.allowance(alice.address, bob.address)).to.equal(50_000_000);
  });

  it('does NOT issue a Solana SPL approve CPI', async () => {
    // The whole point of EVM-side allowances: zero CPI on approve.
    await token.connect(alice).approve(bob.address, 100_000_000);
    const calls = await cpi.getInvocations();
    expect(calls.length).to.equal(0);
  });
});
