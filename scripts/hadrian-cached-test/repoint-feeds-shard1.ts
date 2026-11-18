// Repoint the Hadrian comet (proxy 0x642fF1b5...) from the Pyth shard-0 PriceBook adapters to the shard-1 adapters
// (shard 0 went stale on 2026-11-17). Five feeds change: base USDC, wETH, wSOL, wBTC, wJitoSOL. The mSOL, JUP and BONK
// slots keep their current (soon paused) adapters: no shard-1 source exists and nobody holds them. Nothing else changes.
// Same pattern as repoint-feeds-3600s.ts (2026-10-18): the comet has no Configurator, so a feed change = a new Comet impl
// whose config is the live config with only those feed fields swapped, then ProxyAdmin.upgrade (owner only).
//
// The shard-1 JitoSOL adapter does not exist until registerFeed(JitoSOL shard-1 account) has run on the PriceBook, so its
// address is read at run time with book.adapterOf(JITOSOL_SOURCE); the script stops if it is not registered yet.
//
// Rollback = ProxyAdmin.upgrade(proxy, ROLLBACK_IMPL) with ROLLBACK_IMPL = the impl live before this move (read from the
// proxy at run time and asserted equal to the recorded address below): MODE=restore.
//
// Modes (all read-only except deploy, upgrade, restore):
//   MODE=dry      live read-only report: config diff (only the 5 feeds), new-adapter checks, positions. No deploy simulation
//                 (an eth_call of a creation is not a simulation on Rome); use MODE=fork for that.
//   MODE=fork     FORK_RPC=http://127.0.0.1:8545 (anvil --fork-url <hadrian rpc>): impersonates the ProxyAdmin owner, deploys the
//                 impl, checks its bytecode against the live impl, upgrades, runs the full verify, then rolls back and checks.
//   MODE=deploy   LIVE: deploys the new impl only (owner key), checks its bytecode, records it in the state file.
//   MODE=upgrade  LIVE: ProxyAdmin.upgrade to the impl in the state file (or NEW_IMPL), then the full verify, state file written.
//   MODE=verify   LIVE read-only: the post-upgrade verify (prices == book answers, positions intact).
//   MODE=restore  LIVE: ProxyAdmin.upgrade back to ROLLBACK_IMPL.
// Run: ETH_PK=... (live modes only; the owner key, never printed) ETHERSCAN_KEY=stub SNOWTRACE_KEY=stub MAINNET_QUICKNODE_LINK=stub \
//   UNICHAIN_QUICKNODE_LINK=stub LINEA_QUICKNODE_LINK=stub MODE=dry npx hardhat run scripts/hadrian-cached-test/repoint-feeds-shard1.ts --network hadrian

import { ethers } from 'hardhat';
import * as fs from 'fs';
import * as path from 'path';

const COMET_PROXY = '0x642fF1b5983FcDB9eA565B9FF56ac41c0c36d218';
const PROXY_ADMIN = '0xaC1ED2Ac07D764f9Bd52FcF8D52610E7970F5eE7';
const ROLLBACK_IMPL = '0x42D889e2035340EE99f617a55294C6563850c875'; // live since the 2026-10-18 3600 s repoint (#61); rollback target
const EXPECTED_OWNER = '0x1f4946Be340F06c46A50E65084790968aBcc48F6';
const BOOK = '0xaC3d80043ead56fcf94Db4574a69eE0975F7A63F';
const STATE_FILE = path.join('scripts', 'hadrian-cached-test', 'state-comet-feeds-shard1.json');
const SECONDS_PER_YEAR = 31_536_000;
const MAX_STALENESS = 3600;

