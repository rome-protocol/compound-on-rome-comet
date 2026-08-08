// Cut the live 9-feed (base + 8 collat) Hadrian comet over from per-pair
// CachedPythAdapter clones to PriceBook BookFeedAdapters — one feed swap per
// asset, nothing else about the market changes.
//
// This comet has NO Configurator (same situation as lower-wsol-cf.ts's
// target), so a feed change = deploy a new Comet impl with a byte-identical
// config except the 9 priceFeed fields, then ProxyAdmin.upgrade. Restore =
// re-upgrade to ORIGINAL_IMPL (still on-chain) — one tx, no redeploy. Same
// pattern as lower-wsol-cf.ts / marcus-phase2/swap-comet-impl.ts.
//
// The full config (governor, rates, kinks, tracking, per-asset factors/caps)
// is read LIVE from the proxy every run, never from a file — config drifts.
// Only the 9 old/new feed addresses below are hardcoded, and even those are
// asserted against the live reads before anything is built: a mismatch means
// this map is stale and the script aborts loudly instead of mis-cutting-over.
//
// Asset SET + ORDER is the invariant that protects user positions
// (collateral storage is keyed by asset offset). It's checked twice: the
// old-vs-new config diff must be EXACTLY the 9 feed lines (structural proof,
// all modes), and in cutover mode the pre- vs post-upgrade on-chain reads
// must diff by exactly those same 9 fields (empirical proof).
//
//   MODE=dry     npx hardhat run scripts/hadrian-cached-test/cutover-book-feeds.ts --network hadrian
//   MODE=cutover ETH_PK=<proxyadmin-owner-key> ... npx hardhat run scripts/hadrian-cached-test/cutover-book-feeds.ts --network hadrian
//   MODE=restore ETH_PK=<proxyadmin-owner-key> ... npx hardhat run scripts/hadrian-cached-test/cutover-book-feeds.ts --network hadrian
//
// hardhat.config.ts requires these 5 stub env vars for ANY command against
// ANY network (validated at config-load time, unconditionally):
//   ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//   UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub
// MODE=dry needs no ETH_PK — it sends zero transactions, so hardhat's default
// MNEMONIC (baked into hardhat.config.ts, a well-known public test phrase) is
// sufficient. MODE=cutover/restore need the ProxyAdmin owner's key.

import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// ─── Ground truth (verified on-chain 2026-08-08; re-verified live below) ───
// Comet-identity constants. Default to the first cache-fed comet cut over
// (0xfc322489); override via env to cut over another generation on the SAME
// old->new feed map (all Hadrian cache-fed comets share the 9 CachedPythAdapter
// feed addresses). The old-feed-match assertion below hard-fails if the target
// isn't actually on the expected old feeds, so a wrong COMET_PROXY can't slip through.
const COMET_PROXY = process.env.COMET_PROXY || '0xfc322489D4089AdCC79074C8058Fd257c63622D8';
const PROXY_ADMIN = process.env.PROXY_ADMIN || '0x60d7BD2e676C4626Bb0B99Ce9c471aaB212A1b61';
const ORIGINAL_IMPL = process.env.ORIGINAL_IMPL || '0x1393f6cE821332C42c7311AAAF52CE40B831Fa09'; // restore target
const EXPECTED_EXECUTOR = '0x1f4946Be340F06c46A50E65084790968aBcc48F6'; // ProxyAdmin.owner() — F6, same for both cache-fed comets

interface FeedSwap {
  label: string;
  pair: string;
  old: string;
  new: string;
}

