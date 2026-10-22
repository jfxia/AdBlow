import { isInvisibleClickLayer } from '../engine/clickLayer.ts';
import {
  announcePopupBlock,
  createPopupDenyGate,
  readPopupAllowance,
} from '../engine/popupDomains.ts';
import { keysToScrub, scrubWindowName } from '../engine/scrub.ts';
import {
  NAVIGATION_EVENT_TYPES,
  isNavigationSource,
  looksLikeNavigationHijack,
  shouldBlockClick,
} from './clickGuard.ts';
import { decideOpen, looksLikeTrackingListener, unwrapOpenTarget } from './guards.ts';

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
/**
 * `href` of the `<a>` the last gesture landed on, or null.
 *
 * Under the deny-by-default policy this is the one piece of gesture context that can allow a
 * cross-site window: a link the user clicked points at the destination, and the browser would
 * have opened it anyway. A button (`play`, `share`, `login`) is *not* evidence, because that is
 * also the shape a popunder fires from.
 */
let gestureAnchorHref: string | null = null;

for (const type of ['pointerdown', 'mousedown', 'click', 'keydown', 'touchstart'] as const) {
  addEventListener(
    type,
    (ev) => {
      hadUserGesture = true;
      const target = ev.target instanceof Element ? ev.target : null;
      gestureAnchorHref = target?.closest?.('a[href]')?.getAttribute('href') ?? null;
    },
    { capture: true, passive: true },
  );
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

/**
 * Popup denylist published by the isolated world as inert JSON.
 *
 * The read is lazy: `isDenied` reads the element on the first call and caches it. That keeps
 * the guard independent of startup order (the content script's fetch is async, the page may
 * call window.open before it lands) and costs nothing on pages that never open a window.
 */
const popupDeny = createPopupDenyGate(document);

Object.defineProperty(window, 'open', {
  configurable: false,
  writable: false,
  value: (url?: string | URL, target?: string, features?: string): Window | null => {
    const href = String(url ?? '');
    // A same-site wrapper (`/pop?url=<encoded ad>`) hides the real destination from the
    // `$popup` list: the list is keyed by the host the window lands on. Check it against the
    // unwrapped target as well, otherwise a wrapper defeats the denylist entirely.
    const unwrappedHref = unwrapOpenTarget(href, location.hostname);
    const decision = decideOpen({
      url: href,
      pageHost: location.hostname,
      hadUserGesture,
      gestureAnchorHref,
      // Passing location.href as the base resolves relative targets, so `//host/x` and
      // `/x` are judged by their real host instead of being skipped.
      popupDenied:
        popupDeny.isDenied(href, location.href) ||
        (unwrappedHref !== null && popupDeny.isDenied(unwrappedHref)),
      // Read every call (it is one attribute lookup): the switch can be toggled while the
      // page is open, and caching it would keep the old answer until reload.
      siteAllowsPopups: readPopupAllowance(document),
    });
    if (!decision.allow) {
      // The record and the log name the *real* destination: for a wrapper page the wrapper's
      // host is the same site the user is already on, which says nothing about the block.
      const realTarget = decision.targetUrl ?? href;
      if (decision.reason === 'popup-list') {
        console.debug('[adblow] 已拦截 popup 弹窗', realTarget);
      } else {
        console.debug('[adblow] 已拦截 window.open', href, target, decision.reason, realTarget);
      }
      // Leave a record the isolated world forwards to the worker (per-site count + last
      // target), so a site broken by the new default is diagnosable from the rule manager.
      if (href) announcePopupBlock(document, realTarget);
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

/** Targets whose handlers are page-wide: a listener here can redirect any click. */
function isPageWideTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  if (target === window || target === document) return true;
  // Handlers attached to <body>/<html> are just as page-wide, and this is the shape
  // `document.body.addEventListener('click', …)` uses to hijack every click.
  return target === document.body || target === document.documentElement;
}

EventTarget.prototype.addEventListener = function patched(
  this: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  if (isPageWideTarget(this)) {
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

/**
 * The same check for handlers installed as **IDL properties** (`document.onclick = fn`) or as
 * inline attributes (`<body onclick="…">`, which compiles to exactly that assignment).
 *
 * The addEventListener patch above cannot see those, and they are the most common shape of
 * "click anywhere redirects". Measured gap (2026-10-20): a page that assigns
 * `document.onclick = () => { location.href = ad }` kept working.
 *
 * Only the navigation-shaped functions are refused; any other handler installs as usual, so
 * ordinary `onclick` handlers keep working.
 */
const patchedHandlerOwners = new WeakSet<object>();

function patchEventHandlerProperties(target: object): void {
  for (const type of NAVIGATION_EVENT_TYPES) {
    const prop = `on${type}`;
    // The accessor lives on a prototype shared by every element (Document / GlobalEventHandlers),
    // so find the owner by walking the chain.
    let owner: object | null = target;
    let descriptor: PropertyDescriptor | undefined;
    while (owner && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(owner, prop);
      if (!descriptor) owner = Object.getPrototypeOf(owner) as object | null;
    }
    if (!owner || patchedHandlerOwners.has(owner)) continue;
    const getter = descriptor?.get;
    const setter = descriptor?.set;
    if (typeof getter !== 'function' || typeof setter !== 'function') continue;
    try {
      Object.defineProperty(owner, prop, {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        get: getter,
        set(this: object, value: unknown) {
          if (looksLikeNavigationHijack(value)) {
            console.debug('[adblow] 已拦截文档级跳转处理函数', prop);
            return;
          }
          return setter.call(this, value);
        },
      });
      patchedHandlerOwners.add(owner);
    } catch {
      // Non-configurable accessor: nothing can be done, and nothing is broken.
    }
  }
}

patchEventHandlerProperties(window);
patchEventHandlerProperties(document);

/**
 * Inline `on*` attributes on `<html>`/`<body>` are compiled by the parser, not assigned through
 * the IDL setter, so the patch above never sees them. `<body onclick="location.href='…'">` is
 * therefore enough to redirect any click.
 *
 * Only the page-wide containers are touched, and only when the attribute body is navigation
 * shaped. A normal `<a onclick="location.href = '/next'">` lives on the element itself and is
 * left alone, and so is everything inside the page.
 */
const INLINE_HANDLER_ATTRS = ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'ontouchstart', 'ontouchend', 'onauxclick'];

function stripPageWideInlineHandlers(): void {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    for (const attr of INLINE_HANDLER_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      // Inline handler bodies are source text, not functions: use the text-shaped test.
      if (!isNavigationSource(value)) continue;
      el.removeAttribute(attr);
      console.debug('[adblow] 已移除页面级行内跳转处理器', attr);
    }
  }
}

stripPageWideInlineHandlers();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', stripPageWideInlineHandlers, { once: true });
}