// Live feed order of the comet: base, then asset offsets 0..6. `old` is asserted against the live read, `next` against the book.
// `src` = the shard-1 Pyth push account (bytes32) whose PriceBook adapter `next` is; next === null -> read adapterOf(src) at run time.
const FEEDS: { label: string, pair: string, old: string, next: string | null, src: string | null }[] = [
  { label: 'base', pair: 'USDC/USD', old: '0x889c1d9f2dD8f5FcE75E260E884A2919e16dbBd5', next: '0x31Dd9ac299F61338A3df20D8e280a82d7315FDde', src: '0x76f3408cca63f4229070c2ed89157f14574b82e2d2bca8ce0474fcd02cffb235' },
  { label: 'wETH', pair: 'ETH/USD', old: '0xe765b1aa15046ff217Bd2e8824986F46037bB36f', next: '0x154042874D9f91fb337a3eDa816ae0DB05F47027', src: '0x32f4a70d35806b1cffeae9df942477c7c298ba1a79087b4ce322e40ce3564492' },
  { label: 'wSOL', pair: 'SOL/USD', old: '0x173fe9b24c667827Da8Dd8B8e5aD23fd0e76f8bd', next: '0x4f0F022cC3813D1FCB24Acc4E8A2E17bB71f6329', src: '0x016eeafecd8385b4b39e8425c537a4e0fb52ba958f2739e93b4d551a78e67f95' },
  { label: 'wBTC', pair: 'BTC/USD', old: '0xD656B135327a5c4A835818340e8b0B51880DDC77', next: '0x7f05e2e2Bb4C4cA046368a0B929176682D14a06A', src: '0xa97b1dde101d6b497e3f3ca77b314169d8cbcb258ae3e75c602252a7a4e103fa' },
  { label: 'wJitoSOL', pair: 'JITOSOL/USD', old: '0xDde3A7d1EB7828F7183f8fA1D3B1FcF89757606F', next: null, src: '0x789cebbee9d8e7b42d44f6ac33be9bb3e86180900a45dc6550e502422c26d2b7' },
  // unchanged slots (asserted live, never swapped): mSOL, JUP, BONK
  { label: 'wmSOL', pair: 'MSOL/USD', old: '0x1016dDc9A4DeC29A4C1F639B4F9e7F2E09Af7143', next: '0x1016dDc9A4DeC29A4C1F639B4F9e7F2E09Af7143', src: null },
  { label: 'wJUP', pair: 'JUP/USD', old: '0xe0113dc3Da2452d99Ffe1187018F62644a538D37', next: '0xe0113dc3Da2452d99Ffe1187018F62644a538D37', src: null },
  { label: 'wBONK', pair: 'BONK/USD', old: '0x1ec7e20d8fde7f2a085c57DDC09Df4A82eB5e4BF', next: '0x1ec7e20d8fde7f2a085c57DDC09Df4A82eB5e4BF', src: null },
];
const CHANGED = 5; // FEEDS[0..4]

// Live positions to prove intact (found from the comet's events 2026-11-18): 10 wBTC + base supply; 1 SOL + base supply; 1 SOL + 40 USDC borrow.
const POSITIONS = [
  { label: 'wBTC collateral holder', who: '0x857534c27f4c0e8394921ad3b5b73cb4d7963633' },
  { label: 'wSOL collateral holder', who: '0x3403e0de09bc76ca7d74762f264e4f6b649a0562' },
  { label: 'wSOL collateral + 40 USDC borrow', who: '0x54195950d09f92218d8c88f3965a2a44c71f0989' },
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
  'function getPrice(address) view returns (uint256)',
  'function userBasic(address) view returns (int104 principal,uint64 baseTrackingIndex,uint64 baseTrackingAccrued,uint16 assetsIn,uint8 _reserved)',
  'function collateralBalanceOf(address,address) view returns (uint128)',
  'function borrowBalanceOf(address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function isBorrowCollateralized(address) view returns (bool)',
  'function isLiquidatable(address) view returns (bool)',
  ...ADDR_FIELDS.map((f) => `function ${f}() view returns (address)`),
  ...UINT_FIELDS.map((f) => `function ${f}() view returns (uint256)`),
];
const PA_ABI = [
  'function upgrade(address proxy, address implementation) external',
  'function getProxyImplementation(address proxy) view returns (address)',
  'function owner() view returns (address)',
];
const FEED_ABI = ['function decimals() view returns (uint8)', 'function description() view returns (string)', 'function sourceAccount() view returns (bytes32)', 'function book() view returns (address)'];
const BOOK_ABI = [
  'function adapterOf(bytes32) view returns (address)',
  'function accountOfAdapter(address) view returns (bytes32)',
  'function isPaused(address) view returns (bool)',
  'function entryOf(bytes32) view returns (int256 answer, uint64 publishTime, uint64 cachedAt, uint8 status)',
];

