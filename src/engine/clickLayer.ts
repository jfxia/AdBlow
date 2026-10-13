/**
 * Invisible click-layer (clickjacking) detection.
 *
 * Reported: clicking **anywhere** navigates away — an invisible full-viewport anchor
 * catches the click. The window.open guard allows gestural calls and overlay detection
 * needs ad naming or behavior, so both miss it. Hiding it is visually free (it renders
 * nothing), which cuts the whole clickjacking path at no false-positive cost.
 */

/** Cheap preselect: injected layers almost always carry inline positioning styles. */
export const CLICK_LAYER_PRESELECTOR = [
  '[style*="position"]',
  '[class*="overlay"]',
  '[class*="mask"]',
  '[class*="popup"]',
  '[class*="click"]',
  '[id*="overlay"]',
  '[id*="mask"]',
].join(',');

/** Minimum covered viewport fraction; a clickjacking layer must fill the page. */
export const CLICK_LAYER_MIN_AREA = 0.5;
/** z-index floor: normal content uses absolute too, but not at this level to cover the page. */
export const CLICK_LAYER_MIN_Z = 100;
/** Opacity at or below this counts as "invisible". */
export const CLICK_LAYER_MAX_OPACITY = 0.05;
/** Media below this size is decorative/a placeholder, not "visible content". */
const MEDIA_MIN_SIZE = 8;

export type LayerStyle = {
  position: string;
  zIndex: string;
  opacity: string;
  backgroundColor: string;
  visibility: string;
};

export type LayerContext = {
  viewportArea: number;
  styleOf?: (el: Element) => LayerStyle | null;
  rectOf?: (el: Element) => { width: number; height: number } | null;
};

const defaultStyleOf = (el: Element): LayerStyle | null => {
  const g = globalThis as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration };
  if (typeof g.getComputedStyle !== 'function') return null;
  try {
    const s = g.getComputedStyle(el);
    return {
      position: s.position,
      zIndex: s.zIndex,
      opacity: s.opacity,
      backgroundColor: s.backgroundColor,
      visibility: s.visibility,
    };
  } catch {
    return null;
  }
};

const defaultRectOf = (el: Element): { width: number; height: number } | null => {
  try {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  } catch {
    return null;
  }
};

/** Whether the background is fully transparent (covers shorthand/browser variants). */
export function isTransparentBackground(color: string): boolean {
  const c = (color ?? '').trim().toLowerCase();
  if (c === '' || c === 'transparent') return true;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(c);
  if (!m) return false;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  return alpha <= CLICK_LAYER_MAX_OPACITY;
}

/** Whether the element has "sized enough" visible media (i.e. it is content). */
function hasSizedMedia(el: Element): boolean {
  for (const media of Array.from(el.querySelectorAll('img,video,canvas,svg,iframe'))) {
    try {
      const r = media.getBoundingClientRect();
      if (r.width >= MEDIA_MIN_SIZE && r.height >= MEDIA_MIN_SIZE) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Is the element an "invisible click layer"? All must hold:
 *   1. fixed/absolute positioned, high z-index, covering most of the viewport
 *   2. invisible: opacity near 0 or a fully transparent background
 *   3. renders nothing: no text and no sized media
 */
export function isInvisibleClickLayer(el: Element, ctx: LayerContext): boolean {
  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  if (!style) return false;
  if (style.visibility === 'hidden') return false; // already invisible, not the offending element

  if (style.position !== 'fixed' && style.position !== 'absolute') return false;

  const z = Number.parseInt(style.zIndex, 10);
  if (!Number.isFinite(z) || z < CLICK_LAYER_MIN_Z) return false;

  const rect = (ctx.rectOf ?? defaultRectOf)(el);
  if (!rect || ctx.viewportArea <= 0) return false;
  if ((rect.width * rect.height) / ctx.viewportArea < CLICK_LAYER_MIN_AREA) return false;

  const opacity = Number.parseFloat(style.opacity);
  const invisible = Number.isFinite(opacity)
    ? opacity <= CLICK_LAYER_MAX_OPACITY
    : isTransparentBackground(style.backgroundColor);
  const transparentBg = isTransparentBackground(style.backgroundColor);
  if (!invisible && !transparentBg) return false;

  if ((el.textContent ?? '').trim().length > 0) return false;
  if (hasSizedMedia(el)) return false;

  return true;
}

export function findInvisibleClickLayers(root: ParentNode, ctx: LayerContext): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(CLICK_LAYER_PRESELECTOR))) {
    if (el.closest('[data-adblow-hidden]') !== null) continue;
    if (isInvisibleClickLayer(el, ctx)) out.push(el);
  }
  return out;
}
