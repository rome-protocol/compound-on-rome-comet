# FaucetEgress — native-wallet test-fund drop (Solana lane)

`contracts/test/FaucetEgress.sol` drops SPL test funds straight into a user's
**own Solana wallet** (their pubkey's associated-token-account), so the
Solana-native lending lane can supply from the wallet the way a real Solana
user would. One operator-signed tx per token; the recipient signs nothing.

## Why this exists (two faucets, one per lane)

A lending position on Rome is an EVM Comet contract. A Solana-native user
drives it through a **synthetic** EVM identity (`keccak(pubkey)[12:]`), and the
synthetic is only ever a **pass-through**: supply flows `wallet ATA → synthetic
ATA → Comet`, withdraw reverses it. Funds originate and come to rest in the
user's real wallet.

So a faucet must deliver to the **signing wallet**, per lane:

| Lane | Faucet | Drops to | Notes |
|---|---|---|---|
| EVM / MetaMask | `CompoundFaucet` (windowed `claimTokens`) | the user's EVM address (its PDA ATA) | claim runs through the iterative VM — no per-tx CU cap |
| Solana / Phantom | **`FaucetEgress`** (this) | the user's **own Phantom wallet ATA** | one operator-signed tx per token |

Dropping Solana-lane funds into the synthetic's PDA ATA "works" but is the
wrong model — the user can't see it in Phantom and it skips the wallet origin
the supply flow pulls from. `FaucetEgress` fixes that.

## How it works

The faucet tokens are `SPL_ERC20_cached` wrappers whose **underlying SPL mint
authority is a program PDA** — there is no native keypair to mint with, and the
cached wrappers expose no bridge-out. So the operator (which already holds the
full mint supply on the EVM side, in its `external_auth` PDA ATA) **transfers**
to the user's wallet:

```
drop(recipient, toAta, mint, amount):
  create_ata_for_key(recipient, mint)        // idempotent; creates the user's wallet ATA
  transfer_spl(toAta, amount, mint)          // from external_auth(msg.sender)'s ATA -> user's ATA
```

Both are `HelperProgram` (`0xff..09`) delegatecalls — the same two-CPI body as
`SPL_ERC20.bridgeOutToSolana`, generalized over an arbitrary `mint` so one
deployed contract serves every faucet token (the per-wrapper bridge-out is
hard-bound to its own mint, and the cached collaterals have none).

- `recipient` / `mint` / `toAta` are 32-byte Solana pubkeys as `bytes32`.
- `toAta` = `getAssociatedTokenAddress(mint, recipient)`, derived off-chain by
  the caller and passed in (avoids an on-chain `find_program_address`).
- `create_ata_for_key` is CPI-only (can't run in the iterative VM), so each
  `drop` is one atomic Solana tx (1 create + 1 transfer, well under the 1.4M-CU
  cap). To drop N tokens, the caller loops `drop` per mint — the user clicks
  once and signs nothing; the operator fires N txs.

## Deployments

| Chain | FaucetEgress |
|---|---|
| Hadrian (200010) | `0xb022f3143b5127693e215C542DA5d84f516D2F2e` |

Verified live on Hadrian: dropped 1 wBTC to a fresh wallet → landed in an ATA
owned by that wallet's pubkey (not a PDA), one operator tx, recipient signed
nothing.

## Run

```sh
EGRESS=<addr> ETH_PK=<operator-key> \
  ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
  UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
  npx hardhat run scripts/faucet-egress/deploy-and-drive.ts --network hadrian
```

Omit `EGRESS` to deploy a fresh instance. The operator key must hold the mint
supply (the deployer does). Follow-up: a backend endpoint that loops `drop`
over the comet's collaterals for the connecting wallet, wired into the demo's
`/solana/faucet`.