// totalSupply() and totalBorrow() accrue interest with the block time: not part of a drift comparison (the stored totalSupplyBase/totalBorrowBase are)
const ACCRUING = ['totalSupply', 'totalBorrow'];
const stable = (s: any) => JSON.stringify({ ...s, totalSupply: undefined, totalBorrow: undefined });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const dec = (scale: any) => String(scale.toString()).length - 1; // scale = 10**decimals
const usd = (v: any) => `$${(Number(v.toString()) / 1e8).toFixed(4)}`;
const errText = (e: any) => String(e?.reason ?? e?.error?.message ?? e?.message ?? e).replace(/\s+/g, ' ').slice(0, 200);

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

async function positionsSnapshot(comet: any, assets: string[]) {
  const out: Record<string, any> = {};
  for (const p of POSITIONS) {
    const ub = await comet.userBasic(p.who);
    const coll: Record<string, string> = {};
    for (const a of assets) coll[a] = (await comet.collateralBalanceOf(p.who, a)).toString();
    out[p.who] = { principal: ub.principal.toString(), assetsIn: Number(ub.assetsIn), coll, borrowBalanceOf: (await comet.borrowBalanceOf(p.who)).toString(), balanceOf: (await comet.balanceOf(p.who)).toString() };
  }
  return out;
}

/** Resolve the new feed list: the four known adapters are asserted against adapterOf(src), JitoSOL is read; every changed adapter is checked live. */
async function resolveFeeds(provider: any, book: any, now: number, stubs: Record<string, string> = {}) {
  const feeds = FEEDS.map((f) => ({ ...f }));
  for (let i = 0; i < CHANGED; i++) {
    const f = feeds[i];
    const got: string = await book.adapterOf(f.src);
    if (got === ethers.constants.AddressZero && stubs[f.label]) { // MODE=fork only: registerFeed needs the Solana precompiles an anvil fork lacks
      f.next = stubs[f.label]; (f as any).stub = true;
      console.log(`  ${f.label.padEnd(8)} ${f.pair.padEnd(12)} ${f.old} -> ${f.next}  (FORK STAND-IN: the shard-1 feed is not registered yet)`);
      continue;
    }
    if (got === ethers.constants.AddressZero) throw new Error(`${f.label}: no adapter registered for source ${f.src} (register the shard-1 feed first)`);
    if (f.next && !same(got, f.next)) throw new Error(`${f.label}: adapterOf(src) ${got} != expected ${f.next}`);
    f.next = got;
    if (!same(await book.accountOfAdapter(got), f.src!)) throw new Error(`${f.label}: accountOfAdapter(${got}) != source`);
    const c = new ethers.Contract(got, FEED_ABI, provider);
    const [d, desc, src, bk] = [Number(await c.decimals()), await c.description(), await c.sourceAccount(), await c.book()];
    if (d !== 8 || desc !== f.pair || src !== f.src || !same(bk, BOOK)) throw new Error(`${f.label}: adapter ${got} is ${desc}/${d} dec src ${src} book ${bk}, expected ${f.pair}/8 src ${f.src} book ${BOOK}`);
    if (await book.isPaused(got)) throw new Error(`${f.label}: adapter ${got} is paused`);
    const e = await book.entryOf(f.src);
    const age = now - Number(e.publishTime);
    if (Number(e.status) !== 1 || e.answer.lte(0) || age < 0 || age > MAX_STALENESS) throw new Error(`${f.label}: book entry status ${e.status} answer ${e.answer} age ${age}s (needs status 1, answer > 0, age <= ${MAX_STALENESS})`);
    console.log(`  ${f.label.padEnd(8)} ${f.pair.padEnd(12)} ${f.old} -> ${got}  (book answer ${usd(e.answer)}, age ${age}s)`);
  }
  for (let i = CHANGED; i < feeds.length; i++) console.log(`  ${feeds[i].label.padEnd(8)} ${feeds[i].pair.padEnd(12)} ${feeds[i].old} (unchanged)`);
  return feeds as { label: string, pair: string, old: string, next: string, src: string | null }[];
}