// index 0 = base (baseTokenPriceFeed); index 1..8 = assetConfigs[0..7].
const FEED_SWAPS: FeedSwap[] = [
  { label: 'base (baseTokenPriceFeed)', pair: 'USDC/USD',    old: '0xe6b9bD3d50E3E4bF73724065E6F9f99Fd1b8B027', new: '0x0B1697E8f360271090D540Eaf3A16520C8651d12' },
  { label: 'asset0',                    pair: 'ETH/USD',     old: '0xED815CAe213b16B092d531D0a511E77D43a3C805', new: '0xDFC77D0Dd2a193C08200ECf9EF6fe5a4bF74E1a7' },
  { label: 'asset1',                    pair: 'SOL/USD',     old: '0x23F18946e1c3dcB710Be9548F9C66d1e877CC1F6', new: '0x2779176109cbEDD2fDdA63937E087518b309F4BE' },
  { label: 'asset2',                    pair: 'BTC/USD',     old: '0x63Ecae6b814f4A6a8E31CF4B38C82fee21b5a842', new: '0xF0aF167691D3Bcc49e17902930831AdD58C8cF97' },
  { label: 'asset3',                    pair: 'JITOSOL/USD', old: '0xF08cb365f3f34A288eDd9223F22F1d9397351B39', new: '0xC9afE27D4074d8f4Fe025360C6CFcB86F555d395' },
  { label: 'asset4',                    pair: 'MSOL/USD',    old: '0xf01bDDA1091120804f901E0D5f0293ee9616F62b', new: '0x6dDcFF771f8E00D61086243f28e6B629b240c15b' },
  { label: 'asset5',                    pair: 'JUP/USD',     old: '0xBe43c0d3dFBC10313bF7fBaD67Dc93EC1cA136E7', new: '0x979d8F7b518b96d1a99Fa973Ec133F5705F3b5ae' },
  { label: 'asset6',                    pair: 'JTO/USD',     old: '0x420cD39f59Eea11e3A8e01A9B3C830ff9a2793ae', new: '0xfBb33E87b5Cf9563BB0a1638EbFEDAc230b8A2C2' },
  { label: 'asset7',                    pair: 'BONK/USD',    old: '0xC63Af5d67d2A655a087BF635F3980DCe041963de', new: '0xA5D6693323C58B7Da65578C46E041D975aaEb030' },
];

// Mirrors contracts/CometCore.sol's internal constants.
const SECONDS_PER_YEAR = 31_536_000;
const PRICE_FEED_DECIMALS = 8;

const EXPECTED_CONFIG_DIFF_PATHS = [
  'baseTokenPriceFeed',
  ...Array.from({ length: 8 }, (_, i) => `assetConfigs[${i}].priceFeed`),
];
const EXPECTED_LIVE_DIFF_PATHS = [
  'baseTokenPriceFeed',
  ...Array.from({ length: 8 }, (_, i) => `assets[${i}].priceFeed`),
];

