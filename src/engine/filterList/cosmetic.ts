/**
 * Parsing and compiling of cosmetic (element-hiding) rules.
 *
 * Scope: domain-specific rules (`example.com##.ad`) are enabled — precise and
 * controllable. Generic rules (`##.ad`) are parsed and counted but never injected,
 * matching uBlock Origin Lite: applying them site-wide hurts more than it helps.
 *
 * Syntax coverage (measured over 6 lists, 36,019 cosmetic rules):
 *   `##` hide and `#@#` unhide → enabled
 *   `#?#` procedural, `#$#` style, `##+js(...)` scriptlet → counted only, phase 3
 *
 * Browser-agnostic: unit-testable in Node.
 */

export type CosmeticFlavor = 'hide' | 'unhide' | 'procedural' | 'style' | 'scriptlet';

export type CosmeticFilter = {
  raw: string;
  /** Scope domains; an empty array means a generic rule (all sites). */
  domains: string[];
  /** Domains excluded via `~domain`. */
  excludedDomains: string[];
  /** Selector (raw arguments for procedural/scriptlet rules). */
  selector: string;
  flavor: CosmeticFlavor;
};

/** Separator → flavor. Order matters: longer separators first. */
const SEPARATORS: [string, CosmeticFlavor][] = [
  ['#@#+js(', 'scriptlet'],
  ['##+js(', 'scriptlet'],
  ['#@?#', 'procedural'],
  ['#?#', 'procedural'],
  ['#@$#', 'style'],
  ['#$#', 'style'],
  ['#@#', 'unhide'],
  ['##', 'hide'],
];

/**
 * Split a selector list on top-level commas.
 *
 * A plain `split(',')` is wrong: selectors carry commas inside `:has(a, b)`,
 * `:not(.x, .y)` or `[attr="a,b"]`, and splitting there yields invalid selectors.
 */
