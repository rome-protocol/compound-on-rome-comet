// Tests for the comet cutover coverage gate (lib/cutover-gate.ts).
//
// Run: npx hardhat test scripts/hadrian-cached-test/tests/cutover-gate.test.ts
//   (mocha + chai, same as scripts/registry-driven-deploy/tests/registry-client.test.ts)
//
// No live chain, no network — G1 fixtures are literal manifest objects
// (mirroring registry/apps/compound/200010-hadrian.json's real shape as of
// 2026-08-08, the manifest that motivated this gate); G2 uses mock
// comet->asset->feed maps and mock book readers.

import { expect } from 'chai';
import {
  KnownComet,
  ManifestCometsShape,
  resolveCachedComets,
  extractNotesAddressPrefixes,
  deriveAdapterSetFromReader,
  deriveAdapterSetFromDeployRecord,
  assertCoverage,
  assertSourceAccountParity,
  requireCutoverEnv,
  CometFeedMap,
} from '../lib/cutover-gate';

// Mirrors the real registry/apps/compound/200010-hadrian.json as read
// 2026-08-08: comets[] names only 'fc322489'; notes names the OTHER three
// generations by truncated prefix, including the canonical 0x771D2f21…
// comet that was NEVER added to comets[] — the exact gap this gate closes.
function hadrianManifestFixture(): ManifestCometsShape {
  return {
    comets: [
      { label: 'canonical', address: '0xfc322489D4089AdCC79074C8058Fd257c63622D8' },
    ],
    notes:
      'CANONICAL 9-asset cache-fed Comet (0x771D2f21…) — base wUSDC + 8 DISTINCT cached collats. ' +
      'Supersedes the 4-asset cache-fed comet (0xB42aeBB5…, still live). ' +
      'Supersedes the multicollat Pyth-Pull comet (0xb8Ad4fd3…, still live on-chain).',
  };
}

// The exact false-PASS reproduction from cold review: an editor trims the
// notes prose and the "(0xB42aeBB5…, still live)" sentence quietly goes with
// it. No unresolvable prefix, no ambiguity — the comet just stops being
// mentioned. Without the enumeration floor, resolveCachedComets would return
// a clean 2-comet set and G2 would never know 0xB42aeBB5 exists.
function hadrianManifestMissingB42Fixture(): ManifestCometsShape {
  return {
    comets: [
      { label: 'canonical', address: '0xfc322489D4089AdCC79074C8058Fd257c63622D8' },
    ],
    notes:
      'CANONICAL 9-asset cache-fed Comet (0x771D2f21…) — base wUSDC + 8 DISTINCT cached collats. ' +
      'Supersedes the multicollat Pyth-Pull comet (0xb8Ad4fd3…, still live on-chain).',
  };
}

const KNOWN: readonly KnownComet[] = [
  { label: 'fc322489 (structured comets[0])', address: '0xfc322489D4089AdCC79074C8058Fd257c63622D8', cacheFed: true },
  { label: 'canonical 9-asset', address: '0x771D2f213b4C23f70Fa884d441a405F41F51Ab50', cacheFed: true },
  { label: 'empty 3-asset', address: '0xB42aeBB570DB4EC6ede97e460e2D5df37C472881', cacheFed: true },
  { label: 'multicollat Pyth-Pull (raw lane)', address: '0xb8Ad4fd3776E356d1295E7539FCec02Da4629856', cacheFed: false },
];

describe('extractNotesAddressPrefixes', () => {
  it('recovers every truncated 0x…prefix mentioned in prose', () => {
    const prefixes = extractNotesAddressPrefixes(hadrianManifestFixture().notes);
    expect(prefixes).to.deep.equal(['0x771D2f21', '0xB42aeBB5', '0xb8Ad4fd3']);
  });

  it('returns an empty array for undefined/empty notes', () => {
    expect(extractNotesAddressPrefixes(undefined)).to.deep.equal([]);
    expect(extractNotesAddressPrefixes('')).to.deep.equal([]);
  });
});

