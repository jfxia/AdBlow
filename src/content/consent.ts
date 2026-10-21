import {
  classifyConsentButton,
  judgeCookieConsentBanner,
  CONSENT_MAX_TEXT_CHARS,
  type ConsentButtonKind,
  type ConsentChoiceReason,
} from '../engine/cookieConsent.ts';

/**
 * Page side of cookie-consent handling: collect candidate shapes, decide, click.
 *
 * Everything that needs the DOM or layout lives here; the decision itself is in
 * engine/cookieConsent.ts. The click is the **only** page mutation: the banner is never
 * hidden or removed, so the site records the choice and stops showing it.
 *
 * Candidate discovery is button-first rather than a page-wide scan. A banner has to contain
 * an accept/reject control by definition, so starting at every button-like element and
 * walking up to a fixed/sticky ancestor is both cheaper and narrower than testing every
 * element on the page.
 */

export const CONSENT_CONTROL_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"], a[href]';

/** Candidate ancestors examined above one control. */
export const CONSENT_MAX_ANCESTOR_DEPTH = 8;

/** First look, after the page's own scripts have had a chance to render the banner. */
export const CONSENT_INITIAL_DELAY_MS = 1500;
/** Minimum gap between mutation-triggered retries. */
export const CONSENT_RETRY_THROTTLE_MS = 1000;
/** Hard cap on looks per page: a page that keeps mutating must not cause endless retries. */
export const CONSENT_MAX_ATTEMPTS = 5;

const ROOT_TAGS = new Set(['HTML', 'BODY', 'HEAD']);
const MIN_RENDERED_OPACITY = 0.05;

export type ConsentStyle = {
  position: string;
  display?: string;
  visibility?: string;
  opacity?: string;
  pointerEvents?: string;
};

export type ConsentRect = {
  top: number;
  left: number;
  width: number;
  height: number;
};

export type ConsentDomContext = {
  /** Defaults to the global innerWidth/innerHeight; tests inject it. */
  viewport?: { width: number; height: number };
  /** Defaults to getComputedStyle; tests inject it (jsdom does no layout). */
  styleOf?: (el: Element) => ConsentStyle | null;
  /** Defaults to getBoundingClientRect; tests inject it. */
  rectOf?: (el: Element) => ConsentRect | null;
};

export type ConsentHit = {
  /** The ancestor that satisfied the banner rules. */
  banner: Element;
  /** The control to click (may differ from the control that started the walk). */
  button: Element;
  kind: ConsentButtonKind;
  buttonText: string;
  matchedPhrase: string;
  reason: ConsentChoiceReason;
};

type ControlShape = {
  element: Element;
  text: string;
  enabled: boolean;
  visible: boolean;
  clickable: boolean;
};

const defaultViewport = (): { width: number; height: number } => {
  const g = globalThis as unknown as { innerWidth?: number; innerHeight?: number };
  return { width: g.innerWidth ?? 0, height: g.innerHeight ?? 0 };
};

const defaultStyleOf = (el: Element): ConsentStyle | null => {
  const g = globalThis as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration };
  if (typeof g.getComputedStyle !== 'function') return null;
  try {
    const s = g.getComputedStyle(el);
    return {
      position: s.position,
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      pointerEvents: s.pointerEvents,
    };
  } catch {
    return null;
  }
};

const defaultRectOf = (el: Element): ConsentRect | null => {
  try {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  } catch {
    return null;
  }
};

/** Visible enough to click. Hidden banners are left alone rather than clicked blindly. */
function isRendered(style: ConsentStyle): boolean {
  if ((style.display ?? 'block') === 'none') return false;
  const visibility = style.visibility ?? 'visible';
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  const opacity = Number.parseFloat(style.opacity ?? '1');
  return !Number.isFinite(opacity) || opacity > MIN_RENDERED_OPACITY;
}

/**
 * Label as a user sees it. `aria-label`, `title` and an input's value are included because
 * icon-only consent controls routinely carry their wording there instead of in textContent.
 */
