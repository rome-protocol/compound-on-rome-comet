// End-to-end proof for add-5-collaterals.ts + add-5-faucet-tokens.ts, signed by a plain funded wallet
// (ETH_PK): refresh the 900 s book, getAssetInfo for all 7 collaterals, getPrice for every feed,
// one faucet claim (new tokens), then the wallet's approve_spl grant to the wBTC wrapper, a tiny real
// wBTC collateral supply and a withdraw of it. Every effect is checked with a read; tx hashes go to
// state-add-5-collaterals.json under `verify`.
//
//   ETH_PK=$(cat <wallet key file>) ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-cached-test/verify-add-5.ts --network hadrian

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-add-5-collaterals.json');
const BOOK = '0xbb8961b840610934140d96f41bc0d38835774550';
const FAUCET = '0xf149A784Ccd0c58cF22cbDAE3F67edc76CD1e236';
const HELPER = '0xff00000000000000000000000000000000000009';
const WBTC = '0x94834153eA70219D44edFE295697fF0c204Ec68c';
const SUPPLY = ethers.BigNumber.from(10_000); // 0.00001 wBTC (9 dec)
const U64_MAX = ethers.BigNumber.from(2).pow(64).sub(1);

async function main() {
  const [me] = await ethers.getSigners();
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  console.log(`wallet ${me.address}  gas balance ${ethers.utils.formatEther(await me.getBalance())}  gasPrice ${gasPrice}`);
  const verify: Record<string, any> = { wallet: me.address, txHashes: {} };
  // Rome's estimateGas is a correct cap for calls that create no account and ~1.05M per new account;
  // send estimate x 1.3 and fall back to a fixed 3M only if the estimate itself reverts.
  const send = async (label: string, c: any, method: string, args: any[]) => {
    let gasLimit;
    try { gasLimit = (await c.estimateGas[method](...args, { type: 0, gasPrice })).mul(13).div(10); } catch { gasLimit = ethers.BigNumber.from(3_000_000); }
    const t = await c[method](...args, { type: 0, gasPrice, gasLimit });
    const r = await t.wait();
    if (r.status !== 1) throw new Error(`${label} reverted`);
    verify.txHashes[label] = t.hash;
    console.log(`${label}: ${t.hash}  gasUsed ${r.gasUsed}`);
  };

  const book = new ethers.Contract(BOOK, [
    'function registrationCount() view returns (uint256)', 'function registrationAt(uint256) view returns (bytes32)', 'function refreshAll(bytes32[]) returns (uint256)',
  ], me);
  const accts = await Promise.all(Array.from({ length: Number(await book.registrationCount()) }, (_, i) => book.registrationAt(i)));
  await send('book.refreshAll', book, 'refreshAll', [accts]);

  const comet = new ethers.Contract(st.cometProxy, [
    'function numAssets() view returns (uint8)',
    'function getAssetInfo(uint8) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))',
    'function getPrice(address) view returns (uint256)', 'function baseTokenPriceFeed() view returns (address)',
    'function supply(address,uint256)', 'function withdraw(address,uint256)', 'function collateralBalanceOf(address,address) view returns (uint128)',
  ], me);
  if (Number(await comet.numAssets()) !== 7) throw new Error('numAssets != 7');
  verify.prices = { base: (await comet.getPrice(await comet.baseTokenPriceFeed())).toString() };
  for (let i = 0; i < 7; i++) {
    const a = await comet.getAssetInfo(i);
    const p = await comet.getPrice(a.priceFeed); // reverts StalePriceFeed if not refreshed within 900 s
    verify.prices[a.asset] = p.toString();
    console.log(`asset ${a.offset} ${a.asset} feed ${a.priceFeed} bcf ${a.borrowCollateralFactor} lcf ${a.liquidateCollateralFactor} lf ${a.liquidationFactor} cap ${a.supplyCap} price ${p}`);
  }

  // Faucet: the wallet claims whatever it has not claimed yet (the 3 new tokens if it took the first two earlier).
  const tokens = st.faucet.addedTokens.map((t: any) => new ethers.Contract(t.address, ['function balanceOf(address) view returns (uint256)'], me));
  const bal = async (c: any) => { try { return await c.balanceOf(me.address); } catch { return ethers.constants.Zero; } };
  const b0 = await Promise.all(tokens.map(bal));
  await send('faucet.claim', new ethers.Contract(FAUCET, ['function claim()'], me), 'claim', []);
  const b1 = await Promise.all(tokens.map(bal));
  st.faucet.addedTokens.forEach((t: any, i: number) => console.log(`faucet ${t.symbol}: ${b0[i]} -> ${b1[i]} (drop ${t.dropAmountWei})`));
  verify.faucetBalances = Object.fromEntries(st.faucet.addedTokens.map((t: any, i: number) => [t.symbol, { before: b0[i].toString(), after: b1[i].toString() }]));

  // wBTC collateral: the wrapper moves the wallet's tokens as SPL delegate, so grant it once (approve_spl), plus the ERC-20 allowance.
  const wbtc = new ethers.Contract(WBTC, [
    'function balanceOf(address) view returns (uint256)', 'function mint_id() view returns (bytes32)',
    'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)',
  ], me);
  const have = await wbtc.balanceOf(me.address);
  if (have.lt(SUPPLY)) throw new Error(`wallet holds ${have} wBTC, needs ${SUPPLY}`);
  const helper = new ethers.Contract(HELPER, ['function approve_spl(address spender,uint64 amount,bytes32 mint)'], me);
  await send('wbtc.approve_spl', helper, 'approve_spl', [WBTC, U64_MAX, await wbtc.mint_id()]);
  await send('wbtc.approve', wbtc, 'approve', [st.cometProxy, SUPPLY]);
  console.log(`allowance ${await wbtc.allowance(me.address, st.cometProxy)}`);
  await send('comet.supply', comet, 'supply', [WBTC, SUPPLY]);
  const supplied = await comet.collateralBalanceOf(me.address, WBTC);
  console.log(`collateralBalanceOf after supply: ${supplied} (wallet wBTC ${await wbtc.balanceOf(me.address)}, was ${have})`);
  if (!supplied.eq(SUPPLY)) throw new Error('supply not reflected in collateralBalanceOf');
  await send('comet.withdraw', comet, 'withdraw', [WBTC, SUPPLY]);
  const after = await comet.collateralBalanceOf(me.address, WBTC);
  const back = await wbtc.balanceOf(me.address);
  console.log(`collateralBalanceOf after withdraw: ${after} (wallet wBTC ${back}, was ${have})`);
  if (!after.isZero() || !back.eq(have)) throw new Error('withdraw not reflected');
  verify.wbtc = { supplied: SUPPLY.toString(), collateralAfterSupply: supplied.toString(), collateralAfterWithdraw: after.toString() };

  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...st, verify }, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
