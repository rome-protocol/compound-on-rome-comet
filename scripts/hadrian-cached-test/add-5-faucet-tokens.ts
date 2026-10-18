// Register the new comet collaterals on the EXISTING faucet (CompoundFaucet.addToken is owner-only
// and the faucet owner is the F6 deployer, so no replacement faucet is needed): addToken, warm the
// faucet's ATA on the wrapper, fund FUND_CLAIMS claims from F6. A token F6 holds none of is NOT
// added — claim() reverts "out of token reserve" for every claimant once a registered token is
// empty — and is reported instead. Idempotent: a token already in tokenList() is only topped up.
//
//   ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) ETHERSCAN_KEY=stub \
//     SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-cached-test/add-5-faucet-tokens.ts --network hadrian

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import { callTx } from '../_lib/gas';

const FAUCET = '0xf149A784Ccd0c58cF22cbDAE3F67edc76CD1e236';
const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-add-5-collaterals.json');
const FUND_CLAIMS = 3n;
// Per-claim drop in raw units: ~0.0001 BTC, 1 JUP, 100 BONK; JitoSOL/mSOL: F6 holds none (see below).
const TOKENS = [
  { symbol: 'wBTC', address: '0x94834153eA70219D44edFE295697fF0c204Ec68c', decimals: 9, drop: 10n ** 5n },
  { symbol: 'wJitoSOL', address: '0x8874ce9D11dd54Ee0Bc8185A05F216f2E7bA1a8D', decimals: 8, drop: 10n ** 6n },
  { symbol: 'wmSOL', address: '0x34b1eD3A33C522F01fACED591DEa9E0468E9614A', decimals: 9, drop: 10n ** 7n },
  { symbol: 'wJUP', address: '0x0B04Ce26bce2128309956bf2aeD03ac7e8d3E3De', decimals: 9, drop: 10n ** 9n },
  { symbol: 'wBONK', address: '0xE72168524e9DE5d654BFe8473CA11a8108Cd642b', decimals: 9, drop: 10n ** 11n },
];
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function ensure_token_account(address) returns (bytes32)'];

async function main() {
  const [me] = await ethers.getSigners();
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  const o = { type: 0, gasPrice };
  const faucet = new ethers.Contract(FAUCET, [
    'function owner() view returns (address)', 'function addToken(address,uint256)', 'function tokenList() view returns (address[])', 'function tokenDrop(address) view returns (uint256)',
  ], me);
  if ((await faucet.owner()).toLowerCase() !== me.address.toLowerCase()) throw new Error('signer is not the faucet owner');
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const hashes: Record<string, string> = {};
  const unfunded: string[] = [];
  const listed: any[] = [];
  const inList = (await faucet.tokenList()).map((a: string) => a.toLowerCase());

  for (const t of TOKENS) {
    const w = new ethers.Contract(t.address, ERC20, me);
    const need = t.drop * FUND_CLAIMS;
    let mine = 0n;
    try { mine = (await w.balanceOf(me.address)).toBigInt(); } catch { /* no ATA: holds none */ }
    const registered = inList.includes(t.address.toLowerCase());
    if (!registered && mine < need) { unfunded.push(`${t.symbol}: F6 holds ${mine}, needs ${need}`); console.log(`SKIP ${t.symbol}: F6 holds ${mine} < ${need}`); continue; }
    if (!registered) {
      const add = await callTx(faucet, 'addToken', [t.address, t.drop], o); await add.wait(); hashes[`faucet:addToken:${t.symbol}`] = add.hash;
    }
    let bal = 0n; let hasAta = true;
    try { bal = (await w.balanceOf(FAUCET)).toBigInt(); } catch { hasAta = false; }
    if (!hasAta) { const e = await callTx(w, 'ensure_token_account', [FAUCET], o); await e.wait(); hashes[`faucet:ata:${t.symbol}`] = e.hash; }
    if (bal < need) { const f = await callTx(w, 'transfer', [FAUCET, need - bal], o); await f.wait(); hashes[`faucet:fund:${t.symbol}`] = f.hash; }
    bal = (await w.balanceOf(FAUCET)).toBigInt();
    const drop = (await faucet.tokenDrop(t.address)).toBigInt();
    if (bal < need || drop !== t.drop) throw new Error(`${t.symbol}: read-back mismatch (balance ${bal}, drop ${drop})`);
    console.log(`${t.symbol}: registered, drop ${drop}, faucet balance ${bal}`);
    listed.push({ symbol: t.symbol, address: t.address, decimals: t.decimals, dropAmountWei: t.drop.toString() });
  }
  const list = (await faucet.tokenList()).map((a: string) => a.toLowerCase());
  console.log(`tokenList now ${list.length}: ${list.join(',')}`);
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...st, faucet: { address: FAUCET, addedTokens: listed, notAdded: unfunded, txHashes: hashes } }, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
