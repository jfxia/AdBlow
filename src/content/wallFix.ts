import {
  hasContentMarker,
  hideElement,
  holdsRealContent,
  isHidden,
  isInsideHidden,
} from './engine.ts';
import { findWallPrompts, type WallContext } from '../engine/antiAdblock.ts';

/**
 * Page-side neutralisation of an anti-adblock wall.
 *
 * Product decision: **manual confirmation per site**. Nothing here runs until the user has
 * confirmed the fix for the site, and neutralising the wall must never relax ad blocking:
 * everything we hid stays hidden (`data-adblow-hidden` is a hard invariant, see below).
 *
 * Two actions:
 *   ① hide the detected prompt/overlay elements through `hideElement()` (so they are tagged
 *      `data-adblow-hidden` and re-checked by `verifyHiding`);
 *   ② re-show content **the page itself hid** while the wall is up — for instance a site setting
 *      `#content { display:none !important }`.
 *
 * ② is the delicate half. "The page hid it" has to be established without ever touching the
 * user's normal page, so only two evidence sources are accepted, both narrow:
 *
 *   baseline-visible      The element held real content and was **visible when we captured the
 *                         baseline** (before the page got a chance to hide it) and is hidden now.
 *                         This is the primary source; the content script captures early and
 *                         refreshes as the DOM grows.
 *   runtime-inline-hide   The page hard-hid a content-holding element with an **inline
 *                         `!important`** declaration (`display:none !important`,
 *                         `visibility:hidden !important`). That is the signature of a script
 *                         hiding content at runtime: a block that is hidden by design uses a
 *                         stylesheet rule or markup, not a later inline `!important` write. This
 *                         source exists because a document_start script cannot always see the
 *                         content before the page's own first script runs — exactly the shape of
 *                         the category-24 fixture in tools/e2e/acceptance.mjs, which hides
 *                         `#content` inline while the parser is still running.
 *
 * Never touched, whatever the evidence:
 *   - anything we hid ourselves (self or ancestor carries `data-adblow-hidden`) — ad hiding
 *     outranks wall repair;
 *   - anything that does not hold real content (`holdsRealContent`: article markup or substantive
 *     text) — a hidden ad slot, a collapsed menu of short labels, an empty placeholder;
 *   - anything hidden by a stylesheet rule only, with no baseline entry — that is how sites hide
 *     things by design.
 */

/** Marker on content we re-showed (diagnostics and tests; never removes our hiding). */
export const RESTORED_ATTR = 'data-adblow-wall-restored';
/** Reason written to `data-adblow-reason` for prompt elements we hide. */
export const WALL_REASON = 'anti-adblock-wall';
/** Below this opacity an element does not render. */
export const WALL_MIN_OPACITY = 0.05;

/**
 * Wall detection context for the page.
 *
 * The engine layer deliberately knows nothing about article markup, so the content layer supplies
 * it here: without this, the copy-only detection gate would lose its "not an article" guard.
 */
export function wallContext(viewportArea: number): WallContext {
  return { viewportArea, hasContentMarker };
}

export type VisibleSnapshot = {
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
};

export type StyleReader = (el: Element) => VisibleSnapshot | null;

export type ContentBaseline = {
  /** Elements that held real content and were visible when captured, with the values to restore. */
  visible: Map<Element, VisibleSnapshot>;
  capturedAt: number;
};

export type RestoreReason = 'baseline-visible' | 'runtime-inline-hide';

export type RestoredElement = { element: Element; reason: RestoreReason };

export type NeutralizeResult = {
  /** Prompt elements hidden by this call. */
  hiddenPrompts: Element[];
  /** Prompts that were already hidden by an earlier pass (idempotent re-runs). */
  alreadyHiddenPrompts: number;
  /** Content elements re-shown by this call. */
  restored: RestoredElement[];
  /** Baseline entries left alone because we hid them (our hiding is never undone). */
  keptHiddenByUs: number;
  /** Baseline entries dropped because the element left the document. */
  gone: number;
};

