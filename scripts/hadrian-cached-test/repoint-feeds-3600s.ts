// Repoint the NEW Hadrian comet (proxy 0x642fF1b5...) from the 900 s PriceBook adapters to the 3600 s
// PriceBook adapters: the base USDC/USD feed and all 7 collateral feeds. Nothing else changes.
// Same pattern as add-5-collaterals.ts: the comet has no Configurator, so a feed change = a new Comet
// impl whose config is the live config with only the 8 priceFeed fields swapped, then ProxyAdmin.upgrade.
// Restore = re-upgrade to the recorded impl ORIGINAL_IMPL (one tx, valid while nothing else changes).
//
// The config is read LIVE from the proxy every run. The old feed of every asset is asserted against
// the live read, each new adapter is asserted to be the right pair (description()), and the post-upgrade
// reads must differ from the pre-upgrade reads by exactly those 8 feed fields; totals and every
// totalsCollateral must be identical.
//
//   MODE=dry     npx hardhat run scripts/hadrian-cached-test/repoint-feeds-3600s.ts --network hadrian
//   MODE=upgrade ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) ... (same)
//   MODE=restore ETH_PK=... (same)
// plus the 5 stub env vars hardhat.config.ts requires (ETHERSCAN_KEY, SNOWTRACE_KEY, ...).

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const COMET_PROXY = '0x642fF1b5983FcDB9eA565B9FF56ac41c0c36d218';
const PROXY_ADMIN = '0xaC1ED2Ac07D764f9Bd52FcF8D52610E7970F5eE7';
const ORIGINAL_IMPL = '0xA3562fcD1D46093f87aD67777a6142710b8678Cd'; // restore target (#59, 900 s feeds)
const EXPECTED_OWNER = '0x1f4946Be340F06c46A50E65084790968aBcc48F6';
const BOOK_900 = '0xbb8961b840610934140d96f41bc0d38835774550';
const BOOK_3600 = '0xac3d80043ead56fcf94db4574a69ee0975f7a63f';
const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-comet-feeds-3600s.json');
const SECONDS_PER_YEAR = 31_536_000;

// pair -> { old 900 s adapter (asserted live), new 3600 s adapter }; base first, then offsets 0..6.
const FEEDS = [
  { label: 'base', pair: 'USDC/USD', old: '0xCE5F78af032489748967c08908ff1E923d223Faf', next: '0x889c1d9f2dD8f5FcE75E260E884A2919e16dbBd5' },
  { label: 'wETH', pair: 'ETH/USD', old: '0x03Abaf04882820E0c61DC8182b5e3eBaaC20226d', next: '0xe765b1aa15046ff217Bd2e8824986F46037bB36f' },
  { label: 'wSOL', pair: 'SOL/USD', old: '0xcC9F877aC65521CE952cD784635934C88579bF55', next: '0x173fe9b24c667827Da8Dd8B8e5aD23fd0e76f8bd' },
  { label: 'wBTC', pair: 'BTC/USD', old: '0x6e748Ed1B228F44Efa6ef44De65ca4D8d789d856', next: '0xD656B135327a5c4A835818340e8b0B51880DDC77' },
  { label: 'wJitoSOL', pair: 'JITOSOL/USD', old: '0x2372073F598319EaD87d2207B11a8138d2Ab8A23', next: '0xDde3A7d1EB7828F7183f8fA1D3B1FcF89757606F' },
  { label: 'wmSOL', pair: 'MSOL/USD', old: '0xA7fc8168bfE6042E17B3135F3b148e95476Bff97', next: '0x1016dDc9A4DeC29A4C1F639B4F9e7F2E09Af7143' },
  { label: 'wJUP', pair: 'JUP/USD', old: '0x13268A433c9c0F075Ba0789524f45D192E090F34', next: '0xe0113dc3Da2452d99Ffe1187018F62644a538D37' },
  { label: 'wBONK', pair: 'BONK/USD', old: '0x7E48d3ea045C61b3BF4081e42A699DA4466Af1BC', next: '0x1ec7e20d8fde7f2a085c57DDC09Df4A82eB5e4BF' },
];