function buildConfig(before: any, feeds: { old: string, next: string }[]) {
  const nextOf = (old: string) => feeds.find((f) => same(f.old, old))!.next;
  const perYear = (k: string) => ethers.BigNumber.from(before[k]).mul(SECONDS_PER_YEAR);
  return {
    governor: before.governor, pauseGuardian: before.pauseGuardian, baseToken: before.baseToken,
    baseTokenPriceFeed: nextOf(before.baseTokenPriceFeed), extensionDelegate: before.extensionDelegate,
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
      asset: a.asset, priceFeed: nextOf(a.priceFeed), decimals: dec(a.scale),
      borrowCollateralFactor: a.bcf, liquidateCollateralFactor: a.lcf, liquidationFactor: a.lf, supplyCap: a.cap,
    })),
  };
}

/** The config diff the new impl will have against the live comet, field by field. Returns the changed field names; only the 5 feeds may differ. */
function configDiff(before: any, config: any, feeds: { old: string, next: string }[]) {
  const changed: string[] = [];
  const row = (name: string, a: string, b: string) => { const d = a.toLowerCase() !== b.toLowerCase(); if (d) changed.push(name); console.log(`  ${d ? 'CHANGED' : 'same   '} ${name.padEnd(42)} ${d ? `${a} -> ${b}` : a}`); };
  for (const f of ADDR_FIELDS) row(f, before[f], config[f]);
  for (const f of ['supplyKink', 'borrowKink', 'storeFrontPriceFactor', 'trackingIndexScale', 'baseTrackingSupplySpeed', 'baseTrackingBorrowSpeed', 'baseMinForRewards', 'baseBorrowMin', 'targetReserves']) row(f, String(before[f]), String(config[f]));
  for (const f of ['supplyPerSecondInterestRateSlopeLow', 'supplyPerSecondInterestRateSlopeHigh', 'supplyPerSecondInterestRateBase', 'borrowPerSecondInterestRateSlopeLow', 'borrowPerSecondInterestRateSlopeHigh', 'borrowPerSecondInterestRateBase']) {
    const yearly = f.replace('PerSecond', 'PerYear');
    row(yearly, ethers.BigNumber.from(before[f]).mul(SECONDS_PER_YEAR).toString(), String(config[yearly]));
  }
  before.assets.forEach((a: any, i: number) => {
    const c = config.assetConfigs[i];
    const nm = `asset[${i}] ${a.asset}`;
    row(`${nm} priceFeed`, a.priceFeed, c.priceFeed);
    row(`${nm} decimals`, String(dec(a.scale)), String(c.decimals));
    row(`${nm} bcf`, a.bcf, String(c.borrowCollateralFactor));
    row(`${nm} lcf`, a.lcf, String(c.liquidateCollateralFactor));
    row(`${nm} lf`, a.lf, String(c.liquidationFactor));
    row(`${nm} supplyCap`, a.cap, String(c.supplyCap));
  });
  const allowed = new Set<string>(['baseTokenPriceFeed', ...before.assets.map((a: any, i: number) => `asset[${i}] ${a.asset} priceFeed`)]);
  const unexpected = changed.filter((c) => !allowed.has(c));
  const expectedChanged = feeds.filter((f) => !same(f.old, f.next)).length;
  console.log(`config diff: ${changed.length} fields changed (expected exactly ${expectedChanged}, all price feeds)`);
  if (unexpected.length || changed.length !== expectedChanged) throw new Error(`config diff is not only the feed swaps: ${unexpected.join('; ') || `${changed.length} changed`}`);
}

