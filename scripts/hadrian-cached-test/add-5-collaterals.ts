// List BTC, JitoSOL, mSOL, JUP and BONK on the NEW Hadrian comet (JTO stays out), on the
// 900 s PriceBook feeds — the same way cutover-book-feeds.ts upgraded the old market:
// the comet has no Configurator, so a new collateral = a new Comet impl whose config is the
// live config + 5 appended assets, then ProxyAdmin.upgrade. Restore = re-upgrade to the
// recorded original impl (one tx, still on-chain).
//
// Collateral parameters (borrow/liquidate factor, liquidation factor, supply cap) are read
// LIVE from the old comet SOURCE_COMET by matching each old wrapper's symbol() (the mints of
// some assets were rotated, so mint_id() no longer matches for all of them); the new comet's own config is read live from the proxy. Existing
// asset offsets 0..1 never move (collateral storage is keyed by offset), and the post-upgrade
// read must differ from the pre-upgrade read by exactly numAssets + the 5 new asset rows.
//
//   MODE=dry     ... npx hardhat run scripts/hadrian-cached-test/add-5-collaterals.ts --network hadrian
//   MODE=upgrade ETH_PK=$(jq -r .privateKey ~/rome/.secrets/hadrian/deployer.json) ... (same)
//   MODE=restore ETH_PK=... (same)
// plus the 5 stub env vars hardhat.config.ts requires (ETHERSCAN_KEY, SNOWTRACE_KEY, ...).

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const SOURCE_COMET = '0xfc322489D4089AdCC79074C8058Fd257c63622D8'; // old market, parameter source
const COMET_PROXY = '0x642fF1b5983FcDB9eA565B9FF56ac41c0c36d218';
const PROXY_ADMIN = '0xaC1ED2Ac07D764f9Bd52FcF8D52610E7970F5eE7';
const ORIGINAL_IMPL = '0x49000C546Ef26dF2BF7e6baF54363e61cB71c1fA'; // restore target
const EXPECTED_OWNER = '0x1f4946Be340F06c46A50E65084790968aBcc48F6';
const BOOK = '0xbb8961b840610934140d96f41bc0d38835774550';
const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-add-5-collaterals.json');
const SECONDS_PER_YEAR = 31_536_000;

// New wrappers (wrappers slice, reviewed) -> their 900 s BookFeedAdapter, in the order they are listed.
const NEW_ASSETS = [
  { symbol: 'wBTC', pair: 'BTC/USD', wrapper: '0x94834153eA70219D44edFE295697fF0c204Ec68c', feed: '0x6e748Ed1B228F44Efa6ef44De65ca4D8d789d856' },
  { symbol: 'wJitoSOL', pair: 'JITOSOL/USD', wrapper: '0x8874ce9D11dd54Ee0Bc8185A05F216f2E7bA1a8D', feed: '0x2372073F598319EaD87d2207B11a8138d2Ab8A23' },
  { symbol: 'wmSOL', pair: 'MSOL/USD', wrapper: '0x34b1eD3A33C522F01fACED591DEa9E0468E9614A', feed: '0xA7fc8168bfE6042E17B3135F3b148e95476Bff97' },
  { symbol: 'wJUP', pair: 'JUP/USD', wrapper: '0x0B04Ce26bce2128309956bf2aeD03ac7e8d3E3De', feed: '0x13268A433c9c0F075Ba0789524f45D192E090F34' },
  { symbol: 'wBONK', pair: 'BONK/USD', wrapper: '0xE72168524e9DE5d654BFe8473CA11a8108Cd642b', feed: '0x7E48d3ea045C61b3BF4081e42A699DA4466Af1BC' },
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
  'function getPrice(address) view returns (uint256)',
  'function totalsBasic() view returns (uint64 baseSupplyIndex,uint64 baseBorrowIndex,uint64 trackingSupplyIndex,uint64 trackingBorrowIndex,uint104 totalSupplyBase,uint104 totalBorrowBase,uint40 lastAccrualTime,uint8 pauseFlags)',
  ...ADDR_FIELDS.map((f) => `function ${f}() view returns (address)`),
  ...UINT_FIELDS.map((f) => `function ${f}() view returns (uint256)`),
];
const PA_ABI = [
  'function upgrade(address proxy, address implementation) external',
  'function getProxyImplementation(address proxy) view returns (address)',
  'function owner() view returns (address)',
];
const WRAPPER_ABI = [
  'function mint_id() view returns (bytes32)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function ensure_token_account(address) returns (bytes32)',
];
const BOOK_ABI = [
  'function registrationCount() view returns (uint256)',
  'function registrationAt(uint256) view returns (bytes32)',
  'function refreshAll(bytes32[]) returns (uint256)',
];
const FEED_ABI = ['function decimals() view returns (uint8)'];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dec = (scale: any) => String(scale.toString()).length - 1; // scale = 10**decimals

