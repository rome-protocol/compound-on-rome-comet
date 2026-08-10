// Pure, injectable core of the comet cutover coverage gate.
//
//   G1 — enumerate EVERY cache-fed comet from the registry app manifest:
//        the structured comets[] array UNIONED with every comet the notes
//        prose names. A canonical comet has historically been named ONLY
//        in notes, never added to comets[] (rome-ai memory
//        feedback_retire_shared_infra_enumerate_all_consumers.md) — reading
//        comets[0] alone silently drops it. KNOWN_HADRIAN_COMETS is also an
//        enumeration FLOOR: every cache-fed entry in it MUST be surfaced by
//        the manifest, or resolution throws — otherwise a notes edit that
//        silently stops mentioning a comet would silently drop it instead.
//
//   G2 — given each enumerated comet's live feed map and each book's live
//        adapter set, assert every feed is a NEW_BOOK adapter and NOT an
//        OLD_BOOK adapter (or any address outside NEW_BOOK).
//
// No ethers/hardhat import here on purpose: this module is plain
// string/array/Set logic, unit-testable with literal fixtures — no live
// chain, no network. cutover-book-feeds.ts wires it to real reads.

/**
 * One comet this script knows about, hand-verified against on-chain state
 * at cutover time — the same "hardcoded, asserted against live reads"
 * pattern cutover-book-feeds.ts already uses for COMET_PROXY / ORIGINAL_IMPL
 * / FEED_SWAPS. Notes prose truncates addresses for readability
 * ("0x771D2f21…"), so a prefix can't be mechanically resolved to a full
 * address from text alone — this map is what resolves it, and an
 * unresolvable prefix is treated as a hard failure (see resolveCachedComets).
 */
export interface KnownComet {
  label: string;
  address: string;
  /** false = raw Pyth-Pull lane, never cache-fed — excluded from the G2 gate. */
  cacheFed: boolean;
}

// Ground truth for Hadrian 200010. The first three were cut over to the
// first PriceBook in compound-on-rome-comet #48/#49/#50 (2026-08-08/09); the
// fourth is the pre-existing raw Pyth-Pull comet, confirmed via
// registry/apps/compound/200010-hadrian.json's own notes text ("Supersedes
// the multicollat Pyth-Pull comet (0xb8Ad4fd3…, still live on-chain)") and
// janus/lib/janus/config.ts (COMET.proxy) — it never had cached feeds to
// cut over and stays excluded.
export const KNOWN_HADRIAN_COMETS: readonly KnownComet[] = [
  { label: 'fc322489 (structured comets[0])', address: '0xfc322489D4089AdCC79074C8058Fd257c63622D8', cacheFed: true },
  { label: 'canonical 9-asset (named only in notes)', address: '0x771D2f213b4C23f70Fa884d441a405F41F51Ab50', cacheFed: true },
  { label: 'empty 3-asset (named only in notes)', address: '0xB42aeBB570DB4EC6ede97e460e2D5df37C472881', cacheFed: true },
  { label: 'multicollat Pyth-Pull (named only in notes, raw lane)', address: '0xb8Ad4fd3776E356d1295E7539FCec02Da4629856', cacheFed: false },
];

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Every `0x<hex>…` token in prose. Manifest notes truncate addresses for
 * readability, so this recovers PREFIXES, never full addresses —
 * resolution against KNOWN_HADRIAN_COMETS (in resolveCachedComets) is what
 * turns a prefix into a usable address. An unresolvable prefix is exactly
 * the failure mode this gate exists to catch, so callers throw rather than
 * silently dropping the mention.
 */
export function extractNotesAddressPrefixes(notes: string | undefined): string[] {
  if (!notes) return [];
  const matches = notes.match(/0x[0-9a-fA-F]{6,40}…/g) ?? [];
  return matches.map((m) => m.slice(0, -1)); // drop the trailing ellipsis
}

export interface ManifestCometsShape {
  comets: Array<{ label: string, address: string }>;
  notes?: string;
}

