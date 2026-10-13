import type { KvStore } from './storage.ts';

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

export async function recordDomains(
  store: KvStore,
  pageHost: string,
  domains: string[],
  pageUrl: string,
): Promise<void> {
  if (domains.length === 0) return;

  const key = domainsKey(pageHost);
  const current = (await store.get<DomainMap>(key)) ?? {};
  const now = Date.now();

  for (const host of domains) {
    const entry = current[host] ?? {
      host,
      hits: 0,
      promoted: false,
      lastSeenAt: now,
      samplePage: pageUrl,
    };
    entry.hits += 1;
    entry.lastSeenAt = now;
    if (entry.hits >= PROMOTE_DOMAIN_AFTER) entry.promoted = true;
    current[host] = entry;
  }

  await store.set(key, current);
}

/** Promoted domains for one page host. */
export async function promotedDomainsFor(store: KvStore, pageHost: string): Promise<string[]> {
  const current = (await store.get<DomainMap>(domainsKey(pageHost))) ?? {};
  return Object.values(current)
    .filter((e) => e.promoted)
    .map((e) => e.host)
    .sort();
}

/**
 * **Global** promoted domains (deduplicated).
 *
 * A domain is an ad domain everywhere (`ads.example.com` included), so DNR rules
 * are global too; only user-disabled sites get per-site exemptions.
 */
export async function allPromotedDomains(store: KvStore): Promise<string[]> {
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX));
  const out = new Set<string>();
  for (const key of keys) {
    const current = (await store.get<DomainMap>(key)) ?? {};
    for (const entry of Object.values(current)) {
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
export async function allPromotedDomainScopes(store: KvStore): Promise<Map<string, string[]>> {
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX)).sort();
  const out = new Map<string, Set<string>>();
  for (const key of keys) {
    const pageHost = hostFromDomainsKey(key);
    if (!pageHost) continue;
    const current = (await store.get<DomainMap>(key)) ?? {};
    for (const entry of Object.values(current)) {
      if (!entry.promoted) continue;
      if (!out.has(entry.host)) out.set(entry.host, new Set());
      out.get(entry.host)!.add(pageHost);
    }
  }
  return new Map([...out].map(([host, hosts]) => [host, [...hosts].sort()]));
}

export async function allDomainEntries(
  store: KvStore,
): Promise<{ pageHost: string; entries: DomainEntry[] }[]> {
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX)).sort();
  const out: { pageHost: string; entries: DomainEntry[] }[] = [];
  for (const key of keys) {
    const pageHost = hostFromDomainsKey(key);
    if (!pageHost) continue;
    const current = (await store.get<DomainMap>(key)) ?? {};
    out.push({ pageHost, entries: Object.values(current).sort((a, b) => b.hits - a.hits) });
  }
  return out;
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