const PROXY_ADMIN_ABI = [
  'function upgrade(address proxy, address implementation) external',
  'function getProxyImplementation(address proxy) external view returns (address)',
  'function owner() external view returns (address)',
];
const COMET_READ_ABI = [
  'function governor() view returns (address)',
  'function pauseGuardian() view returns (address)',
  'function baseToken() view returns (address)',
  'function baseTokenPriceFeed() view returns (address)',
  'function extensionDelegate() view returns (address)',
  'function supplyKink() view returns (uint64)',
  'function supplyPerSecondInterestRateSlopeLow() view returns (uint64)',
  'function supplyPerSecondInterestRateSlopeHigh() view returns (uint64)',
  'function supplyPerSecondInterestRateBase() view returns (uint64)',
  'function borrowKink() view returns (uint64)',
  'function borrowPerSecondInterestRateSlopeLow() view returns (uint64)',
  'function borrowPerSecondInterestRateSlopeHigh() view returns (uint64)',
  'function borrowPerSecondInterestRateBase() view returns (uint64)',
  'function storeFrontPriceFactor() view returns (uint64)',
  'function trackingIndexScale() view returns (uint64)',
  'function baseTrackingSupplySpeed() view returns (uint64)',
  'function baseTrackingBorrowSpeed() view returns (uint64)',
  'function baseMinForRewards() view returns (uint104)',
  'function baseBorrowMin() view returns (uint104)',
  'function targetReserves() view returns (uint104)',
  'function numAssets() view returns (uint8)',
  'function getAssetInfo(uint8 i) view returns (tuple(uint8 offset,address asset,address priceFeed,uint64 scale,uint64 borrowCollateralFactor,uint64 liquidateCollateralFactor,uint64 liquidationFactor,uint128 supplyCap))',
  'function getPrice(address priceFeed) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrow() view returns (uint256)',
];
const FEED_ABI = [
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

interface AssetSnapshot {
  offset: number;
  asset: string;
  priceFeed: string;
  decimals: number;
  borrowCollateralFactor: BigNumber;
  liquidateCollateralFactor: BigNumber;
  liquidationFactor: BigNumber;
  supplyCap: BigNumber;
}

interface LiveSnapshot {
  governor: string;
  pauseGuardian: string;
  baseToken: string;
  baseTokenPriceFeed: string;
  extensionDelegate: string;
  supplyKink: BigNumber;
  supplyPerSecondInterestRateSlopeLow: BigNumber;
  supplyPerSecondInterestRateSlopeHigh: BigNumber;
  supplyPerSecondInterestRateBase: BigNumber;
  borrowKink: BigNumber;
  borrowPerSecondInterestRateSlopeLow: BigNumber;
  borrowPerSecondInterestRateSlopeHigh: BigNumber;
  borrowPerSecondInterestRateBase: BigNumber;
  storeFrontPriceFactor: BigNumber;
  trackingIndexScale: BigNumber;
  baseTrackingSupplySpeed: BigNumber;
  baseTrackingBorrowSpeed: BigNumber;
  baseMinForRewards: BigNumber;
  baseBorrowMin: BigNumber;
  targetReserves: BigNumber;
  numAssets: number;
  assets: AssetSnapshot[];
  totalSupply: BigNumber;
  totalBorrow: BigNumber;
}

interface AssetConfigInput {
  asset: string;
  priceFeed: string;
  decimals: number;
  borrowCollateralFactor: BigNumber;
  liquidateCollateralFactor: BigNumber;
  liquidationFactor: BigNumber;
  supplyCap: BigNumber;
}

interface ConfigurationInput {
  governor: string;
  pauseGuardian: string;
  baseToken: string;
  baseTokenPriceFeed: string;
  extensionDelegate: string;
  supplyKink: BigNumber;
  supplyPerYearInterestRateSlopeLow: BigNumber;
  supplyPerYearInterestRateSlopeHigh: BigNumber;
  supplyPerYearInterestRateBase: BigNumber;
  borrowKink: BigNumber;
  borrowPerYearInterestRateSlopeLow: BigNumber;
  borrowPerYearInterestRateSlopeHigh: BigNumber;
  borrowPerYearInterestRateBase: BigNumber;
  storeFrontPriceFactor: BigNumber;
  trackingIndexScale: BigNumber;
  baseTrackingSupplySpeed: BigNumber;
  baseTrackingBorrowSpeed: BigNumber;
  baseMinForRewards: BigNumber;
  baseBorrowMin: BigNumber;
  targetReserves: BigNumber;
  assetConfigs: AssetConfigInput[];
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// Comet packs each asset's scale as 10**decimals, so this is always an exact
// power-of-10 divide — no rounding.
function scaleToDecimals(scale: BigNumber): number {
  let s = scale;
  let decimals = 0;
  while (s.gt(1)) {
    s = s.div(10);
    decimals++;
  }
  return decimals;
}

async function readLiveSnapshot(comet: any): Promise<LiveSnapshot> {
  const [
    governor, pauseGuardian, baseToken, baseTokenPriceFeed, extensionDelegate,
    supplyKink, supplyPerSecondInterestRateSlopeLow, supplyPerSecondInterestRateSlopeHigh, supplyPerSecondInterestRateBase,
    borrowKink, borrowPerSecondInterestRateSlopeLow, borrowPerSecondInterestRateSlopeHigh, borrowPerSecondInterestRateBase,
    storeFrontPriceFactor, trackingIndexScale, baseTrackingSupplySpeed, baseTrackingBorrowSpeed,
    baseMinForRewards, baseBorrowMin, targetReserves, numAssetsRaw, totalSupply, totalBorrow,
  ] = await Promise.all([
    comet.governor(), comet.pauseGuardian(), comet.baseToken(), comet.baseTokenPriceFeed(), comet.extensionDelegate(),
    comet.supplyKink(), comet.supplyPerSecondInterestRateSlopeLow(), comet.supplyPerSecondInterestRateSlopeHigh(), comet.supplyPerSecondInterestRateBase(),
    comet.borrowKink(), comet.borrowPerSecondInterestRateSlopeLow(), comet.borrowPerSecondInterestRateSlopeHigh(), comet.borrowPerSecondInterestRateBase(),
    comet.storeFrontPriceFactor(), comet.trackingIndexScale(), comet.baseTrackingSupplySpeed(), comet.baseTrackingBorrowSpeed(),
    comet.baseMinForRewards(), comet.baseBorrowMin(), comet.targetReserves(), comet.numAssets(),
    comet.totalSupply(), comet.totalBorrow(),
  ]);

  const numAssets = Number(numAssetsRaw);
  const infos = await Promise.all(Array.from({ length: numAssets }, (_, i) => comet.getAssetInfo(i)));
  const assets: AssetSnapshot[] = infos.map((info: any) => ({
    offset: Number(info.offset),
    asset: info.asset,
    priceFeed: info.priceFeed,
    decimals: scaleToDecimals(info.scale),
    borrowCollateralFactor: info.borrowCollateralFactor,
    liquidateCollateralFactor: info.liquidateCollateralFactor,
    liquidationFactor: info.liquidationFactor,
    supplyCap: info.supplyCap,
  }));

  return {
    governor, pauseGuardian, baseToken, baseTokenPriceFeed, extensionDelegate,
    supplyKink, supplyPerSecondInterestRateSlopeLow, supplyPerSecondInterestRateSlopeHigh, supplyPerSecondInterestRateBase,
    borrowKink, borrowPerSecondInterestRateSlopeLow, borrowPerSecondInterestRateSlopeHigh, borrowPerSecondInterestRateBase,
    storeFrontPriceFactor, trackingIndexScale, baseTrackingSupplySpeed, baseTrackingBorrowSpeed,
    baseMinForRewards, baseBorrowMin, targetReserves,
    numAssets, assets, totalSupply, totalBorrow,
  };
}

// Comet's constructor takes PER-YEAR rates and does `perYear / SECONDS_PER_YEAR`
// (floor) to get the immutable PER-SECOND rate it actually stores. Reading the
// live per-second value and reconstructing perYear = perSecond * SECONDS_PER_YEAR
// gives an exact multiple, so floor(perYear / SECONDS_PER_YEAR) reproduces the
// SAME per-second immutable on redeploy — no drift from the live value.
function toConfiguration(live: LiveSnapshot, baseFeed: string, assetFeed: (i: number) => string): ConfigurationInput {
  return {
    governor: live.governor,
    pauseGuardian: live.pauseGuardian,
    baseToken: live.baseToken,
    baseTokenPriceFeed: baseFeed,
    extensionDelegate: live.extensionDelegate,
    supplyKink: live.supplyKink,
    supplyPerYearInterestRateSlopeLow: live.supplyPerSecondInterestRateSlopeLow.mul(SECONDS_PER_YEAR),
    supplyPerYearInterestRateSlopeHigh: live.supplyPerSecondInterestRateSlopeHigh.mul(SECONDS_PER_YEAR),
    supplyPerYearInterestRateBase: live.supplyPerSecondInterestRateBase.mul(SECONDS_PER_YEAR),
    borrowKink: live.borrowKink,
    borrowPerYearInterestRateSlopeLow: live.borrowPerSecondInterestRateSlopeLow.mul(SECONDS_PER_YEAR),
    borrowPerYearInterestRateSlopeHigh: live.borrowPerSecondInterestRateSlopeHigh.mul(SECONDS_PER_YEAR),
    borrowPerYearInterestRateBase: live.borrowPerSecondInterestRateBase.mul(SECONDS_PER_YEAR),
    storeFrontPriceFactor: live.storeFrontPriceFactor,
    trackingIndexScale: live.trackingIndexScale,
    baseTrackingSupplySpeed: live.baseTrackingSupplySpeed,
    baseTrackingBorrowSpeed: live.baseTrackingBorrowSpeed,
    baseMinForRewards: live.baseMinForRewards,
    baseBorrowMin: live.baseBorrowMin,
    targetReserves: live.targetReserves,
    assetConfigs: live.assets.map((a, i) => ({
      asset: a.asset,
      priceFeed: assetFeed(i),
      decimals: a.decimals,
      borrowCollateralFactor: a.borrowCollateralFactor,
      liquidateCollateralFactor: a.liquidateCollateralFactor,
      liquidationFactor: a.liquidationFactor,
      supplyCap: a.supplyCap,
    })),
  };
}

function isEqualValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (BigNumber.isBigNumber(a) || BigNumber.isBigNumber(b)) {
    return ethers.BigNumber.from(a as any).eq(ethers.BigNumber.from(b as any));
  }
  if (typeof a === 'string' && typeof b === 'string' && a.startsWith('0x') && b.startsWith('0x')) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

function stringifyValue(v: unknown): string {
  if (v == null) return String(v);
  if (BigNumber.isBigNumber(v)) return (v as BigNumber).toString();
  return String(v);
}

interface Diff { path: string, before: string, after: string }

// Recursively diffs two same-shaped plain-data snapshots (nested objects /
// arrays of addresses, BigNumbers, or numbers) and returns the leaf paths
// that differ. Used both to prove "only the 9 feed fields differ" between an
// old/new config pair built from the SAME live read, and to prove "nothing
// else changed" between pre- and post-upgrade on-chain reads.
function deepDiff(a: any, b: any, prefix = ''): Diff[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out: Diff[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      out.push(...deepDiff(a[i], b[i], `${prefix}[${i}]`));
    }
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !BigNumber.isBigNumber(a) && !BigNumber.isBigNumber(b)) {
    const out: Diff[] = [];
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      out.push(...deepDiff(a[key], b[key], prefix ? `${prefix}.${key}` : key));
    }
    return out;
  }
  return isEqualValue(a, b) ? [] : [{ path: prefix, before: stringifyValue(a), after: stringifyValue(b) }];
}