export interface EnumeratedComet {
  address: string;
  label: string;
  source: 'structured' | 'notes';
  cacheFed: boolean | 'unknown';
}

export interface ResolvedComets {
  /** Cache-fed comets — the G2 gate's target set. */
  comets: EnumeratedComet[];
  /** Raw/Pyth-Pull comets named in the manifest — surfaced, never gated. */
  excluded: EnumeratedComet[];
  warnings: string[];
}

/**
 * G1: the full set of cache-fed comets for one registry app manifest —
 * structured comets[] UNIONED with every comet the notes prose names,
 * resolved to full addresses via `knownComets`. Fails loudly (throws)
 * rather than silently omitting a consumer:
 *   - a notes-prefix that matches no known comet (map is stale)
 *   - a notes-prefix that matches more than one known comet (ambiguous map)
 *   - a known cache-fed comet that the manifest no longer surfaces at all
 *     (the FLOOR — catches a notes edit that just stops mentioning it,
 *     which produces neither an unresolvable nor an ambiguous prefix)
 *   - a resulting cache-fed set that's empty
 * A structured comets[] address NOT in the known map is still included —
 * we have its full address, so we never drop what we can resolve — but
 * flagged in `warnings` (cacheFed comes back 'unknown') for a human to add
 * it to the map with a confirmed cacheFed value.
 */
