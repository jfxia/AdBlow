import { registrableDomain } from '../engine/score.ts';
import { looksLikeTrackingListener } from './guards.ts';

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
 * Index of the top-level `=>` of an arrow function, or -1.
 *
 * Parens/brackets/braces and string literals are tracked so `({target}) => …` and
 * `() => 'a => b'` do not confuse the scan.
 */
function topLevelArrow(text: string): number {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '=' && text[i + 1] === '>' && depth === 0) return i;
  }
  return -1;
}

/**
 * The body of a listener's source text.
 *
 * Covers the shapes that reach us: `function name(args) { … }`, `(args) => { … }`,
 * `args => expression`, and method shorthand `name(args) { … }`. Anything unusual (destructuring
 * defaults, a nested arrow as the whole body, trailing `//# sourceURL`) simply yields text that
 * does not match a single navigation statement, which means "keep the listener" — the safe side.
 */
function bodyOfSource(source: string): string {
  const text = source.trim();
  const arrow = topLevelArrow(text);
  const rest = arrow >= 0 ? text.slice(arrow + 2).trim() : text;
  if (rest.startsWith('{')) {
    const close = rest.lastIndexOf('}');
    return close > 0 ? rest.slice(1, close) : rest.slice(1);
  }
  if (arrow >= 0) return rest;
  const open = rest.indexOf('{');
  if (open < 0) return rest;
  const close = rest.lastIndexOf('}');
  return close > open ? rest.slice(open + 1, close) : rest.slice(open + 1);
}

/**
 * Source text of a listener — either a function or an object with `handleEvent`.
 *
 * Returns '' when the text cannot be read. A page may hand `addEventListener` a Proxy, an object
 * with a throwing `handleEvent` getter, or a function whose `toString` was replaced; the native
 * API reads none of that and accepts the listener, so an unreadable listener must be left alone
 * instead of raising an error the page never expected. Measured: both shapes used to throw out
 * of `addEventListener` and abort the caller's initialisation.
 */
function listenerSource(listener: unknown): string {
  try {
    if (typeof listener === 'function') return String(listener);
    const handleEvent = (listener as { handleEvent?: unknown } | null)?.handleEvent;
    return typeof handleEvent === 'function' ? String(handleEvent) : '';
  } catch {
    return '';
  }
}

/**
 * Strip the wrappers that do not change what a statement *is*: surrounding braces or parens (a
 * function body / parenthesised expression), one trailing `;`, and a leading `return`.
 */
function normalizeStatement(raw: string): string {
  let text = raw.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.trim();
    if (text.startsWith('{') && text.endsWith('}')) text = text.slice(1, -1);
    else if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1);
    else break;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.endsWith(';')) text = text.slice(0, -1).trim();
  if (/^return\b/.test(text)) text = text.slice('return'.length).trim();
  return text;
}

/** `window.` / `self.` / `top.` / `parent.` / `document.`, optional. */
const OWNER = String.raw`(?:window|self|top|parent|document)\s*\.\s*`;
/** `location` with an optional owner — `location`, `window.location`, `self.location`, … */
const LOCATION = String.raw`(?:${OWNER})?location`;
/** `location.href` / `location['href']` / `window.location.href`, up to the `=`. */
const HREF = String.raw`${LOCATION}\s*(?:\.\s*href|\[\s*['"]href['"]\s*\])\s*`;
/** Call arguments that cannot contain a second statement or a block. */
const CALL = String.raw`\([^;{}]*\)`;

/**
 * Source shapes that perform nothing but one navigation.
 *
 * Each pattern is anchored at both ends and refuses `;` inside, so a body with a second statement
 * — or with any branch — cannot match.
 */