const ASSET_TUPLE = 'tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap)';
const ADDR_FIELDS = ['governor', 'pauseGuardian', 'baseToken', 'baseTokenPriceFeed', 'extensionDelegate'];
const UINT_FIELDS = [
  'supplyKink', 'supplyPerSecondInterestRateSlopeLow', 'supplyPerSecondInterestRateSlopeHigh', 'supplyPerSecondInterestRateBase',
  'borrowKink', 'borrowPerSecondInterestRateSlopeLow', 'borrowPerSecondInterestRateSlopeHigh', 'borrowPerSecondInterestRateBase',
  'storeFrontPriceFactor', 'trackingIndexScale', 'baseTrackingSupplySpeed', 'baseTrackingBorrowSpeed',
  'baseMinForRewards', 'baseBorrowMin', 'targetReserves', 'totalSupply', 'totalBorrow',
];
const COMET_ABI = [
  'function numAssets() view returns (uint8)',
  `function getAssetInfo(uint8) view returns (${ASSET_TUPLE})`,
  'function totalsBasic() view returns (uint64 baseSupplyIndex,uint64 baseBorrowIndex,uint64 trackingSupplyIndex,uint64 trackingBorrowIndex,uint104 totalSupplyBase,uint104 totalBorrowBase,uint40 lastAccrualTime,uint8 pauseFlags)',
  'function totalsCollateral(address) view returns (uint128 totalSupplyAsset,uint128 _reserved)',
  ...ADDR_FIELDS.map((f) => `function ${f}() view returns (address)`),
  ...UINT_FIELDS.map((f) => `function ${f}() view returns (uint256)`),
];
const PA_ABI = [
  'function upgrade(address proxy, address implementation) external',
  'function getProxyImplementation(address proxy) view returns (address)',
  'function owner() view returns (address)',
];
const FEED_ABI = ['function decimals() view returns (uint8)', 'function description() view returns (string)'];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dec = (scale: any) => String(scale.toString()).length - 1; // scale = 10**decimals
const next = (old: string) => FEEDS.find((f) => same(f.old, old))!.next;

async function snapshot(comet: any) {
  const s: Record<string, any> = {};
  for (const f of [...ADDR_FIELDS, ...UINT_FIELDS]) s[f] = (await comet[f]()).toString();
  const tb = await comet.totalsBasic();
  s.totalSupplyBase = tb.totalSupplyBase.toString();
  s.totalBorrowBase = tb.totalBorrowBase.toString();
  const n = Number(await comet.numAssets());
  s.numAssets = n;
  s.assets = [];
  s.totalsCollateral = {};
  for (let i = 0; i < n; i++) {
    const a = await comet.getAssetInfo(i);
    s.assets.push({
      offset: Number(a.offset), asset: a.asset, priceFeed: a.priceFeed, scale: a.scale.toString(),
      bcf: a.borrowCollateralFactor.toString(), lcf: a.liquidateCollateralFactor.toString(),
      lf: a.liquidationFactor.toString(), cap: a.supplyCap.toString(),
    });
    s.totalsCollateral[a.asset] = (await comet.totalsCollateral(a.asset)).totalSupplyAsset.toString();
  }
  return s;
}

