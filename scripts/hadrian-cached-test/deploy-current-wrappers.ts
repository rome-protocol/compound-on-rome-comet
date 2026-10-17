// Redeploy the canonical Hadrian Comet market + its faucet on the CURRENT SPL wrappers.
//
// Why: the program now refuses DELEGATECALL into a precompile that signs as the
// caller, so approve/transfer on the wrappers retired in the 2026-09 rotation
// revert, and every write on the old market (and its faucet claim) fails.
//
// What it does (same shape as deploy-5collat.ts; params read from the live source
// comet the way cutover-book-feeds.ts readLiveSnapshot/toConfiguration do):
//   1. read SOURCE_COMET's configuration + assets from chain
//   2. map each old asset to its CURRENT registry wrapper BY MINT (mint_id());
//      an asset with no current wrapper, or no pair in the new PriceBook, is skipped
//   3. deploy CometProxyAdmin + CometExt + Comet impl + proxy, initializeStorage,
//      warm the comet's ATA on every wrapper
//   4. deploy a CompoundFaucet over the collaterals and fund a few claims
// Governor / pause guardian / proxy-admin owner = the signer (the F6 deployer).
//
// Run (key read inline, never printed):
//   ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) \
//     ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//     UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub \
//     npx hardhat run scripts/hadrian-cached-test/deploy-current-wrappers.ts --network hadrian

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';
import { callTx } from '../_lib/gas';
import { fetchHadrianWrappers } from './registry';

const SOURCE_COMET = process.env.SOURCE_COMET || '0xfc322489D4089AdCC79074C8058Fd257c63622D8';
const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-current-wrappers.json');
const SECONDS_PER_YEAR = 31_536_000;

// PriceBook 0xbb8961b8 (maxStaleness 900 s) BookFeedAdapters, by pair.
const BOOK_ADAPTERS: Record<string, string> = {
  'BONK/USD': '0x7E48d3ea045C61b3BF4081e42A699DA4466Af1BC',
  'BTC/USD': '0x6e748Ed1B228F44Efa6ef44De65ca4D8d789d856',
  'ETH/USD': '0x03Abaf04882820E0c61DC8182b5e3eBaaC20226d',
  'JITOSOL/USD': '0x2372073F598319EaD87d2207B11a8138d2Ab8A23',
  'JUP/USD': '0x13268A433c9c0F075Ba0789524f45D192E090F34',
  'MSOL/USD': '0xA7fc8168bfE6042E17B3135F3b148e95476Bff97',
  'SOL/USD': '0xcC9F877aC65521CE952cD784635934C88579bF55',
  'USDC/USD': '0xCE5F78af032489748967c08908ff1E923d223Faf',
  'USDT/USD': '0xa71555539FC816dEC5f68038d5B8afb1b884dec4',
};
// Old-market wrapper symbol -> its Pyth pair (wJTO has no pair in the new book).
const PAIR_OF: Record<string, string> = {
  wUSDC: 'USDC/USD', wETH: 'ETH/USD', wSOL: 'SOL/USD', wBTC: 'BTC/USD',
  wJitoSOL: 'JITOSOL/USD', wmSOL: 'MSOL/USD', wJUP: 'JUP/USD', wBONK: 'BONK/USD',
};

// Faucet drops per claim (raw units, caller pre-multiplies by decimals) and pre-funded claims.
const DROP_BY_SYMBOL: Record<string, bigint> = { wETH: 10n ** 5n, wSOL: 10n ** 7n };
const FUND_CLAIMS = 3n;

// Rome: explicit gas limits (estimateGas can wrongly return 21000), legacy tx at 2x gas price.
const DEPLOY_GAS = 200_000_000;
const SEND_GAS = 30_000_000;

const WRAPPER_ABI = [
  'function symbol() view returns (string)',
  'function mint_id() view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function ensure_token_account(address) returns (bytes32)',
];
const ADDR_FIELDS = ['governor', 'pauseGuardian', 'baseToken', 'baseTokenPriceFeed', 'extensionDelegate'];
const UINT_FIELDS = [
  'supplyKink', 'supplyPerSecondInterestRateSlopeLow', 'supplyPerSecondInterestRateSlopeHigh', 'supplyPerSecondInterestRateBase',
  'borrowKink', 'borrowPerSecondInterestRateSlopeLow', 'borrowPerSecondInterestRateSlopeHigh', 'borrowPerSecondInterestRateBase',
  'storeFrontPriceFactor', 'trackingIndexScale', 'baseTrackingSupplySpeed', 'baseTrackingBorrowSpeed',
  'baseMinForRewards', 'baseBorrowMin', 'targetReserves',
];
const COMET_ABI = [
  'function numAssets() view returns (uint8)',
  'function getAssetInfo(uint8) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  ...ADDR_FIELDS.map((f) => `function ${f}() view returns (address)`),
  ...UINT_FIELDS.map((f) => `function ${f}() view returns (uint256)`),
];