function printDiff(diffs: Diff[], title: string): void {
  console.log(`\n${title} (${diffs.length} field${diffs.length === 1 ? '' : 's'} differ):`);
  for (const d of diffs) {
    console.log(`  ${d.path}`);
    console.log(`    before: ${d.before}`);
    console.log(`    after:  ${d.after}`);
  }
}

function assertOnlyExpectedDiffer(diffs: Diff[], expectedPaths: string[], context: string): void {
  const expected = new Set(expectedPaths);
  const gotPaths = diffs.map((d) => d.path);
  const unexpected = gotPaths.filter((p) => !expected.has(p));
  const missing = expectedPaths.filter((p) => !gotPaths.includes(p));
  if (unexpected.length > 0 || missing.length > 0) {
    if (unexpected.length) console.error(`  UNEXPECTED diffs (should be identical): ${unexpected.join(', ')}`);
    if (missing.length) console.error(`  MISSING expected diffs (feed didn't change?): ${missing.join(', ')}`);
    throw new Error(`${context}: config-identity invariant violated — see above`);
  }
  console.log(`✓ ${context}: exactly the ${expectedPaths.length} feed fields differ, everything else identical.`);
}

function assertOldFeedsMatch(live: LiveSnapshot): void {
  const mismatches: string[] = [];
  if (!sameAddr(live.baseTokenPriceFeed, FEED_SWAPS[0].old)) {
    mismatches.push(`${FEED_SWAPS[0].label}: on-chain=${live.baseTokenPriceFeed} expected-old=${FEED_SWAPS[0].old}`);
  }
  live.assets.forEach((a, i) => {
    const expected = FEED_SWAPS[i + 1];
    if (!sameAddr(a.priceFeed, expected.old)) {
      mismatches.push(`${expected.label} (${a.asset}): on-chain=${a.priceFeed} expected-old=${expected.old}`);
    }
  });
  if (mismatches.length > 0) {
    throw new Error(`Old-feed map is STALE — on-chain feed(s) don't match the recorded ground truth:\n  ${mismatches.join('\n  ')}`);
  }
  console.log('✓ All 9 on-chain feeds match the recorded old (CachedPythAdapter) set.');
}