describe('resolveCachedComets (G1 — enumerate ALL cache-fed comets)', () => {
  it('enumerates the structured comets[] entry', () => {
    const { comets } = resolveCachedComets(hadrianManifestFixture(), KNOWN);
    const addrs = comets.map((c) => c.address);
    expect(addrs).to.include('0xfc322489D4089AdCC79074C8058Fd257c63622D8');
  });

  it('enumerates a comet named ONLY in notes — the historical-lesson case (0x771D2f21…, never in comets[])', () => {
    const { comets } = resolveCachedComets(hadrianManifestFixture(), KNOWN);
    const addrs = comets.map((c) => c.address);
    expect(addrs).to.include('0x771D2f213b4C23f70Fa884d441a405F41F51Ab50');
    const canonical = comets.find((c) => c.address === '0x771D2f213b4C23f70Fa884d441a405F41F51Ab50');
    expect(canonical?.source).to.equal('notes');
  });

  it('enumerates the full expected cache-fed set (fc322489 + canonical 771D2f21 + empty B42aeBB5), nothing more', () => {
    const { comets } = resolveCachedComets(hadrianManifestFixture(), KNOWN);
    const addrs = comets.map((c) => c.address.toLowerCase()).sort();
    expect(addrs).to.deep.equal(
      [
        '0xfc322489D4089AdCC79074C8058Fd257c63622D8',
        '0x771D2f213b4C23f70Fa884d441a405F41F51Ab50',
        '0xB42aeBB570DB4EC6ede97e460e2D5df37C472881',
      ].map((a) => a.toLowerCase()).sort(),
    );
  });

  it('excludes the multicollat Pyth-Pull comet (0xb8Ad4fd3…, raw lane) from the cache-fed set', () => {
    const { comets, excluded } = resolveCachedComets(hadrianManifestFixture(), KNOWN);
    expect(comets.map((c) => c.address)).to.not.include('0xb8Ad4fd3776E356d1295E7539FCec02Da4629856');
    expect(excluded.map((c) => c.address)).to.include('0xb8Ad4fd3776E356d1295E7539FCec02Da4629856');
  });

  it('throws when notes name a comet prefix absent from the known-comet map (stale map — the actual incident this gate re-creates)', () => {
    const manifest: ManifestCometsShape = {
      comets: [],
      notes: 'Supersedes the earlier comet (0xDEADBEEF…, still live).',
    };
    expect(() => resolveCachedComets(manifest, KNOWN)).to.throw(/not in the known-comet map/);
  });

  it('throws when a notes prefix is ambiguous (matches more than one known comet)', () => {
    const ambiguous: readonly KnownComet[] = [
      { label: 'a', address: '0x1111111111111111111111111111111111111a', cacheFed: true },
      { label: 'b', address: '0x1111111111111111111111111111111111111b', cacheFed: true },
    ];
    const manifest: ManifestCometsShape = { comets: [], notes: 'See comet (0x11111111…).' };
    expect(() => resolveCachedComets(manifest, ambiguous)).to.throw(/ambiguous/);
  });

  it('throws when the enumerated cache-fed set is EMPTY (degenerate: knownComets has no cache-fed entries and the manifest surfaces nothing)', () => {
    const manifest: ManifestCometsShape = { comets: [], notes: undefined };
    const noCacheFedKnown: readonly KnownComet[] = [
      { label: 'raw-only', address: '0xRaw00000000000000000000000000000000000a', cacheFed: false },
    ];
    expect(() => resolveCachedComets(manifest, noCacheFedKnown)).to.throw(/EMPTY/);
  });

  it('still includes a structured comets[] address unknown to the map (never drop a resolvable address), flagged via warnings', () => {
    // The floor (every known cache-fed comet is surfaced) is satisfied by
    // hadrianManifestFixture()'s own comets[0]+notes; this test only adds an
    // EXTRA unrecognized structured entry on top, isolating the "never drop
    // a resolvable address" property from the floor check below.
    const base = hadrianManifestFixture();
    const manifest: ManifestCometsShape = {
      comets: [...base.comets, { label: 'brand-new', address: '0x9999999999999999999999999999999999999a' }],
      notes: base.notes,
    };
    const { comets, warnings } = resolveCachedComets(manifest, KNOWN);
    expect(comets.map((c) => c.address)).to.include('0x9999999999999999999999999999999999999a');
    expect(comets.find((c) => c.address === '0x9999999999999999999999999999999999999a')?.cacheFed).to.equal('unknown');
    expect(warnings.some((w) => w.includes('not in the known-comet map'))).to.equal(true);
  });

  it('(F1) THROWS naming a known cache-fed comet the manifest no longer surfaces — reproduces the cold-review false-PASS (dropping the 0xB42aeBB5 notes sentence)', () => {
    expect(() => resolveCachedComets(hadrianManifestMissingB42Fixture(), KNOWN))
      .to.throw(/0xB42aeBB570DB4EC6ede97e460e2D5df37C472881/);
  });

  it('(F1) the floor error names ALL missing known cache-fed comets, not just one', () => {
    const manifest: ManifestCometsShape = { comets: [], notes: undefined };
    let thrown: Error | undefined;
    try {
      resolveCachedComets(manifest, KNOWN);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown, 'expected resolveCachedComets to throw').to.not.be.undefined;
    expect(thrown!.message).to.include('0xfc322489D4089AdCC79074C8058Fd257c63622D8');
    expect(thrown!.message).to.include('0x771D2f213b4C23f70Fa884d441a405F41F51Ab50');
    expect(thrown!.message).to.include('0xB42aeBB570DB4EC6ede97e460e2D5df37C472881');
  });
});

