/**
 * Safety valves for the self-learning stores (learned selectors and ad domains).
 *
 * These numbers are NOT measured p99 values. Real sites teach single-digit entries
 * per site (measured median: 6 selectors / 7 domains), so ordinary browsing never
 * comes near them; the caps exist to bound a pathological page (one that mints a new
 * obfuscated class on every load) and a long-lived profile that accumulates sites.
 * Treat them as generous ceilings, not as tuned thresholds.
 *
 * Two policies, each anchored to the entry's own clock:
 *   - TTL: an entry not hit for N days loses its right to exist. A *promoted* rule is
 *     aged out only while its store is over the cap, so a rule that merely has not
 *     fired for a while is never dropped on age alone.
 *   - Decay: hits halve once per DECAY_INTERVAL_DAYS without a new hit, so a rule that
 *     used to be noisy and has gone quiet sinks in the ranking.
 *
 * Decay is derived, never stored on the read path. Stored `hits` changes only when a
 * new hit arrives: that write bakes the pending halvings in and moves the anchor to the
 * new hit. Halving a stored counter on every read would halve it again on the next read,
 * so reads compute the effective value from (hits, lastHitAt) and leave storage alone.
 *
 * Everything here is pure and clock-injected — no chrome.*, and the only ambient clock
 * read sits behind the resolveNow seam — so the whole policy is testable under Node.
 */
import type { KvStore } from './storage.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Hits halve once per this interval without a new hit. */
export const DECAY_INTERVAL_DAYS = 30;
/** Observing (not yet promoted) selector: dropped after this long without a hit. */
export const OBSERVING_TTL_DAYS = 30;
/** Promoted selector: dropped after this long without a hit, but only while over the cap. */
export const PROMOTED_TTL_DAYS = 90;
/** Per-site ad domain: dropped after this long without a sighting (promoted only while over the cap). */
export const DOMAIN_TTL_DAYS = 90;

/** Promoted selectors kept per site (strongest by decayed hits). */
export const MAX_PROMOTED_PER_SITE = 40;
/** Observing selectors kept per site. */
export const MAX_OBSERVING_PER_SITE = 200;
/** Ad domains kept per site. */
export const MAX_DOMAINS_PER_SITE = 50;
/** Distinct learned ad domains kept across all sites. */
export const MAX_GLOBAL_DOMAINS = 2000;

export type RuleLimits = {
  maxPromotedPerSite: number;
  maxObservingPerSite: number;
  maxDomainsPerSite: number;
  maxGlobalDomains: number;
  decayIntervalMs: number;
  observingTtlMs: number;
  promotedTtlMs: number;
  domainTtlMs: number;
};

export const DEFAULT_LIMITS: RuleLimits = {
  maxPromotedPerSite: MAX_PROMOTED_PER_SITE,
  maxObservingPerSite: MAX_OBSERVING_PER_SITE,
  maxDomainsPerSite: MAX_DOMAINS_PER_SITE,
  maxGlobalDomains: MAX_GLOBAL_DOMAINS,
  decayIntervalMs: DECAY_INTERVAL_DAYS * DAY_MS,
  observingTtlMs: OBSERVING_TTL_DAYS * DAY_MS,
  promotedTtlMs: PROMOTED_TTL_DAYS * DAY_MS,
  domainTtlMs: DOMAIN_TTL_DAYS * DAY_MS,
};

/** Merge overrides onto the defaults. The default object is shared: treat the result as read-only. */
export const resolveLimits = (overrides?: Partial<RuleLimits>): RuleLimits =>
  overrides ? { ...DEFAULT_LIMITS, ...overrides } : DEFAULT_LIMITS;

/** Clock seam: callers may inject `now` so TTL and decay are testable. */
export const resolveNow = (now?: number): number =>
  typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

/**
 * Clock and limit overrides accepted by every storage entry point.
 *
 * Production callers pass nothing (system clock, default limits); tests pass both so
 * the policy can be driven without waiting 30 days or minting 2000 entries.
 */
export type LimitOptions = { now?: number; limits?: Partial<RuleLimits> };

// ── Cleanup audit trail ───────────────────────────────────────────────────────

