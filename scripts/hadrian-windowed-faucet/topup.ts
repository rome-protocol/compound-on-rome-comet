// Idempotent finisher/top-up for the windowed faucet: ensure each cached-wrapper
// ATA exists on the faucet + fund each token up to DROP*FUND_CLAIMS. Safe to
// re-run (skips tokens already at target; ensure_token_account guarded). Used to
// recover the deploy after a transient ProviderError on the last token.
//
//   FAUCET=0x… ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-windowed-faucet/topup.ts --network hadrian
import { ethers } from 'hardhat';
import { callTx } from '../_lib/gas';

const FAUCET = process.env.FAUCET || '0xfE18912e37D91FF8C8fFfb6ea2e1b212E43a78ff';
const COLLATS = [
  { symbol: 'wBTC', address: '0xa000137fFcB2808aB6D2094c6f7Db5830c437883' },
  { symbol: 'wJitoSOL', address: '0xD6C203B9dA334fFB0169801159A4aD0699D6FA21' },
  { symbol: 'wmSOL', address: '0xC829D19cf6B95F28Bc7dDa1e983154AE7be0ca60' },
  { symbol: 'wJUP', address: '0x8aeDa0c4e0D4D780A810E0f85163eE485E8A253E' },
  { symbol: 'wJTO', address: '0x3d8F5adc8f7181C8bBC83cc8e5FA108CeC1d8Be6' },
  { symbol: 'wBONK', address: '0x80007675665ffCa47d7DBEdD5Fb4F7AB2e135322' },
];
const DROP = 10n ** 9n;
const FUND_CLAIMS = 5n;
const LEGACY = { type: 0, gasPrice: 0n };
const ENSURE_GAS = 30_000_000n;
const XFER_GAS = 30_000_000n;

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
];
const CACHED_ABI = ['function ensure_token_account(address owner) external'];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('deployer:', deployer.address, '| faucet:', FAUCET);
  const target = DROP * FUND_CLAIMS;

  for (const c of COLLATS) {
    const erc = new ethers.Contract(c.address, ERC20_ABI, deployer);
    // balanceOf on a cached wrapper REVERTS if the faucet's ATA is uninitialized
    // ("account data invalid") — so a revert here means "no ATA yet", treat as 0.
    let bal = 0n;
    let hasAta = true;
    try {
      bal = (await erc.balanceOf(FAUCET)).toBigInt();
    } catch {
      hasAta = false;
    }
    if (hasAta && bal >= target) {
      console.log(`${c.symbol}: faucet balance ${bal} ≥ target ${target} — OK`);
      continue;
    }
    if (!hasAta) {
      const cached = new ethers.Contract(c.address, CACHED_ABI, deployer);
      console.log(`${c.symbol}: ATA missing — ensure_token_account(faucet)…`);
      await (await callTx(cached, 'ensure_token_account', [FAUCET], { gasLimit: ENSURE_GAS, ...LEGACY })).wait();
    }
    const need = target - bal;
    console.log(`${c.symbol}: transfer ${need} → faucet`);
    await (await callTx(erc, 'transfer', [FAUCET, need], { gasLimit: XFER_GAS, ...LEGACY })).wait();
    bal = (await erc.balanceOf(FAUCET)).toBigInt();
    console.log(`   ${c.symbol} faucet balance = ${bal}`);
  }
  console.log('\nTop-up complete for', FAUCET);
}

main().catch((err) => { console.error(err); process.exit(1); });
