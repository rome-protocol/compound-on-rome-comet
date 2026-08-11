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
// MODE=verify (alias: pass --verify) is the coverage gate: it enumerates
// EVERY cache-fed comet from the registry app manifest (scripts/hadrian-cached-test/lib/cutover-gate.ts's
// resolveCachedComets — structured comets[] UNIONED with every comet named
// only in prose notes, e.g. the canonical 0x771D2f21… comet that was never
// added to comets[]) and asserts every asset's feed is a NEW_BOOK adapter
// and NOT an OLD_BOOK adapter (or any address outside NEW_BOOK). It also
// runs automatically at the end of MODE=cutover — this run's own target
// must land fully on NEW_BOOK (hard failure otherwise); other enumerated
// comets not yet cut over are reported but don't fail THIS run (matches the
// real workflow: one comet cut over per PR, #48/#49/#50).
//   REGISTRY_ROOT=<path> NEW_BOOK=<addr> [OLD_BOOK=<addr>] \
//     MODE=verify npx hardhat run scripts/hadrian-cached-test/cutover-book-feeds.ts --network hadrian
//
// hardhat.config.ts requires these 5 stub env vars for ANY command against
// ANY network (validated at config-load time, unconditionally):
//   ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//   UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub
// MODE=dry/verify need no ETH_PK — both are read-only, so hardhat's default
// MNEMONIC (baked into hardhat.config.ts, a well-known public test phrase) is
// sufficient. MODE=cutover/restore need the ProxyAdmin owner's key.

import { ethers } from 'hardhat';
import { BigNumber } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { RegistryClient } from '../registry-driven-deploy/lib/registry-client';
import {
  resolveCachedComets,
  deriveAdapterSetFromReader,
  assertCoverage,
  assertSourceAccountParity,
  requireCutoverEnv,
  formatCoverageReport,
  CometFeedMap,
  CoverageResult,
} from './lib/cutover-gate';

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

// ─── MODE=verify (coverage gate) config ─────────────────────────────────────
// NEW_BOOK has no safe default — it's the redeployed (fixed) PriceBook this
// cutover is moving TO, and doesn't exist until that deploy happens.
// OLD_BOOK defaults to the live (first) PriceBook (rome-solidity
// deployments/hadrian.json#PriceBook.address, deployed 2026-08-08) being
// retired. REGISTRY_ROOT has no safe default (private repo, per-machine
// checkout path) — same convention as scripts/registry-driven-deploy's
// documented REGISTRY_ROOT=/path/to/registry-checkout.
const NEW_BOOK = process.env.NEW_BOOK || '';
const OLD_BOOK = process.env.OLD_BOOK || '0x619134d4d5e1e98ea10c9a6782957df24837fdda';
const REGISTRY_ROOT = process.env.REGISTRY_ROOT || '';
const CHAIN_ID = Number(process.env.CHAIN_ID || '200010');

const PRICE_BOOK_ABI = [
  'function registrationCount() view returns (uint256)',
  'function registrationAt(uint256 index) view returns (bytes32)',
  'function adapterOf(bytes32 sourceAccount) view returns (address)',
];

// BookFeedAdapter's one read the parity guard needs — the bytes32 source
// account it wraps. Both the old (first-book) and new (fixed-book) feeds are
// BookFeedAdapters so both expose it; a legacy CachedPythAdapter does NOT
// (it has pythAccount), which the guard turns into a loud abort.
const BOOK_FEED_ADAPTER_ABI = ['function sourceAccount() view returns (bytes32)'];

interface FeedSwap {
  label: string;
  pair: string;
  old: string;
  new: string;
}