function assertAssetCount(live: LiveSnapshot, expected: number): void {
  if (live.numAssets !== expected) {
    throw new Error(`numAssets on-chain=${live.numAssets} != expected=${expected} — asset set has changed, map is stale`);
  }
  console.log(`✓ numAssets = ${expected}, matches expectation.`);
}

function assertIsOwner(owner: string, signerAddr: string): void {
  if (!sameAddr(owner, EXPECTED_EXECUTOR)) {
    throw new Error(`ProxyAdmin owner on-chain (${owner}) != recorded EXPECTED_EXECUTOR (${EXPECTED_EXECUTOR}) — ownership drifted since ground truth was recorded; abort before sending any tx`);
  }
  if (!sameAddr(owner, signerAddr)) {
    throw new Error(`signer ${signerAddr} is NOT the ProxyAdmin owner (${owner}) — abort, no tx sent`);
  }
}

// Read-only: prints each pair's old-feed vs new-feed answer side by side and
// flags >1% divergence. Also hard-asserts new-feed decimals == 8, since
// Comet's constructor reverts with BadDecimals() otherwise — better to catch
// that here than after a 200M-gas deploy.
async function printPriceSanity(signerOrProvider: any): Promise<void> {
  console.log('\nPrice sanity (old feed vs. new BookFeedAdapter, same pair):');
  let anyWarn = false;
  for (const f of FEED_SWAPS) {
    const oldFeed = new ethers.Contract(f.old, FEED_ABI, signerOrProvider);
    const newFeed = new ethers.Contract(f.new, FEED_ABI, signerOrProvider);
    const [oldDec, oldRound, newDec, newRound] = await Promise.all([
      oldFeed.decimals(), oldFeed.latestRoundData(),
      newFeed.decimals(), newFeed.latestRoundData(),
    ]);
    if (Number(newDec) !== PRICE_FEED_DECIMALS) {
      throw new Error(`${f.label}: new feed ${f.new} has decimals=${newDec}, Comet requires ${PRICE_FEED_DECIMALS} — deploy would revert with BadDecimals()`);
    }
    const oldPrice = Number(oldRound.answer) / 10 ** Number(oldDec);
    const newPrice = Number(newRound.answer) / 10 ** Number(newDec);
    const pctDiff = oldPrice === 0 ? NaN : (Math.abs(newPrice - oldPrice) / oldPrice) * 100;
    const flag = !(pctDiff <= 1) ? '  ⚠ >1%' : '';
    if (flag) anyWarn = true;
    console.log(
      `  ${f.label.padEnd(24)} ${f.pair.padEnd(12)} old=$${oldPrice.toFixed(6)} (dec ${oldDec})  new=$${newPrice.toFixed(6)} (dec ${newDec})  diff=${pctDiff.toFixed(3)}%${flag}`,
    );
  }
  if (anyWarn) {
    console.warn('\n⚠ One or more pairs differ by >1% — expected for live market data in motion; confirm it is not a wrong-pair mapping before cutover.');
  }
}

