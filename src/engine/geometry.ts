/**
 * 几何变化追踪：给「随动伸缩 / 悬浮展开 / 自动放大」这类广告补一次判定。
 *
 * 背景（2026-10-10 验收实测）：引擎原本只在**节点被加入 DOM** 时判定一次
 * （首屏扫描 + MutationObserver）。但有一整类广告靠**纯 CSS 变化**工作：
 * 元素一直在页面上、只是又小又不起眼，鼠标移上去之后由脚本改尺寸/内联样式
 * 撑成大图。这类变化不产生任何 DOM 节点增删，因此**永远不触发重判** ——
 * 验收实测里 8（随动伸缩）、18（区域展开）、21（富媒体扩展）三条全挂在这里。
 *
 * 做法：周期性给候选元素记面积快照，发现「面积突然涨到原来的若干倍、并且
 * 已经占了视口相当比例」就交给上层重判一次。几何突增本身就是证据，
 * 因此这一趟**不再要求"必须证明是脚本注入"**。
 *
 * 样式与几何都可由调用方注入，因此本模块浏览器无关、可在 Node 里直接测。
 */

/** 面积增长到原来的多少倍算「突然撑大」。 */
export const GROWTH_FACTOR = 2.5;
/** 撑大之后至少要占视口这么大比例，才值得重判（避免为小控件的展开而误伤）。 */
export const GROWTH_MIN_AREA_RATIO = 0.15;
/** 单次最多看多少个候选元素，防止在超大页面上拖慢主线程。 */
export const GEOMETRY_MAX_CANDIDATES = 600;

/**
 * 廉价预筛。用内联定位样式与媒体标签为主：会「撑大」的广告几乎都带内联定位，
 * 或者是图片/视频本身在被放大。
 */
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
  /** 命中后向上追几层祖先（广告容器往往是撑大元素的祖先）。 */
  ancestorDepth?: number;
  /** 判断祖先是否为定位元素；默认用 getComputedStyle。 */
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
 * 记录面积快照，返回「面积显著变大」的元素（外加其上若干层祖先）。
 *
 * 第一次见到的元素只记录、不返回：没有基线就无法判断"变大"。
 * 已隐藏子树里的元素一律跳过。
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

    // 广告容器常常是撑大元素的祖先（图片被放大时尤其如此）。
    // 只把「定位祖先」或「含媒体的祖先」算进来：普通的布局包裹 div 加进来
    // 只会制造噪声候选（判定层还要再筛一遍，没必要让它们进来）。
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

/** 祖先是否值得作为候选：固定/绝对定位，或内部含媒体。 */
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