// index 0 = base (baseTokenPriceFeed); index 1..8 = assetConfigs[0..7].
// S5-F3 SECOND cutover (2026-08-10): old = the FIRST PriceBook's (0x619134d4)
// BookFeedAdapters the comets were cut over to by #48/#49/#50; new = the
// REDEPLOYED fixed PriceBook's (0x3827ce84, rome-solidity#322 pause-fail-closed)
// BookFeedAdapters. old side verified live == the comets' current feeds (the
// MODE=verify STILL_OLD table); new side from pricebook-s5f3-deploy.json.
const FEED_SWAPS: FeedSwap[] = [
  { label: 'base (baseTokenPriceFeed)', pair: 'USDC/USD',    old: '0x0B1697E8f360271090D540Eaf3A16520C8651d12', new: '0x8552B15784f5cA685b7814f60cA0bBe612F56c60' },
  { label: 'asset0',                    pair: 'ETH/USD',     old: '0xDFC77D0Dd2a193C08200ECf9EF6fe5a4bF74E1a7', new: '0x708Da7aC0401cA2DEB74Aa0a87B0BaaC8262040a' },
  { label: 'asset1',                    pair: 'SOL/USD',     old: '0x2779176109cbEDD2fDdA63937E087518b309F4BE', new: '0x10d1ab750883696D1be78F68f361D55D27145FB7' },
  { label: 'asset2',                    pair: 'BTC/USD',     old: '0xF0aF167691D3Bcc49e17902930831AdD58C8cF97', new: '0x88F3eDb4c0A1Ef81756e5594Ba46ca55c71Dfe0A' },
  { label: 'asset3',                    pair: 'JITOSOL/USD', old: '0xC9afE27D4074d8f4Fe025360C6CFcB86F555d395', new: '0x9a4A2b9586902e18f7107D7F4047b898BE235832' },
  { label: 'asset4',                    pair: 'MSOL/USD',    old: '0x6dDcFF771f8E00D61086243f28e6B629b240c15b', new: '0x7b3b69c3B6E4C092793473FC727cFE56fbA4576A' },
  { label: 'asset5',                    pair: 'JUP/USD',     old: '0x979d8F7b518b96d1a99Fa973Ec133F5705F3b5ae', new: '0xE922d82F3ecA3093181f173feE1ff5575Ec60c93' },
  { label: 'asset6',                    pair: 'JTO/USD',     old: '0xfBb33E87b5Cf9563BB0a1638EbFEDAc230b8A2C2', new: '0x7227a15304D25609D322F66244Ff74A451235Ea3' },
  { label: 'asset7',                    pair: 'BONK/USD',    old: '0xA5D6693323C58B7Da65578C46E041D975aaEb030', new: '0xB592182D08b11569C2dCaB233bE9B845FfFE574A' },
];

// Mirrors contracts/CometCore.sol's internal constants.
const SECONDS_PER_YEAR = 31_536_000;
const PRICE_FEED_DECIMALS = 8;

// old CachedPythAdapter -> new BookFeedAdapter, keyed by lowercased old
// address. Lets the script cut over ANY cache-fed comet on this shared feed
// set — the full 8-asset comets AND subsets (e.g. the 3-asset 0xB42aeBB5,
// base+ETH/SOL/BTC) — by looking each live feed up rather than assuming a
// fixed count/order. A live feed absent from this map aborts (unknown feed).
const OLD_TO_NEW = new Map<string, FeedSwap>(FEED_SWAPS.map((f) => [f.old.toLowerCase(), f]));
function newFor(oldFeed: string): string {
  const swap = OLD_TO_NEW.get(oldFeed.toLowerCase());
  if (!swap) throw new Error(`live feed ${oldFeed} is not in the known old->new map — refusing to cut over an unrecognized feed`);
  return swap.new;
}
// Diff paths are derived from the comet's live numAssets, not a fixed 8.
const configDiffPaths = (n: number): string[] => ['baseTokenPriceFeed', ...Array.from({ length: n }, (_, i) => `assetConfigs[${i}].priceFeed`)];
const liveDiffPaths = (n: number): string[] => ['baseTokenPriceFeed', ...Array.from({ length: n }, (_, i) => `assets[${i}].priceFeed`)];

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
  // Every live feed (base + each asset) must be a KNOWN old cached feed in the
  // map. Works for any subset/order — protects against a wrong COMET_PROXY
  // (a comet on some other feed set aborts here) and against a stale map.
  const mismatches: string[] = [];
  if (!OLD_TO_NEW.has(live.baseTokenPriceFeed.toLowerCase())) {
    mismatches.push(`base: on-chain=${live.baseTokenPriceFeed} is not a known old cached feed`);
  }
  live.assets.forEach((a, i) => {
    if (!OLD_TO_NEW.has(a.priceFeed.toLowerCase())) {
      mismatches.push(`asset${i} (${a.asset}): on-chain=${a.priceFeed} is not a known old cached feed`);
    }
  });
  if (mismatches.length > 0) {
    throw new Error(`On-chain feed(s) not in the known old->new map — wrong comet or stale map:\n  ${mismatches.join('\n  ')}`);
  }
  console.log(`✓ All ${live.numAssets + 1} on-chain feeds (base + ${live.numAssets} assets) are known old (CachedPythAdapter) feeds.`);
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

