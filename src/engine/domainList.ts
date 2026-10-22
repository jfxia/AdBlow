import { isValidRequestDomain } from './filterList/validate.ts';

/**
 * Shared helpers for packaged hostname snapshots.
 *
 * Two features read a JSON list of hostnames at runtime: the badware gate (cookie-consent
 * handling leaves listed sites alone) and the popup denylist (window.open to a listed host is
 * refused). They share the file shape, normalization and the dot-boundary suffix match --
 * deliberately, because two copies of a security check drift apart, and the difference between
 * `a.com` covering `nota.com` or not is exactly the kind of drift that cannot be found by eye.
 *
 * Pure module: no chrome.* / DOM access, so the same code runs in the build script, the service
 * worker, an isolated content script and the MAIN-world bundle.
 */

/** The runtime form of a packaged domain list. */
export type DomainIndex = {
  domains: Set<string>;
  /** False when the file could not be read or parsed; callers allow on false. */
  available: boolean;
};

/** `||example.com^`, `||example.com`, `||example.com^|` — a bare domain anchor. */
const DOMAIN_ANCHOR_RE = /^\|\|([a-z0-9.-]+)\^?\|?$/i;

/**
 * Extract the domain from one filter pattern, or null.
 *
 * Only bare domain anchors qualify. Path patterns, regexes and wildcard hosts are not evidence
 * that the host itself is an ad/popup host, and a malformed domain would poison the suffix
 * match (`||allyes.` from a truncated list line).
 */
export function domainFromAnchor(pattern: string): string | null {
  const match = DOMAIN_ANCHOR_RE.exec((pattern ?? '').trim());
  if (!match) return null;
  const domain = match[1]!.toLowerCase().replace(/\.$/, '');
  return isValidRequestDomain(domain) ? domain : null;
}

/** Normalize one hostname for comparison; strips case, trailing dot and port. */
export function normalizeHost(raw: string): string {
  return (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/** Normalize one list entry; empty/invalid entries are dropped by the parser. */
export function normalizeDomainEntry(raw: string): string | null {
  const domain = normalizeHost(raw).replace(/^\./, '');
  if (!domain || !isValidRequestDomain(domain)) return null;
  return domain;
}

/**
 * Parse a JSON array of hostnames.
 *
 * Returns `null` when the value is not an array, so the caller can tell "unavailable" from
 * "valid but empty": an empty array means the build had no entries, not that the file is
 * broken. Invalid entries are dropped individually.
 */
export function domainSetFromArray(raw: unknown): Set<string> | null {
  if (!Array.isArray(raw)) return null;
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const domain = normalizeDomainEntry(entry);
    if (domain) out.add(domain);
  }
  return out;
}

/**
 * Parse a generated list file (`{ generatedFrom, domains }`).
 *
 * Returns `null` when the file is missing the `domains` array (old artifact, corrupt JSON,
 * wrong shape) so the caller can log "unavailable" once and allow. An **empty array is
 * valid** and returns an empty set.
 */
export function parseDomainFile(raw: unknown): Set<string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return domainSetFromArray((raw as { domains?: unknown }).domains);
}

/**
 * Hostname suffix match at dot boundaries.
 *
 * `a.com` covers `a.com`, `www.a.com` and `x.y.a.com`; it does **not** cover `nota.com` or
 * `a.com.evil`, so a plain `endsWith`/`includes` is deliberately not used. The host is also
 * tried with a leading `www.` removed, as required by the store-page convention of listing
 * both forms.
 */
export function isListedHost(host: string, domains: ReadonlySet<string>): boolean {
  const normalized = normalizeHost(host);
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

export type DomainIndexLoaderOptions = {
  /** Reads and parses the JSON value (the worker supplies fetch + getURL). */
  loadFile: () => Promise<unknown>;
  /** Called once on success, for the worker's startup line. */
  onLoaded?: (count: number) => void;
  /** Called once on failure. The failure result is cached too, so this is not a retry loop. */
  onUnavailable?: (error: unknown) => void;
};

/**
 * Lazy, cached loader for a packaged domain index.
 *
 * The service worker can be woken by many tabs at once, so the load must be a single
 * in-flight promise: a retry per content-script message would re-fetch the file and log
 * repeatedly. Failure is cached as well -- "missing list" is a stable build property, not a
 * transient condition worth retrying for every page.
 */
export function createDomainIndexLoader(
  options: DomainIndexLoaderOptions,
): { load: () => Promise<DomainIndex> } {
  let pending: Promise<DomainIndex> | null = null;
  return {
    load(): Promise<DomainIndex> {
      if (!pending) {
        pending = (async () => {
          try {
            const file = await options.loadFile();
            const domains = parseDomainFile(file);
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