async function assertGetPriceSane(comet: any, feeds: string[]): Promise<void> {
  console.log('\nComet.getPrice() sanity for each new feed:');
  for (const feed of feeds) {
    const price = await comet.getPrice(feed);
    if (price.lte(0)) {
      throw new Error(`Comet.getPrice(${feed}) returned <= 0`);
    }
    console.log(`  getPrice(${feed}) = ${price.toString()}`);
  }
}

// Rates are byte-identical across the upgrade (see toConfiguration's
// per-second/per-year note), so any growth here is ordinary interest accrual
// over the few seconds the deploy+upgrade txs took, not evidence the swap
// touched accounting. Bound generously so a genuine corruption (reset,
// doubling, wrong storage layout) still trips this.
function assertTotalsConsistent(before: BigNumber, after: BigNumber, label: string): void {
  if (after.lt(before)) {
    throw new Error(`${label} DECREASED across the upgrade: before=${before.toString()} after=${after.toString()} — possible accounting corruption`);
  }
  if (before.isZero()) {
    if (!after.isZero()) {
      throw new Error(`${label} was 0 before the upgrade but is ${after.toString()} after — possible accounting corruption`);
    }
    console.log(`✓ ${label}: 0 before and after.`);
    return;
  }
  const deltaBps = after.sub(before).mul(10_000).div(before);
  if (deltaBps.gt(10)) {
    throw new Error(`${label} grew by ${deltaBps.toString()} bps across the upgrade (before=${before.toString()} after=${after.toString()}) — too large for a same-block accrual tick`);
  }
  console.log(`✓ ${label}: before=${before.toString()} after=${after.toString()} (+${deltaBps.toString()} bps, consistent with ordinary accrual).`);
}