describe('deriveAdapterSetFromReader (G2 — derive a book\'s adapter set live)', () => {
  it('walks registrationCount/registrationAt/adapterOf and returns the adapter set', async () => {
    const accounts = ['acct-a', 'acct-b', 'acct-c'];
    const adapters: Record<string, string> = {
      'acct-a': '0xAAAA000000000000000000000000000000000A',
      'acct-b': '0xBBBB000000000000000000000000000000000B',
      'acct-c': '0xCCCC000000000000000000000000000000000C',
    };
    const reader = {
      registrationCount: async () => accounts.length,
      registrationAt: async (i: number) => accounts[i],
      adapterOf: async (acct: string) => adapters[acct],
    };
    const set = await deriveAdapterSetFromReader(reader);
    expect(set).to.deep.equal(
      new Set(['0xaaaa000000000000000000000000000000000a', '0xbbbb000000000000000000000000000000000b', '0xcccc000000000000000000000000000000000c']),
    );
  });

  it('accepts a bigint registrationCount (raw ethers BigNumberish)', async () => {
    const reader = {
      registrationCount: async () => BigInt(1),
      registrationAt: async () => 'acct-only',
      adapterOf: async () => '0xAdapterOnly00000000000000000000000000A',
    };
    const set = await deriveAdapterSetFromReader(reader);
    expect(set.has('0xadapteronly00000000000000000000000000a')).to.equal(true);
  });
});

describe('deriveAdapterSetFromDeployRecord (G2 — derive a book\'s adapter set from a deploy record)', () => {
  it('reads deployments/<chain>.json#PriceBook.feeds[].adapter shape', () => {
    const record = {
      feeds: [
        { pair: 'SOL/USD', adapter: '0x2779176109cbEDD2fDdA63937E087518b309F4BE' },
        { pair: 'BTC/USD', adapter: '0xF0aF167691D3Bcc49e17902930831AdD58C8cF97' },
      ],
    };
    const set = deriveAdapterSetFromDeployRecord(record);
    expect(set).to.deep.equal(
      new Set(['0x2779176109cbedd2fdda63937e087518b309f4be', '0xf0af167691d3bcc49e17902930831add58c8cf97']),
    );
  });
});

