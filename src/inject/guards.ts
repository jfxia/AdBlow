import { registrableDomain } from '../engine/score.ts';
import { isPopupAllowlistedHost } from './popupAllow.ts';

/**
 * window.open policy: deny cross-site windows by default, allow only what the browser itself
 * would have opened.
 *
 * Why the default flipped: a popunder does not need a suspicious URL, it needs a *real click*.
 * The previous rule ("with a gesture, any control may open anything") allowed exactly the
 * reported case -- a click on a play button, then a cross-site window. Chasing those windows by
 * ad-domain blacklist cannot keep up: new hosts and random subdomains appear faster than lists
 * are updated. So the decision is inverted: a cross-site target is refused unless something
 * concrete says the user meant it.
 *
 * The allow rules, in order:
 *   1. empty / `about:blank` / `javascript:` -- never a real window;
 *   2. no user gesture -- never;
 *   3. the site's popup escape hatch is on -- the user explicitly allowed it here;
 *   4. the target is on the packaged `$popup` denylist -- refused even from a control;
 *   5. same registrable domain as the page;
 *   6. the gesture landed on an `<a>` whose href is the same origin or registrable domain as
 *      the target (the browser opens it that way anyway);
 *   7. the target is a known sign-in / checkout / payment host;
 *   8. everything else -- refused.
 *
 * Rules 3 and 4 sit above 5-7 on purpose: the `$popup` list must win over a play-button click,
 * while the escape hatch must win over the list, or a user who just allowed popups on a site
 * would still have them blocked.
 *
 * Rules 5-8 judge the **unwrapped** target when the window opens a same-site wrapper page that
 * carries another absolute URL in a query parameter (`/pop?url=<encoded ad>`). Such a wrapper
 * is same-site by its own host and used to pass rule 5, after which the page itself navigated
 * to the ad -- the measured bypass on videos.example (2026-10-22). The wrapper is only a string
 * we read before anything loads: no redirect is followed, only the first layer is unwrapped.
 *
 * The cost is that a site opening a cross-site window from a `<button>` (OAuth buttons, "share
 * to X", payment redirects built by script) now needs either an `<a>` markup or the per-site
 * switch. That trade is deliberate: those cases are visible and fixable, a drive-by popunder is
 * not.
 */

/** Inputs collected by the MAIN-world guard at call time. */
export type OpenRequest = {
  url: string;
  /** Hostname of the page that called `window.open` (no port). */
  pageHost: string;
  hadUserGesture: boolean;
  /** `href` of the `<a>` the gesture landed on; null when it did not land on a link. */
  gestureAnchorHref?: string | null;
  /** Target host is on the packaged `$popup` list. */
  popupDenied?: boolean;
  /** The user turned on "allow popups on this site". */
  siteAllowsPopups?: boolean;
};

/** Why a window was allowed or refused; the guard logs/records it, tests assert on it. */
export type OpenReason =
  | 'invalid-target'
  | 'no-gesture'
  | 'site-permitted'
  | 'popup-list'
  | 'same-site'
  | 'anchor-target'
  | 'allowlisted-host'
  | 'cross-site';

export type OpenDecision = {
  allow: boolean;
  reason: OpenReason;
  /**
   * Absolute URL the decision was actually made about, after unwrapping a wrapper page's
   * query parameter (see `unwrapOpenTarget`). The block record uses it so the rule manager
   * names the host that would have loaded, not a stream of same-site wrappers. Absent when
   * the target could not be parsed at all.
   */
  targetUrl?: string;
};

