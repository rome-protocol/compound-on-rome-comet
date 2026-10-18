// End-to-end proof for repoint-feeds-3600s.ts, signed by a plain funded wallet (ETH_PK): refresh the
// 3600 s book, getAssetInfo + getPrice for the base and all 7 collaterals, then a tiny real wUSDC
// supply and withdraw. Every effect is checked with a read; tx hashes go to state-comet-feeds-3600s.json
// under `verify`.
//
//   ETH_PK=$(cat <wallet key file>) ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-cached-test/verify-repoint-3600s.ts --network hadrian

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-comet-feeds-3600s.json');
const HELPER = '0xff00000000000000000000000000000000000009';
const SUPPLY = ethers.BigNumber.from(10_000); // 0.01 wUSDC (6 dec)
const U64_MAX = ethers.BigNumber.from(2).pow(64).sub(1);

async function main() {
  const [me] = await ethers.getSigners();
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  console.log(`wallet ${me.address}  gas balance ${ethers.utils.formatEther(await me.getBalance())}  gasPrice ${gasPrice}`);
  const verify: Record<string, any> = { wallet: me.address, txHashes: {} };
  // Rome's estimateGas is a correct cap for calls that create no account; send estimate x 1.3, fixed 3M if the estimate reverts.
  const send = async (label: string, c: any, method: string, args: any[]) => {
    let gasLimit;
    try { gasLimit = (await c.estimateGas[method](...args, { type: 0, gasPrice })).mul(13).div(10); } catch { gasLimit = ethers.BigNumber.from(3_000_000); }
    const t = await c[method](...args, { type: 0, gasPrice, gasLimit });
    const r = await t.wait();
    if (r.status !== 1) throw new Error(`${label} reverted`);
    verify.txHashes[label] = t.hash;
    console.log(`${label}: ${t.hash}  gasUsed ${r.gasUsed}`);
  };

  const book = new ethers.Contract(st.book3600, [
    'function registrationCount() view returns (uint256)', 'function registrationAt(uint256) view returns (bytes32)', 'function refreshAll(bytes32[]) returns (uint256)',
  ], me);
  const accts = await Promise.all(Array.from({ length: Number(await book.registrationCount()) }, (_, i) => book.registrationAt(i)));
  await send('book.refreshAll', book, 'refreshAll', [accts]);

  const comet = new ethers.Contract(st.cometProxy, [
    'function numAssets() view returns (uint8)',
    'function getAssetInfo(uint8) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))',
    'function getPrice(address) view returns (uint256)', 'function baseTokenPriceFeed() view returns (address)', 'function baseToken() view returns (address)',
    'function supply(address,uint256)', 'function withdraw(address,uint256)', 'function balanceOf(address) view returns (uint256)',
  ], me);
  if (Number(await comet.numAssets()) !== 7) throw new Error('numAssets != 7');
  const baseFeed = await comet.baseTokenPriceFeed();
  verify.prices = { base: { feed: baseFeed, price: (await comet.getPrice(baseFeed)).toString() } };
  for (let i = 0; i < 7; i++) {
    const a = await comet.getAssetInfo(i);
    const p = await comet.getPrice(a.priceFeed); // reverts StalePriceFeed if not refreshed within 3600 s
    verify.prices[a.asset] = { feed: a.priceFeed, price: p.toString() };
    console.log(`asset ${a.offset} ${a.asset} feed ${a.priceFeed} bcf ${a.borrowCollateralFactor} lcf ${a.liquidateCollateralFactor} lf ${a.liquidationFactor} cap ${a.supplyCap} price ${p}`);
  }
  console.log(`base feed ${baseFeed} price ${verify.prices.base.price}`);

  // wUSDC: the wrapper moves the wallet's tokens as SPL delegate, so grant it once (approve_spl), plus the ERC-20 allowance.
  const baseTokenAddr = await comet.baseToken();
  const usdc = new ethers.Contract(baseTokenAddr, [
    'function balanceOf(address) view returns (uint256)', 'function mint_id() view returns (bytes32)',
    'function approve(address,uint256) returns (bool)',
  ], me);
  const have = await usdc.balanceOf(me.address);
  if (have.lt(SUPPLY)) throw new Error(`wallet holds ${have} wUSDC, needs ${SUPPLY}`);
  const helper = new ethers.Contract(HELPER, ['function approve_spl(address spender,uint64 amount,bytes32 mint)'], me);
  await send('wusdc.approve_spl', helper, 'approve_spl', [baseTokenAddr, U64_MAX, await usdc.mint_id()]);
  await send('wusdc.approve', usdc, 'approve', [st.cometProxy, SUPPLY]);
  const b0 = await comet.balanceOf(me.address);
  await send('comet.supply', comet, 'supply', [baseTokenAddr, SUPPLY]);
  const supplied = await comet.balanceOf(me.address);
  console.log(`comet.balanceOf after supply: ${supplied} (was ${b0}); wallet wUSDC ${await usdc.balanceOf(me.address)} (was ${have})`);
  if (supplied.sub(b0).lt(SUPPLY.sub(1))) throw new Error('supply not reflected in balanceOf');
  await send('comet.withdraw', comet, 'withdraw', [baseTokenAddr, SUPPLY]);
  const after = await comet.balanceOf(me.address);
  const back = await usdc.balanceOf(me.address);
  console.log(`comet.balanceOf after withdraw: ${after}; wallet wUSDC ${back} (was ${have})`);
  if (after.gt(b0.add(1)) || back.lt(have.sub(1))) throw new Error('withdraw not reflected');
  verify.wusdc = { supplied: SUPPLY.toString(), balanceBefore: b0.toString(), balanceAfterSupply: supplied.toString(), balanceAfterWithdraw: after.toString(), walletBefore: have.toString(), walletAfter: back.toString() };

  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...st, verify }, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
