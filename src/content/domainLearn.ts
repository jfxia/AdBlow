import type { KvStore } from './storage.ts';
import {
  aggregateGlobalDomains,
  appendCleanupLog,
  effectiveDomainHits,
  pruneDomainEntries,
  rankGlobalDomainEvictions,
  resolveLimits,
  resolveNow,
  type LimitOptions,
  type CleanupRemoval,
  type RuleLimits,
} from './ruleLimits.ts';

/**
 * Network-layer learning: promote domains used by hidden ads into DNR rules.
 *
 * DOM hiding only makes ads invisible while requests still go out (bandwidth,
 * tracking), and unknown sites had no network rules at all. A domain seen in ads
 * PROMOTE_DOMAIN_AFTER times is promoted, after which its requests are blocked
 * before they start — zero-config and improving with use.
 *
 * Anti-pollution matches the selector learner: accumulate hits before promoting,
 * and every entry stays revocable.
 *
 * Growth is bounded by the safety valves in ruleLimits.ts: per-site domains expire and
 * are capped, and the distinct domains across all sites are capped, with the weakest
 * (fewest decayed hits, then longest unused) evicted first. Write and read paths both
 * prune, since data written before the valves existed may already be over a cap.
 */

export const PROMOTE_DOMAIN_AFTER = 3;

export type DomainEntry = {
  host: string;
  hits: number;
  promoted: boolean;
  lastSeenAt: number;
  /** Page where it first appeared; lets the user judge whether learning was right. */
  samplePage: string;
};

export type DomainMap = Record<string, DomainEntry>;

export const domainsKey = (pageHost: string): string => `adDomains:${pageHost}`;

const PREFIX = 'adDomains:';

export function hostFromDomainsKey(key: string): string | null {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}

/** One site's domain map after pruning, ready to be persisted. */
async function writeDomainMap(
  store: KvStore,
  key: string,
  entries: readonly DomainEntry[],
  now: number,
  removals: readonly CleanupRemoval[],
): Promise<void> {
  const next: DomainMap = {};
  for (const entry of entries) next[entry.host] = entry;

  // Drop the key once empty; a leftover empty key shows up as an empty UI group.
  if (Object.keys(next).length === 0) await store.remove(key);
  else await store.set(key, next);
  await appendCleanupLog(store, now, removals);
}

/**
 * Prune one site's domain map and persist the result only if something changed.
 * Returns the surviving entries (raw counters).
 */
async function persistPrunedDomains(
  store: KvStore,
  key: string,
  entries: readonly DomainEntry[],
  now: number,
  limits: RuleLimits,
): Promise<DomainEntry[]> {
  const { kept, removals } = pruneDomainEntries(entries, now, limits);
  if (removals.length > 0) await writeDomainMap(store, key, kept, now, removals);
  return kept;
}

export async function recordDomains(
  store: KvStore,
  pageHost: string,
  domains: string[],
  pageUrl: string,
  options: LimitOptions = {},
): Promise<void> {
  if (domains.length === 0) return;

  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const key = domainsKey(pageHost);
  const current = (await store.get<DomainMap>(key)) ?? {};

  for (const host of domains) {
    const prev = current[host] ?? {
      host,
      hits: 0,
      promoted: false,
      lastSeenAt: now,
      samplePage: pageUrl,
    };
    // Decay of the entry being seen is baked in here; its anchor moves to `now` with the
    // new sighting. Other entries keep their raw counter (see ruleLimits).
    const hits = effectiveDomainHits(prev, now, limits) + 1;
    current[host] = {
      ...prev,
      host,
      hits,
      lastSeenAt: now,
      promoted: prev.promoted || hits >= PROMOTE_DOMAIN_AFTER,
    };
  }

  const { kept, removals } = pruneDomainEntries(Object.values(current), now, limits);
  await writeDomainMap(store, key, kept, now, removals);
}

/** Promoted domains for one page host. */
export async function promotedDomainsFor(
  store: KvStore,
  pageHost: string,
  options: LimitOptions = {},
): Promise<string[]> {
  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const key = domainsKey(pageHost);
  const current = (await store.get<DomainMap>(key)) ?? {};
  const kept = await persistPrunedDomains(store, key, Object.values(current), now, limits);
  return kept
    .filter((e) => e.promoted)
    .map((e) => e.host)
    .sort();
}

export type DomainSite = { pageHost: string; entries: DomainEntry[] };