function stripTotals(s: LiveSnapshot): Omit<LiveSnapshot, 'totalSupply' | 'totalBorrow'> {
  const { totalSupply: _totalSupply, totalBorrow: _totalBorrow, ...rest } = s;
  return rest;
}

async function runRestore(comet: any, pa: any, signer: any): Promise<void> {
  const owner = await pa.owner();
  assertIsOwner(owner, signer.address);

  const currentImpl = await pa.getProxyImplementation(COMET_PROXY);
  if (sameAddr(currentImpl, ORIGINAL_IMPL)) {
    console.log(`Proxy is already on ORIGINAL_IMPL (${ORIGINAL_IMPL}) — nothing to restore.`);
    return;
  }

  console.log(`\nRestoring proxy ${COMET_PROXY}\n  ${currentImpl} -> ${ORIGINAL_IMPL}`);
  const tx = await pa.upgrade(COMET_PROXY, ORIGINAL_IMPL, { gasLimit: 5_000_000 });
  await tx.wait();

  const implNow = await pa.getProxyImplementation(COMET_PROXY);
  if (!sameAddr(implNow, ORIGINAL_IMPL)) {
    throw new Error(`restore post-verify: proxy impl=${implNow}, expected ORIGINAL_IMPL=${ORIGINAL_IMPL}`);
  }
  const after = await readLiveSnapshot(comet);
  assertOldFeedsMatch(after);
  console.log('\nRESTORE COMPLETE — proxy back on ORIGINAL_IMPL, all 9 feeds back to the CachedPythAdapter set.');
}

async function runCutover(comet: any, pa: any, signer: any, live: LiveSnapshot, newConfig: ConfigurationInput): Promise<void> {
  const owner = await pa.owner();
  assertIsOwner(owner, signer.address);

  const currentImpl = await pa.getProxyImplementation(COMET_PROXY);
  if (!sameAddr(currentImpl, ORIGINAL_IMPL)) {
    throw new Error(`live impl (${currentImpl}) != recorded ORIGINAL_IMPL (${ORIGINAL_IMPL}) — state drifted since ground truth was recorded (already cut over?); abort before sending any tx`);
  }

  console.log('\nDeploying new Comet impl (9 feeds -> BookFeedAdapters, everything else byte-identical)...');
  const Comet = await ethers.getContractFactory('contracts/Comet.sol:Comet', signer);
  const impl = await (await Comet.deploy(newConfig, { gasLimit: 200_000_000 })).deployed();
  console.log(`  new impl: ${impl.address}`);

  console.log(`Upgrading proxy ${COMET_PROXY}\n  ${ORIGINAL_IMPL} -> ${impl.address}`);
  const upgradeTx = await pa.upgrade(COMET_PROXY, impl.address, { gasLimit: 5_000_000 });
  await upgradeTx.wait();

  console.log('\nPost-upgrade verification...');
  const implNow = await pa.getProxyImplementation(COMET_PROXY);
  if (!sameAddr(implNow, impl.address)) {
    throw new Error(`post-verify: proxy impl=${implNow}, expected new impl=${impl.address}`);
  }
  console.log(`✓ proxy now points at ${impl.address}`);

  const after = await readLiveSnapshot(comet);

  if (!sameAddr(after.baseTokenPriceFeed, FEED_SWAPS[0].new)) {
    throw new Error(`post-verify: baseTokenPriceFeed=${after.baseTokenPriceFeed}, expected new=${FEED_SWAPS[0].new}`);
  }
  after.assets.forEach((a, i) => {
    const expected = FEED_SWAPS[i + 1].new;
    if (!sameAddr(a.priceFeed, expected)) {
      throw new Error(`post-verify: assets[${i}].priceFeed=${a.priceFeed}, expected new=${expected}`);
    }
  });
  console.log('✓ all 9 feeds now point at the new BookFeedAdapters.');

  const liveDiffs = deepDiff(stripTotals(live), stripTotals(after));
  printDiff(liveDiffs, 'Pre- vs. post-upgrade on-chain diff');
  assertOnlyExpectedDiffer(liveDiffs, EXPECTED_LIVE_DIFF_PATHS, 'post-cutover config identity');

  await assertGetPriceSane(comet, FEED_SWAPS.map((f) => f.new));

  assertTotalsConsistent(live.totalSupply, after.totalSupply, 'totalSupply');
  assertTotalsConsistent(live.totalBorrow, after.totalBorrow, 'totalBorrow');

  const state = {
    cometProxy: COMET_PROXY,
    proxyAdmin: PROXY_ADMIN,
    originalImpl: ORIGINAL_IMPL,
    newImpl: impl.address,
    txHashes: {
      deploy: impl.deployTransaction.hash,
      upgrade: upgradeTx.hash,
    },
    feeds: FEED_SWAPS.map((f) => ({ label: f.label, pair: f.pair, old: f.old, new: f.new })),
    cutoverAt: new Date().toISOString(),
  };
  const stateFile = path.join('scripts', 'hadrian-cached-test', 'state-book-cutover.json');
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

  console.log('\nCUTOVER COMPLETE.');
  console.log(`  new impl: ${impl.address}`);
  console.log(`  state:    ${stateFile}`);
  console.log(`  restore with: MODE=restore ... (-> impl ${ORIGINAL_IMPL})`);
}