export function splitTopLevel(selectorList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const ch of selectorList) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

    if (ch === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Coarse check that a selector could be valid CSS.
 *
 * No full CSS parse (the browser is the final judge); only obviously broken forms
 * are rejected: empty, whitespace-only, angle brackets, bare braces.
 * ⚠️ One invalid selector discards the whole stylesheet rule, so under-injecting
 * is the safe side.
 */
export function looksLikeValidSelector(selector: string): boolean {
  const s = selector.trim();
  if (!s || s.length > 500) return false;
  if (/[{}<>]/.test(s)) return false;
  // Must start with a tag name / # / . / [ / : / *
  return /^[a-z*#.[:]/i.test(s);
}

/** Parse one cosmetic rule; null when the line is not cosmetic. */
export function parseCosmeticLine(rawLine: string): CosmeticFilter | null {
  const raw = rawLine.trim();
  if (!raw || raw.startsWith('!')) return null;

  let sepIndex = -1;
  let flavor: CosmeticFlavor | null = null;
  for (const [sep, f] of SEPARATORS) {
    const i = raw.indexOf(sep);
    if (i >= 0 && (sepIndex < 0 || i < sepIndex)) {
      sepIndex = i;
      flavor = f;
    }
  }
  if (sepIndex < 0 || !flavor) return null;

  const sep = SEPARATORS.find(([, f]) => f === flavor)![0];
  const domainPart = raw.slice(0, sepIndex);
  // Scriptlet rules: the "selector" is the `+js(...)` payload, not CSS
  const selectorPart =
    flavor === 'scriptlet' ? raw.slice(sepIndex).replace(/^#@?#?##?\+js\(/, '').replace(/\)$/, '') : raw.slice(sepIndex + sep.length);

  const domains: string[] = [];
  const excludedDomains: string[] = [];
  if (domainPart) {
    for (const item of domainPart.split(',')) {
      const d = item.trim().toLowerCase();
      if (!d) continue;
      if (d.startsWith('~')) excludedDomains.push(d.slice(1));
      else domains.push(d);
    }
  }

  const selector = selectorPart.trim();
  if (!selector) return null;

  return { raw, domains, excludedDomains, selector, flavor };
}

export type CosmeticIndex = {
  /** Domain → selectors to hide there */
  hideByDomain: Map<string, Set<string>>;
  /** Domain → selectors to un-hide there (`#@#`) */
  unhideByDomain: Map<string, Set<string>>;
  /** Generic hide selectors (not injected by default, see header) */
  genericHide: Set<string>;
  /** Generic exceptions */
  genericUnhide: Set<string>;
  stats: {
    parsed: number;
    hide: number;
    unhide: number;
    generic: number;
    domainSpecific: number;
    /** Procedural / style / scriptlet: counted only, not emitted yet */
    deferred: Record<string, number>;
    invalidSelectors: number;
    /** Rules with `~`: whole-rule exclusion only, no "everywhere but x" form */
    skippedExcluded: number;
  };
};

/**
 * Compile parsed rules into a per-domain index.
 *
 * ⚠️ `~domain` means "everywhere except these". A forward domain index cannot
 * express that, so such rules are skipped and counted — treating them as positive
 * rules would apply them to the very sites they exclude.
 */
export function buildCosmeticIndex(filters: CosmeticFilter[]): CosmeticIndex {
  const index: CosmeticIndex = {
    hideByDomain: new Map(),
    unhideByDomain: new Map(),
    genericHide: new Set(),
    genericUnhide: new Set(),
    stats: {
      parsed: filters.length,
      hide: 0,
      unhide: 0,
      generic: 0,
      domainSpecific: 0,
      deferred: {},
      invalidSelectors: 0,
      skippedExcluded: 0,
    },
  };

  const add = (map: Map<string, Set<string>>, domain: string, selector: string): void => {
    const set = map.get(domain);
    if (set) set.add(selector);
    else map.set(domain, new Set([selector]));
  };

  for (const f of filters) {
    if (f.flavor === 'procedural' || f.flavor === 'style' || f.flavor === 'scriptlet') {
      index.stats.deferred[f.flavor] = (index.stats.deferred[f.flavor] ?? 0) + 1;
      continue;
    }

    if (!looksLikeValidSelector(f.selector)) {
      index.stats.invalidSelectors += 1;
      continue;
    }

    if (f.excludedDomains.length > 0) {
      index.stats.skippedExcluded += 1;
      continue;
    }

    const isHide = f.flavor === 'hide';
    if (f.domains.length === 0) {
      if (isHide) {
        index.genericHide.add(f.selector);
        index.stats.hide += 1;
      } else {
        index.genericUnhide.add(f.selector);
        index.stats.unhide += 1;
      }
      index.stats.generic += 1;
      continue;
    }

    for (const domain of f.domains) {
      if (isHide) add(index.hideByDomain, domain, f.selector);
      else add(index.unhideByDomain, domain, f.selector);
    }
    index.stats.domainSpecific += 1;
    if (isHide) index.stats.hide += 1;
    else index.stats.unhide += 1;
  }

  return index;
}

/**
 * Selectors that apply to a hostname.
 *
 * ABP semantics: `example.com##.ad` applies to `example.com` and all its
 * subdomains, so walk up the hostname (`a.b.example.com` → `b.example.com` →
 * `example.com`) and subtract the `#@#` exceptions seen along the way.
 */
export function selectorsForHost(index: CosmeticIndex, host: string): string[] {
  const keys = domainKeysForHost(host);
  const result = new Set<string>();
  const unhide = new Set<string>();

  for (const key of keys) {
    for (const s of index.hideByDomain.get(key) ?? []) result.add(s);
    for (const s of index.unhideByDomain.get(key) ?? []) unhide.add(s);
  }

  for (const s of unhide) result.delete(s);
  return [...result];
}

/** CSS to inject (`display:none !important`, matching the existing hideElement). */
export function cosmeticCssFor(selectors: string[]): string {
  if (selectors.length === 0) return '';
  return `${selectors.join(',')}{display:none!important;}`;
}

// Why shards: domain-specific rules span tens of thousands of hostnames and a
// multi-MB JSON cannot be read on every page load. Splitting by domain hash means
// the runtime reads only the ~2-3 shards (a few KB each) holding the current
// hostname and its parents, via `chrome.runtime.getURL()` — local files, no network.
//
// Generator and runtime must share one hash function, so it lives here, with tests.

/** Shard count: 256 keeps each shard to a few dozen domains and a few KB. */
export const COSMETIC_SHARD_COUNT = 256;

/** FNV-1a 32-bit hash (deterministic, dependency-free, identical on both ends). */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shardOf(domain: string, shardCount = COSMETIC_SHARD_COUNT): number {
  return fnv1a(domain.toLowerCase()) % shardCount;
}

/**
 * Domains to query for a hostname under ABP semantics (itself plus each parent).
 *
 * `a.b.example.com` → `['a.b.example.com','b.example.com','example.com']`.
 * Capped at 6 levels so a malformed hostname cannot trigger endless lookups.
 */
export function domainsToQuery(host: string, maxLevels = 6): string[] {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < labels.length && i < maxLevels; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

/**
 * As above, plus wildcard-TLD keys.
 *
 * Lists contain `amazon.*` / `momondo.*` rules (measured 250 keys, 2.3%), and a
 * literal-suffix lookup never matches them, so add an `xxx.*` key per suffix level.
 */
export function domainKeysForHost(host: string, maxLevels = 6): string[] {
  const keys = new Set(domainsToQuery(host, maxLevels));
  for (const d of [...keys]) {
    const parts = d.split('.');
    if (parts.length < 2) continue;
    // Replace only the last label: `amazon.com` → `amazon.*`
    keys.add([...parts.slice(0, -1), '*'].join('.'));
    // ccTLD second-level suffixes (co.jp, com.au, co.uk…) need one more level:
    // `amazon.*` covers any public suffix under ABP semantics. Rather than a full
    // public-suffix table, use the cheap "last label is 2 letters" test.
    const tld = parts[parts.length - 1]!;
    if (/^[a-z]{2}$/.test(tld) && parts.length >= 3) {
      keys.add([...parts.slice(0, -2), '*'].join('.'));
    }
  }
  return [...keys];
}

/** Which shards a hostname needs (deduped, ascending). */
export function shardsForHost(host: string, shardCount = COSMETIC_SHARD_COUNT): number[] {
  const set = new Set(domainKeysForHost(host).map((d) => shardOf(d, shardCount)));
  return [...set].sort((a, b) => a - b);
}

export type CosmeticShard = {
  /** Domain → hide selectors */
  hide: Record<string, string[]>;
  /** Domain → un-hide selectors */
  unhide: Record<string, string[]>;
};

/** Split the index into N shards. */
export function shardIndex(index: CosmeticIndex, shardCount = COSMETIC_SHARD_COUNT): CosmeticShard[] {
  const shards: CosmeticShard[] = Array.from({ length: shardCount }, () => ({ hide: {}, unhide: {} }));
  for (const [domain, selectors] of index.hideByDomain) {
    shards[shardOf(domain, shardCount)]!.hide[domain] = [...selectors];
  }
  for (const [domain, selectors] of index.unhideByDomain) {
    shards[shardOf(domain, shardCount)]!.unhide[domain] = [...selectors];
  }
  return shards;
}

/**
 * Collect the selectors a hostname should apply from a set of shards.
 *
 * This is the runtime's main path, hence a pure function: shards + hostname →
 * selectors. Same semantics as `selectorsForHost`: walk up the parents, then
 * subtract `#@#` exceptions.
 */
export function selectorsFromShards(
  shards: (CosmeticShard | null)[],
  host: string,
): string[] {
  const domains = domainKeysForHost(host);
  const hide = new Set<string>();
  const unhide = new Set<string>();

  for (const shard of shards) {
    if (!shard) continue;
    for (const domain of domains) {
      for (const s of shard.hide[domain] ?? []) hide.add(s);
      for (const s of shard.unhide[domain] ?? []) unhide.add(s);
    }
  }
  for (const s of unhide) hide.delete(s);
  return [...hide];
}
