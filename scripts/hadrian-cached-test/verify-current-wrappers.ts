// End-to-end proof for the market deploy-current-wrappers.ts made, signed by a
// plain funded wallet (the signer is whatever ETH_PK is): refresh the PriceBook,
// getPrice on every feed, approve + supply + read + withdraw-all on the base
// asset, then one faucet claim. Every effect is checked with a read; every tx
// hash goes to state-current-wrappers.json under `verify`.
//
//   ETH_PK=$(cat <wallet key file>) ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub \
//     MAINNET_QUICKNODE_LINK=stub UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-cached-test/verify-current-wrappers.ts --network hadrian

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import { callTx } from '../_lib/gas';

const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-current-wrappers.json');
const BOOK = '0xbb8961b840610934140d96f41bc0d38835774550';
const SUPPLY = ethers.BigNumber.from(50_000); // 0.05 wUSDC (6 dec)

async function main() {
  const [me] = await ethers.getSigners();
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  const tx = { type: 0, gasPrice, gasLimit: 3_000_000 };
  const verify: Record<string, string> = {};
  const step = async (label: string, p: Promise<any>) => {
    const t = await p;
    const r = await t.wait();
    if (r.status !== 1) throw new Error(`${label} reverted`);
    verify[label] = t.hash;
    console.log(`${label}: ${t.hash}`);
  };

  const book = new ethers.Contract(BOOK, [
    'function registrationCount() view returns (uint256)',
    'function registrationAt(uint256) view returns (bytes32)',
    'function refreshAll(bytes32[]) returns (uint256)',
  ], me);
  const accts = await Promise.all(Array.from({ length: Number(await book.registrationCount()) }, (_, i) => book.registrationAt(i)));
  await step('book.refreshAll', book.refreshAll(accts, tx));

  const comet = new ethers.Contract(st.cometProxy, [
    'function getPrice(address) view returns (uint256)',
    'function supply(address,uint256)',
    'function withdraw(address,uint256)',
    'function balanceOf(address) view returns (uint256)',
  ], me);
  const prices: Record<string, string> = {};
  for (const a of [st.baseAsset, ...st.collateralAssets]) {
    prices[a.symbol] = (await comet.getPrice(a.priceFeed)).toString(); // reverts if the feed is stale
    console.log(`getPrice ${a.symbol}: ${prices[a.symbol]}`);
  }

  const base = new ethers.Contract(st.baseAsset.address, [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)',
  ], me);
  const before = await base.balanceOf(me.address);
  await step('base.approve', base.approve(st.cometProxy, SUPPLY, tx));
  console.log(`allowance: ${await base.allowance(me.address, st.cometProxy)}`);
  await step('comet.supply', callTx(comet, 'supply', [st.baseAsset.address, SUPPLY], { type: 0, gasPrice }));
  const supplied = await comet.balanceOf(me.address);
  console.log(`comet.balanceOf after supply: ${supplied}  (wallet base ${await base.balanceOf(me.address)})`);
  if (supplied.lt(SUPPLY.sub(1))) throw new Error('supply not reflected in comet.balanceOf');
  await step('comet.withdraw', callTx(comet, 'withdraw', [st.baseAsset.address, ethers.constants.MaxUint256], { type: 0, gasPrice }));
  const after = await comet.balanceOf(me.address);
  console.log(`comet.balanceOf after withdraw: ${after}  (wallet base ${await base.balanceOf(me.address)}, was ${before})`);

  const faucet = new ethers.Contract(st.faucet.address, [
    'function claim()',
    'function claimed(address) view returns (bool)',
  ], me);
  const bals0 = await Promise.all(st.faucet.tokens.map((t: any) => new ethers.Contract(t.address, ['function balanceOf(address) view returns (uint256)'], me).balanceOf(me.address)));
  await step('faucet.claim', faucet.claim({ ...tx, gasLimit: 30_000_000 }));
  const bals1 = await Promise.all(st.faucet.tokens.map((t: any) => new ethers.Contract(t.address, ['function balanceOf(address) view returns (uint256)'], me).balanceOf(me.address)));
  st.faucet.tokens.forEach((t: any, i: number) => console.log(`faucet ${t.symbol}: ${bals0[i]} -> ${bals1[i]} (drop ${t.dropAmountWei})`));
  console.log(`faucet.claimed(me): ${await faucet.claimed(me.address)}`);

  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...st, verify: { wallet: me.address, prices, txHashes: verify } }, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
