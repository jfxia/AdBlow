import type { ParsedFilter } from './filterList/parse.ts';
import { isValidRequestDomain } from './filterList/validate.ts';

/**
 * Badware-domain list: built from the `ublock-badware` filter list, read by the worker.
 *
 * Why this exists instead of `declarativeNetRequest.testMatchOutcome`: that API is only
 * available for unpacked extensions, so a store-installed build cannot use it at all.
 * This list is a build-time export of the same list's domain-anchored rules, and the
 * runtime match is a plain hostname suffix test.
 *
 * Failure direction is deliberately the opposite of the DNR gate that preceded it: a
 * missing or unreadable list means "no evidence", and the banner handler is **allowed**
 * to run. The old gate fail-closed on a missing answer, which would silently disable the
 * whole feature on every packaged build. A consent banner on an unknown site is a much
 * smaller problem than never dismissing any banner anywhere.
 */

/** Source list id in filters/meta.json. */
export const BADWARE_LIST_ID = 'ublock-badware';

/** File name at the extension root. Must stay a literal at the getURL call site. */
export const BADWARE_DOMAINS_FILE = 'badware-domains.json';

/** Shape written by tools/build/gen-rulesets.ts. */
export type BadwareDomainFile = {
  generatedFrom: string;
  domains: string[];
};

/** `||example.com^`, `||example.com`, `||example.com^|` — a bare domain anchor. */
const DOMAIN_ANCHOR_RE = /^\|\|([a-z0-9.-]+)\^?\|?$/i;

/**
 * Extract the domain from one filter pattern, or null.
 *
 * Only bare domain anchors qualify. Path patterns, regexes and wildcard hosts are not
 * evidence that the host itself is badware, and a malformed domain would poison the
 * suffix match (`||allyes.` from a truncated list line).
 */
export function badwareDomainFromPattern(pattern: string): string | null {
  const match = DOMAIN_ANCHOR_RE.exec((pattern ?? '').trim());
  if (!match) return null;
  const domain = match[1]!.toLowerCase().replace(/\.$/, '');
  return isValidRequestDomain(domain) ? domain : null;
}

/**
 * Domains to export from the parsed filters.
 *
 * Scoped rules (`$domain=...`, `$to=...`, `$denyallow=...`) are skipped: the domain is
 * only badware in the context of another site. Exceptions (`@@`) subtract from the block
 * set, and `$badfilter` rules are ignored because they cancel another rule. The result is
 * lowercase, unique and sorted.
 */
export function extractBadwareDomains(
  filters: readonly ParsedFilter[],
  source: string = BADWARE_LIST_ID,
): string[] {
  const blocked = new Set<string>();
  const allowed = new Set<string>();

  for (const filter of filters) {
    if (filter.source !== undefined && filter.source !== source) continue;
    if (filter.badfilter) continue;
    if (filter.initiatorDomains?.length) continue;
    if (filter.excludedInitiatorDomains?.length) continue;
    // Same rule for target scoping (`$to=` / `$denyallow=`): the host's badness is
    // then conditional on where the request goes. Measured examples would otherwise
    // add legitimate hosts to the runtime gate (`||roblox.com.$all,to=~cloudflare.net`,
    // whose trailing-dot pattern still parses to `roblox.com`).
    if (filter.requestDomains?.length) continue;
    if (filter.excludedRequestDomains?.length) continue;
    const domain = badwareDomainFromPattern(filter.pattern);
    if (!domain) continue;
    if (filter.exception) allowed.add(domain);
    else blocked.add(domain);
  }

  for (const domain of allowed) blocked.delete(domain);
  return [...blocked].sort();
}

/** Normalize one hostname for comparison; strips case, trailing dot and port. */
export function normalizeBadwareHost(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/** Normalize one list entry; empty/invalid entries are dropped by the parser. */
function normalizeListDomain(raw: string): string | null {
  const domain = normalizeBadwareHost(raw).replace(/^\./, '');
  if (!domain || !isValidRequestDomain(domain)) return null;
  return domain;
}

/**
 * Parse the generated JSON file.
 *
 * Returns `null` when the file is missing the `domains` array (old artifact, corrupt
 * JSON, wrong shape) so the caller can log "unavailable" once and allow handling.
 * An **empty array is valid** and returns an empty set: it means the build had no badware
 * domains, not that the file is broken.
 */
export function parseBadwareDomainFile(raw: unknown): Set<string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const domains = (raw as { domains?: unknown }).domains;
  if (!Array.isArray(domains)) return null;

  const out = new Set<string>();
  for (const entry of domains) {
    if (typeof entry !== 'string') continue;
    const domain = normalizeListDomain(entry);
    if (domain) out.add(domain);
  }
  return out;
}

/**
 * Hostname suffix match at dot boundaries.
 *
 * `a.com` covers `a.com`, `www.a.com` and `x.y.a.com`; it does **not** cover `nota.com`
 * or `a.com.evil`, so a plain `endsWith`/`includes` is deliberately not used. The host
 * is also tried with a leading `www.` removed, as required by the store-page convention
 * of listing both forms.
 */
export function isBadwareHost(host: string, domains: ReadonlySet<string>): boolean {
  const normalized = normalizeBadwareHost(host);
  if (!normalized) return false;

  const candidates = normalized.startsWith('www.')
    ? [normalized, normalized.slice('www.'.length)]
    : [normalized];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (domains.has(candidate)) return true;
    let dot = candidate.indexOf('.');
    while (dot >= 0) {
      const parent = candidate.slice(dot + 1);
      if (parent && domains.has(parent)) return true;
      dot = candidate.indexOf('.', dot + 1);
    }
  }
  return false;
}

export type BadwareIndex = {
  domains: Set<string>;
  /** False when the file could not be read or parsed; callers allow on false. */
  available: boolean;
};

export type BadwareIndexLoaderOptions = {
  /** Reads and parses the JSON value (the worker supplies fetch + getURL). */
  loadFile: () => Promise<unknown>;
  /** Called once on success, for the worker's startup line. */
  onLoaded?: (count: number) => void;
  /** Called once on failure. The failure result is cached too, so this is not a retry loop. */
  onUnavailable?: (error: unknown) => void;
};

/**
 * Lazy, cached loader for the badware index.
 *
 * The service worker can be woken by many tabs at once, so the load must be a single
 * in-flight promise: a retry per content-script message would re-fetch the file and log
 * repeatedly. Failure is cached as well — "missing list" is a stable build property, not
 * a transient condition worth retrying for every page.
 */
export function createBadwareIndexLoader(
  options: BadwareIndexLoaderOptions,
): { load: () => Promise<BadwareIndex> } {
  let pending: Promise<BadwareIndex> | null = null;
  return {
    load(): Promise<BadwareIndex> {
      if (!pending) {
        pending = (async () => {
          try {
            const file = await options.loadFile();
            const domains = parseBadwareDomainFile(file);
            if (!domains) throw new Error('missing or invalid domains array');
            options.onLoaded?.(domains.size);
            return { domains, available: true };
          } catch (error) {
            options.onUnavailable?.(error);
            return { domains: new Set<string>(), available: false };
          }
        })();
      }
      return pending;
    },
  };
}