async function snapshot(comet: any) {
  const s: Record<string, any> = {};
  for (const f of [...ADDR_FIELDS, ...UINT_FIELDS]) s[f] = (await comet[f]()).toString();
  const tb = await comet.totalsBasic();
  s.totalSupplyBase = tb.totalSupplyBase.toString();
  s.totalBorrowBase = tb.totalBorrowBase.toString();
  const n = Number(await comet.numAssets());
  s.numAssets = n;
  s.assets = [];
  for (let i = 0; i < n; i++) {
    const a = await comet.getAssetInfo(i);
    s.assets.push({
      offset: Number(a.offset), asset: a.asset, priceFeed: a.priceFeed, scale: a.scale.toString(),
      bcf: a.borrowCollateralFactor.toString(), lcf: a.liquidateCollateralFactor.toString(),
      lf: a.liquidationFactor.toString(), cap: a.supplyCap.toString(),
    });
  }
  return s;
}

async function refreshBook(signer: any, tx: any): Promise<string | null> {
  const book = new ethers.Contract(BOOK, BOOK_ABI, signer);
  const accts = await Promise.all(Array.from({ length: Number(await book.registrationCount()) }, (_, i) => book.registrationAt(i)));
  const t = await book.refreshAll(accts, tx);
  await t.wait();
  return t.hash;
}