const PURE_NAVIGATION_SOURCES: RegExp[] = [
  // location.href = … / window.location['href'] = … (not `==` / `===`)
  new RegExp(String.raw`^${HREF}=(?!=)\s*[^;]+$`),
  // location = '…' / self.location = '…' — whole-object replacement
  new RegExp(String.raw`^${LOCATION}\s*=(?!=)\s*[^;]+$`),
  // location.assign(…) / location['replace'](…) / window.location.assign(…)
  new RegExp(
    String.raw`^${LOCATION}\s*(?:\.\s*(?:assign|replace)|\[\s*['"](?:assign|replace)['"]\s*\])\s*${CALL}$`,
  ),
  // window.open(…) / self.open(…) / top.open(…). `document.open()` rewrites the document
  // instead of navigating, so it is not in this list.
  new RegExp(String.raw`^(?:window|self|top|parent)\s*\.\s*open\s*${CALL}$`),
];

/**
 * Whether a handler's **entire body** is a single navigation statement.
 *
 * Measured case: `document.addEventListener('click', () => { location.href = ad }, true)`. The
 * click target is ordinary content, so the event layer cannot block it — that would block normal
 * clicks — and assigning `location.href` cannot be intercepted either. Refusing the registration
 * is the only spot.
 *
 * Why only a *single statement*: `String(fn)` contains every nested function body, so a
 * substring test also matches a normal delegated handler that merely *has* a `window.open(…)`
 * "open in new tab" fallback or a `location.href = …` fallback next to its routing code. Dropping
 * that handler silently disables the page's own click handling — the page still renders but stops
 * responding. Measured: three of four realistic handler shapes were dropped that way.
 *
 * Trade-off, deliberate: a real hijack written as `e.preventDefault(); location.href = ad` (two
 * statements) now survives. Missing one full-page redirect is much cheaper than silently removing
 * a working delegated handler, and a cross-site window is still blocked at call time by the
 * `window.open` guard. When in doubt this returns false, i.e. "keep the listener".
 *
 * The same test is applied to inline attribute bodies (`<body onclick="location.href='…'">`),
 * where the parser has already given us the body as text.
 */
export function isNavigationSource(source: string): boolean {
  const body = normalizeStatement(source);
  if (!body) return false;
  return PURE_NAVIGATION_SOURCES.some((re) => re.test(body));
}


/** `isNavigationSource` for a listener (function or `handleEvent` object). Never throws. */
export function looksLikeNavigationHijack(listener: unknown): boolean {
  const source = listenerSource(listener);
  if (!source) return false;
  return isNavigationSource(bodyOfSource(source));
}

/**
 * Targets whose handlers are page-wide: a listener here can redirect any click.
 *
 * Handlers attached to `<body>`/`<html>` are just as page-wide, and that is the shape
 * `document.body.addEventListener('click', …)` uses to hijack every click.
 */
export function isPageWideTarget(target: unknown, win: unknown, doc: unknown): boolean {
  if (!target) return false;
  if (target === win || target === doc) return true;
  const element = doc as { body?: unknown; documentElement?: unknown } | null;
  return target === element?.body || target === element?.documentElement;
}

/**
 * What to do with a page-wide listener registration: `null` keeps it.
 *
 * Returning `'navigation'` means "this handler does nothing but navigate, and it is registered on
 * a target that sees every click", which is the click-hijack shape. Everything else is kept; see
 * the trade-off note on `isNavigationSource`.
 *
 * May throw (a pathological listener can still surprise `looksLikeTrackingListener`); the caller
 * `guardAddEventListener` turns that into "register natively" so the page never sees it.
 */
export function classifyPageWideListener(input: {
  target: unknown;
  type: string;
  listener: unknown;
  win: unknown;
  doc: unknown;
}): 'navigation' | 'unload-beacon' | null {
  if (!isPageWideTarget(input.target, input.win, input.doc)) return null;
  const type = String(input.type ?? '');
  if (
    (type === 'pagehide' || type === 'beforeunload') &&
    looksLikeTrackingListener(input.listener)
  ) {
    return 'unload-beacon';
  }
  if (NAVIGATION_EVENT_TYPES.has(type) && looksLikeNavigationHijack(input.listener)) {
    return 'navigation';
  }
  return null;
}