export type NeutralizeOptions = {
  /** Visibility snapshot taken before the page hid anything (captureContentBaseline). */
  baseline: ContentBaseline;
  /** Wall detection context: viewport area, and in tests injected style/geometry readers. */
  wall: WallContext;
  /** Style reader for the restore checks; defaults to `getComputedStyle`. */
  styleOf?: StyleReader;
  /** Diagnostics hook: called for every prompt hidden. */
  onHide?: (el: Element) => void;
  /** Diagnostics hook: called for every content element re-shown. */
  onRestore?: (el: Element, reason: RestoreReason) => void;
};

const defaultStyleOf = (el: Element): VisibleSnapshot | null => {
  const g = globalThis as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration };
  if (typeof g.getComputedStyle !== 'function') return null;
  try {
    const s = g.getComputedStyle(el);
    return {
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      pointerEvents: s.pointerEvents,
    };
  } catch {
    return null;
  }
};

/** Does this snapshot render? */
export function isVisibleSnapshot(s: VisibleSnapshot): boolean {
  if (s.display === 'none') return false;
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return false;
  const opacity = Number.parseFloat(s.opacity);
  return !Number.isFinite(opacity) || opacity > WALL_MIN_OPACITY;
}

function readVisible(el: Element, styleOf: StyleReader): VisibleSnapshot | null {
  let snapshot: VisibleSnapshot | null;
  try {
    snapshot = styleOf(el);
  } catch {
    // A hostile page can break style reads; one element must not stop the pass.
    return null;
  }
  if (!snapshot) return null;
  return isVisibleSnapshot(snapshot) ? snapshot : null;
}

/** Style read that never throws (used by the restore checks). */
function readNow(el: Element, styleOf: StyleReader): VisibleSnapshot | null {
  try {
    return styleOf(el);
  } catch {
    return null;
  }
}

/**
 * Record every element that holds real content and is visible right now.
 *
 * Idempotent: an element already in the baseline keeps its first (visible) snapshot, so a later
 * hide cannot overwrite it with the hidden values.
 */
export function refreshContentBaseline(
  baseline: ContentBaseline,
  root: ParentNode,
  styleOf: StyleReader = defaultStyleOf,
): number {
  let nodes: Element[];
  try {
    nodes = Array.from(root.querySelectorAll('*'));
  } catch {
    return 0;
  }

  let added = 0;
  for (const el of nodes) {
    if (baseline.visible.has(el)) continue;
    // Our own hiding is never a restore source: ad hiding must survive wall repair.
    if (isInsideHidden(el)) continue;
    if (!holdsRealContent(el)) continue;
    const snapshot = readVisible(el, styleOf);
    if (!snapshot) continue;
    baseline.visible.set(el, snapshot);
    added += 1;
  }
  return added;
}

/** Capture a fresh baseline (see refreshContentBaseline). */
export function captureContentBaseline(
  root: ParentNode,
  styleOf: StyleReader = defaultStyleOf,
): ContentBaseline {
  const baseline: ContentBaseline = { visible: new Map(), capturedAt: Date.now() };
  refreshContentBaseline(baseline, root, styleOf);
  return baseline;
}

/**
 * Re-show to the snapshot values, as inline `!important`.
 *
 * Inline `!important` beats both a stylesheet rule the page added later and the page's own
 * earlier inline declaration (same declaration block: the later write wins), so a single write
 * covers every way the page hid that element.
 */
function restoreToSnapshot(el: Element, snapshot: VisibleSnapshot): boolean {
  const style = (el as HTMLElement).style;
  if (!style) return false;
  try {
    style.setProperty('display', snapshot.display, 'important');
    style.setProperty('visibility', snapshot.visibility, 'important');
    style.setProperty('opacity', snapshot.opacity, 'important');
    style.setProperty('pointer-events', snapshot.pointerEvents, 'important');
  } catch {
    return false;
  }
  el.setAttribute(RESTORED_ATTR, '1');
  return true;
}

/** Inline declarations an ad-wall script uses to hard-hide the page (must be `!important`). */
function inlineHardHide(el: Element): boolean {
  const style = (el as HTMLElement).style;
  if (!style) return false;
  return (
    (style.getPropertyValue('display') === 'none' &&
      style.getPropertyPriority('display') === 'important') ||
    (style.getPropertyValue('visibility') === 'hidden' &&
      style.getPropertyPriority('visibility') === 'important')
  );
}