describe('assertCoverage (G2 — zero old/foreign references, or FAIL naming exactly what and where)', () => {
  const NEW_BOOK_ADAPTERS = new Set(['0xnew00000000000000000000000000000000001', '0xnew00000000000000000000000000000000002']);
  const OLD_BOOK_ADAPTERS = new Set(['0xold00000000000000000000000000000000001', '0xold00000000000000000000000000000000002']);
  const COMET_A = '0xComet00000000000000000000000000000000A';
  const COMET_B = '0xComet00000000000000000000000000000000B';

  it('(a) FAILS, naming the asset, when a comet\'s asset still points at an OLD adapter', () => {
    const cometFeeds = new Map<string, CometFeedMap>([
      [COMET_A.toLowerCase(), { base: '0xnew00000000000000000000000000000000001', asset0: '0xold00000000000000000000000000000000002' }],
    ]);
    const result = assertCoverage({
      enumeratedComets: [COMET_A],
      cometFeeds,
      newBookAdapters: NEW_BOOK_ADAPTERS,
      oldBookAdapters: OLD_BOOK_ADAPTERS,
    });
    expect(result.pass).to.equal(false);
    expect(result.failures).to.have.length(1);
    expect(result.failures[0]).to.include({ comet: COMET_A, label: 'asset0' });
    expect(result.failures[0].reason).to.match(/OLD book/);
  });

  it('(b) FAILS when an enumerated comet was never read (missing coverage)', () => {
    const cometFeeds = new Map<string, CometFeedMap>([
      [COMET_A.toLowerCase(), { base: '0xnew00000000000000000000000000000000001' }],
      // COMET_B enumerated below but absent here — never read.
    ]);
    const result = assertCoverage({
      enumeratedComets: [COMET_A, COMET_B],
      cometFeeds,
      newBookAdapters: NEW_BOOK_ADAPTERS,
      oldBookAdapters: OLD_BOOK_ADAPTERS,
    });
    expect(result.pass).to.equal(false);
    expect(result.failures.some((f) => f.comet === COMET_B && f.reason.includes('never read'))).to.equal(true);
  });

  it('(c) PASSES when every comet\'s every feed (base + all assets) is on the NEW book', () => {
    const cometFeeds = new Map<string, CometFeedMap>([
      [COMET_A.toLowerCase(), { base: '0xnew00000000000000000000000000000000001', asset0: '0xnew00000000000000000000000000000000002' }],
      [COMET_B.toLowerCase(), { base: '0xnew00000000000000000000000000000000001' }],
    ]);
    const result = assertCoverage({
      enumeratedComets: [COMET_A, COMET_B],
      cometFeeds,
      newBookAdapters: NEW_BOOK_ADAPTERS,
      oldBookAdapters: OLD_BOOK_ADAPTERS,
    });
    expect(result.pass).to.equal(true);
    expect(result.failures).to.have.length(0);
    expect(result.rows.every((r) => r.status === 'OK')).to.equal(true);
  });

  it('(d) FAILS when a feed is a foreign/unknown address (neither NEW_BOOK nor OLD_BOOK)', () => {
    const cometFeeds = new Map<string, CometFeedMap>([
      [COMET_A.toLowerCase(), { base: '0xForeign000000000000000000000000000000F' }],
    ]);
    const result = assertCoverage({
      enumeratedComets: [COMET_A],
      cometFeeds,
      newBookAdapters: NEW_BOOK_ADAPTERS,
      oldBookAdapters: OLD_BOOK_ADAPTERS,
    });
    expect(result.pass).to.equal(false);
    expect(result.failures[0].reason).to.match(/foreign/i);
  });

  it('(M3) classifies a CHECKSUMMED (mixed-case) feed as STILL_OLD when it case-insensitively matches an OLD_BOOK adapter', () => {
    // OLD_BOOK_ADAPTERS stores '0xold00000000000000000000000000000000001'
    // (lowercase, as a live read would normalize it). The comet's live read
    // here comes back mixed-case (e.g. ethers' checksummed getAddress
    // formatting) — same address, different casing. Without normalizing
    // before the Set lookup this is a silent case-mismatch that reads as
    // FOREIGN instead of the OLD-book hit it actually is.
    const checksummedOldFeed = '0xOLD00000000000000000000000000000000001';
    const cometFeeds = new Map<string, CometFeedMap>([[COMET_A.toLowerCase(), { base: checksummedOldFeed }]]);
    const result = assertCoverage({
      enumeratedComets: [COMET_A],
      cometFeeds,
      newBookAdapters: NEW_BOOK_ADAPTERS,
      oldBookAdapters: OLD_BOOK_ADAPTERS,
    });
    expect(result.pass).to.equal(false);
    expect(result.rows[0].status).to.equal('STILL_OLD');
    expect(result.failures[0].reason).to.match(/OLD book/);
  });

  it('treats an address registered on BOTH books as STILL_OLD (assert-zero-old wins over new-registration)', () => {
    const shared = '0xshared0000000000000000000000000000000s';
    const cometFeeds = new Map<string, CometFeedMap>([[COMET_A.toLowerCase(), { base: shared }]]);
    const result = assertCoverage({
      enumeratedComets: [COMET_A],
      cometFeeds,
      newBookAdapters: new Set([shared]),
      oldBookAdapters: new Set([shared]),
    });
    expect(result.pass).to.equal(false);
    expect(result.rows[0].status).to.equal('STILL_OLD');
  });
});