/** The runtime code of the new impl must equal the live impl's code with each swapped feed address replaced by its new address (immutables only). */
async function codeCheck(provider: any, oldImpl: string, newImpl: string, feeds: { old: string, next: string }[]) {
  const oldHex = (await provider.getCode(oldImpl)).toLowerCase();
  const newHex = (await provider.getCode(newImpl)).toLowerCase();
  let expect = oldHex;
  const swaps = feeds.filter((f) => !same(f.old, f.next));
  for (const f of swaps) expect = expect.split(f.old.slice(2).toLowerCase()).join('PLACEHOLDER' + f.next.slice(2).toLowerCase());
  expect = expect.split('PLACEHOLDER').join('');
  const ok = expect === newHex;
  console.log(`bytecode: live impl ${(oldHex.length - 2) / 2} bytes, new impl ${(newHex.length - 2) / 2} bytes; new == live with the ${swaps.length} feed addresses swapped: ${ok ? 'YES (byte-identical otherwise)' : 'NO'}`);
  if (!ok) {
    let n = 0; const m = Math.min(oldHex.length, newHex.length);
    for (let i = 2; i < m; i++) if (oldHex[i] !== newHex[i]) n++;
    console.log(`  differing hex chars: ${n} (a different compile of the same source also shows here)`);
  }
  return ok;
}