// ── MODE=verify (coverage gate) live wiring ──────────────────────────────
// Everything below is a thin ethers/registry adapter over the pure logic in
// ./lib/cutover-gate.ts — enumeration (G1) and coverage assertion (G2) are
// unit-tested there with mocks; this is just "how do we get real data into
// them" for an actual run.

// One comet's live feed map (base + every collateral asset), for ANY comet
// address — unlike readLiveSnapshot (config-diff proof for the single
// COMET_PROXY target), this only reads what the coverage gate needs.
async function buildCometFeedMap(cometAddress: string, signerOrProvider: any): Promise<CometFeedMap> {
  const comet = new ethers.Contract(cometAddress, COMET_READ_ABI, signerOrProvider);
  const [baseTokenPriceFeed, numAssetsRaw] = await Promise.all([comet.baseTokenPriceFeed(), comet.numAssets()]);
  const numAssets = Number(numAssetsRaw);
  const infos = await Promise.all(Array.from({ length: numAssets }, (_, i) => comet.getAssetInfo(i)));
  const feeds: CometFeedMap = { base: baseTokenPriceFeed };
  infos.forEach((info: any, i: number) => {
    feeds[`asset${i}`] = info.priceFeed;
  });
  return feeds;
}

// A book's full BookFeedAdapter clone set, derived live via
// registrationAt/adapterOf (PriceBook.sol's read surface).
async function deriveLiveAdapterSet(bookAddress: string, signerOrProvider: any): Promise<Set<string>> {
  const book = new ethers.Contract(bookAddress, PRICE_BOOK_ABI, signerOrProvider);
  return deriveAdapterSetFromReader({
    registrationCount: () => book.registrationCount(),
    registrationAt: (i: number) => book.registrationAt(i),
    adapterOf: (acct: string) => book.adapterOf(acct),
  });
}

