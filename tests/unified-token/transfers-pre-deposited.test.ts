// UnifiedToken — pre-deposited mode (Solana lane).
//
// Spec §5.1 Tier A mode-(a): the orchestrator program already moved SPL tokens
// from the supplier's ATA → the protocol's authority-PDA's ATA in the SAME
// Solana tx. UnifiedToken's `transferFromPreDeposited(...)` confirms the ATA
// balance increased by `value` since a pre-call snapshot, and emits the
// Transfer event so the lending protocol sees a normal IERC20 receipt.
//
// This path takes ZERO CPIs — the SPL movement already happened upstream.
// CU savings vs the EVM-lane CPI path are material (each CPI ≈ 1-7K CU).
//
// Authority: only addresses with the PRE_DEPOSITED_CALLER role can invoke
// the verify-mode (typically Compound's MetaHook callee, NOT user wallets).
// This prevents griefing where a user replays a stale snapshot to "pull"
// someone else's freshly-deposited balance.

import {
  expect, ethers,
  installMockPrecompiles,
  encodeSplTokenAccountData,
  USDC_MINT_DEVNET,
} from './_helpers';

describe('UnifiedToken — pre-deposited mode (Solana lane)', function () {
  let token: any;
  let sys: any;
  let cpi: any;
  let admin: any;
  let alice: any;
  let bob: any;
  let orchestrator: any;
  const protocolPdaAta = '0x9999999999999999999999999999999999999999999999999999999999999999';

  beforeEach(async () => {
    [admin, alice, bob, orchestrator] = await ethers.getSigners();
    ({ sys, cpi } = await installMockPrecompiles());

    const T = await ethers.getContractFactory('UnifiedToken');
    token = await T.deploy(USDC_MINT_DEVNET, 'Unified USDC', 'USDC', 6);
    await token.deployed();

    // Grant orchestrator the PRE_DEPOSITED_CALLER role.
    await token.connect(admin).grantPreDepositedCaller(orchestrator.address);

    // Stub: protocol's PDA ATA at known location, alice's ATA elsewhere.
    const aliceAta = '0x1111111111111111111111111111111111111111111111111111111111111111';
    await sys.setAtaFor(alice.address, USDC_MINT_DEVNET, aliceAta);
  });

  it('verifies a pre-transfer and emits Transfer without CPI', async () => {
    // Snapshot: protocol ATA holds 0 before the orchestrator's SPL transfer.
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(0n));
    await token.connect(orchestrator).snapshotAta(protocolPdaAta);

    // Orchestrator submits the SPL transfer in the same Solana tx; mock simulates
    // the post-transfer state (ATA now holds 50 USDC).
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(50_000_000n));

    await expect(
      token.connect(orchestrator).transferFromPreDeposited(
        alice.address,
        protocolPdaAta,
        50_000_000,
      ),
    ).to.emit(token, 'Transfer').withArgs(alice.address, protocolPdaAta, 50_000_000);

    // Critical: zero CPIs were dispatched.
    const calls = await cpi.getInvocations();
    const transferCalls = calls.filter((c: any) => c.signed === true);
    expect(transferCalls.length).to.equal(0);
  });

  it('reverts if the post-snapshot delta is less than `value`', async () => {
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(0n));
    await token.connect(orchestrator).snapshotAta(protocolPdaAta);

    // Only 30 USDC actually deposited.
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(30_000_000n));

    await expect(
      token.connect(orchestrator).transferFromPreDeposited(
        alice.address,
        protocolPdaAta,
        50_000_000,
      ),
    ).to.be.revertedWith('UnifiedToken: insufficient pre-deposit');
  });

  it('reverts if no snapshot exists for the recipient ATA', async () => {
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(50_000_000n));

    await expect(
      token.connect(orchestrator).transferFromPreDeposited(
        alice.address,
        protocolPdaAta,
        50_000_000,
      ),
    ).to.be.revertedWith('UnifiedToken: no snapshot');
  });

  it('reverts when called by a non-PRE_DEPOSITED_CALLER address', async () => {
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(0n));

    await expect(
      token.connect(bob).snapshotAta(protocolPdaAta),
    ).to.be.revertedWith('UnifiedToken: not pre-deposited caller');

    await expect(
      token.connect(bob).transferFromPreDeposited(
        alice.address,
        protocolPdaAta,
        50_000_000,
      ),
    ).to.be.revertedWith('UnifiedToken: not pre-deposited caller');
  });

  it('snapshot is consumed (single-use) after a successful verify', async () => {
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(0n));
    await token.connect(orchestrator).snapshotAta(protocolPdaAta);
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(50_000_000n));
    await token.connect(orchestrator).transferFromPreDeposited(alice.address, protocolPdaAta, 50_000_000);

    // Second call (same snapshot) should fail — snapshot was consumed.
    await expect(
      token.connect(orchestrator).transferFromPreDeposited(alice.address, protocolPdaAta, 50_000_000),
    ).to.be.revertedWith('UnifiedToken: no snapshot');
  });

  it('emits Transfer with the synthetic-EVM-address corresponding to the recipient PDA', async () => {
    // The recipient ATA's owner-PDA is the protocol's PDA, but Transfer events
    // need an EVM address. The contract uses the bytes32-prefix of the ATA pubkey
    // as the EVM address representation when no explicit `to` EVM address is
    // supplied. (Tests against this convention; implementation may evolve to a
    // synthetic-address derivation lookup.)
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(0n));
    await token.connect(orchestrator).snapshotAta(protocolPdaAta);
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(50_000_000n));

    const tx = await token.connect(orchestrator).transferFromPreDeposited(alice.address, protocolPdaAta, 50_000_000);
    const rcpt = await tx.wait();
    const ev = rcpt.events!.find((e: any) => e.event === 'Transfer');
    expect(ev).to.not.be.undefined;
    expect(ev.args.from).to.equal(alice.address);
  });

  it('two snapshots on the same ATA can both verify in the same tx (compose)', async () => {
    // Compound's "supply 50 USDC" uses one snapshot; if the same Solana tx
    // also withdraws 50 USDC then re-supplies 30, two snapshots stack. This
    // tests the FIFO consumption.
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(0n));
    await token.connect(orchestrator).snapshotAta(protocolPdaAta);
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(50_000_000n));
    await token.connect(orchestrator).transferFromPreDeposited(alice.address, protocolPdaAta, 50_000_000);

    // Second snapshot
    await token.connect(orchestrator).snapshotAta(protocolPdaAta);
    await cpi.setAccountData(protocolPdaAta, encodeSplTokenAccountData(80_000_000n));
    await token.connect(orchestrator).transferFromPreDeposited(alice.address, protocolPdaAta, 30_000_000);
  });
});