async function main() {
  const mode = process.env.MODE || 'dry';
  if (!['dry', 'upgrade', 'restore'].includes(mode)) throw new Error(`MODE must be dry|upgrade|restore, got ${mode}`);
  const [signer] = await ethers.getSigners();
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  const tx = { type: 0, gasPrice, gasLimit: 30_000_000 };
  console.log(`Mode ${mode}; signer ${signer.address}`);

  const comet = new ethers.Contract(COMET_PROXY, COMET_ABI, signer);
  const pa = new ethers.Contract(PROXY_ADMIN, PA_ABI, signer);
  const owner = await pa.owner();
  if (!same(owner, EXPECTED_OWNER)) throw new Error(`ProxyAdmin owner ${owner} != ${EXPECTED_OWNER}`);
  const implNow0 = await pa.getProxyImplementation(COMET_PROXY);

  if (mode === 'restore') {
    if (!same(owner, signer.address)) throw new Error('signer is not the ProxyAdmin owner');
    const t = await pa.upgrade(COMET_PROXY, ORIGINAL_IMPL, { ...tx, gasLimit: 5_000_000 });
    await t.wait();
    const now = await pa.getProxyImplementation(COMET_PROXY);
    if (!same(now, ORIGINAL_IMPL)) throw new Error(`restore failed: impl ${now}`);
    console.log(`RESTORED -> ${ORIGINAL_IMPL}  tx ${t.hash}`);
    return;
  }

  if (!same(implNow0, ORIGINAL_IMPL)) throw new Error(`impl ${implNow0} != ORIGINAL_IMPL — already upgraded? abort before any tx`);

  const before = await snapshot(comet);
  if (before.numAssets !== 7) throw new Error(`expected 7 live assets, got ${before.numAssets}`);

  // Every old feed must match the live read, every new feed must be the right pair with 8 decimals.
  const liveFeeds = [before.baseTokenPriceFeed, ...before.assets.map((a: any) => a.priceFeed)];
  FEEDS.forEach((f, i) => { if (!same(liveFeeds[i], f.old)) throw new Error(`${f.label}: live feed ${liveFeeds[i]} != ${f.old} (stale map)`); });
  for (const f of FEEDS) {
    const c = new ethers.Contract(f.next, FEED_ABI, ethers.provider);
    const [d, desc] = [Number(await c.decimals()), await c.description()];
    if (d !== 8 || desc !== f.pair) throw new Error(`${f.label}: new feed ${f.next} is ${desc}/${d} dec, expected ${f.pair}/8`);
    console.log(`${f.label} ${f.pair}: ${f.old} -> ${f.next}`);
  }

  // Config: the live config (per-year = per-second * SECONDS_PER_YEAR) with only the 8 feeds swapped.
  const perYear = (k: string) => ethers.BigNumber.from(before[k]).mul(SECONDS_PER_YEAR);
  const config = {
    governor: before.governor, pauseGuardian: before.pauseGuardian, baseToken: before.baseToken,
    baseTokenPriceFeed: next(before.baseTokenPriceFeed), extensionDelegate: before.extensionDelegate,
    supplyKink: before.supplyKink,
    supplyPerYearInterestRateSlopeLow: perYear('supplyPerSecondInterestRateSlopeLow'),
    supplyPerYearInterestRateSlopeHigh: perYear('supplyPerSecondInterestRateSlopeHigh'),
    supplyPerYearInterestRateBase: perYear('supplyPerSecondInterestRateBase'),
    borrowKink: before.borrowKink,
    borrowPerYearInterestRateSlopeLow: perYear('borrowPerSecondInterestRateSlopeLow'),
    borrowPerYearInterestRateSlopeHigh: perYear('borrowPerSecondInterestRateSlopeHigh'),
    borrowPerYearInterestRateBase: perYear('borrowPerSecondInterestRateBase'),
    storeFrontPriceFactor: before.storeFrontPriceFactor, trackingIndexScale: before.trackingIndexScale,
    baseTrackingSupplySpeed: before.baseTrackingSupplySpeed, baseTrackingBorrowSpeed: before.baseTrackingBorrowSpeed,
    baseMinForRewards: before.baseMinForRewards, baseBorrowMin: before.baseBorrowMin, targetReserves: before.targetReserves,
    assetConfigs: before.assets.map((a: any) => ({
      asset: a.asset, priceFeed: next(a.priceFeed), decimals: dec(a.scale),
      borrowCollateralFactor: a.bcf, liquidateCollateralFactor: a.lcf, liquidationFactor: a.lf, supplyCap: a.cap,
    })),
  };
  console.log(`Config: ${config.assetConfigs.length} assets, 8 feeds swapped`);
  if (mode === 'dry') { console.log('DRY RUN COMPLETE — no transactions sent.'); return; }
  if (!same(owner, signer.address)) throw new Error('signer is not the ProxyAdmin owner');

  // Deploy the impl, upgrade.
  const hashes: Record<string, string> = {};
  const Comet = await ethers.getContractFactory('contracts/Comet.sol:Comet', signer);
  const impl = await (await Comet.deploy(config, { ...tx, gasLimit: 200_000_000 })).deployed();
  hashes.deploy = impl.deployTransaction.hash;
  console.log(`new impl: ${impl.address}`);
  const up = await pa.upgrade(COMET_PROXY, impl.address, { ...tx, gasLimit: 5_000_000 });
  await up.wait();
  hashes.upgrade = up.hash;
  const implNow = await pa.getProxyImplementation(COMET_PROXY);
  if (!same(implNow, impl.address)) throw new Error(`post-upgrade impl ${implNow} != ${impl.address}`);

  // Post-upgrade reads: only the 8 feeds differ; totals and every totalsCollateral identical.
  const after = await snapshot(comet);
  const skip = new Set(['baseTokenPriceFeed', 'assets']);
  for (const k of Object.keys(before).filter((k) => !skip.has(k) && k !== 'totalsCollateral')) {
    if (String(before[k]).toLowerCase() !== String(after[k]).toLowerCase()) throw new Error(`config field ${k} changed: ${before[k]} -> ${after[k]}`);
  }
  if (JSON.stringify(before.totalsCollateral) !== JSON.stringify(after.totalsCollateral)) throw new Error('totalsCollateral changed');
  if (!same(after.baseTokenPriceFeed, FEEDS[0].next)) throw new Error(`base feed ${after.baseTokenPriceFeed}`);
  before.assets.forEach((a: any, i: number) => {
    const expect = JSON.stringify({ ...a, priceFeed: FEEDS[i + 1].next });
    if (expect.toLowerCase() !== JSON.stringify(after.assets[i]).toLowerCase()) throw new Error(`asset ${i} changed beyond its feed: ${JSON.stringify(after.assets[i])}`);
  });
  console.log(`totalSupply before ${before.totalSupply} after ${after.totalSupply}; totalBorrow before ${before.totalBorrow} after ${after.totalBorrow}; totalsCollateral identical`);

  const state = {
    upgradedAt: new Date().toISOString(), network: 'hadrian', chainId: 200010,
    cometProxy: COMET_PROXY, proxyAdmin: PROXY_ADMIN, originalImpl: ORIGINAL_IMPL, newImpl: impl.address,
    rollback: { tx: `ProxyAdmin(${PROXY_ADMIN}).upgrade(${COMET_PROXY}, ${ORIGINAL_IMPL}) signed by ${EXPECTED_OWNER}; MODE=restore of this script`, validWhile: 'nothing else about the comet changes' },
    txHashes: hashes, book900: BOOK_900, book3600: BOOK_3600,
    feeds: FEEDS.map((f) => ({ label: f.label, pair: f.pair, old900s: f.old, new3600s: f.next })),
    before: { numAssets: before.numAssets, totalSupply: before.totalSupply, totalBorrow: before.totalBorrow, totalSupplyBase: before.totalSupplyBase, totalBorrowBase: before.totalBorrowBase, totalsCollateral: before.totalsCollateral, baseTokenPriceFeed: before.baseTokenPriceFeed },
    after: { numAssets: after.numAssets, totalSupply: after.totalSupply, totalBorrow: after.totalBorrow, totalSupplyBase: after.totalSupplyBase, totalBorrowBase: after.totalBorrowBase, totalsCollateral: after.totalsCollateral, baseTokenPriceFeed: after.baseTokenPriceFeed },
    assetsBefore: before.assets,
    assets: after.assets,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log(`UPGRADE COMPLETE. state: ${STATE_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