async function main() {
  const [admin] = await ethers.getSigners();
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  const tx = { type: 0, gasPrice, gasLimit: SEND_GAS };
  console.log(`Deployer: ${admin.address}  (gasPrice ${gasPrice.toString()})`);

  // ─── 1. Source market ───────────────────────────────────────────
  const src = new ethers.Contract(SOURCE_COMET, COMET_ABI, ethers.provider);
  const n = Number(await src.numAssets());
  const live: Record<string, any> = {};
  for (const f of [...ADDR_FIELDS, ...UINT_FIELDS]) live[f] = await src[f]();
  const infos = await Promise.all(Array.from({ length: n }, (_, i) => src.getAssetInfo(i)));
  const wrapper = (a: string) => new ethers.Contract(a, WRAPPER_ABI, admin);
  const sym = (a: string) => wrapper(a).symbol();

  // ─── 2. Map by mint to the current registry wrappers ────────────
  async function current(oldAddr: string): Promise<string | null> {
    const symbol = await sym(oldAddr);
    let reg;
    try { reg = (await fetchHadrianWrappers([symbol]))[symbol]; } catch { return null; }
    const [a, b] = await Promise.all([wrapper(oldAddr).mint_id(), wrapper(reg.address).mint_id()]);
    return a === b ? reg.address : null;
  }
  const baseOldSymbol = await sym(live.baseToken);
  const baseWrapper = await current(live.baseToken);
  if (!baseWrapper) throw new Error('no current base wrapper');
  const skipped: { symbol: string; why: string }[] = [];
  const assets: any[] = [];
  for (const info of infos) {
    const symbol = await sym(info.asset);
    const cur = await current(info.asset);
    const pair = PAIR_OF[symbol];
    if (!cur) { skipped.push({ symbol, why: 'no current registry wrapper for its mint' }); continue; }
    if (!pair || !BOOK_ADAPTERS[pair]) { skipped.push({ symbol, why: 'pair not in the new PriceBook' }); continue; }
    assets.push({ symbol, oldAsset: info.asset, asset: cur, pair, priceFeed: BOOK_ADAPTERS[pair], info });
  }
  console.log(`Base ${baseOldSymbol}: ${live.baseToken} -> ${baseWrapper}`);
  assets.forEach((a) => console.log(`  ${a.symbol}: ${a.oldAsset} -> ${a.asset}  feed ${a.pair} ${a.priceFeed}`));
  skipped.forEach((s) => console.log(`  SKIPPED ${s.symbol}: ${s.why}`));

  const hashes: Record<string, string> = {};
  const mined = async (label: string, c: any) => { await c.deployed(); hashes[label] = c.deployTransaction.hash; return c; };

  // ─── 3. Comet ───────────────────────────────────────────────────
  const CometProxyAdmin = await ethers.getContractFactory('contracts/CometProxyAdmin.sol:CometProxyAdmin');
  const cpa = await mined('proxyAdmin', await CometProxyAdmin.deploy(admin.address, { ...tx, gasLimit: DEPLOY_GAS }));
  console.log(`CometProxyAdmin: ${cpa.address}`);

  const CometExt = await ethers.getContractFactory('contracts/CometExt.sol:CometExt');
  const ext = await mined('extensionDelegate', await CometExt.deploy({
    name32: ethers.utils.formatBytes32String(await src.name()),
    symbol32: ethers.utils.formatBytes32String(await src.symbol()),
  }, { ...tx, gasLimit: DEPLOY_GAS }));
  console.log(`CometExt: ${ext.address}`);

  const perYear = (k: string) => live[k].mul(SECONDS_PER_YEAR);
  const config = {
    governor: admin.address,
    pauseGuardian: admin.address,
    baseToken: baseWrapper,
    baseTokenPriceFeed: BOOK_ADAPTERS['USDC/USD'],
    extensionDelegate: ext.address,
    supplyKink: live.supplyKink,
    supplyPerYearInterestRateSlopeLow: perYear('supplyPerSecondInterestRateSlopeLow'),
    supplyPerYearInterestRateSlopeHigh: perYear('supplyPerSecondInterestRateSlopeHigh'),
    supplyPerYearInterestRateBase: perYear('supplyPerSecondInterestRateBase'),
    borrowKink: live.borrowKink,
    borrowPerYearInterestRateSlopeLow: perYear('borrowPerSecondInterestRateSlopeLow'),
    borrowPerYearInterestRateSlopeHigh: perYear('borrowPerSecondInterestRateSlopeHigh'),
    borrowPerYearInterestRateBase: perYear('borrowPerSecondInterestRateBase'),
    storeFrontPriceFactor: live.storeFrontPriceFactor,
    trackingIndexScale: live.trackingIndexScale,
    baseTrackingSupplySpeed: live.baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed: live.baseTrackingBorrowSpeed,
    baseMinForRewards: live.baseMinForRewards,
    baseBorrowMin: live.baseBorrowMin,
    targetReserves: live.targetReserves,
    assetConfigs: assets.map((a) => ({
      asset: a.asset,
      priceFeed: a.priceFeed,
      decimals: Math.round(Math.log10(a.info.scale.toNumber())),
      borrowCollateralFactor: a.info.borrowCollateralFactor,
      liquidateCollateralFactor: a.info.liquidateCollateralFactor,
      liquidationFactor: a.info.liquidationFactor,
      supplyCap: a.info.supplyCap,
    })),
  };
  const Comet = await ethers.getContractFactory('contracts/Comet.sol:Comet');
  const impl = await mined('implementation', await Comet.deploy(config, { ...tx, gasLimit: DEPLOY_GAS }));
  console.log(`Comet impl: ${impl.address}`);

  const Proxy = await ethers.getContractFactory(
    'contracts/vendor/proxy/transparent/TransparentUpgradeableProxy.sol:TransparentUpgradeableProxy',
  );
  const proxy = await mined('proxy', await Proxy.deploy(impl.address, cpa.address, '0x', { ...tx, gasLimit: DEPLOY_GAS }));
  console.log(`CometProxy: ${proxy.address}`);
  const init = await Comet.attach(proxy.address).initializeStorage(tx);
  await init.wait();
  hashes.initializeStorage = init.hash;

  for (const addr of [baseWrapper, ...assets.map((a) => a.asset)]) {
    const t = await wrapper(addr).ensure_token_account(proxy.address, tx);
    await t.wait();
    hashes[`ata:${addr}`] = t.hash;
  }
  const save = (extra: object) => fs.writeFileSync(STATE_FILE, JSON.stringify({
    deployedAt: new Date().toISOString(), deployer: admin.address, network: 'hadrian', chainId: 200010,
    sourceComet: SOURCE_COMET,
    baseAsset: { symbol: baseOldSymbol, address: baseWrapper, oldAddress: live.baseToken, priceFeed: BOOK_ADAPTERS['USDC/USD'] },
    collateralAssets: assets.map((a) => ({ symbol: a.symbol, address: a.asset, oldAddress: a.oldAsset, pair: a.pair, priceFeed: a.priceFeed })),
    skipped,
    cometProxy: proxy.address, cometImpl: impl.address, cometExt: ext.address, cometProxyAdmin: cpa.address,
    txHashes: hashes, ...extra,
  }, null, 2) + '\n');
  save({});

  // ─── 4. Faucet over the collaterals ─────────────────────────────
  const Faucet = await ethers.getContractFactory('CompoundFaucet', admin);
  const faucet = await mined('faucet', await Faucet.deploy(0, { ...tx, gasLimit: DEPLOY_GAS }));
  console.log(`Faucet: ${faucet.address}`);
  const faucetTokens: object[] = [];
  for (const a of assets) {
    const drop = DROP_BY_SYMBOL[a.symbol];
    if (!drop) continue;
    const add = await faucet.addToken(a.asset, drop, tx);
    await add.wait();
    const ata = await wrapper(a.asset).ensure_token_account(faucet.address, tx);
    await ata.wait();
    const fund = await wrapper(a.asset).transfer(faucet.address, drop * FUND_CLAIMS, tx);
    await fund.wait();
    hashes[`faucet:addToken:${a.symbol}`] = add.hash;
    hashes[`faucet:ata:${a.symbol}`] = ata.hash;
    hashes[`faucet:fund:${a.symbol}`] = fund.hash;
    faucetTokens.push({ symbol: a.symbol, address: a.asset, decimals: Math.round(Math.log10(a.info.scale.toNumber())), dropAmountWei: drop.toString() });
    console.log(`  ${a.symbol}: balance ${(await wrapper(a.asset).balanceOf(faucet.address)).toString()}`);
  }
  save({ faucet: { address: faucet.address, gasDropWei: '0', tokens: faucetTokens } });
  console.log(`\nDONE. state: ${STATE_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