// G1 + G2, wired to the registry + live chain. Never throws on a per-comet
// read failure — that comet is simply absent from cometFeeds, which
// assertCoverage turns into a named MISSING_COMET failure in the report
// (loud, but doesn't hide every OTHER comet's status in the same run).
// Throws only on setup problems (missing env, missing registry entry) or on
// resolveCachedComets's own fail-loud conditions (stale map, empty set).
async function runVerify(signerOrProvider: any): Promise<CoverageResult> {
  if (!NEW_BOOK) throw new Error('MODE=verify requires NEW_BOOK (the redeployed PriceBook address) — not set.');
  if (!OLD_BOOK) throw new Error('MODE=verify requires OLD_BOOK (the PriceBook being retired) — not set.');
  if (!REGISTRY_ROOT) {
    throw new Error(
      'MODE=verify requires REGISTRY_ROOT (path to a rome-protocol/registry checkout), e.g. ' +
      'REGISTRY_ROOT=/path/to/registry-checkout — not set.',
    );
  }

  console.log(`\n--- Coverage verify: enumerating cache-fed comets (registry chainId=${CHAIN_ID}, root=${REGISTRY_ROOT}) ---`);
  const client = new RegistryClient({ registryRoot: REGISTRY_ROOT });
  const manifest = client.getCompoundDeployment(CHAIN_ID);
  if (!manifest) throw new Error(`no apps/compound entry for chainId=${CHAIN_ID} under ${REGISTRY_ROOT}`);

  const { comets, excluded, warnings } = resolveCachedComets(manifest);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  console.log(`✓ enumerated ${comets.length} cache-fed comet(s):`);
  for (const c of comets) console.log(`    ${c.label} (${c.address}) [${c.source}]`);
  if (excluded.length > 0) {
    console.log(`  excluded (raw/non-cached lane, never gated):`);
    for (const c of excluded) console.log(`    ${c.label} (${c.address}) [${c.source}]`);
  }

  const cometFeeds = new Map<string, CometFeedMap>();
  for (const c of comets) {
    try {
      cometFeeds.set(c.address.toLowerCase(), await buildCometFeedMap(c.address, signerOrProvider));
    } catch (e: any) {
      console.error(`✗ could not read comet ${c.label} (${c.address}) on-chain: ${e?.message ?? e}`);
    }
  }

  const [newBookAdapters, oldBookAdapters] = await Promise.all([
    deriveLiveAdapterSet(NEW_BOOK, signerOrProvider),
    deriveLiveAdapterSet(OLD_BOOK, signerOrProvider),
  ]);
  console.log(`✓ NEW_BOOK ${NEW_BOOK}: ${newBookAdapters.size} registered adapter(s).`);
  console.log(`✓ OLD_BOOK ${OLD_BOOK}: ${oldBookAdapters.size} registered adapter(s).`);

  const result = assertCoverage({
    enumeratedComets: comets.map((c) => c.address),
    cometFeeds,
    newBookAdapters,
    oldBookAdapters,
  });
  console.log('\n' + formatCoverageReport(result));
  return result;
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

  // Each post feed must be exactly newFor(the SAME asset's pre-image old feed).
  if (!sameAddr(after.baseTokenPriceFeed, newFor(live.baseTokenPriceFeed))) {
    throw new Error(`post-verify: baseTokenPriceFeed=${after.baseTokenPriceFeed}, expected new=${newFor(live.baseTokenPriceFeed)}`);
  }
  after.assets.forEach((a, i) => {
    const expected = newFor(live.assets[i].priceFeed);
    if (!sameAddr(a.priceFeed, expected)) {
      throw new Error(`post-verify: assets[${i}].priceFeed=${a.priceFeed}, expected new=${expected}`);
    }
  });
  console.log(`✓ all ${after.numAssets + 1} feeds now point at the new BookFeedAdapters.`);

  const liveDiffs = deepDiff(stripTotals(live), stripTotals(after));
  printDiff(liveDiffs, 'Pre- vs. post-upgrade on-chain diff');
  assertOnlyExpectedDiffer(liveDiffs, liveDiffPaths(after.numAssets), 'post-cutover config identity');

  await assertGetPriceSane(comet, [after.baseTokenPriceFeed, ...after.assets.map((a) => a.priceFeed)]);

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
    feeds: [
      { label: 'base', old: live.baseTokenPriceFeed, new: after.baseTokenPriceFeed },
      ...live.assets.map((a, i) => ({ label: `asset${i}`, old: a.priceFeed, new: after.assets[i].priceFeed })),
    ],
    cutoverAt: new Date().toISOString(),
  };
  const stateFile = path.join('scripts', 'hadrian-cached-test', 'state-book-cutover.json');
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');

  console.log('\n--- Post-cutover coverage verify (auto) ---');
  const verifyResult = await runVerify(signer);
  const targetRows = verifyResult.rows.filter((r) => sameAddr(r.comet, COMET_PROXY));
  if (targetRows.length === 0) {
    // Without this check, an un-enumerated target makes targetBad below
    // VACUOUSLY empty (filtering zero rows), so the script would fall
    // through and could print "✓ full coverage" having never actually
    // looked at COMET_PROXY at all — coverage silently unverified for the
    // one comet this run just touched.
    throw new Error(
      `post-cutover verify: this run's target (${COMET_PROXY}) was not enumerated by the coverage gate at all — ` +
      `the registry manifest doesn't surface it as a known cache-fed comet, so coverage CANNOT be confirmed. ` +
      `Add it to KNOWN_HADRIAN_COMETS (or fix the manifest) before trusting this cutover.`,
    );
  }
  const targetBad = targetRows.filter((r) => r.status !== 'OK');
  if (targetBad.length > 0) {
    throw new Error(
      `post-cutover verify: THIS run's own target (${COMET_PROXY}) is not fully on NEW_BOOK — ` +
      `${targetBad.length} asset(s) failed (see table above). The upgrade tx landed but coverage doesn't confirm it.`,
    );
  }
  if (!verifyResult.pass) {
    console.warn(
      `\n⚠ ${COMET_PROXY} is fully cut over, but OTHER enumerated cache-fed comets are not yet on NEW_BOOK ` +
      `(see FAIL rows above) — cut those over before retiring OLD_BOOK.`,
    );
  } else {
    console.log('\n✓ full coverage: every enumerated cache-fed comet is on NEW_BOOK.');
  }

  console.log('\nCUTOVER COMPLETE.');
  console.log(`  new impl: ${impl.address}`);
  console.log(`  state:    ${stateFile}`);
  console.log(`  restore with: MODE=restore ... (-> impl ${ORIGINAL_IMPL})`);
}