/**
 * Read every site's domains, apply both levels of the policy, and persist what changed:
 * first the per-site caps/TTL, then the global distinct-domain cap.
 *
 * Every domain read path goes through here, which is also why the global cap needs no
 * scan of its own on the write path: the service worker runs this on every `adDomains:*`
 * storage change (storage.onChanged → syncDnrRules → allPromotedDomainScopes), so a write
 * from a content script is followed by a global prune without paying for an O(sites)
 * scan inside the page.
 */
async function pruneDomainStore(store: KvStore, options: LimitOptions): Promise<DomainSite[]> {
  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX)).sort();

  const sites: (DomainSite & { key: string })[] = [];
  for (const key of keys) {
    const pageHost = hostFromDomainsKey(key);
    if (!pageHost) continue;
    const current = (await store.get<DomainMap>(key)) ?? {};
    const entries = await persistPrunedDomains(store, key, Object.values(current), now, limits);
    sites.push({ pageHost, key, entries });
  }

  const candidates = aggregateGlobalDomains(sites, now, limits);
  const evicted = new Set(rankGlobalDomainEvictions(candidates, limits.maxGlobalDomains));
  if (evicted.size > 0) {
    let removedEntries = 0;
    for (const site of sites) {
      const before = site.entries.length;
      const kept = site.entries.filter((e) => !evicted.has(e.host));
      if (kept.length === before) continue;
      removedEntries += before - kept.length;
      site.entries = kept;
      await writeDomainMap(store, site.key, kept, now, []);
    }
    await appendCleanupLog(store, now, [
      { reason: 'domain-global-overflow', removed: removedEntries },
    ]);
  }

  return sites.map(({ pageHost, entries }) => ({ pageHost, entries }));
}

/**
 * **Global** promoted domains (deduplicated).
 *
 * A domain is an ad domain everywhere (`ads.example.com` included), so DNR rules
 * are global too; only user-disabled sites get per-site exemptions.
 */
export async function allPromotedDomains(store: KvStore, options: LimitOptions = {}): Promise<string[]> {
  const sites = await pruneDomainStore(store, options);
  const out = new Set<string>();
  for (const site of sites) {
    for (const entry of site.entries) {
      if (entry.promoted) out.add(entry.host);
    }
  }
  return [...out].sort();
}

/**
 * **Global** promoted domains plus the sites that taught them.
 *
 * Learned domains used to compile into global DNR rules, but "an ad domain here"
 * does not imply "an ad domain there": shared third-party CDNs make this fatal
 * (measured: a video site's own script/player CDN was learned, after which the
 * whole page broke). Scoping each rule with `initiatorDomains` limits the blast
 * radius to the site that taught it.
 *
 * Returns `Map<domain, pageHost[]>`, consumed by `learnedDomainRules`.
 */
export async function allPromotedDomainScopes(
  store: KvStore,
  options: LimitOptions = {},
): Promise<Map<string, string[]>> {
  const sites = await pruneDomainStore(store, options);
  const out = new Map<string, Set<string>>();
  for (const { pageHost, entries } of sites) {
    for (const entry of entries) {
      if (!entry.promoted) continue;
      if (!out.has(entry.host)) out.set(entry.host, new Set());
      out.get(entry.host)!.add(pageHost);
    }
  }
  return new Map([...out].map(([host, hosts]) => [host, [...hosts].sort()]));
}

export async function allDomainEntries(
  store: KvStore,
  options: LimitOptions = {},
): Promise<DomainSite[]> {
  const now = resolveNow(options.now);
  const limits = resolveLimits(options.limits);
  const sites = await pruneDomainStore(store, options);
  return sites.map(({ pageHost, entries }) => ({
    pageHost,
    entries: entries
      .map((e) => ({ ...e, hits: effectiveDomainHits(e, now, limits) }))
      .sort((a, b) => b.hits - a.hits),
  }));
}

export async function forgetDomain(
  store: KvStore,
  pageHost: string,
  host: string,
): Promise<void> {
  const key = domainsKey(pageHost);
  const current = (await store.get<DomainMap>(key)) ?? {};
  if (!(host in current)) return;

  delete current[host];
  // Drop the key once empty; leftover empty keys show up as empty UI groups.
  if (Object.keys(current).length === 0) await store.remove(key);
  else await store.set(key, current);
}

export async function clearDomains(store: KvStore, pageHost: string): Promise<void> {
  await store.remove(domainsKey(pageHost));
}
