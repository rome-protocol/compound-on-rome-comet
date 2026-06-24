// Unit tests for CompoundFaucet — the one-shot, fixed-amount test-fund
// drip used by compound-on-rome-demo's /faucet page.
//
// Differs from Compound's stock Fauceteer (0.01% per-token-per-day drip).
// This faucet:
//   - Drips a FIXED amount per registered token (set by owner at addToken)
//   - Drips a FIXED native gas amount (set at construction)
//   - Allows AT MOST ONE claim per address ever (mapping claimed[user])
//   - Uses IERC20.transfer (not mint) because compound's SPL_ERC20_cached
//     wrappers have no public mint
import { expect, exp, makeProtocol } from './helpers';
import { ethers } from 'hardhat';

describe('CompoundFaucet', () => {
  async function deployFaucet({ gasDrop }: { gasDrop: bigint }) {
    const [deployer, user] = await ethers.getSigners();
    const Faucet = await ethers.getContractFactory('CompoundFaucet');
    const faucet = await Faucet.connect(deployer).deploy(gasDrop, { value: gasDrop });
    await faucet.deployed();
    return { faucet, deployer, user };
  }

  it('lets owner register tokens with a per-claim drop amount', async () => {
    const protocol = await makeProtocol();
    const { faucet, deployer } = await deployFaucet({ gasDrop: 0n });
    const token = protocol.tokens['USDC'];
    const drop = exp(100, 6);
    await faucet.connect(deployer).addToken(token.address, drop);
    expect((await faucet.tokenDrop(token.address)).toBigInt()).to.equal(drop);
    expect(await faucet.tokens(0)).to.equal(token.address);
  });

  it('reverts addToken when called by non-owner', async () => {
    const protocol = await makeProtocol();
    const { faucet } = await deployFaucet({ gasDrop: 0n });
    const [, , notOwner] = await ethers.getSigners();
    const token = protocol.tokens['USDC'];
    await expect(
      faucet.connect(notOwner).addToken(token.address, '1'),
    ).to.be.revertedWith('CompoundFaucet: not owner');
  });

  it('claim sends gas + token drops + flips claimed mapping', async () => {
    const protocol = await makeProtocol();
    const { faucet, deployer, user } = await deployFaucet({ gasDrop: exp(10, 18) });
    const token = protocol.tokens['USDC'];
    const drop = exp(100, 6);
    await faucet.connect(deployer).addToken(token.address, drop);

    // Pre-fund the faucet with enough token balance for one claim. The
    // FaucetToken in tests has a public allocateTo so we drip into the
    // faucet directly without consuming the deployer's allowance.
    await token.allocateTo(faucet.address, drop);

    const gasBefore = (await ethers.provider.getBalance(user.address)).toBigInt();
    const tokenBefore = (await token.balanceOf(user.address)).toBigInt();

    const tx = await faucet.connect(user).claim();
    const receipt = await tx.wait();
    const gasCost = receipt.gasUsed.mul(receipt.effectiveGasPrice).toBigInt();

    const gasAfter = (await ethers.provider.getBalance(user.address)).toBigInt();
    const tokenAfter = (await token.balanceOf(user.address)).toBigInt();
    expect(gasAfter).to.equal(gasBefore + exp(10, 18) - gasCost);
    expect(tokenAfter).to.equal(tokenBefore + drop);
    expect(await faucet.claimed(user.address)).to.equal(true);
  });

  // Windowed claim makes claim() idempotent/resumable: a second full claim
  // re-drips nothing (every token already flagged) and does NOT revert. The
  // per-token guard still enforces at-most-once PER TOKEN, so the anti-drain
  // property holds — only the all-or-nothing revert is gone.
  it('second claim from the same address is a no-op (no extra tokens, no revert)', async () => {
    const protocol = await makeProtocol();
    const { faucet, deployer, user } = await deployFaucet({ gasDrop: exp(1, 18) });
    const token = protocol.tokens['USDC'];
    const drop = exp(100, 6);
    await faucet.connect(deployer).addToken(token.address, drop);
    await token.allocateTo(faucet.address, drop * 2n);

    await faucet.connect(user).claim();
    const afterFirst = (await token.balanceOf(user.address)).toBigInt();
    await faucet.connect(user).claim(); // must not revert
    const afterSecond = (await token.balanceOf(user.address)).toBigInt();
    expect(afterSecond).to.equal(afterFirst); // no double-drip
  });

  it('emits Claimed(user, gas, tokenCount) on success', async () => {
    const protocol = await makeProtocol();
    const { faucet, deployer, user } = await deployFaucet({ gasDrop: 0n });
    const token = protocol.tokens['USDC'];
    const drop = exp(100, 6);
    await faucet.connect(deployer).addToken(token.address, drop);
    await token.allocateTo(faucet.address, drop);
    await expect(faucet.connect(user).claim())
      .to.emit(faucet, 'Claimed')
      .withArgs(user.address, 0, 1);
  });

  it('tokenList returns all registered tokens', async () => {
    const protocol = await makeProtocol();
    const { faucet, deployer } = await deployFaucet({ gasDrop: 0n });
    const a = protocol.tokens['USDC'];
    const b = protocol.tokens['COMP'] ?? protocol.tokens['WETH'];
    await faucet.connect(deployer).addToken(a.address, '1');
    await faucet.connect(deployer).addToken(b.address, '1');
    const list = await faucet.tokenList();
    expect(list).to.have.lengthOf(2);
    expect(list[0]).to.equal(a.address);
    expect(list[1]).to.equal(b.address);
  });

  // ---------------------------------------------------------------------------
  // Windowed claim — claimTokens(start, count). Lets the Solana-native lane
  // split a multi-token drip across 2 sequential DoTxUnsigned txs so neither
  // exceeds Solana's 1.4M CU cap. The 6-cached-wrapper claim() over-runs at
  // 1.3996M CU in one atomic Solana tx; claimTokens windows the transfers.
  // ---------------------------------------------------------------------------

  // Register N distinct fixed-drop tokens, each pre-funded for one claim.
  async function deployWithTokens(count: number, gasDrop = 0n) {
    const { faucet, deployer, user } = await deployFaucet({ gasDrop });
    const _protocol = await makeProtocol();
    const drop = exp(100, 6);
    const tokens = [];
    for (let i = 0; i < count; i++) {
      const Tok = await ethers.getContractFactory('FaucetToken');
      const t = await Tok.deploy(exp(1_000_000, 18).toString(), `T${i}`, 18, `T${i}`);
      await t.deployed();
      await faucet.connect(deployer).addToken(t.address, drop);
      await t.allocateTo(faucet.address, drop);
      tokens.push(t);
    }
    return { faucet, deployer, user, tokens, drop };
  }

  it('claimTokens(start,count) drips ONLY the window', async () => {
    const { faucet, user, tokens, drop } = await deployWithTokens(4);
    await faucet.connect(user).claimTokens(0, 2);
    expect((await tokens[0].balanceOf(user.address)).toBigInt()).to.equal(drop);
    expect((await tokens[1].balanceOf(user.address)).toBigInt()).to.equal(drop);
    expect((await tokens[2].balanceOf(user.address)).toBigInt()).to.equal(0n);
    expect((await tokens[3].balanceOf(user.address)).toBigInt()).to.equal(0n);
  });

  it('two windows cover all tokens, each exactly once', async () => {
    const { faucet, user, tokens, drop } = await deployWithTokens(4);
    await faucet.connect(user).claimTokens(0, 2);
    await faucet.connect(user).claimTokens(2, 2);
    for (const t of tokens) {
      expect((await t.balanceOf(user.address)).toBigInt()).to.equal(drop);
    }
  });

  it('claimTokens is idempotent per token (no double-drip on overlapping windows)', async () => {
    const { faucet, user, tokens, drop } = await deployWithTokens(4);
    await faucet.connect(user).claimTokens(0, 3);
    await faucet.connect(user).claimTokens(1, 3); // overlaps tokens 1,2
    for (const t of tokens) {
      expect((await t.balanceOf(user.address)).toBigInt()).to.equal(drop); // never 2×drop
    }
  });

  it('count past the end clamps (no revert)', async () => {
    const { faucet, user, tokens, drop } = await deployWithTokens(4);
    await faucet.connect(user).claimTokens(2, 999);
    expect((await tokens[2].balanceOf(user.address)).toBigInt()).to.equal(drop);
    expect((await tokens[3].balanceOf(user.address)).toBigInt()).to.equal(drop);
    expect((await tokens[0].balanceOf(user.address)).toBigInt()).to.equal(0n);
  });

  it('gas drop is sent once across windows', async () => {
    const { faucet, user } = await deployWithTokens(4, exp(5, 18));
    const before = (await ethers.provider.getBalance(user.address)).toBigInt();
    const r1 = await (await faucet.connect(user).claimTokens(0, 2)).wait();
    const r2 = await (await faucet.connect(user).claimTokens(2, 2)).wait();
    const cost = r1.gasUsed.mul(r1.effectiveGasPrice).toBigInt() + r2.gasUsed.mul(r2.effectiveGasPrice).toBigInt();
    const after = (await ethers.provider.getBalance(user.address)).toBigInt();
    // Net gas delta = +5e18 (once) - tx costs; if gas were sent twice it'd be +10e18.
    expect(after).to.equal(before + exp(5, 18) - cost);
  });

  it('claim() still drips ALL tokens (claim-all preserved for the EVM lane)', async () => {
    const { faucet, user, tokens, drop } = await deployWithTokens(5);
    await faucet.connect(user).claim();
    for (const t of tokens) {
      expect((await t.balanceOf(user.address)).toBigInt()).to.equal(drop);
    }
  });

  it('claimed(user) view is false until every token + gas is claimed', async () => {
    const { faucet, user } = await deployWithTokens(4, exp(1, 18));
    expect(await faucet.claimed(user.address)).to.equal(false);
    await faucet.connect(user).claimTokens(0, 2);
    expect(await faucet.claimed(user.address)).to.equal(false); // 2 of 4 done
    await faucet.connect(user).claimTokens(2, 2);
    expect(await faucet.claimed(user.address)).to.equal(true); // all done
  });
});
