/**
 * Storage layer of the learned-rule growth loop.
 *
 * Anti-pollution: persisting a selector on its first hit would freeze
 * misjudgements forever, so a generic selector must accumulate PROMOTE_AFTER
 * hits to become persistent (below that it still applies on the current page).
 * forgetSelector backs the one-click undo in the UI.
 *
 * Storage is an injected KvStore, so this module needs no chrome.* and is
 * directly testable under Node.
 */
import type { KvStore } from './storage.ts';

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
};

export type LearnedMap = Record<string, LearnedEntry>;

export const learnedKey = (host: string): string => `learned:${host}`;

export function hostFromLearnedKey(key: string): string | null {
  return key.startsWith(LEARNED_PREFIX) ? key.slice(LEARNED_PREFIX.length) : null;
}

export async function recordHit(
  store: KvStore,
  host: string,
  selector: string,
): Promise<LearnedEntry> {
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  const entry = current[selector] ?? { selector, hits: 0, promoted: false };

  entry.hits += 1;
  if (entry.hits >= PROMOTE_AFTER) entry.promoted = true;

  current[selector] = entry;
  await store.set(key, current);
  return entry;
}

export async function promotedSelectors(store: KvStore, host: string): Promise<string[]> {
  const current = (await store.get<LearnedMap>(learnedKey(host))) ?? {};
  return Object.values(current)
    .filter((e) => e.promoted)
    .map((e) => e.selector)
    .sort();
}

/**
 * One-shot migration: on version mismatch, wipe all learned data (selectors and
 * domains) and stamp the new version.
 *
 * Safety gates only prevent *future* bad rules; data already in a browser
 * survives extension reloads and would keep misfiring. Returns whether a wipe ran.
 */
export async function migrateLearnedSchema(store: KvStore): Promise<boolean> {
  const current = await store.get<number>(SCHEMA_KEY);
  if (current === LEARNED_SCHEMA_VERSION) return false;

  for (const key of await store.keys()) {
    if (key.startsWith(LEARNED_PREFIX) || key.startsWith(DOMAINS_PREFIX)) {
      await store.remove(key);
    }
  }
  await store.set(SCHEMA_KEY, LEARNED_SCHEMA_VERSION);
  return true;
}

export async function allEntries(store: KvStore, host: string): Promise<LearnedEntry[]> {
  const current = (await store.get<LearnedMap>(learnedKey(host))) ?? {};
  return Object.values(current).sort((a, b) => b.hits - a.hits);
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

/** Every site with learned rules, plus its entries. */
export async function listAllSites(
  store: KvStore,
): Promise<{ host: string; entries: LearnedEntry[] }[]> {
  const keys = await store.keys();
  const hosts = keys.map(hostFromLearnedKey).filter((h): h is string => h !== null).sort();

  const out: { host: string; entries: LearnedEntry[] }[] = [];
  for (const host of hosts) out.push({ host, entries: await allEntries(store, host) });
  return out;
}
