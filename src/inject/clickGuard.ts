import { registrableDomain } from '../engine/score.ts';

/**
 * 点击劫持拦截判定。
 *
 * 纯函数，因此「该不该拦这次点击」可以完整单测，而不必开浏览器。
 * 三个判据分别对应三种真实手法：
 *
 * ① 脚本合成的点击指向跨站链接 —— 典型实现是运行时造一个隐藏的 `<a>` 再 `.click()`。
 *    用 `isTrusted === false` 识别（真实用户点击永远是 true）。
 * ② 真实点击落在我们已判定为广告/已隐藏的元素上。
 * ③ 真实点击落在**隐形全屏覆盖层**上 —— 这就是「随便点哪里都跳走」的直接原因。
 *
 * 为什么不无条件拦「跨站点击」：那会把页面上所有正常的外链都拦掉。
 * 每一条判据都要求先有"这不是正常点击"的证据。
 */

export type ClickGuardInput = {
  /** 事件是否由真实用户输入产生。脚本合成的事件为 false。 */
  trusted: boolean;
  pageHost: string;
  /** 事件目标（或落点最上层元素）所属链接的 href，没有则为 null */
  linkHref: string | null;
  /** 该链接元素是否不可见（零尺寸/不可见）。合成点击的劫持锚点通常如此 */
  linkIsInvisible: boolean;
  /** 落点/目标位于我们已隐藏的广告子树里 */
  insideHiddenAd: boolean;
  /** 落点最上层是隐形全屏覆盖层 */
  overInvisibleLayer: boolean;
};

export type ClickGuardVerdict = {
  block: boolean;
  reason: string | null;
};

/** href 是否指向与当前页面不同的可注册域名。 */
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

  // ① 脚本合成的点击 + 跨站链接 + 链接不可见
  //    要求"不可见"是为了不误伤正常的程序化下载流程（那类锚点通常有尺寸）
  if (!input.trusted) {
    if (crossSite && input.linkIsInvisible) {
      return { block: true, reason: 'synthetic-hidden-cross-site-click' };
    }
    return { block: false, reason: null };
  }

  // ② 真实点击落在我们已判定为广告的元素上
  if (input.insideHiddenAd) {
    return { block: true, reason: 'click-inside-hidden-ad' };
  }

  // ③ 真实点击落在隐形全屏覆盖层上 —— 点击劫持的主通路
  if (input.overInvisibleLayer) {
    return { block: true, reason: 'invisible-click-layer' };
  }

  return { block: false, reason: null };
}

/** 会触发导航的事件类型（文档级处理函数挂在这些类型上都值得怀疑）。 */
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
 * 取出监听器的源码文本（函数或 handleEvent 对象）。
 */
function listenerSource(listener: unknown): string {
  if (typeof listener === 'function') return String(listener);
  const handleEvent = (listener as { handleEvent?: unknown } | null)?.handleEvent;
  return typeof handleEvent === 'function' ? String(handleEvent) : '';
}

/**
 * 判断一个**文档级**点击监听器是否在做导航操作（即点击劫持形态）。
 *
 * 背景（实测踩到）：`/capture` 那种手法是
 * `document.addEventListener('click', () => { location.href = 广告地址 }, true)`。
 * 这种点击的目标是**正常内容**，所以事件层没法拦（拦了就是拦正常点击）；
 * 而 `location.href` 的赋值本身**无法被拦截**。
 * 唯一可行的位置是在注册时就拒绝它。
 *
 * 判定只看**导航操作本身**（赋值或调用 assign/replace），不看是否提到 location ——
 * 否则会误伤 SPA 路由（它们常在文档级监听器里读 `location.pathname` 并
 * `history.pushState`，那是正常行为）。
 *
 * 取舍：如果一个站点真在文档级监听器里做整页跳转，它会被一起拦掉。
 * 正常站点不会这么写（它们用 `<a href>` 或 History API），因此接受这个代价。
 */
export function looksLikeNavigationHijack(listener: unknown): boolean {
  const source = listenerSource(listener);
  if (!source) return false;

  // 前置边界：`location` 不能是更长标识符的一部分（如 mylocation），
  // 但要允许前面是 `.`（window.location / self.location）。
  const L = String.raw`(?:^|[^\w$])location`;

  // ① location.href = … / location['href'] = … / location.assign = …
  if (new RegExp(`${L}\\s*(?:\\.\\s*|\\[\\s*["']?)(?:href|assign|replace)["']?\\s*\\]?\\s*=[^=]`, 'i').test(source)) {
    return true;
  }
  // ② location.assign(…) / location.replace(…) / location['assign'](…)
  if (new RegExp(`${L}\\s*\\.\\s*(?:assign|replace)\\s*\\(`, 'i').test(source)) return true;
  if (new RegExp(`${L}\\s*\\[\\s*["'](?:assign|replace)["']\\s*\\]\\s*\\(`, 'i').test(source)) return true;
  // ③ location = '…' / self.location = '…'（整体替换；排除同名变量声明）
  if (!/(?:^|[^.\w])(?:const|let|var)\s+location\s*=/.test(source)) {
    if (new RegExp(`${L}\\s*=[^=]`, 'i').test(source)) return true;
    if (/(?:^|[^\w$])(?:self|top|parent|window|document)\s*\.\s*location\s*=[^=]/i.test(source)) {
      return true;
    }
  }
  // ④ window.open(…) / self.open(…)
  if (/(?:^|[^\w$])(?:window|self|top)\s*\.\s*open\s*\(/i.test(source)) return true;

  return false;
}
