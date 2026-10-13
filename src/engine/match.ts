/**
 * Match-pattern matching for site rule packs: the minimal MV3 subset
 * `*://host/path` and `*://*.host/path`, with `*` wildcards in host and path.
 * Paths match pathname only (no query) — every in-repo pack uses `/*`, so that is
 * behavior-neutral; distinguishing query would have to be done here.
 */

const PATTERN_RE = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/;

function pathToRegExp(path: string): RegExp {
  const escaped = path
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

function hostMatches(hostPat: string, host: string): boolean {
  if (hostPat === '*') return true;
  if (hostPat.startsWith('*.')) {
    const base = hostPat.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return hostPat === host;
}

export function matchPattern(pattern: string, url: string): boolean {
  const m = PATTERN_RE.exec(pattern);
  if (!m) return false;

  const [, scheme, hostPat, pathPat] = m as unknown as [string, string, string, string];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (scheme !== '*' && scheme !== parsed.protocol.replace(':', '')) return false;
  if (!hostMatches(hostPat, parsed.hostname)) return false;
  return pathToRegExp(pathPat).test(parsed.pathname);
}
