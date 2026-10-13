import { registrableDomain } from '../engine/score.ts';

/**
 * Click-hijack verdict logic. Pure functions, so "should this click be blocked" is fully
 * unit-testable without launching a browser.
 *
 * Three criteria, matching three real techniques: a script-synthesized click on a
 * cross-site link (usually a hidden `<a>` created at runtime and `.click()`ed, caught via
 * `isTrusted === false`); a real click inside an ad we already hid; and a real click on an
 * invisible full-viewport overlay.
 *
 * Blocking all cross-site clicks is not an option — it would kill every normal outbound
 * link — so each criterion first requires evidence that the click is not a normal one.
 */

export type ClickGuardInput = {
  /** False for script-synthesized events. */
  trusted: boolean;
  pageHost: string;
  /** href of the link owning the target (or topmost) element, null if none. */
  linkHref: string | null;
  /** Link is zero-sized/invisible — typical of synthetic hijack anchors. */
  linkIsInvisible: boolean;
  /** Probe/target sits inside an ad subtree we already hid. */
  insideHiddenAd: boolean;
  /** Topmost element at the point is an invisible full-viewport layer. */
  overInvisibleLayer: boolean;
};

export type ClickGuardVerdict = {
  block: boolean;
  reason: string | null;
};

/** True when href targets a different registrable domain than the page. */
export function isCrossSiteHref(href: string, pageHost: string): boolean {
  if (!href) return false;
  if (!/^https?:/i.test(href) && !href.startsWith('//')) return false;
  try {
    const parsed = new URL(href, `https://${pageHost}`);
    return registrableDomain(parsed.hostname) !== registrableDomain(pageHost);
  } catch {
    return false;
  }
}

export function shouldBlockClick(input: ClickGuardInput): ClickGuardVerdict {
  const crossSite = input.linkHref ? isCrossSiteHref(input.linkHref, input.pageHost) : false;

  // Synthetic click on an invisible cross-site link. Requiring invisibility avoids
  // breaking legitimate programmatic downloads (those anchors usually have a size).
  if (!input.trusted) {
    if (crossSite && input.linkIsInvisible) {
      return { block: true, reason: 'synthetic-hidden-cross-site-click' };
    }
    return { block: false, reason: null };
  }

  if (input.insideHiddenAd) {
    return { block: true, reason: 'click-inside-hidden-ad' };
  }

  // Main click-hijack path.
  if (input.overInvisibleLayer) {
    return { block: true, reason: 'invisible-click-layer' };
  }

  return { block: false, reason: null };
}

/** Event types that can trigger navigation (worth suspecting on document-level handlers). */
export const NAVIGATION_EVENT_TYPES = new Set([
  'click',
  'mousedown',
  'mouseup',
  'pointerdown',
  'pointerup',
  'auxclick',
  'touchstart',
  'touchend',
]);

/**
 * Source text of a listener — either a function or an object with `handleEvent`.
 */
function listenerSource(listener: unknown): string {
  if (typeof listener === 'function') return String(listener);
  const handleEvent = (listener as { handleEvent?: unknown } | null)?.handleEvent;
  return typeof handleEvent === 'function' ? String(handleEvent) : '';
}

/**
 * Whether a **document-level** click listener performs a navigation (click-hijack shape).
 *
 * Measured case: `document.addEventListener('click', () => { location.href = ad }, true)`.
 * The click target is normal content, so the event layer cannot block it — that would
 * block normal clicks — and assigning `location.href` itself cannot be intercepted.
 * Refusing the registration is the only viable spot.
 *
 * Only the navigation operation itself is matched (assignment or an assign/replace call),
 * not any mention of `location`; otherwise SPA routers, which read `location.pathname` and
 * call `history.pushState` in document-level listeners, would be broken.
 *
 * Tradeoff: a site that really does a full-page redirect from a document-level listener is
 * blocked too. Normal sites use `<a href>` or the History API, so this is acceptable.
 */
export function looksLikeNavigationHijack(listener: unknown): boolean {
  const source = listenerSource(listener);
  if (!source) return false;

  // Boundary: `location` must not be part of a longer identifier (mylocation), but a
  // leading `.` is allowed (window.location / self.location).
  const L = String.raw`(?:^|[^\w$])location`;

  // location.href = … / location['href'] = … / location.assign = …
  if (new RegExp(`${L}\\s*(?:\\.\\s*|\\[\\s*["']?)(?:href|assign|replace)["']?\\s*\\]?\\s*=[^=]`, 'i').test(source)) {
    return true;
  }
  // location.assign(…) / location.replace(…) / location['assign'](…)
  if (new RegExp(`${L}\\s*\\.\\s*(?:assign|replace)\\s*\\(`, 'i').test(source)) return true;
  if (new RegExp(`${L}\\s*\\[\\s*["'](?:assign|replace)["']\\s*\\]\\s*\\(`, 'i').test(source)) return true;
  // location = '…' / self.location = '…' (whole-object replacement; skip declarations)
  if (!/(?:^|[^.\w])(?:const|let|var)\s+location\s*=/.test(source)) {
    if (new RegExp(`${L}\\s*=[^=]`, 'i').test(source)) return true;
    if (/(?:^|[^\w$])(?:self|top|parent|window|document)\s*\.\s*location\s*=[^=]/i.test(source)) {
      return true;
    }
  }
  // window.open(…) / self.open(…)
  if (/(?:^|[^\w$])(?:window|self|top)\s*\.\s*open\s*\(/i.test(source)) return true;

  return false;
}