async function main(): Promise<void> {
  const mode = process.argv.includes('--verify') ? 'verify' : (process.env.MODE || 'dry');
  if (mode !== 'dry' && mode !== 'cutover' && mode !== 'restore' && mode !== 'verify') {
    throw new Error(`MODE must be one of dry|cutover|restore|verify, got '${mode}'`);
  }
  // Fail fast BEFORE any mutation: a cutover missing NEW_BOOK/REGISTRY_ROOT
  // would otherwise skip the pre-deploy adapterOf wrong-book check and only
  // surface the misconfig in the post-upgrade verify, AFTER deploy+upgrade.
  requireCutoverEnv({ mode, newBook: NEW_BOOK, registryRoot: REGISTRY_ROOT });

  const [signer] = await ethers.getSigners();
  console.log(`Mode: ${mode}`);
  console.log(`Signer: ${signer.address}`);

  if (mode === 'verify') {
    const result = await runVerify(signer);
    if (!result.pass) {
      throw new Error(`coverage verify FAILED — ${result.failures.length} asset(s) not on NEW_BOOK (see table above).`);
    }
    console.log('\nCOVERAGE VERIFIED — every enumerated cache-fed comet is fully on NEW_BOOK.');
    return;
  }

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
  console.log(`✓ numAssets = ${live.numAssets} (count-stability is enforced by the pre/post live diff below, not a hardcoded expectation).`);
  assertOldFeedsMatch(live);

  // Book->book source-account parity (pre-deploy): every live feed we're about
  // to swap must map old->new BookFeedAdapters that wrap the SAME on-chain
  // source account. Catches a transposed FEED_SWAPS row BEFORE the 200M-gas
  // impl deploy — printPriceSanity only WARNS on >1% and the coverage gate is
  // set-membership, both blind to which source a new adapter actually tracks.
  const livePairs = [live.baseTokenPriceFeed, ...live.assets.map((a) => a.priceFeed)].map((oldFeed) => {
    const swap = OLD_TO_NEW.get(oldFeed.toLowerCase());
    if (!swap) throw new Error(`live feed ${oldFeed} absent from OLD_TO_NEW — assertOldFeedsMatch should have caught this; main() ordering regressed`);
    return swap;
  });
  const readSourceAccount = (adapter: string): Promise<string> =>
    new ethers.Contract(adapter, BOOK_FEED_ADAPTER_ABI, signer).sourceAccount();
  const newBookAdapterOf = NEW_BOOK
    ? (src: string): Promise<string> => new ethers.Contract(NEW_BOOK, PRICE_BOOK_ABI, signer).adapterOf(src)
    : undefined;
  await assertSourceAccountParity(livePairs, readSourceAccount, newBookAdapterOf);
  console.log(
    `✓ source-account parity: all ${livePairs.length} old->new adapter pair(s) wrap the same source` +
    (newBookAdapterOf ? ', each new adapter NEW_BOOK-registered.' : ' (NEW_BOOK adapterOf check skipped — NEW_BOOK unset).'),
  );

  // Both projections come from the SAME live read; oldProjected re-uses the
  // live feeds verbatim (identity), newConfig maps each via newFor — so the
  // diff between them is EXACTLY the feeds, by construction, for any subset.
  const oldProjected = toConfiguration(live, live.baseTokenPriceFeed, (i) => live.assets[i].priceFeed);
  const newConfig = toConfiguration(live, newFor(live.baseTokenPriceFeed), (i) => newFor(live.assets[i].priceFeed));

  const diffs = deepDiff(oldProjected, newConfig);
  printDiff(diffs, 'Config diff (old feeds -> new BookFeedAdapters)');
  assertOnlyExpectedDiffer(diffs, configDiffPaths(live.numAssets), 'dry-run config diff');

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