/** Drop exactly the inline declarations the page wrote; its own stylesheet applies again. */
function restoreInlineHide(el: Element): boolean {
  const style = (el as HTMLElement).style;
  if (!style) return false;
  let changed = false;
  try {
    if (
      style.getPropertyValue('display') === 'none' &&
      style.getPropertyPriority('display') === 'important'
    ) {
      style.removeProperty('display');
      changed = true;
    }
    if (
      style.getPropertyValue('visibility') === 'hidden' &&
      style.getPropertyPriority('visibility') === 'important'
    ) {
      style.removeProperty('visibility');
      changed = true;
    }
  } catch {
    return false;
  }
  if (changed) el.setAttribute(RESTORED_ATTR, '1');
  return changed;
}

/** Cheap preselect: only elements carrying an inline style can be runtime-inline-hide sources. */
export const WALL_INLINE_PRESELECTOR = '[style]';

/**
 * Content-holding elements the page hard-hid at runtime with an inline `!important` write.
 *
 * The expensive content test runs only after the cheap inline check, so a page full of inline
 * styles still costs one attribute read per element.
 */
function runtimeHiddenContent(root: ParentNode, styleOf: StyleReader): Element[] {
  let candidates: Element[];
  try {
    candidates = Array.from(root.querySelectorAll(WALL_INLINE_PRESELECTOR));
  } catch {
    return [];
  }

  const out: Element[] = [];
  for (const el of candidates) {
    if (isHidden(el) || isInsideHidden(el)) continue;
    if (!inlineHardHide(el)) continue;
    if (!holdsRealContent(el)) continue;
    const snapshot = readNow(el, styleOf);
    if (snapshot && isVisibleSnapshot(snapshot)) continue; // not actually hidden any more
    out.push(el);
  }
  return out;
}

/**
 * Neutralise one wall pass: hide the prompts, then re-show hidden content.
 *
 * Hiding comes first so the prompt cannot be re-read as content, and both halves are idempotent —
 * the content script calls this on the first pass and again on later DOM changes and upkeep
 * rounds, which is also what repairs a page that re-hides the content.
 */
export function neutralizeWall(root: ParentNode, opts: NeutralizeOptions): NeutralizeResult {
  const styleOf = opts.styleOf ?? defaultStyleOf;
  const result: NeutralizeResult = {
    hiddenPrompts: [],
    alreadyHiddenPrompts: 0,
    restored: [],
    keptHiddenByUs: 0,
    gone: 0,
  };

  // ① Hide the prompts/overlays.
  const wall: WallContext = { hasContentMarker, ...opts.wall };
  let prompts: Element[] = [];
  try {
    prompts = findWallPrompts(root, wall);
  } catch {
    prompts = [];
  }
  for (const el of prompts) {
    if (isHidden(el)) {
      result.alreadyHiddenPrompts += 1;
      continue;
    }
    hideElement(el, WALL_REASON);
    result.hiddenPrompts.push(el);
    opts.onHide?.(el);
  }

  // ② Restore content that was visible at baseline time and is hidden now.
  for (const [el, snapshot] of [...opts.baseline.visible]) {
    if (!el.isConnected) {
      opts.baseline.visible.delete(el);
      result.gone += 1;
      continue;
    }
    if (isHidden(el) || isInsideHidden(el)) {
      result.keptHiddenByUs += 1;
      continue;
    }
    const now = readNow(el, styleOf);
    if (now && isVisibleSnapshot(now)) continue;

    if (restoreToSnapshot(el, snapshot)) {
      result.restored.push({ element: el, reason: 'baseline-visible' });
      opts.onRestore?.(el, 'baseline-visible');
    }
  }

  // ③ Restore content the page hard-hid before our first look (no baseline entry).
  for (const el of runtimeHiddenContent(root, styleOf)) {
    if (opts.baseline.visible.has(el)) continue; // handled by ②
    if (!restoreInlineHide(el)) continue;
    result.restored.push({ element: el, reason: 'runtime-inline-hide' });
    opts.onRestore?.(el, 'runtime-inline-hide');
  }

  return result;
}
