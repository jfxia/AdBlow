import { isInvisibleClickLayer } from '../engine/clickLayer.ts';
import { keysToScrub, scrubWindowName } from '../engine/scrub.ts';
import {
  NAVIGATION_EVENT_TYPES,
  looksLikeNavigationHijack,
  shouldBlockClick,
} from './clickGuard.ts';
import { looksLikeTrackingListener, shouldAllowOpen } from './guards.ts';

/**
 * MAIN world injection.
 *
 * Must be MAIN world: `window.open` and event capture can only be patched in the page's own
 * context, which is why no chrome.* API may be used here (unavailable in MAIN world).
 *
 * See design doc §1.4 (persisted popup state) and the click-hijack interception.
 */

const HIDDEN_ATTR = 'data-adblow-hidden';

let hadUserGesture = false;
for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
  addEventListener(type, () => { hadUserGesture = true; }, { capture: true, passive: true });
}

/** Hide immediately, using the same marker and styles as the content script. */
function hideNow(el: Element): void {
  el.setAttribute(HIDDEN_ATTR, '1');
  const style = (el as HTMLElement).style;
  if (!style) return;
  style.setProperty('display', 'none', 'important');
  style.setProperty('height', '0', 'important');
  style.setProperty('margin', '0', 'important');
  style.setProperty('padding', '0', 'important');
}

// window.open guard
const rawOpen = window.open.bind(window);

Object.defineProperty(window, 'open', {
  configurable: false,
  writable: false,
  value: (url?: string | URL, target?: string, features?: string): Window | null => {
    const href = String(url ?? '');
    if (!shouldAllowOpen(href, location.hostname, hadUserGesture)) {
      console.debug('[adblow] 已拦截 window.open', href, target);
      return null;
    }
    return rawOpen(url as string, target, features);
  },
});

// Click-hijack interception.
//
// Reported symptom: after page load, clicking anywhere navigated off-site. The tricks are
// an invisible full-viewport overlay, or a document-level click handler that redirects the
// click. We run in the capture phase and register before page scripts (document_start), so
// the page's own handlers never execute.

function pointOf(ev: Event): { x: number; y: number } | null {
  const mouse = ev as MouseEvent;
  if (typeof mouse.clientX === 'number' && typeof mouse.clientY === 'number') {
    return { x: mouse.clientX, y: mouse.clientY };
  }
  const touch = ev as TouchEvent;
  const t = touch.touches?.[0] ?? touch.changedTouches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

/** Link info for an element: href plus whether the anchor is invisible. */
function linkInfo(el: Element | null): { href: string | null; invisible: boolean } {
  const anchor = el?.closest?.('a[href]') ?? null;
  if (!anchor) return { href: null, invisible: false };
  let invisible = false;
  try {
    const rect = anchor.getBoundingClientRect();
    invisible =
      rect.width < 2 || rect.height < 2 || getComputedStyle(anchor).visibility === 'hidden';
  } catch {
    /* ignore */
  }
  return { href: anchor.getAttribute('href'), invisible };
}

function clickGuard(ev: Event): void {
  const target = ev.target instanceof Element ? ev.target : null;
  const point = pointOf(ev);
  const topmost = point ? document.elementFromPoint(point.x, point.y) : null;
  const probe = topmost ?? target;

  const targetLink = linkInfo(target);
  const topLink = linkInfo(topmost);

  const verdict = shouldBlockClick({
    trusted: ev.isTrusted,
    pageHost: location.hostname,
    linkHref: targetLink.href ?? topLink.href,
    linkIsInvisible: targetLink.invisible || topLink.invisible,
    insideHiddenAd: (probe?.closest(`[${HIDDEN_ATTR}]`) ?? null) !== null,
    overInvisibleLayer: topmost
      ? isInvisibleClickLayer(topmost, { viewportArea: innerWidth * innerHeight })
      : false,
  });

  if (!verdict.block) return;

  // All three are needed: preventDefault kills the navigation, stopImmediatePropagation
  // beats sibling listeners on the same node, stopPropagation stops the rest.
  ev.preventDefault();
  ev.stopImmediatePropagation();
  ev.stopPropagation();

  if (verdict.reason === 'invisible-click-layer' && topmost) hideNow(topmost);

  console.debug('[adblow] 已拦截点击劫持', verdict.reason, targetLink.href ?? topLink.href ?? '');
}

const CLICK_EVENTS = ['click', 'mousedown', 'mouseup', 'auxclick', 'pointerdown', 'touchstart'] as const;
for (const type of CLICK_EVENTS) {
  // passive: false is mandatory — otherwise preventDefault is a no-op on touchstart.
  // Capture phase on window fires first; document_start already puts us ahead of any
  // handler the page registers in the same phase.
  window.addEventListener(type, clickGuard, { capture: true, passive: false });
  document.addEventListener(type, clickGuard, { capture: true, passive: false });
}

// Persisted popup-state cleanup
function scrub(): void {
  for (const holder of [localStorage, sessionStorage]) {
    try {
      for (const key of keysToScrub(Object.keys(holder))) holder.removeItem(key);
    } catch {
      // storage is disabled in some contexts
    }
  }
  try {
    window.name = scrubWindowName(window.name);
  } catch {
    // ignore
  }
}

scrub();
setInterval(scrub, 2000);

// Refuse document-level "click navigates away" handlers at registration time. The click
// target is normal content, so the event layer cannot block it, and assigning
// `location.href` cannot be intercepted either. See looksLikeNavigationHijack in
// clickGuard.ts. Element-level listeners are untouched, so buttons/links keep working.
const rawAddEventListener = EventTarget.prototype.addEventListener;

EventTarget.prototype.addEventListener = function patched(
  this: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  if (this === window || this === document) {
    if ((type === 'pagehide' || type === 'beforeunload') && looksLikeTrackingListener(listener)) {
      console.debug('[adblow] 已拦截卸载期上报监听器', type);
      return;
    }
    if (NAVIGATION_EVENT_TYPES.has(type) && looksLikeNavigationHijack(listener)) {
      console.debug('[adblow] 已拦截文档级跳转处理函数', type);
      return;
    }
  }
  return rawAddEventListener.call(this, type, listener, options);
};