function urlOf(value: string, base: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

/** Same registrable domain (eTLD+1), case-insensitively. Empty hosts never match. */
function sameSite(hostA: string, hostB: string): boolean {
  const a = hostA.toLowerCase();
  const b = hostB.toLowerCase();
  if (!a || !b) return false;
  return registrableDomain(a) === registrableDomain(b);
}

/** Same origin, or same registrable domain -- what a clicked link may legitimately open. */
function matchesAnchor(anchor: URL, target: URL): boolean {
  if (anchor.origin === target.origin) return true;
  // `javascript:` / `data:` anchors have the opaque origin "null" and an empty host; they are
  // not evidence that the user meant a cross-site window.
  if (!anchor.hostname || !target.hostname) return false;
  return sameSite(anchor.hostname, target.hostname);
}

/** How many `decodeURIComponent` passes a query value may take (double encoding is common). */
const MAX_PARAM_DECODE_PASSES = 2;

/**
 * An absolute `http(s)` URL, or null.
 *
 * Deliberately narrow: the value must *be* a URL. A relative reference (`/login`), another
 * scheme (`javascript:`, `data:`) or a word (`abc`) is not a destination carried in a
 * parameter, so it leaves the old judgement path untouched.
 */
function absoluteHttpUrl(value: string): URL | null {
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  try {
    const parsed = new URL(text);
    return parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The real destination carried by a wrapper page, or null.
 *
 * A same-site wrapper (`/pop?url=<encoded ad>`) is judged same-site by its own host, then the
 * wrapper redirects to the ad. Which parameter carries the destination is site-specific
 * (`url`, `to`, `target`, `redirect`, …), so *every* value is tested and the first one that
 * qualifies wins. Only a cross-site `http(s)` URL qualifies: a share or sign-in page that puts
 * `https://same.site/...` or `https://accounts.google.com/...` in a parameter keeps its old
 * judgement. Decoding is bounded (`MAX_PARAM_DECODE_PASSES`); a value that fails to decode
 * after that is simply not a wrapper target. Nothing is fetched or followed here -- this is
 * one string read before the window opens, not redirect tracing.
 */
function wrapperTargetOf(wrapper: URL, pageHost: string): string | null {
  for (const value of wrapper.searchParams.values()) {
    let candidate = value;
    for (let pass = 0; ; pass += 1) {
      const target = absoluteHttpUrl(candidate);
      if (target && !sameSite(target.hostname, pageHost)) return target.href;
      if (pass >= MAX_PARAM_DECODE_PASSES) break;
      let decoded: string;
      try {
        decoded = decodeURIComponent(candidate);
      } catch {
        break; // Malformed percent sequence: keep the value as delivered.
      }
      if (decoded === candidate) break;
      candidate = decoded;
    }
  }
  return null;
}

/**
 * Absolute URL of the destination a `window.open` target really leads to, or null when the
 * target is not a wrapper carrying a cross-site URL.
 *
 * Exported for the guard in `inject/index.ts`: the `$popup` denylist has to be checked against
 * this URL too, or a listed host hidden behind a wrapper is never seen.
 */
export function unwrapOpenTarget(url: string, pageHost: string): string | null {
  const wrapper = urlOf(url, `https://${pageHost}`);
  return wrapper ? wrapperTargetOf(wrapper, pageHost) : null;
}

/**
 * Full policy decision, with the reason.
 *
 * `shouldAllowOpen` is the boolean view of this function, kept because it is the name callers
 * and older tests use.
 */
export function decideOpen(request: OpenRequest): OpenDecision {
  const { url, pageHost, hadUserGesture } = request;

  // 1. Never a real window, gesture or not.
  if (!url || url === 'about:blank' || url.startsWith('javascript:')) {
    return { allow: false, reason: 'invalid-target' };
  }

  // 2. A window with no user gesture is drive-by by definition.
  if (!hadUserGesture) return { allow: false, reason: 'no-gesture' };

  // The target is read here rather than at rule 5 so that rule 4 can report the real host, but
  // the *order* of the rules below is unchanged: the site switch and the `$popup` list still
  // answer before a malformed URL does.
  const wrapper = urlOf(url, `https://${pageHost}`);
  const unwrappedHref = wrapper ? wrapperTargetOf(wrapper, pageHost) : null;
  // A cross-site target carried by a same-site wrapper replaces the wrapper for rules 5-8.
  const target = unwrappedHref ? (urlOf(unwrappedHref, `https://${pageHost}`) ?? wrapper) : wrapper;
  const targetUrl = target?.href;

  // 3. The per-site escape hatch: the user asked for this site's popups, so everything with a
  //    gesture passes, including the `$popup` list below. Deliberately placed before rule 4.
  if (request.siteAllowsPopups) return { allow: true, reason: 'site-permitted', targetUrl };

  // 4. The packaged `$popup` denylist outranks the allow rules below: a play button is still a
  //    play button when it fires an ad window. The caller checks the list against the unwrapped
  //    target as well, so a listed host behind a wrapper lands here.
  if (request.popupDenied) return { allow: false, reason: 'popup-list', targetUrl };

  if (!target) return { allow: false, reason: 'invalid-target' };

  // 5. The page's own windows (help, checkout, media player) stay allowed.
  if (sameSite(target.hostname, pageHost)) return { allow: true, reason: 'same-site', targetUrl };

  // 6. A real link to that site: the user clicked something that points at the same place.
  //    The anchor is NOT unwrapped: an `<a href="/pop?url=<ad>">` is a link to the wrapper,
  //    not evidence that the user meant the ad, so it does not whitelist the decoded target.
  const anchorHref = request.gestureAnchorHref;
  if (anchorHref) {
    const anchor = urlOf(anchorHref, `https://${pageHost}`);
    if (anchor && matchesAnchor(anchor, target)) {
      return { allow: true, reason: 'anchor-target', targetUrl };
    }
  }

  // 7. Stable sign-in / checkout infrastructure (see popupAllow.ts).
  if (isPopupAllowlistedHost(target.hostname)) {
    return { allow: true, reason: 'allowlisted-host', targetUrl };
  }

  // 8. Unknown cross-site target: refuse.
  return { allow: false, reason: 'cross-site', targetUrl };
}

/** Boolean view of `decideOpen`, matching the name older call sites use. */
export function shouldAllowOpen(request: OpenRequest): boolean {
  return decideOpen(request).allow;
}

/**
 * Whether a listener on pagehide/beforeunload looks like an ad beacon. Sites re-attach
 * reporting at unload to compensate for requests we blocked. Source-text heuristics only,
 * so it stays deliberately conservative: block only on clear reporting keywords, to avoid
 * killing a site's legitimate cleanup logic.
 */
export function looksLikeTrackingListener(listener: unknown): boolean {
  const source =
    typeof listener === 'function'
      ? listener.toString()
      : typeof (listener as { handleEvent?: unknown })?.handleEvent === 'function'
        ? String((listener as { handleEvent: () => unknown }).handleEvent)
        : '';
  if (!source) return false;
  return /beacon|navigator\.sendBeacon|report\.json|eventTracking|ab-test|pending/i.test(source);
}