describe('assertSourceAccountParity (pre-deploy book->book guard — old.sourceAccount() == new.sourceAccount())', () => {
  const SRC = {
    usdc: '0x' + '11'.repeat(32),
    eth: '0x' + '22'.repeat(32),
    sol: '0x' + '33'.repeat(32),
  };
  // Correct map: old and new adapter of each pair wrap the SAME source.
  const src: Record<string, string> = {
    '0xoldusdc': SRC.usdc, '0xnewusdc': SRC.usdc,
    '0xoldeth': SRC.eth, '0xneweth': SRC.eth,
    '0xoldsol': SRC.sol, '0xnewsol': SRC.sol,
  };
  const reader = (a: string): Promise<string> => Promise.resolve(src[a.toLowerCase()]);
  const goodPairs = [
    { label: 'base', pair: 'USDC/USD', old: '0xOLDUSDC', new: '0xNEWUSDC' },
    { label: 'asset0', pair: 'ETH/USD', old: '0xOLDETH', new: '0xNEWETH' },
    { label: 'asset1', pair: 'SOL/USD', old: '0xOLDSOL', new: '0xNEWSOL' },
  ];

  it('PASSES when every old/new pair wraps the same source account', async () => {
    const rows = await assertSourceAccountParity(goodPairs, reader);
    expect(rows).to.have.length(3);
    expect(rows[0].source.toLowerCase()).to.equal(SRC.usdc);
  });

  it('THROWS on a transposed row (old -> new mapped to a DIFFERENT source)', async () => {
    const transposed = [{ ...goodPairs[0], new: '0xNEWETH' }, goodPairs[1], goodPairs[2]];
    let err: Error | undefined;
    try { await assertSourceAccountParity(transposed, reader); } catch (e) { err = e as Error; }
    expect(err, 'expected a parity throw').to.not.be.undefined;
    expect(err!.message).to.match(/parity FAILED/i);
    expect(err!.message).to.include('USDC/USD');
  });

  it('THROWS LOUD when an adapter has no readable sourceAccount() (legacy CachedPythAdapter pythAccount)', async () => {
    const cachedReader = (a: string): Promise<string> =>
      a.toLowerCase() === '0xoldusdc'
        ? Promise.reject(new Error('call revert (no sourceAccount)'))
        : Promise.resolve(src[a.toLowerCase()]);
    let err: Error | undefined;
    try { await assertSourceAccountParity(goodPairs, cachedReader); } catch (e) { err = e as Error; }
    expect(err, 'expected an absent-sourceAccount throw').to.not.be.undefined;
    expect(err!.message).to.match(/no readable sourceAccount/i);
    expect(err!.message).to.match(/pythAccount/);
  });

  it('THROWS when the new adapter is not NEW_BOOK\'s registered adapter for that source (right-source-wrong-book)', async () => {
    const adapterOf = (source: string): Promise<string> => {
      if (source.toLowerCase() === SRC.usdc) return Promise.resolve('0xFOREIGNUSDC');
      const map: Record<string, string> = { [SRC.eth]: '0xNEWETH', [SRC.sol]: '0xNEWSOL' };
      return Promise.resolve(map[source.toLowerCase()]);
    };
    let err: Error | undefined;
    try { await assertSourceAccountParity(goodPairs, reader, adapterOf); } catch (e) { err = e as Error; }
    expect(err, 'expected an adapterOf-mismatch throw').to.not.be.undefined;
    expect(err!.message).to.match(/adapterOf/i);
  });

  it('PASSES with the adapterOf check when each new adapter IS NEW_BOOK-registered for its source', async () => {
    const adapterOf = (source: string): Promise<string> => {
      const map: Record<string, string> = { [SRC.usdc]: '0xNEWUSDC', [SRC.eth]: '0xNEWETH', [SRC.sol]: '0xNEWSOL' };
      return Promise.resolve(map[source.toLowerCase()]);
    };
    const rows = await assertSourceAccountParity(goodPairs, reader, adapterOf);
    expect(rows).to.have.length(3);
  });

  it('THROWS on a zero/unset sourceAccount()', async () => {
    const zeroReader = (a: string): Promise<string> =>
      a.toLowerCase() === '0xoldusdc'
        ? Promise.resolve('0x' + '00'.repeat(32))
        : Promise.resolve(src[a.toLowerCase()]);
    let err: Error | undefined;
    try { await assertSourceAccountParity(goodPairs, zeroReader); } catch (e) { err = e as Error; }
    expect(err, 'expected a zero-source throw').to.not.be.undefined;
    expect(err!.message).to.match(/zero|empty/i);
  });
});

describe('requireCutoverEnv (fail-fast BEFORE the mutating cutover path)', () => {
  it('THROWS in cutover mode when NEW_BOOK is unset (adapterOf check would silently skip on the mutating path)', () => {
    expect(() => requireCutoverEnv({ mode: 'cutover', newBook: '', registryRoot: '/reg' })).to.throw(/NEW_BOOK/);
  });

  it('THROWS in cutover mode when REGISTRY_ROOT is unset (verify would only fail AFTER the upgrade)', () => {
    expect(() => requireCutoverEnv({ mode: 'cutover', newBook: '0xbook', registryRoot: '' })).to.throw(/REGISTRY_ROOT/);
  });

  it('does NOT throw in cutover mode when both are set', () => {
    expect(() => requireCutoverEnv({ mode: 'cutover', newBook: '0xbook', registryRoot: '/reg' })).to.not.throw();
  });

  it('does NOT throw in dry/verify/restore even when both are unset (read-only paths)', () => {
    for (const mode of ['dry', 'verify', 'restore']) {
      expect(() => requireCutoverEnv({ mode, newBook: '', registryRoot: '' }), mode).to.not.throw();
    }
  });
});