async function main() {
  const mode = process.env.MODE || 'dry';
  if (!['dry', 'upgrade', 'restore'].includes(mode)) throw new Error(`MODE must be dry|upgrade|restore, got ${mode}`);
  const [signer] = await ethers.getSigners();
  const gasPrice = (await ethers.provider.getGasPrice()).mul(2);
  const tx = { type: 0, gasPrice, gasLimit: 30_000_000 };
  console.log(`Mode ${mode}; signer ${signer.address}`);

  const comet = new ethers.Contract(COMET_PROXY, COMET_ABI, signer);
  const src = new ethers.Contract(SOURCE_COMET, COMET_ABI, ethers.provider);
  const pa = new ethers.Contract(PROXY_ADMIN, PA_ABI, signer);
  const owner = await pa.owner();
  if (!same(owner, EXPECTED_OWNER)) throw new Error(`ProxyAdmin owner ${owner} != ${EXPECTED_OWNER}`);
  const impl0 = await pa.getProxyImplementation(COMET_PROXY);

  if (mode === 'restore') {
    if (!same(owner, signer.address)) throw new Error('signer is not the ProxyAdmin owner');
    const t = await pa.upgrade(COMET_PROXY, ORIGINAL_IMPL, { ...tx, gasLimit: 5_000_000 });
    await t.wait();
    const now = await pa.getProxyImplementation(COMET_PROXY);
    if (!same(now, ORIGINAL_IMPL)) throw new Error(`restore failed: impl ${now}`);
    console.log(`RESTORED -> ${ORIGINAL_IMPL}  tx ${t.hash}  numAssets ${await comet.numAssets()}`);
    return;
  }

  if (!same(impl0, ORIGINAL_IMPL)) throw new Error(`impl ${impl0} != ORIGINAL_IMPL — already upgraded? abort before any tx`);

  // Refresh first: the 900 s book reverts StalePriceFeed on getPrice otherwise, and the
  // Comet constructor / post-checks read feeds. Dry mode only reads, so it skips the refresh.
  if (mode === 'upgrade') console.log(`book.refreshAll: ${await refreshBook(signer, tx)}`);

  const before = await snapshot(comet);
  if (before.numAssets !== 2) throw new Error(`expected 2 live assets, got ${before.numAssets}`);

  // 1. Old market's parameters per new wrapper, matched by mint.
  const srcN = Number(await src.numAssets());
  const srcInfos = await Promise.all(Array.from({ length: srcN }, (_, i) => src.getAssetInfo(i)));
  const srcSym = await Promise.all(srcInfos.map((i: any) => new ethers.Contract(i.asset, WRAPPER_ABI, ethers.provider).symbol()));
  const srcMint = await Promise.all(srcInfos.map((i: any) => new ethers.Contract(i.asset, WRAPPER_ABI, ethers.provider).mint_id()));
  const added = [] as any[];
  for (const n of NEW_ASSETS) {
    const w = new ethers.Contract(n.wrapper, WRAPPER_ABI, ethers.provider);
    const mint = await w.mint_id();
    const hits = srcSym.map((x: string, i: number) => (x === n.symbol ? i : -1)).filter((i: number) => i >= 0);
    if (hits.length !== 1) throw new Error(`${n.symbol}: expected exactly one old-market asset with that symbol, got ${hits.length}`);
    const k = hits[0];
    console.log(`  ${n.symbol}: old-market mint ${srcMint[k] === mint ? 'matches' : 'differs from'} the new wrapper's mint (matched by symbol)`);
    const info = srcInfos[k];
    const d = Number(await w.decimals());
    // The new wrapper's decimals follow its mint (wJitoSOL is 8, the old one was 9). The supply cap is in
    // raw units, so rescale it to keep the same whole-token cap; the factors are ratios and carry over.
    const od = dec(info.scale);
    const cap = d >= od ? info.supplyCap.mul(ethers.BigNumber.from(10).pow(d - od)) : info.supplyCap.div(ethers.BigNumber.from(10).pow(od - d));
    if (d !== od) console.log(`  ${n.symbol}: decimals ${od} (old) -> ${d} (new); supply cap ${info.supplyCap} -> ${cap}`);
    if (Number(await new ethers.Contract(n.feed, FEED_ABI, ethers.provider).decimals()) !== 8) throw new Error(`${n.symbol}: feed decimals != 8`);
    added.push({ ...n, decimals: d, info, cap });
    console.log(`${n.symbol} ${n.wrapper} (old ${info.asset}) feed ${n.pair} ${n.feed} bcf ${info.borrowCollateralFactor} lcf ${info.liquidateCollateralFactor} lf ${info.liquidationFactor} cap ${info.supplyCap}`);
  }

  // 2. Config: live new-comet config (per-year = per-second * SECONDS_PER_YEAR) + 5 appended assets.
  const perYear = (k: string) => ethers.BigNumber.from(before[k]).mul(SECONDS_PER_YEAR);
  const config = {
    governor: before.governor, pauseGuardian: before.pauseGuardian, baseToken: before.baseToken,
    baseTokenPriceFeed: before.baseTokenPriceFeed, extensionDelegate: before.extensionDelegate,
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
    assetConfigs: [
      ...before.assets.map((a: any) => ({
        asset: a.asset, priceFeed: a.priceFeed, decimals: dec(a.scale),
        borrowCollateralFactor: a.bcf, liquidateCollateralFactor: a.lcf, liquidationFactor: a.lf, supplyCap: a.cap,
      })),
      ...added.map((a) => ({
        asset: a.wrapper, priceFeed: a.feed, decimals: a.decimals,
        borrowCollateralFactor: a.info.borrowCollateralFactor, liquidateCollateralFactor: a.info.liquidateCollateralFactor,
        liquidationFactor: a.info.liquidationFactor, supplyCap: a.cap,
      })),
    ],
  };
  console.log(`Config: ${config.assetConfigs.length} assets (${before.numAssets} live + ${added.length} new)`);
  if (mode === 'dry') { console.log('DRY RUN COMPLETE — no transactions sent.'); return; }
  if (!same(owner, signer.address)) throw new Error('signer is not the ProxyAdmin owner');

  // 3. Deploy impl, warm the comet's ATA on each new wrapper, upgrade.
  const hashes: Record<string, string> = {};
  const Comet = await ethers.getContractFactory('contracts/Comet.sol:Comet', signer);
  const impl = await (await Comet.deploy(config, { ...tx, gasLimit: 200_000_000 })).deployed();
  hashes.deploy = impl.deployTransaction.hash;
  console.log(`new impl: ${impl.address}`);
  for (const a of added) {
    const t = await new ethers.Contract(a.wrapper, WRAPPER_ABI, signer).ensure_token_account(COMET_PROXY, tx);
    await t.wait();
    hashes[`ata:${a.symbol}`] = t.hash;
  }
  const up = await pa.upgrade(COMET_PROXY, impl.address, { ...tx, gasLimit: 5_000_000 });
  await up.wait();
  hashes.upgrade = up.hash;
  const implNow = await pa.getProxyImplementation(COMET_PROXY);
  if (!same(implNow, impl.address)) throw new Error(`post-upgrade impl ${implNow} != ${impl.address}`);

  // 4. Post-upgrade reads: old rows untouched, 5 new rows exact, principal totals identical.
  const after = await snapshot(comet);
  if (after.numAssets !== 7) throw new Error(`numAssets ${after.numAssets} != 7`);
  for (const k of [...ADDR_FIELDS, ...UINT_FIELDS.filter((f) => !f.startsWith('total')), 'totalSupplyBase', 'totalBorrowBase']) {
    if (String(before[k]).toLowerCase() !== String(after[k]).toLowerCase()) throw new Error(`config field ${k} changed: ${before[k]} -> ${after[k]}`);
  }
  before.assets.forEach((a: any, i: number) => {
    if (JSON.stringify(a) !== JSON.stringify(after.assets[i])) throw new Error(`asset ${i} changed across the upgrade`);
  });
  added.forEach((a, j) => {
    const r = after.assets[2 + j];
    const ok = r.offset === 2 + j && same(r.asset, a.wrapper) && same(r.priceFeed, a.feed) && r.scale === ethers.BigNumber.from(10).pow(a.decimals).toString()
      && r.bcf === a.info.borrowCollateralFactor.toString() && r.lcf === a.info.liquidateCollateralFactor.toString()
      && r.lf === a.info.liquidationFactor.toString() && r.cap === a.cap.toString();
    if (!ok) throw new Error(`new asset ${a.symbol} row mismatch: ${JSON.stringify(r)}`);
  });
  console.log(`totalSupply before ${before.totalSupply} after ${after.totalSupply}; totalBorrow before ${before.totalBorrow} after ${after.totalBorrow}; principal totals identical`);

  const state = {
    upgradedAt: new Date().toISOString(), network: 'hadrian', chainId: 200010,
    cometProxy: COMET_PROXY, proxyAdmin: PROXY_ADMIN, originalImpl: ORIGINAL_IMPL, newImpl: impl.address,
    rollback: { tx: `ProxyAdmin(${PROXY_ADMIN}).upgrade(${COMET_PROXY}, ${ORIGINAL_IMPL}) signed by ${EXPECTED_OWNER}; MODE=restore of this script` },
    txHashes: hashes, parameterSource: SOURCE_COMET, book: BOOK,
    before: { numAssets: before.numAssets, totalSupply: before.totalSupply, totalBorrow: before.totalBorrow, totalSupplyBase: before.totalSupplyBase, totalBorrowBase: before.totalBorrowBase },
    after: { numAssets: after.numAssets, totalSupply: after.totalSupply, totalBorrow: after.totalBorrow, totalSupplyBase: after.totalSupplyBase, totalBorrowBase: after.totalBorrowBase },
    assets: after.assets,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
  console.log(`UPGRADE COMPLETE. state: ${STATE_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
