/**
 * 隐形点击层（点击劫持）识别。
 *
 * 用户反馈的现象（missav.watch 之类的站）：页面加载后**随便点哪里**都会被带去
 * 另一个网站。典型实现是在页面上覆盖一个看不见的全屏层：
 *
 * ```html
 * <a href="https://ad.example.com/landing"
 *    style="position:fixed;inset:0;z-index:2147483647;opacity:0"></a>
 * ```
 *
 * 于是点击「任意位置」其实都点在它上面。已有的防护都拦不住这种情况：
 *   - `window.open` 守卫放行「有用户手势」的调用 —— 而这里用的正是真实点击；
 *   - 覆盖层检测要求元素有广告命名或行为证据，而隐形层两者都没有。
 *
 * 判定思路（也是它安全的理由）：**一个铺满视口、层级很高、却渲染不出任何可见
 * 内容的元素，隐藏它在视觉上是零影响** —— 因为它本来就什么都看不见。
 * 所以这条规则几乎没有误伤代价，却能掐断整个点击劫持通路。
 *
 * 样式与几何都可由调用方注入，因此本模块浏览器无关、可在 Node 里直接测。
 */

/** 廉价预筛：隐形层是注入脚本创建的，几乎一定带内联定位样式。 */
export const CLICK_LAYER_PRESELECTOR = [
  '[style*="position"]',
  '[class*="overlay"]',
  '[class*="mask"]',
  '[class*="popup"]',
  '[class*="click"]',
  '[id*="overlay"]',
  '[id*="mask"]',
].join(',');

/** 覆盖视口面积的下限（比例）。点击劫持层必须铺满，否则「点哪都中」不成立。 */
export const CLICK_LAYER_MIN_AREA = 0.5;
/** z-index 下限：正常内容也会用 absolute，但不会用这么高的层级去盖住整页。 */
export const CLICK_LAYER_MIN_Z = 100;
/** 不透明度低于此值视为"看不见"。 */
export const CLICK_LAYER_MAX_OPACITY = 0.05;
/** 小于这个尺寸的媒体元素视为装饰性/占位，不算"可见内容"。 */
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

/** 背景是否完全透明（各浏览器/简写形式的判断）。 */
export function isTransparentBackground(color: string): boolean {
  const c = (color ?? '').trim().toLowerCase();
  if (c === '' || c === 'transparent') return true;
  // rgba(0, 0, 0, 0) / rgba(0,0,0,0.0)
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/.exec(c);
  if (!m) return false;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  return alpha <= CLICK_LAYER_MAX_OPACITY;
}

/** 元素内部是否有"够大"的可见媒体（说明它其实是内容，不是隐形层）。 */
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
 * 元素是否为「隐形点击层」。
 *
 * 全部条件都满足才算：
 *   1. 固定/绝对定位，层级很高，铺满视口大半
 *   2. 看不见：整体不透明度接近 0，或背景全透明
 *   3. 渲染不出内容：没有文字，也没有够大的媒体
 */
export function isInvisibleClickLayer(el: Element, ctx: LayerContext): boolean {
  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  if (!style) return false;
  if (style.visibility === 'hidden') return false; // 已不可见，不是问题元素

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

/** 在子树里找出隐形点击层（用廉价预筛缩小范围）。 */
export function findInvisibleClickLayers(root: ParentNode, ctx: LayerContext): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(CLICK_LAYER_PRESELECTOR))) {
    if (el.closest('[data-adblow-hidden]') !== null) continue;
    if (isInvisibleClickLayer(el, ctx)) out.push(el);
  }
  return out;
}
