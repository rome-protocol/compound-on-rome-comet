// Fund the MARTIUS faucet WITHOUT the hadrian deployer key, by claiming from
// the PUBLIC hadrian CompoundFaucet and forwarding the SPL cross-chain.
//
// Why this works: the exotic-collat wrappers on hadrian and martius wrap the
// SAME underlying devnet test mints. A wrapper balance is plain SPL in the
// holder's per-chain-program ATA, and HelperProgram.transfer_spl(bytes32
// to_ata, …) can target ANY raw ATA — including the martius faucet's (created
// by martius-faucet/deploy.ts; pubkeys in state.json). Rome accepts
// gasPrice=0 legacy txs, so fresh throwaway wallets can claim + forward
// without ever holding native gas.
//
// Each throwaway wallet = one claim = 1 token of each collat (the hadrian
// faucet is one-time per token per wallet). N_CLAIMS wallets → N tokens per
// collat in the martius faucet. Hadrian faucet inventory is ~99,999 per token,
// so this draw is negligible.
//
// Run:
//   ETH_PK=<any key, unused for signing — wallets are generated> \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/martius-faucet/fund-via-hadrian-claims.ts --network hadrian
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';
import { callTx } from '../_lib/gas';

const STATE = path.resolve(__dirname, 'state.json');

const HADRIAN_FAUCET = '0xA24CB9b443F46aE205586Cd3dDF0447A9f295019';
const N_CLAIMS = 5; // → 5 claims of inventory per token on the martius faucet
const DROP = 10n ** 9n;

const LEGACY = { type: 0, gasPrice: 0n };
const CLAIM_GAS = 30_000_000n;
const XFER_GAS = 30_000_000n;

const FAUCET_ABI = [
  'function claimTokens(uint256 start, uint256 count) external',
  'function tokenClaimed(address user, address token) external view returns (bool)',
];
const HELPER = '0xff00000000000000000000000000000000000009';
const HELPER_ABI = ['function transfer_spl(bytes32 to_ata, uint64 tokens, bytes32 mint) external'];
const ERC20_ABI = ['function balanceOf(address account) external view returns (uint256)'];

// Hadrian-side wrapper per symbol (registry apps/compound/200010-hadrian.json).
// The MINTS come from state.json (identical on both chains); the wrapper
// addresses differ per chain, so the hadrian ones are pinned here.
const HADRIAN_WRAPPERS: Record<string, string> = {
  wBTC: '0xd3200df5e6f5e37fdba0275bb63dca1b22506760',
  wJitoSOL: '0x1ae3f6327a919c33ebb7590df3d14e3f222f2b04',
  wmSOL: '0x872b857058bfb8bf30720b3aa6a0816b76abb271',
  wJUP: '0x1b3f2b2d67d5ac13bc9c3121eedf15e968e5609a',
  wJTO: '0xcca3f9df5e9f60bb7485606260e3816ebcafbf7f',
  wBONK: '0xae4309c91925e1710d725234aa8797631dc3d88a',
};

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));

  for (let i = 0; i < N_CLAIMS; i++) {
    const wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    console.log(`\n[claim ${i + 1}/${N_CLAIMS}] wallet ${wallet.address}`);

    // Windowed claim (two txs) — the atomic 6-token claim() is too heavy for
    // the proxy's emulation ("heap log not found"); same split the Solana lane
    // uses to stay under the CU cap.
    const faucet = new ethers.Contract(HADRIAN_FAUCET, FAUCET_ABI, wallet);
    await (await callTx(faucet, 'claimTokens', [0, 3], { gasLimit: CLAIM_GAS, ...LEGACY })).wait();
    await (await callTx(faucet, 'claimTokens', [3, 3], { gasLimit: CLAIM_GAS, ...LEGACY })).wait();

    for (const f of state.funding) {
      const erc = new ethers.Contract(HADRIAN_WRAPPERS[f.symbol], ERC20_ABI, wallet);
      const bal: bigint = (await erc.balanceOf(wallet.address)).toBigInt();
      if (bal < DROP) throw new Error(`${f.symbol}: claim landed but wallet holds ${bal} < ${DROP}`);

      const helper = new ethers.Contract(HELPER, HELPER_ABI, wallet);
      console.log(`   forward ${bal} ${f.symbol} → martius faucet ATA ${f.faucetAta}`);
      await (await callTx(helper, 'transfer_spl', [f.faucetAta, bal, f.mintId], { gasLimit: XFER_GAS, ...LEGACY })).wait();
    }
  }
  console.log(`\nDONE. Forwarded ${N_CLAIMS} claims per token. Verify on martius: wrapper.balanceOf(faucet).`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
