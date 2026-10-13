/**
 * Geometry-change tracking: a second pass for "grow / expand / auto-enlarge" ads.
 *
 * The engine judges a node only when it is added to the DOM, but these ads work by
 * pure CSS change and so never trigger a re-judge (acceptance cases 8/18/21).
 * Growth past GROWTH_FACTOR and GROWTH_MIN_AREA_RATIO is itself evidence, so this
 * pass need not prove script injection. Styles/geometry are injected by the
 * caller, keeping the module browser-agnostic and Node-testable.
 */

/** Area growth factor that counts as "suddenly enlarged". */
export const GROWTH_FACTOR = 2.5;
/** Min viewport share after growth before a re-judge is worth it (skips small widgets). */
export const GROWTH_MIN_AREA_RATIO = 0.15;
/** Candidate cap per pass, to avoid janking the main thread on huge pages. */
export const GEOMETRY_MAX_CANDIDATES = 600;

/** Cheap preselect: growing ads carry inline positioning, or are the media itself. */
export const GEOMETRY_PRESELECTOR = [
  '[style*="position"]',
  'img',
  'video',
  'picture',
  'iframe',
  'object',
  'embed',
  '[class*="expand"]',
  '[class*="sticky"]',
  '[class*="float"]',
  '[class*="popup"]',
  '[class*="banner"]',
].join(',');

export type Rect = { width: number; height: number };

export type GeometryContext = {
  viewportArea: number;
  rectOf?: (el: Element) => Rect | null;
  /** How many ancestor levels to walk up after a hit (the ad container is usually an ancestor). */
  ancestorDepth?: number;
  /** Whether an ancestor is positioned; defaults to getComputedStyle. */
  styleOf?: (el: Element) => { position: string } | null;
};

export type GrowthTracker = {
  areas: WeakMap<Element, number>;
};

export function createGrowthTracker(): GrowthTracker {
  return { areas: new WeakMap<Element, number>() };
}

const defaultRectOf = (el: Element): Rect | null => {
  try {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  } catch {
    return null;
  }
};

/**
 * Snapshot areas; return elements whose area grew a lot, plus a few ancestors.
 * A first sighting only records (no baseline, no growth); hidden subtrees are skipped.
 */
export function collectGrownElements(
  root: ParentNode,
  tracker: GrowthTracker,
  ctx: GeometryContext,
): Element[] {
  const rectOf = ctx.rectOf ?? defaultRectOf;
  const depth = ctx.ancestorDepth ?? 3;
  if (ctx.viewportArea <= 0) return [];

  let candidates: Element[];
  try {
    candidates = Array.from(root.querySelectorAll(GEOMETRY_PRESELECTOR));
  } catch {
    return [];
  }
  if (candidates.length > GEOMETRY_MAX_CANDIDATES) {
    candidates = candidates.slice(0, GEOMETRY_MAX_CANDIDATES);
  }

  const out = new Set<Element>();

  for (const el of candidates) {
    if (el.closest('[data-adblow-hidden]') !== null) continue;

    const rect = rectOf(el);
    if (!rect) continue;
    const area = rect.width * rect.height;

    const prev = tracker.areas.get(el);
    tracker.areas.set(el, area);

    if (prev === undefined || prev <= 0) continue;
    if (area / prev < GROWTH_FACTOR) continue;
    if (area / ctx.viewportArea < GROWTH_MIN_AREA_RATIO) continue;

    out.add(el);

    // The ad container is usually an ancestor of the grown element. Only
    // positioned or media-bearing ancestors count; plain wrappers are noise.
    let parent = el.parentElement;
    for (let i = 0; i < depth && parent; i++) {
      if (parent === document.body || parent === document.documentElement) break;
      if (parent.closest('[data-adblow-hidden]') !== null) break;
      if (isPositionedOrMedia(parent, ctx)) out.add(parent);
      parent = parent.parentElement;
    }
  }

  return [...out];
}

/** Whether an ancestor is worth proposing: fixed/absolute positioned, or contains media. */
function isPositionedOrMedia(el: Element, ctx: GeometryContext): boolean {
  const styleOf = ctx.styleOf;
  if (styleOf) {
    const style = styleOf(el);
    if (style && (style.position === 'fixed' || style.position === 'absolute')) return true;
  } else {
    try {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'absolute') return true;
    } catch {
      /* ignore */
    }
  }
  return el.querySelector('img,video,picture,iframe,object,embed') !== null;
}
