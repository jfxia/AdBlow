/**
 * Click-triggered navigation watch — **observation only**.
 *
 * Why it exists: the existing guards inspect a handler's *source text* (`location.href = …`,
 * `window.open(…)`) and refuse to install it. That covers the common shapes but not obfuscated
 * or indirect code — and the videos.example popunder SDK is exactly the obfuscated kind. The
 * general answer is to look at the **outcome** instead: a top-frame navigation to another site
 * that follows a click on ordinary content, seconds later.
 *
 * This module only decides when to record such an observation. Nothing here changes behaviour,
 * so a wrong record costs a line in the rule manager, not a broken page.
 *
 * Pure functions: no chrome.*, no DOM, so the decision is unit-testable.
 */

/** How long after a plain-area click a cross-site navigation still counts as click-triggered. */
export const CLICK_WATCH_WINDOW_MS = 5000;

export type PlainClick = {
  /** Page the click happened on (hostname). */
  host: string;
  /** Full URL of that page. */
  url: string;
  /** When the click was reported, ms since epoch. */
  at: number;
};

export type ClickIncident = {
  /** Site the click happened on. */
  host: string;
  count: number;
  firstAt: number;
  lastAt: number;
  /** One recent example, for triage: where it went and when. */
  lastTarget: string;
  lastTargetHost: string;
};

export const CLICK_WATCH_PREFIX = 'clickwatch:';

/** Storage key for a site's observation record. */
export function clickWatchKey(host: string): string {
  return `${CLICK_WATCH_PREFIX}${host}`;
}

/** Hosts of the two URLs, or null when either is not http(s). */
export function httpHosts(fromUrl: string, toUrl: string): { from: string; to: string } | null {
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    if (!/^https?:$/.test(from.protocol) || !/^https?:$/.test(to.protocol)) return null;
    return { from: from.hostname, to: to.hostname };
  } catch {
    return null;
  }
}

/**
 * Should this navigation be recorded as click-triggered?
 *
 * Requires all three: a plain-area click was seen on that tab, it happened within the window,
 * and the navigation crosses to another registrable domain. Same-site navigations are ignored —
 * an SPA route change is not what this watches for.
 */
export function shouldRecordClickNavigation(input: {
  click: PlainClick | null;
  toUrl: string;
  now: number;
  windowMs?: number;
}): { record: boolean; reason: string; targetHost?: string } {
  const windowMs = input.windowMs ?? CLICK_WATCH_WINDOW_MS;
  if (!input.click) return { record: false, reason: 'no click seen' };

  const age = input.now - input.click.at;
  if (age < 0 || age > windowMs) return { record: false, reason: 'outside the window' };

  const hosts = httpHosts(input.click.url, input.toUrl);
  if (!hosts) return { record: false, reason: 'not an http(s) navigation' };

  if (hosts.from.toLowerCase() === hosts.to.toLowerCase()) {
    return { record: false, reason: 'same host' };
  }
  const from = hosts.from.split('.').slice(-2).join('.');
  const to = hosts.to.split('.').slice(-2).join('.');
  if (from === to) return { record: false, reason: 'same registrable domain' };

  return { record: true, reason: 'cross-site navigation after a plain-area click', targetHost: hosts.to };
}

/** Fold a new observation into a site's record (counts, window, one sample). */
export function mergeIncident(
  existing: ClickIncident | null | undefined,
  host: string,
  targetHost: string,
  at: number,
): ClickIncident {
  if (!existing || typeof existing.count !== 'number' || existing.count < 0) {
    return { host, count: 1, firstAt: at, lastAt: at, lastTarget: targetHost, lastTargetHost: targetHost };
  }
  return {
    host: existing.host || host,
    count: existing.count + 1,
    firstAt: existing.firstAt || at,
    lastAt: at,
    lastTarget: targetHost,
    lastTargetHost: targetHost,
  };
}