/** The post-upgrade proof: prices == book answers, no config drift, positions intact. */
async function verifyAfter(provider: any, comet: any, book: any, feeds: any[], before: any, posBefore: any) {
  const bad: string[] = [];
  const after = await snapshot(comet);
  // 1. no drift but the feeds
  for (const k of Object.keys(before).filter((k) => !['baseTokenPriceFeed', 'assets', 'totalsCollateral', ...ACCRUING].includes(k))) {
    if (String(before[k]).toLowerCase() !== String(after[k]).toLowerCase()) bad.push(`config field ${k}: ${before[k]} -> ${after[k]}`);
  }
  if (JSON.stringify(before.totalsCollateral) !== JSON.stringify(after.totalsCollateral)) bad.push('totalsCollateral changed');
  if (!same(after.baseTokenPriceFeed, feeds[0].next)) bad.push(`base feed ${after.baseTokenPriceFeed}`);
  before.assets.forEach((a: any, i: number) => {
    const exp = JSON.stringify({ ...a, priceFeed: feeds[i + 1].next }).toLowerCase();
    if (exp !== JSON.stringify(after.assets[i]).toLowerCase()) bad.push(`asset ${i} changed beyond its feed: ${JSON.stringify(after.assets[i])}`);
  });
  console.log(`config: only the feeds differ: ${bad.length ? 'NO' : 'yes'}; totalSupply ${after.totalSupply}, totalBorrow ${after.totalBorrow}`);

  // 2. getPrice == the book answer: base and every asset with a non-zero total supply (the other slots are informational)
  const slots = [{ label: 'base', feed: after.baseTokenPriceFeed, supply: '1', src: feeds[0].src }, ...after.assets.map((a: any, i: number) => ({ label: feeds[i + 1].label, feed: a.priceFeed, supply: after.totalsCollateral[a.asset], src: feeds[i + 1].src, stub: (feeds[i + 1] as any).stub }))];
  for (const s of slots) {
    const held = s.supply !== '0';
    if (!s.src || s.stub) { // mSOL / JUP / BONK (no shard-1 source) or a fork stand-in: informational
      let t = ''; try { t = usd(await comet.getPrice(s.feed)); } catch (e) { t = `reverts (${errText(e)})`; }
      console.log(`  info ${s.label.padEnd(8)} getPrice ${t}  total supply ${s.supply}${held ? '  HELD, would break borrowers' : ''}`);
      if (held) bad.push(`${s.label} is held but has no shard-1 feed`);
      continue;
    }
    let price: any, answer: any, ok = false;
    try {
      for (let t = 0; t < 2 && !ok; t++) { // one retry: the book entry may refresh between the two reads
        price = await comet.getPrice(s.feed); answer = (await book.entryOf(s.src)).answer; ok = price.eq(answer);
      }
    } catch (e) { console.log(`  FAIL ${s.label.padEnd(8)} getPrice reverts (${errText(e)})`); bad.push(`${s.label} getPrice reverts`); continue; }
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${s.label.padEnd(8)} getPrice ${usd(price)} book ${usd(answer)} total supply ${s.supply}${held ? '' : ' (not held)'}`);
    if (!ok) bad.push(`${s.label} getPrice != book answer`);
  }

  // 3. the live positions
  const assets = after.assets.map((a: any) => a.asset);
  const posAfter = await positionsSnapshot(comet, assets);
  for (const p of POSITIONS) {
    const b = posBefore[p.who], a = posAfter[p.who];
    let coll = false, liq = true;
    try { coll = await comet.isBorrowCollateralized(p.who); liq = await comet.isLiquidatable(p.who); } catch (e) { bad.push(`${p.label}: isBorrowCollateralized/isLiquidatable reverts (${errText(e)})`); }
    const same_ = b.principal === a.principal && b.assetsIn === a.assetsIn && JSON.stringify(b.coll) === JSON.stringify(a.coll);
    console.log(`  ${coll && !liq && same_ ? 'ok  ' : 'FAIL'} ${p.who} ${p.label}: principal ${a.principal} (was ${b.principal}), assetsIn ${a.assetsIn}, collateral ${JSON.stringify(Object.fromEntries(Object.entries(a.coll).filter(([, v]) => v !== '0')))}, borrowBalanceOf ${a.borrowBalanceOf}, isBorrowCollateralized ${coll}, isLiquidatable ${liq}`);
    if (!same_) bad.push(`${p.label}: principal/collateral changed`);
    if (!coll) bad.push(`${p.label}: not borrow-collateralized`);
    if (liq) bad.push(`${p.label}: liquidatable`);
  }
  console.log(bad.length ? `VERIFY PROBLEMS:\n  ${bad.join('\n  ')}` : 'VERIFY: all ok');
  return { ok: bad.length === 0, bad, after, posAfter };
}

async function main() {
  const mode = process.env.MODE || 'dry';
  if (!['dry', 'fork', 'deploy', 'upgrade', 'verify', 'restore'].includes(mode)) throw new Error(`MODE must be dry|fork|deploy|upgrade|verify|restore, got ${mode}`);
  const live = ['deploy', 'upgrade', 'restore'].includes(mode);

  let provider: any = ethers.provider, signer: any;
  if (mode === 'fork') {
    const url = process.env.FORK_RPC;
    if (!url) throw new Error('MODE=fork needs FORK_RPC (an anvil --fork-url of the Hadrian rpc)');
    provider = new ethers.providers.JsonRpcProvider(url);
    await provider.send('anvil_impersonateAccount', [EXPECTED_OWNER]);
    await provider.send('anvil_setBalance', [EXPECTED_OWNER, '0x' + (10n ** 24n).toString(16)]);
    signer = provider.getSigner(EXPECTED_OWNER);
  } else if (live) {
    [signer] = await ethers.getSigners();
  }
  const net = await provider.getNetwork();
  if (net.chainId !== 200010) throw new Error(`connected to chain ${net.chainId}, want 200010`);
  const gasPrice = (await provider.getGasPrice()).mul(2);
  const tx = { type: 0, gasPrice, gasLimit: 30_000_000 };
  console.log(`Mode ${mode}; chain ${net.chainId}; ${signer ? `signer ${await signer.getAddress()}` : 'read-only (no signer)'}`);

  const comet = new ethers.Contract(COMET_PROXY, COMET_ABI, provider);
  const pa = new ethers.Contract(PROXY_ADMIN, PA_ABI, signer ?? provider);
  const book = new ethers.Contract(BOOK, BOOK_ABI, provider);
  const owner = await pa.owner();
  if (!same(owner, EXPECTED_OWNER)) throw new Error(`ProxyAdmin owner ${owner} != ${EXPECTED_OWNER}`);
  const implNow = await pa.getProxyImplementation(COMET_PROXY);
  const now = (await provider.getBlock('latest')).timestamp;
  if (live && !same(owner, await signer.getAddress())) throw new Error('signer is not the ProxyAdmin owner');

  if (mode === 'restore') {
    if (same(implNow, ROLLBACK_IMPL)) { console.log(`already on ${ROLLBACK_IMPL}; nothing to do`); return; }
    const t = await pa.upgrade(COMET_PROXY, ROLLBACK_IMPL, { ...tx, gasLimit: 5_000_000 });
    await t.wait();
    const cur = await pa.getProxyImplementation(COMET_PROXY);
    if (!same(cur, ROLLBACK_IMPL)) throw new Error(`restore failed: impl ${cur}`);
    console.log(`RESTORED -> ${ROLLBACK_IMPL}  tx ${t.hash}`);
    return;
  }

  console.log(`proxy ${COMET_PROXY}\nimpl now ${implNow}  (rollback target ${ROLLBACK_IMPL})`);
  const st: any = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const upgraded = !same(implNow, ROLLBACK_IMPL);
  if (upgraded && ['dry', 'fork', 'deploy'].includes(mode)) throw new Error(`impl ${implNow} != ROLLBACK_IMPL: already upgraded? abort before any tx`);

  const stubs: Record<string, string> = {};
  if (mode === 'fork' && same(await book.adapterOf(FEEDS[4].src), ethers.constants.AddressZero)) {
    const Stub = (await ethers.getContractFactory('contracts/test/SimplePriceFeed.sol:SimplePriceFeed')).connect(signer);
    stubs[FEEDS[4].label] = (await (await Stub.deploy(9_700_000_000, 8, { ...tx, gasLimit: 5_000_000 })).deployed()).address;
  }
  console.log('new feeds:');
  const feeds = await resolveFeeds(provider, book, now, stubs);

  const before = await snapshot(comet);
  if (before.numAssets !== 7) throw new Error(`expected 7 live assets, got ${before.numAssets}`);
  const posBefore = await positionsSnapshot(comet, before.assets.map((a: any) => a.asset));

  if (!upgraded) {
    const liveFeeds = [before.baseTokenPriceFeed, ...before.assets.map((a: any) => a.priceFeed)];
    feeds.forEach((f, i) => { if (!same(liveFeeds[i], f.old)) throw new Error(`${f.label}: live feed ${liveFeeds[i]} != ${f.old} (stale map)`); });
    console.log('live feeds on the comet equal the recorded old map: yes');
    const config = buildConfig(before, feeds);
    console.log('config (new impl) against the live config:');
    configDiff(before, config, feeds);
    console.log('positions before:');
    for (const p of POSITIONS) console.log(`  ${p.who} ${p.label}: ${JSON.stringify(posBefore[p.who])}`);
    // what the comet does today (informational): which feeds revert
    for (const f of feeds.slice(0, CHANGED)) {
      let t = ''; try { t = usd(await comet.getPrice(f.old)); } catch (e) { t = `reverts (${errText(e)})`; }
      console.log(`  today old ${f.label} adapter getPrice: ${t}`);
    }
    if (mode === 'dry') { console.log('DRY RUN COMPLETE: no transactions sent. Simulate deploy + upgrade with MODE=fork on the build VM.'); return; }

    // deploy the impl (fork or live)
    if (mode === 'deploy' || mode === 'fork') {
      const Comet = (await ethers.getContractFactory('contracts/Comet.sol:Comet')).connect(signer);
      const impl = await (await Comet.deploy(config, { ...tx, gasLimit: 200_000_000 })).deployed();
      console.log(`new impl: ${impl.address}  deploy tx ${impl.deployTransaction.hash}`);
      const codeOk = await codeCheck(provider, implNow, impl.address, feeds);
      if (mode === 'deploy') {
        fs.writeFileSync(STATE_FILE, JSON.stringify({ deployedAt: new Date().toISOString(), cometProxy: COMET_PROXY, proxyAdmin: PROXY_ADMIN, rollbackImpl: ROLLBACK_IMPL, newImpl: impl.address, deployTx: impl.deployTransaction.hash, codeMatchesLiveImplWithFeedSwaps: codeOk, feeds: feeds.map((f) => ({ label: f.label, pair: f.pair, old: f.old, new: f.next })) }, null, 2) + '\n');
        if (!codeOk) throw new Error('the new impl bytecode is not the live impl with only the feeds swapped: do NOT upgrade; read the state file and investigate');
        console.log(`DEPLOYED. state: ${STATE_FILE}. Next: MODE=upgrade`);
        return;
      }
      // fork: upgrade, verify, roll back
      const up = await pa.upgrade(COMET_PROXY, impl.address, { ...tx, gasLimit: 5_000_000 });
      await up.wait();
      const cur = await pa.getProxyImplementation(COMET_PROXY);
      if (!same(cur, impl.address)) throw new Error(`post-upgrade impl ${cur} != ${impl.address}`);
      console.log(`FORK upgrade ok: impl ${cur}`);
      const v = await verifyAfter(provider, comet, book, feeds, before, posBefore);
      const rb = await pa.upgrade(COMET_PROXY, ROLLBACK_IMPL, { ...tx, gasLimit: 5_000_000 });
      await rb.wait();
      const cur2 = await pa.getProxyImplementation(COMET_PROXY);
      const snap2 = await snapshot(comet);
      const rbOk = same(cur2, ROLLBACK_IMPL) && stable(snap2) === stable(before);
      console.log(`FORK rollback: impl ${cur2}; comet snapshot equals the pre-upgrade snapshot: ${rbOk ? 'yes' : 'NO'}`);
      console.log(codeOk && v.ok && rbOk ? 'FORK SIMULATION PASSED' : 'FORK SIMULATION FAILED');
      process.exit(codeOk && v.ok && rbOk ? 0 : 1);
    }
    if (mode === 'verify') throw new Error('MODE=verify is for after the upgrade; the comet still has the old feeds');
  }

  if (mode === 'verify') {
    const v = await verifyAfter(provider, comet, book, feeds, before, posBefore);
    process.exit(v.ok ? 0 : 1);
  }

  if (mode === 'upgrade') {
    if (upgraded) throw new Error(`impl ${implNow} != ROLLBACK_IMPL: already upgraded? abort before any tx`);
    const target: string = process.env.NEW_IMPL || st.newImpl;
    if (!target) throw new Error('no new impl: run MODE=deploy first (state file) or pass NEW_IMPL');
    if (!st.codeMatchesLiveImplWithFeedSwaps && !process.env.NEW_IMPL) throw new Error('state file says the impl bytecode check failed');
    if (!(await codeCheck(provider, ROLLBACK_IMPL, target, feeds))) throw new Error('impl bytecode check failed; not upgrading');
    const up = await pa.upgrade(COMET_PROXY, target, { ...tx, gasLimit: 5_000_000 });
    await up.wait();
    const cur = await pa.getProxyImplementation(COMET_PROXY);
    if (!same(cur, target)) throw new Error(`post-upgrade impl ${cur} != ${target}`);
    console.log(`UPGRADED -> ${cur}  tx ${up.hash}`);
    const v = await verifyAfter(provider, comet, book, feeds, before, posBefore);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...st, upgradedAt: new Date().toISOString(), upgradeTx: up.hash, newImpl: target, rollback: `ProxyAdmin(${PROXY_ADMIN}).upgrade(${COMET_PROXY}, ${ROLLBACK_IMPL}) signed by ${EXPECTED_OWNER}; MODE=restore of this script`, verifyOk: v.ok, verifyProblems: v.bad, assets: v.after.assets, positions: v.posAfter }, null, 2) + '\n');
    console.log(v.ok ? `UPGRADE COMPLETE. state: ${STATE_FILE}` : 'UPGRADE DONE BUT VERIFY FAILED: consider MODE=restore');
    process.exit(v.ok ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
