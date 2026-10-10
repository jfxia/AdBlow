/**
 * 站点规则包的 match pattern 匹配。
 *
 * 支持 MV3 match pattern 的最小子集：`*://host/path`、`*://*.host/path`，
 * 其中 host 与 path 可用 `*` 通配。
 *
 * 只对 pathname 做路径匹配（不并入 query）。本项目自有规则包一律用 `/*`，
 * 因此这个简化不影响行为；若将来需要区分 query，必须在此处显式处理。
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