/**
 * Key of the cleanup audit trail the options page can render later.
 *
 * Pruning deletes rules for real (no retirement area), so it must leave a readable
 * trace behind: "when, why, how many". Newest record last, bounded to
 * LEARNED_CLEANUP_MAX_RECORDS; nothing is written when a pass removed nothing.
 */
export const CLEANUP_LOG_KEY = 'learnedCleanupLog';
export const LEARNED_CLEANUP_MAX_RECORDS = 20;

/** Fixed order, so the log a pass writes is deterministic. */
export const CLEANUP_REASONS = [
  'selector-observing-expired',
  'selector-observing-overflow',
  'selector-promoted-expired',
  'selector-promoted-overflow',
  'domain-expired',
  'domain-overflow',
  'domain-global-overflow',
] as const;

export type CleanupReason = (typeof CLEANUP_REASONS)[number];

export type CleanupRecord = {
  /** Epoch ms of the pass that removed the entries. */
  at: number;
  reason: CleanupReason;
  /** Entries really deleted (always > 0: a no-op pass records nothing). */
  removed: number;
};

export type CleanupRemoval = { reason: CleanupReason; removed: number };

function isCleanupRecord(value: unknown): value is CleanupRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r['at'] === 'number' &&
    Number.isFinite(r['at']) &&
    typeof r['removed'] === 'number' &&
    Number.isFinite(r['removed']) &&
    (CLEANUP_REASONS as readonly unknown[]).includes(r['reason'])
  );
}

/** Read the audit trail (newest last). Tolerates missing or corrupted data. */
export async function readCleanupLog(store: KvStore): Promise<CleanupRecord[]> {
  const raw = await store.get<unknown>(CLEANUP_LOG_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCleanupRecord);
}

/**
 * Append what a pass removed. Returns the records written, or null when the pass
 * removed nothing — in that case storage is left untouched, which keeps the hot read
 * paths (popup, options, service worker) write-free while data is small.
 */
export async function appendCleanupLog(
  store: KvStore,
  at: number,
  removals: readonly CleanupRemoval[],
): Promise<CleanupRecord[] | null> {
  const records: CleanupRecord[] = [];
  for (const { reason, removed } of removals) {
    if (removed > 0) records.push({ at, reason, removed });
  }
  if (records.length === 0) return null;

  const existing = await readCleanupLog(store);
  await store.set(CLEANUP_LOG_KEY, [...existing, ...records].slice(-LEARNED_CLEANUP_MAX_RECORDS));
  return records;
}

// ── Decay ─────────────────────────────────────────────────────────────────────

/**
 * Effective hit count at `now`: halved once per decay interval elapsed since the last
 * hit (`since`). Missing/absurd anchors mean "no ageing information", so the counter is
 * returned unchanged — legacy data written before limits existed must not be mass-decayed
 * or mass-expired on the first read after an upgrade.
 */
export function decayHits(hits: number, since: number | undefined, now: number, intervalMs: number): number {
  if (!Number.isFinite(since) || intervalMs <= 0) return hits;
  const elapsed = now - (since as number);
  if (elapsed < intervalMs) return hits;

  const periods = Math.floor(elapsed / intervalMs);
  // 2^31 already exceeds any reachable counter; clamp so the shift stays exact.
  return Math.floor(hits / 2 ** Math.min(periods, 31));
}