export function resolveCachedComets(
  manifest: ManifestCometsShape,
  knownComets: readonly KnownComet[] = KNOWN_HADRIAN_COMETS,
): ResolvedComets {
  const byAddress = new Map<string, EnumeratedComet>();
  const warnings: string[] = [];

  const knownOf = (address: string): KnownComet | undefined =>
    knownComets.find((k) => sameAddr(k.address, address));

  for (const c of manifest.comets ?? []) {
    const known = knownOf(c.address);
    if (!known) {
      warnings.push(
        `structured comets[] entry '${c.label}' (${c.address}) is not in the known-comet map — ` +
        `cacheFed status unconfirmed; add it to KNOWN_HADRIAN_COMETS.`,
      );
    }
    byAddress.set(c.address.toLowerCase(), {
      address: c.address,
      label: c.label,
      source: 'structured',
      cacheFed: known ? known.cacheFed : 'unknown',
    });
  }

  for (const prefix of extractNotesAddressPrefixes(manifest.notes)) {
    const matches = knownComets.filter((k) => k.address.toLowerCase().startsWith(prefix.toLowerCase()));
    if (matches.length === 0) {
      throw new Error(
        `notes mention a comet '${prefix}…' that is not in the known-comet map — the map is stale ` +
        `(this is exactly the bug class this gate exists to catch: a comet named only in notes, never ` +
        `enumerated). Add its full address to KNOWN_HADRIAN_COMETS before proceeding.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `notes prefix '${prefix}…' matches ${matches.length} known comets ` +
        `(${matches.map((m) => m.address).join(', ')}) — ambiguous, fix KNOWN_HADRIAN_COMETS.`,
      );
    }
    const known = matches[0];
    const existing = byAddress.get(known.address.toLowerCase());
    byAddress.set(known.address.toLowerCase(), {
      address: known.address,
      label: existing?.label ?? known.label,
      source: existing?.source ?? 'notes',
      cacheFed: known.cacheFed,
    });
  }

  const all = Array.from(byAddress.values());
  const comets = all.filter((c) => c.cacheFed !== false);
  const excluded = all.filter((c) => c.cacheFed === false);

  // FLOOR: knownComets isn't just a resolution dictionary for notes
  // prefixes — every cache-fed comet it lists MUST actually be surfaced by
  // this manifest (via comets[] or notes), or the gate refuses to run.
  // Without this, editing/trimming the notes prose (e.g. dropping the
  // "(0xB42aeBB5… still live)" sentence) silently drops that comet from the
  // enumerated set with zero warnings/throws — G2 then never reads it and
  // trivially PASSES while it could still be sitting on the old book. This
  // is the exact bug class the gate exists to catch, applied to itself.
  const enumeratedAddrs = new Set(all.map((c) => c.address.toLowerCase()));
  const missingKnown = knownComets.filter(
    (k) => k.cacheFed && !enumeratedAddrs.has(k.address.toLowerCase()),
  );
  if (missingKnown.length > 0) {
    throw new Error(
      `${missingKnown.length} known cache-fed comet(s) are no longer surfaced by this manifest ` +
      `(neither comets[] nor notes mention them) — the manifest/notes text stopped naming a known ` +
      `consumer, which silently drops it from the enumerated set instead of failing loud:\n` +
      missingKnown.map((k) => `  ${k.label} (${k.address})`).join('\n') +
      `\nEither the manifest genuinely retired this comet (remove it from KNOWN_HADRIAN_COMETS explicitly, ` +
      `with a note why) or the notes text/regex regressed — don't proceed silently either way.`,
    );
  }

  if (comets.length === 0) {
    throw new Error(
      'enumerated cache-fed comet set is EMPTY — refusing to run a gate that would trivially pass over nothing.',
    );
  }

  return { comets, excluded, warnings };
}

// ── G2: book adapter sets ────────────────────────────────────────────────

/**
 * Read surface the gate needs from a live PriceBook — matches
 * PriceBook.sol's registrationCount/registrationAt/adapterOf. Injectable so
 * tests supply a mock without any chain.
 */
export interface BookRegistrationReader {
  registrationCount(): Promise<number | bigint>;
  registrationAt(index: number): Promise<string>;
  adapterOf(sourceAccount: string): Promise<string>;
}

/**
 * Derives a book's full BookFeedAdapter clone set by walking its live
 * registration roster (registrationAt(i) -> adapterOf).
 */
export async function deriveAdapterSetFromReader(reader: BookRegistrationReader): Promise<Set<string>> {
  const countRaw = await reader.registrationCount();
  const count = typeof countRaw === 'bigint' ? Number(countRaw) : countRaw;
  const out = new Set<string>();
  for (let i = 0; i < count; i++) {
    const acct = await reader.registrationAt(i);
    const adapter = await reader.adapterOf(acct);
    out.add(adapter.toLowerCase());
  }
  return out;
}

/**
 * Derives a book's adapter set from its deploy record (e.g. rome-solidity
 * deployments/<chain>.json#PriceBook.feeds[].adapter) instead of a live
 * read — same output shape, no chain call.
 */
export function deriveAdapterSetFromDeployRecord(record: { feeds: Array<{ adapter: string }> }): Set<string> {
  return new Set(record.feeds.map((f) => f.adapter.toLowerCase()));
}

// ── G2: coverage assertion ───────────────────────────────────────────────

/** label ('base' | 'assetN') -> feed address, for one comet's live read. */
export type CometFeedMap = Record<string, string>;

export type CoverageStatus = 'OK' | 'STILL_OLD' | 'FOREIGN' | 'MISSING_COMET';

export interface CoverageRow {
  comet: string;
  label: string;
  feed: string;
  status: CoverageStatus;
}

export interface CoverageFailure {
  comet: string;
  label: string;
  reason: string;
}

export interface CoverageResult {
  pass: boolean;
  rows: CoverageRow[];
  failures: CoverageFailure[];
}

export interface CoverageInput {
  /** Every comet G1 enumerated — including ones with no read (see MISSING_COMET). */
  enumeratedComets: string[];
  /**
   * address (case-insensitive) -> its live feed map. A comet absent here
   * (enumerated but not read) becomes a MISSING_COMET failure — this is how
   * an unreadable comet surfaces as a NAMED gate failure instead of
   * silently dropping out of the report.
   */
  cometFeeds: Map<string, CometFeedMap>;
  newBookAdapters: Set<string>;
  oldBookAdapters: Set<string>;
}

/**
 * G2: PASS only if every enumerated comet was read AND every one of its
 * feeds (base + every collateral asset) is a NEW_BOOK adapter and NOT an
 * OLD_BOOK adapter. Any feed outside NEW_BOOK — whether it's a known
 * OLD_BOOK adapter or a wholly foreign address — fails, named. Pure: no
 * I/O, no chain; every input is already-resolved data.
 */
export function assertCoverage(input: CoverageInput): CoverageResult {
  const rows: CoverageRow[] = [];
  const failures: CoverageFailure[] = [];

  for (const cometAddr of input.enumeratedComets) {
    const feeds = input.cometFeeds.get(cometAddr.toLowerCase());
    if (!feeds) {
      rows.push({ comet: cometAddr, label: '(comet)', feed: '', status: 'MISSING_COMET' });
      failures.push({
        comet: cometAddr,
        label: '(comet)',
        reason: 'enumerated but never read on-chain — coverage UNKNOWN, treat as not-yet-verified (could still be on the old book)',
      });
      continue;
    }
    for (const [label, feedRaw] of Object.entries(feeds)) {
      const feed = feedRaw.toLowerCase();
      const onNew = input.newBookAdapters.has(feed);
      const onOld = input.oldBookAdapters.has(feed);
      const status: CoverageStatus = onOld ? 'STILL_OLD' : onNew ? 'OK' : 'FOREIGN';
      rows.push({ comet: cometAddr, label, feed: feedRaw, status });
      if (status === 'STILL_OLD') {
        failures.push({ comet: cometAddr, label, reason: `still on the OLD book (feed=${feedRaw})` });
      } else if (status === 'FOREIGN') {
        failures.push({
          comet: cometAddr,
          label,
          reason: `points at a feed that is neither NEW_BOOK nor OLD_BOOK (feed=${feedRaw}) — unknown/foreign adapter`,
        });
      }
    }
  }

  return { pass: failures.length === 0, rows, failures };
}

/**
 * Renders the per-comet/per-asset table plus a FAIL summary. Pure string
 * formatting — no console.log here, callers decide where it goes.
 */
export function formatCoverageReport(result: CoverageResult): string {
  const lines: string[] = [];
  lines.push('Comet cutover coverage:');
  for (const r of result.rows) {
    const mark = r.status === 'OK' ? '✓' : '✗';
    lines.push(`  ${mark} ${r.comet}  ${r.label.padEnd(10)} ${r.status.padEnd(14)} ${r.feed}`);
  }
  if (result.pass) {
    lines.push('\nPASS — every asset on every enumerated comet is on NEW_BOOK, zero on OLD_BOOK or foreign.');
  } else {
    lines.push(`\nFAIL — ${result.failures.length} asset(s) not on NEW_BOOK:`);
    for (const f of result.failures) {
      lines.push(`  ${f.comet} ${f.label}: ${f.reason}`);
    }
  }
  return lines.join('\n');
}

// ── Pre-deploy book->book source-account parity guard ─────────────────────

/** One old->new feed swap this cutover is about to make. */
export interface FeedSwapPair {
  label: string;
  pair: string;
  old: string;
  new: string;
}

export interface SourceParityRow {
  label: string;
  pair: string;
  old: string;
  new: string;
  /** The shared bytes32 source account both adapters wrap. */
  source: string;
}

const ZERO_SOURCE = /^0x0*$/i;

async function readSourceOrThrow(
  read: (adapter: string) => Promise<string>,
  adapter: string,
  context: string,
): Promise<string> {
  let v: string;
  try {
    v = await read(adapter);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    throw new Error(
      `${context} has no readable sourceAccount() (${msg}) — a legacy CachedPythAdapter exposes pythAccount, ` +
      `not sourceAccount; this cutover only supports book->book. Abort (teach an explicit mapping for a ` +
      `cached->book run rather than silently skipping this guard).`,
    );
  }
  if (!v || typeof v !== 'string' || ZERO_SOURCE.test(v)) {
    throw new Error(`${context} returned an empty/zero sourceAccount() (${String(v)}) — unconfigured adapter, abort.`);
  }
  return v;
}

/**
 * Pre-deploy guard for a book->book feed cutover: every swap row must map an
 * old BookFeedAdapter to a new BookFeedAdapter that wraps the SAME on-chain
 * source account. A transposed row (old-for-A -> new-for-B) passes both the
 * set-membership coverage gate AND printPriceSanity's >1% *warn* (both blind
 * to which source a new adapter tracks) yet silently mis-prices an asset.
 * This asserts, per row, old.sourceAccount() == new.sourceAccount(), and —
 * when a NEW_BOOK adapterOf reader is supplied — that the new adapter is
 * genuinely NEW_BOOK's registered adapter for that source (catches
 * right-source-wrong-book: a new address that wraps the right source but
 * isn't the book's canonical adapter for it).
 *
 * Throws BEFORE any impl deploy. Fails LOUD if an adapter has no readable
 * sourceAccount(). Pure over injected readers; no ethers/chain import here.
 */
export async function assertSourceAccountParity(
  pairs: FeedSwapPair[],
  readSourceAccount: (adapter: string) => Promise<string>,
  newBookAdapterOf?: (sourceAccount: string) => Promise<string>,
): Promise<SourceParityRow[]> {
  const rows: SourceParityRow[] = [];
  const problems: string[] = [];

  for (const p of pairs) {
    const oldSource = await readSourceOrThrow(readSourceAccount, p.old, `${p.label} (${p.pair}) old adapter ${p.old}`);
    const newSource = await readSourceOrThrow(readSourceAccount, p.new, `${p.label} (${p.pair}) new adapter ${p.new}`);

    if (oldSource.toLowerCase() !== newSource.toLowerCase()) {
      problems.push(
        `${p.label} (${p.pair}): old ${p.old} sourceAccount=${oldSource} != new ${p.new} sourceAccount=${newSource} ` +
        `— row maps this asset to a new adapter tracking a DIFFERENT source (transposed/wrong map).`,
      );
    } else if (newBookAdapterOf) {
      const registered = await newBookAdapterOf(newSource);
      if (!registered || registered.toLowerCase() !== p.new.toLowerCase()) {
        problems.push(
          `${p.label} (${p.pair}): NEW_BOOK.adapterOf(${newSource})=${registered} != mapped new adapter ${p.new} ` +
          `— right source, but ${p.new} is not NEW_BOOK's registered adapter for it (stale/foreign adapter).`,
        );
      }
    }
    rows.push({ label: p.label, pair: p.pair, old: p.old, new: p.new, source: oldSource });
  }

  if (problems.length > 0) {
    throw new Error(
      `Feed-swap source-account parity FAILED (${problems.length} of ${pairs.length} row(s)) — refusing to deploy a ` +
      `mis-mapped Comet impl; no tx sent:\n  ${problems.join('\n  ')}`,
    );
  }
  return rows;
}

/**
 * Fail-fast env guard for the MUTATING cutover path. A cutover must have both
 * NEW_BOOK (so the pre-deploy source-parity guard's adapterOf wrong-book
 * sub-check actually runs — with NEW_BOOK unset it is silently skipped) and
 * REGISTRY_ROOT (so the post-upgrade coverage verify can't die on a setup
 * error AFTER the impl deploy + ProxyAdmin.upgrade have already landed).
 * Without this, a cutover missing either mutates first and only then throws,
 * with the wrong-book protection never having run. dry/verify/restore are
 * read-only and unaffected. Pure predicate; throws naming what's missing.
 */
export function requireCutoverEnv(env: { mode: string, newBook?: string, registryRoot?: string }): void {
  if (env.mode !== 'cutover') return;
  const missing: string[] = [];
  if (!env.newBook) missing.push('NEW_BOOK (enables the pre-deploy adapterOf wrong-book check)');
  if (!env.registryRoot) missing.push('REGISTRY_ROOT (post-upgrade coverage verify)');
  if (missing.length > 0) {
    throw new Error(
      `MODE=cutover requires ${missing.join(' and ')} — refusing to mutate (deploy + upgrade) with either unset; ` +
      `otherwise the wrong-book guard is skipped and/or the coverage verify only fails AFTER the mutation lands.`,
    );
  }
}