async function main(): Promise<void> {
  const mode = process.env.MODE || 'dry';
  if (mode !== 'dry' && mode !== 'cutover' && mode !== 'restore') {
    throw new Error(`MODE must be one of dry|cutover|restore, got '${mode}'`);
  }

  const [signer] = await ethers.getSigners();
  console.log(`Mode: ${mode}`);
  console.log(`Signer: ${signer.address}`);
  console.log(`Comet proxy: ${COMET_PROXY}`);
  console.log(`ProxyAdmin: ${PROXY_ADMIN}\n`);

  const comet = new ethers.Contract(COMET_PROXY, COMET_READ_ABI, signer);
  const pa = new ethers.Contract(PROXY_ADMIN, PROXY_ADMIN_ABI, signer);

  const currentImpl = await pa.getProxyImplementation(COMET_PROXY);
  console.log(`Current impl: ${currentImpl}`);
  if (!sameAddr(currentImpl, ORIGINAL_IMPL)) {
    const msg = `impl drifted from recorded ground truth: on-chain=${currentImpl} expected ORIGINAL_IMPL=${ORIGINAL_IMPL}`;
    if (mode === 'dry') {
      console.warn(`⚠ ${msg} (continuing — dry mode is read-only)`);
    } else {
      throw new Error(`${msg} — abort before sending any tx (has cutover already run?)`);
    }
  } else {
    console.log('✓ matches recorded ORIGINAL_IMPL.');
  }

  const owner = await pa.owner();
  console.log(`ProxyAdmin owner: ${owner}`);
  if (!sameAddr(owner, EXPECTED_EXECUTOR)) {
    const msg = `owner drifted from recorded ground truth: on-chain=${owner} expected EXPECTED_EXECUTOR=${EXPECTED_EXECUTOR}`;
    if (mode === 'dry') {
      console.warn(`⚠ ${msg} (continuing — dry mode is read-only)`);
    } else {
      throw new Error(`${msg} — abort before sending any tx`);
    }
  } else {
    console.log('✓ matches recorded EXPECTED_EXECUTOR.');
  }

  if (mode === 'restore') {
    await runRestore(comet, pa, signer);
    return;
  }

  const live = await readLiveSnapshot(comet);
  assertAssetCount(live, 8);
  assertOldFeedsMatch(live);

  const oldProjected = toConfiguration(live, FEED_SWAPS[0].old, (i) => FEED_SWAPS[i + 1].old);
  const newConfig = toConfiguration(live, FEED_SWAPS[0].new, (i) => FEED_SWAPS[i + 1].new);

  const diffs = deepDiff(oldProjected, newConfig);
  printDiff(diffs, 'Config diff (old feeds -> new BookFeedAdapters)');
  assertOnlyExpectedDiffer(diffs, EXPECTED_CONFIG_DIFF_PATHS, 'dry-run config diff');

  await printPriceSanity(signer);

  if (mode === 'dry') {
    console.log('\nDRY RUN COMPLETE — no transactions were sent.');
    return;
  }

  await runCutover(comet, pa, signer, live, newConfig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