/** Anchor timestamp, or `now` when the entry predates timestamps (treated as fresh). */
const anchorOf = (value: number | undefined, now: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : now;

export type SelectorLike = {
  selector: string;
  hits: number;
  promoted: boolean;
  /** Epoch ms of the last hit; absent on data written before limits existed. */
  lastHitAt?: number;
  /**
   * Added by hand through the element picker. Manual rules are the user's explicit
   * decision, so no automatic policy may ever delete one: they are exempt from the
   * per-site caps and from both TTLs (see pruneSelectorEntries).
   */
  picked?: boolean;
};

export type DomainLike = {
  host: string;
  hits: number;
  promoted: boolean;
  lastSeenAt: number;
};

export const effectiveSelectorHits = (entry: SelectorLike, now: number, limits: RuleLimits): number =>
  // A picked rule is never pruned, so decaying its counter would only understate it in the
  // UI and make a manual rule look weaker than an automatically learned one.
  entry.picked
    ? entry.hits
    : decayHits(entry.hits, anchorOf(entry.lastHitAt, now), now, limits.decayIntervalMs);

export const effectiveDomainHits = (entry: DomainLike, now: number, limits: RuleLimits): number =>
  decayHits(entry.hits, anchorOf(entry.lastSeenAt, now), now, limits.decayIntervalMs);

// ── Pruning ───────────────────────────────────────────────────────────────────

export type PruneOutcome<T> = {
  /** Survivors, in their original order, counters untouched (raw hits, not decayed). */
  kept: T[];
  /** What was deleted, in CLEANUP_REASONS order; empty when nothing was pruned. */
  removals: CleanupRemoval[];
};

type ReasonTally = Map<CleanupReason, number>;

const tally = (into: ReasonTally, reason: CleanupReason, count: number): void => {
  if (count > 0) into.set(reason, (into.get(reason) ?? 0) + count);
};

const toRemovals = (from: ReasonTally): CleanupRemoval[] => {
  const out: CleanupRemoval[] = [];
  for (const reason of CLEANUP_REASONS) {
    const removed = from.get(reason);
    if (removed) out.push({ reason, removed });
  }
  return out;
};

/** Strongest first; `rank` returns <0 when the first argument should survive. */
function splitTop<T>(list: readonly T[], max: number, rank: (a: T, b: T) => number): { kept: T[]; dropped: T[] } {
  const sorted = [...list].sort(rank);
  return { kept: sorted.slice(0, max), dropped: sorted.slice(max) };
}

/**
 * Selector policy.
 *
 * Manual (`picked`) entries are kept unconditionally. They are exempt from the observing
 * TTL, the promoted TTL, the per-site caps and decay: a rule the user added by hand must
 * not silently disappear after 30/90 days, which users would rightly report as a bug. The
 * caps therefore bound only the automatically learned set, and picked entries do not
 * compete for its slots.
 *
 * Observing entries: dropped once stale (observingTtlMs without a hit) — an
 * unpromoted guess is not a rule yet — and capped at maxObservingPerSite by hit weight.
 * Promoted entries: dropped for age only while the promoted set is over its cap, and then
 * weakest-first by decayed hits; a promoted rule is never discarded for age alone.
 * Ordering everywhere: decayed hits desc, then most recent hit, then selector name, so the
 * outcome is deterministic against a tie.
 */
export function pruneSelectorEntries<T extends SelectorLike>(
  entries: readonly T[],
  now: number,
  limits: RuleLimits,
): PruneOutcome<T> {
  const reasons: ReasonTally = new Map();
  const dropped = new Set<T>();
  const ageOf = (e: T): number => now - anchorOf(e.lastHitAt, now);
  const rank = (a: T, b: T): number =>
    effectiveSelectorHits(b, now, limits) - effectiveSelectorHits(a, now, limits) ||
    anchorOf(b.lastHitAt, now) - anchorOf(a.lastHitAt, now) ||
    (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0);

  // The caps apply to the learned set only; manual rules are outside the policy entirely.
  const auto = entries.filter((e) => !e.picked);
  const observing = auto.filter((e) => !e.promoted);
  const promoted = auto.filter((e) => e.promoted);

  // Observing: TTL is unconditional.
  const liveObserving = observing.filter((e) => ageOf(e) < limits.observingTtlMs);
  const expiredObserving = observing.length - liveObserving.length;
  for (const e of observing) if (ageOf(e) >= limits.observingTtlMs) dropped.add(e);
  tally(reasons, 'selector-observing-expired', expiredObserving);

  if (liveObserving.length > limits.maxObservingPerSite) {
    const { dropped: weak } = splitTop(liveObserving, limits.maxObservingPerSite, rank);
    for (const e of weak) dropped.add(e);
    tally(reasons, 'selector-observing-overflow', weak.length);
  }

  // Promoted: age matters only while over the cap.
  if (promoted.length > limits.maxPromotedPerSite) {
    const fresh = promoted.filter((e) => ageOf(e) < limits.promotedTtlMs);
    const stale = promoted.filter((e) => ageOf(e) >= limits.promotedTtlMs);
    for (const e of stale) dropped.add(e);
    tally(reasons, 'selector-promoted-expired', stale.length);

    if (fresh.length > limits.maxPromotedPerSite) {
      const { dropped: weak } = splitTop(fresh, limits.maxPromotedPerSite, rank);
      for (const e of weak) dropped.add(e);
      tally(reasons, 'selector-promoted-overflow', weak.length);
    }
  }

  return { kept: entries.filter((e) => !dropped.has(e)), removals: toRemovals(reasons) };
}

/**
 * Per-site ad-domain policy.
 *
 * Observing domains: dropped once domainTtlMs without a sighting (they are not rules yet).
 * Promoted domains: dropped for age only while the site is over its cap, then weakest-first
 * by decayed hits — the same protection promoted selectors get.
 */
export function pruneDomainEntries<T extends DomainLike>(
  entries: readonly T[],
  now: number,
  limits: RuleLimits,
): PruneOutcome<T> {
  const reasons: ReasonTally = new Map();
  const dropped = new Set<T>();
  const ageOf = (e: T): number => now - anchorOf(e.lastSeenAt, now);
  const rank = (a: T, b: T): number =>
    effectiveDomainHits(b, now, limits) - effectiveDomainHits(a, now, limits) ||
    anchorOf(b.lastSeenAt, now) - anchorOf(a.lastSeenAt, now) ||
    (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);

  const observing = entries.filter((e) => !e.promoted);
  const promoted = entries.filter((e) => e.promoted);

  const liveObserving = observing.filter((e) => ageOf(e) < limits.domainTtlMs);
  for (const e of observing) if (ageOf(e) >= limits.domainTtlMs) dropped.add(e);
  tally(reasons, 'domain-expired', observing.length - liveObserving.length);

  let livePromoted = promoted;
  if (liveObserving.length + livePromoted.length > limits.maxDomainsPerSite) {
    const fresh = promoted.filter((e) => ageOf(e) < limits.domainTtlMs);
    const stale = promoted.filter((e) => ageOf(e) >= limits.domainTtlMs);
    for (const e of stale) dropped.add(e);
    tally(reasons, 'domain-expired', stale.length);
    livePromoted = fresh;

    const alive = [...liveObserving, ...livePromoted];
    if (alive.length > limits.maxDomainsPerSite) {
      const { dropped: weak } = splitTop(alive, limits.maxDomainsPerSite, rank);
      for (const e of weak) dropped.add(e);
      tally(reasons, 'domain-overflow', weak.length);
    }
  }

  return { kept: entries.filter((e) => !dropped.has(e)), removals: toRemovals(reasons) };
}

// ── Global domain pool ────────────────────────────────────────────────────────

export type GlobalDomainCandidate = {
  host: string;
  /** Sum of decayed hits over every site that taught it. */
  hits: number;
  /** Newest sighting over every site that taught it. */
  lastSeenAt: number;
};

/** Collapse the per-site domain entries into one row per distinct domain. */
export function aggregateGlobalDomains(
  sites: readonly { entries: readonly DomainLike[] }[],
  now: number,
  limits: RuleLimits,
): GlobalDomainCandidate[] {
  const acc = new Map<string, GlobalDomainCandidate>();
  for (const site of sites) {
    for (const entry of site.entries) {
      const hits = effectiveDomainHits(entry, now, limits);
      const seen = anchorOf(entry.lastSeenAt, now);
      const prev = acc.get(entry.host);
      if (!prev) acc.set(entry.host, { host: entry.host, hits, lastSeenAt: seen });
      else {
        prev.hits += hits;
        if (seen > prev.lastSeenAt) prev.lastSeenAt = seen;
      }
    }
  }
  return [...acc.values()];
}

/**
 * Which distinct domains lose their place when the global pool is over its cap.
 * Weakest first: fewest decayed hits, then longest unused, then host name for determinism.
 */
export function rankGlobalDomainEvictions(
  candidates: readonly GlobalDomainCandidate[],
  maxDomains: number,
): string[] {
  const excess = candidates.length - maxDomains;
  if (excess <= 0) return [];
  const sorted = [...candidates].sort(
    (a, b) =>
      a.hits - b.hits ||
      a.lastSeenAt - b.lastSeenAt ||
      (a.host < b.host ? -1 : a.host > b.host ? 1 : 0),
  );
  return sorted.slice(0, excess).map((c) => c.host);
}