function labelOf(el: Element): string {
  const inputValue = el.tagName === 'INPUT' ? ((el as HTMLInputElement).value ?? '') : '';
  return [el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', inputValue]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A link with a real destination is not a consent control: clicking it navigates instead of
 * recording a choice. Hash/javascript links are the shape used by banner widgets; an anchor
 * with no href at all (often role="button") is treated as a button. An empty href is rejected
 * because it can reload the page, which would make the script click again after every load.
 */
function isClickableControl(el: Element): boolean {
  if (el.tagName !== 'A') return true;
  if (!el.hasAttribute('href')) return true;
  const href = (el.getAttribute('href') ?? '').trim();
  return href.startsWith('#') || /^javascript:/i.test(href);
}

function controlShape(el: Element, ctx: ConsentDomContext): ControlShape {
  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  const rect = (ctx.rectOf ?? defaultRectOf)(el);
  const rendered = style === null ? true : isRendered(style);
  const sized = rect === null ? true : rect.width > 0 && rect.height > 0;
  const disabled =
    (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  return {
    element: el,
    text: labelOf(el),
    enabled: !disabled,
    visible: rendered && sized,
    clickable: isClickableControl(el),
  };
}

function collectControls(container: Element, ctx: ConsentDomContext): ControlShape[] {
  let found: Element[];
  try {
    found = Array.from(container.querySelectorAll(CONSENT_CONTROL_SELECTOR));
  } catch {
    return [];
  }
  // querySelectorAll does not include the container itself; an element can be the control.
  try {
    if (container.matches(CONSENT_CONTROL_SELECTOR)) found.unshift(container);
  } catch {
    // Ignore a hostile matches() implementation; descendants are still usable.
  }
  return found.map((el) => controlShape(el, ctx));
}

function hasMainContent(el: Element): boolean {
  const selector = 'main, article, [role="main"]';
  try {
    if (el.matches(selector)) return true;
    return el.querySelector(selector) !== null;
  } catch {
    return true; // fail safe: an unreadable candidate is not clicked
  }
}

function hasPasswordField(el: Element): boolean {
  try {
    return el.querySelector('input[type="password"]') !== null;
  } catch {
    return true; // fail safe
  }
}

/**
 * Sticky headers are the main false-positive shape this pass could otherwise click: they are
 * fixed/sticky, edge-anchored, and often carry "privacy"/"cookie" links plus an "OK"-style
 * button. Site navigation or a search control inside the candidate rules it out.
 */
function hasNavigation(el: Element): boolean {
  const selector =
    'nav, [role="navigation"], input[type="search"], form[role="search"], [role="search"]';
  try {
    if (el.matches(selector)) return true;
    return el.querySelector(selector) !== null;
  } catch {
    return true; // fail safe
  }
}

/**
 * Find the first usable consent banner, preferring a candidate that offers a reject control.
 *
 * Walking up from every labelled control means a banner whose button is nested inside a
 * static wrapper is still found at its fixed ancestor. An accept-only candidate is kept as a
 * fallback rather than returned immediately, so a reject control elsewhere in the same
 * banner wins even when the accept button comes first in DOM order.
 */
export function findConsentBanner(
  root: ParentNode,
  ctx: ConsentDomContext = {},
): ConsentHit | null {
  const viewport = ctx.viewport ?? defaultViewport();
  if (!(viewport.width > 0) || !(viewport.height > 0)) return null;
  const styleOf = ctx.styleOf ?? defaultStyleOf;
  const rectOf = ctx.rectOf ?? defaultRectOf;

  let controls: Element[];
  try {
    controls = Array.from(root.querySelectorAll(CONSENT_CONTROL_SELECTOR));
  } catch {
    return null;
  }

  let acceptFallback: ConsentHit | null = null;

  for (const control of controls) {
    if (!classifyConsentButton(labelOf(control))) continue;

    let node: Element | null = control;
    for (let depth = 0; depth < CONSENT_MAX_ANCESTOR_DEPTH && node; depth += 1) {
      if (ROOT_TAGS.has(node.tagName)) break;

      // Parents only get larger, so a too-long node ends this walk.
      const textLength = (node.textContent ?? '').length;
      if (textLength > CONSENT_MAX_TEXT_CHARS) break;

      const style = styleOf(node);
      const position = (style?.position ?? '').toLowerCase();
      if (style && (position === 'fixed' || position === 'sticky') && isRendered(style)) {
        const candidateControls = collectControls(node, ctx);
        const rect = rectOf(node);
        if (rect) {
          const verdict = judgeCookieConsentBanner({
            position,
            rect,
            viewport,
            text: node.textContent ?? '',
            buttons: candidateControls.map((c) => ({
              text: c.text,
              enabled: c.enabled,
              visible: c.visible,
              clickable: c.clickable,
            })),
            hasPasswordField: hasPasswordField(node),
            hasMainContent: hasMainContent(node),
            hasNavigation: hasNavigation(node),
          });
          const selected = candidateControls[verdict.isBanner ? verdict.buttonIndex : -1];
          if (verdict.isBanner && selected) {
            const hit: ConsentHit = {
              banner: node,
              button: selected.element,
              kind: verdict.kind,
              buttonText: selected.text,
              matchedPhrase: verdict.matchedPhrase,
              reason: verdict.reason,
            };
            if (verdict.kind === 'reject') return hit;
            if (!acceptFallback) acceptFallback = hit;
          }
        }
      }

      node = node.parentElement;
    }
  }

  return acceptFallback;
}

/** Use the platform click; fall back to a bubbling Event for non-HTMLElement controls. */
export function clickConsentControl(button: Element): void {
  const clickable = button as unknown as { click?: () => void };
  if (typeof clickable.click === 'function') {
    clickable.click();
    return;
  }
  button.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
}

// ── Idempotent runner ────────────────────────────────────────────────────────

/** Minimal timer seam so the runner is testable without real waiting. */
export type ConsentTimer = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const defaultTimer: ConsentTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type ConsentControllerStats = {
  attempts: number;
  handled: boolean;
  stopped: boolean;
  reason: string;
};

export type ConsentControllerOptions = {
  /** Gates: false stops the runner permanently (site disabled, blocked, unknown). */
  isAllowed: () => Promise<boolean>;
  find: () => ConsentHit | null;
  click: (button: Element) => void;
  initialDelayMs?: number;
  throttleMs?: number;
  maxAttempts?: number;
  timer?: ConsentTimer;
  /** Disconnect the MutationObserver, if the caller attached one. */
  onFinish?: () => void;
  log?: (message: string) => void;
};

export interface ConsentController {
  /** Schedule the first look. Repeated calls do nothing. */
  start(): void;
  /** Feed a DOM mutation; throttled, and ignored once the page is done. */
  notifyMutation(): void;
  /** Run one look immediately (also used by tests). */
  runAttempt(): Promise<void>;
  /** Stop permanently; safe to call repeatedly. */
  stop(reason: string): void;
  stats(): ConsentControllerStats;
}

/**
 * One page, one decision.
 *
 * The runner stops on the first of: the gates refuse (disabled / blocked / unknown), a
 * banner is found and clicked, the click throws, or CONSENT_MAX_ATTEMPTS looks are used up.
 * A missing banner is not a failure — later mutations may still insert one — so that case
 * only consumes one attempt.
 */
export function createConsentController(options: ConsentControllerOptions): ConsentController {
  const timer = options.timer ?? defaultTimer;
  const initialDelayMs = options.initialDelayMs ?? CONSENT_INITIAL_DELAY_MS;
  const throttleMs = options.throttleMs ?? CONSENT_RETRY_THROTTLE_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? CONSENT_MAX_ATTEMPTS);
  const log = options.log ?? (() => {});

  let attempts = 0;
  let handled = false;
  let stopped = false;
  let reason = 'running';
  let pending: unknown | null = null;
  let finishNotified = false;

  const finish = (nextReason: string): void => {
    if (stopped) return;
    stopped = true;
    reason = nextReason;
    if (pending !== null) {
      timer.clear(pending);
      pending = null;
    }
    if (!finishNotified) {
      finishNotified = true;
      try {
        options.onFinish?.();
      } catch {
        // A failing observer disconnect must not surface as a page error.
      }
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped || handled || pending !== null) return;
    pending = timer.set(() => {
      pending = null;
      void runAttempt();
    }, delayMs);
  };

  const runAttempt = async (): Promise<void> => {
    if (stopped || handled) return;
    // A direct call supersedes a scheduled one, so no look is counted twice.
    if (pending !== null) {
      timer.clear(pending);
      pending = null;
    }
    if (attempts >= maxAttempts) {
      finish('attempt-limit');
      return;
    }
    attempts += 1;

    let allowed = false;
    try {
      allowed = await options.isAllowed();
    } catch (error) {
      log(`consent gate failed (${String(error)}); leaving the banner alone`);
      finish('gate-error');
      return;
    }
    if (!allowed) {
      log('consent gates refused this site; leaving the banner alone');
      finish('gate-blocked');
      return;
    }

    let hit: ConsentHit | null = null;
    try {
      hit = options.find();
    } catch (error) {
      log(`consent scan failed (${String(error)}); will retry on a later mutation`);
      hit = null;
    }
    if (!hit) {
      if (attempts >= maxAttempts) finish('attempt-limit');
      return;
    }

    handled = true;
    try {
      options.click(hit.button);
      log(
        `consent: clicked ${hit.kind} (${hit.matchedPhrase}) on ` +
          `${hit.banner.tagName.toLowerCase()} via "${hit.buttonText.slice(0, 60)}"`,
      );
    } catch (error) {
      log(`consent click failed (${String(error)}); not retrying`);
    }
    finish('handled');
  };

  return {
    start(): void {
      schedule(initialDelayMs);
    },
    notifyMutation(): void {
      if (stopped || handled) return;
      if (attempts >= maxAttempts) {
        finish('attempt-limit');
        return;
      }
      schedule(throttleMs);
    },
    runAttempt,
    stop: finish,
    stats(): ConsentControllerStats {
      return { attempts, handled, stopped, reason };
    },
  };
}
