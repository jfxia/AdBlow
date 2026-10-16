/**
 * Storage layer of the learned-rule growth loop.
 *
 * Anti-pollution: persisting a selector on its first hit would freeze
 * misjudgements forever, so a generic selector must accumulate PROMOTE_AFTER
 * hits to become persistent (below that it still applies on the current page).
 * forgetSelector backs the one-click undo in the UI.
 *
 * Growth is bounded by the safety valves in ruleLimits.ts: observing selectors expire
 * after 30 days without a hit, promoted ones are capped per site, and hit counters decay
 * with age. Every entry point (write AND read) prunes, because data written before the
 * valves existed may already be over any cap and must be trimmed on first sight.
 *
 * Storage is an injected KvStore, so this module needs no chrome.* and is
 * directly testable under Node.
 */
import type { KvStore } from './storage.ts';
import {
  CLEANUP_LOG_KEY,
  appendCleanupLog,
  effectiveSelectorHits,
  pruneSelectorEntries,
  resolveLimits,
  resolveNow,
  type LimitOptions,
  type RuleLimits,
} from './ruleLimits.ts';

export const PROMOTE_AFTER = 3;

/**
 * Format/trust version of the learned data.
 *
 * Bumping it wipes everything learned, for when old data is no longer trustworthy.
 *
 * History: 1 → 2 (2026-10-10) tightened the selector safety gates. Earlier data
 * could contain content-card selectors that went into the document_start
 * stylesheet and hid whole pages, so it is discarded and relearned.
 */
export const LEARNED_SCHEMA_VERSION = 2;

const SCHEMA_KEY = 'learnedSchemaVersion';
const LEARNED_PREFIX = 'learned:';
const DOMAINS_PREFIX = 'adDomains:';

export type LearnedEntry = {
  selector: string;
  hits: number;
  promoted: boolean;
  /**
   * Epoch ms of the last hit. Absent on data written before the limits existed; such
   * entries are treated as "just hit" (see ruleLimits), so an upgrade never mass-expires
   * rules learned by an older build.
   */
  lastHitAt?: number;
};

export type LearnedMap = Record<string, LearnedEntry>;

export const learnedKey = (host: string): string => `learned:${host}`;

export function hostFromLearnedKey(key: string): string | null {
  return key.startsWith(LEARNED_PREFIX) ? key.slice(LEARNED_PREFIX.length) : null;
}

/**
 * Prune one site's map and persist the result.
 *
 * `dirty` is true when the caller already changed the map (a new hit) and the write must
 * happen even if nothing was pruned. On read paths nothing is written unless pruning
 * really removed an entry, which keeps repeated popup/worker reads free of storage churn.
 */
async function persistPrunedSelectors(
  store: KvStore,
  key: string,
  map: LearnedMap,
  now: number,
  limits: RuleLimits,
  dirty: boolean,
): Promise<LearnedMap> {
  const { kept, removals } = pruneSelectorEntries(Object.values(map), now, limits);
  if (!dirty && removals.length === 0) return map;

  const next: LearnedMap = {};
  for (const entry of kept) next[entry.selector] = entry;

  if (Object.keys(next).length === 0) await store.remove(key);
  else await store.set(key, next);
  await appendCleanupLog(store, now, removals);
  return next;
}

export async function recordHit(
  store: KvStore,
  host: string,
  selector: string,
  options: LimitOptions = {},
): Promise<LearnedEntry> {
  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  const existing = current[selector] ?? { selector, hits: 0, promoted: false };

  // Decay is baked in only for the entry being hit: its anchor moves to `now` together
  // with the new hit, which keeps the stored counter idempotent. Other entries keep their
  // raw counter; every read derives their decayed value instead.
  const hits = effectiveSelectorHits(existing, now, limits) + 1;
  const entry: LearnedEntry = {
    ...existing,
    selector,
    hits,
    lastHitAt: now,
    promoted: existing.promoted || hits >= PROMOTE_AFTER,
  };

  const next = await persistPrunedSelectors(
    store,
    key,
    { ...current, [selector]: entry },
    now,
    limits,
    true,
  );
  // In the pathological case where the just-hit selector is itself evicted by the cap,
  // storage no longer holds it; the returned entry is still the one that was counted.
  return next[selector] ?? entry;
}

export async function promotedSelectors(
  store: KvStore,
  host: string,
  options: LimitOptions = {},
): Promise<string[]> {
  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  const kept = await persistPrunedSelectors(store, key, current, now, limits, false);
  return Object.values(kept)
    .filter((e) => e.promoted)
    .map((e) => e.selector)
    .sort();
}

/**
 * One-shot migration: on version mismatch, wipe all learned data (selectors, domains and
 * the cleanup trail) and stamp the new version.
 *
 * Safety gates only prevent *future* bad rules; data already in a browser
 * survives extension reloads and would keep misfiring. Returns whether a wipe ran.
 */
export async function migrateLearnedSchema(store: KvStore): Promise<boolean> {
  const current = await store.get<number>(SCHEMA_KEY);
  if (current === LEARNED_SCHEMA_VERSION) return false;

  for (const key of await store.keys()) {
    if (key.startsWith(LEARNED_PREFIX) || key.startsWith(DOMAINS_PREFIX) || key === CLEANUP_LOG_KEY) {
      await store.remove(key);
    }
  }
  await store.set(SCHEMA_KEY, LEARNED_SCHEMA_VERSION);
  return true;
}

/** Entries with their decayed hit counts, strongest first. */
export async function allEntries(
  store: KvStore,
  host: string,
  options: LimitOptions = {},
): Promise<LearnedEntry[]> {
  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  const kept = await persistPrunedSelectors(store, key, current, now, limits, false);
  return Object.values(kept)
    .map((e) => ({ ...e, hits: effectiveSelectorHits(e, now, limits) }))
    .sort((a, b) => b.hits - a.hits);
}

export async function forgetSelector(
  store: KvStore,
  host: string,
  selector: string,
): Promise<void> {
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  delete current[selector];
  await store.set(key, current);
}

export async function clearSite(store: KvStore, host: string): Promise<void> {
  await store.remove(learnedKey(host));
}

/**
 * Every site with learned rules, plus its entries.
 *
 * Sites are listed from the keys present at call time: a site whose entries were all
 * pruned away on this call still appears once, with no entries, and disappears on the
 * next call because the now-empty key was removed.
 */
export async function listAllSites(
  store: KvStore,
  options: LimitOptions = {},
): Promise<{ host: string; entries: LearnedEntry[] }[]> {
  const keys = await store.keys();
  const hosts = keys.map(hostFromLearnedKey).filter((h): h is string => h !== null).sort();

  const out: { host: string; entries: LearnedEntry[] }[] = [];
  for (const host of hosts) out.push({ host, entries: await allEntries(store, host, options) });
  return out;
}
