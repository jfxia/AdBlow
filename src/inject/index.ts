import { isInvisibleClickLayer } from '../engine/clickLayer.ts';
import { keysToScrub, scrubWindowName } from '../engine/scrub.ts';
import {
  NAVIGATION_EVENT_TYPES,
  looksLikeNavigationHijack,
  shouldBlockClick,
} from './clickGuard.ts';
import { looksLikeTrackingListener, shouldAllowOpen } from './guards.ts';

/**
 * MAIN world 注入。
 *
 * 必须在 MAIN world：`window.open` 与事件捕获都只能在页面自身上下文里改。
 * 因此这里**不能**用任何 chrome.* API（MAIN world 拿不到）。
 *
 * 依据：设计文档 §1.4（持久化弹窗状态）与点击劫持拦截。
 */

const HIDDEN_ATTR = 'data-adblow-hidden';

let hadUserGesture = false;
for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
  addEventListener(type, () => { hadUserGesture = true; }, { capture: true, passive: true });
}

/** 立刻隐藏（与内容脚本用同一套标记与样式，便于统计与排查）。 */
function hideNow(el: Element): void {
  el.setAttribute(HIDDEN_ATTR, '1');
  const style = (el as HTMLElement).style;
  if (!style) return;
  style.setProperty('display', 'none', 'important');
  style.setProperty('height', '0', 'important');
  style.setProperty('margin', '0', 'important');
  style.setProperty('padding', '0', 'important');
}

// ── 1) window.open 守卫 ──────────────────────────────────────────
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

// ── 2) 点击劫持拦截 ──────────────────────────────────────────────
//
// 现象（用户反馈）：页面加载后随便点哪里都会跳到别的网站。
// 手法是覆盖一个看不见的全屏层，或用一个文档级点击处理函数把点击导流走。
// 这里在**捕获相**、且注册得比页面脚本早（document_start），因此页面自己的
// 处理函数不会被执行。

function pointOf(ev: Event): { x: number; y: number } | null {
  const mouse = ev as MouseEvent;
  if (typeof mouse.clientX === 'number' && typeof mouse.clientY === 'number') {
    return { x: mouse.clientX, y: mouse.clientY };
  }
  const touch = ev as TouchEvent;
  const t = touch.touches?.[0] ?? touch.changedTouches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

/** 取元素所属链接的信息（href 与是否不可见）。 */
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

  // 三重阻断：阻止默认导航 + 阻止同一节点上的其它监听器 + 阻止继续传播
  ev.preventDefault();
  ev.stopImmediatePropagation();
  ev.stopPropagation();

  if (verdict.reason === 'invisible-click-layer' && topmost) hideNow(topmost);

  console.debug('[adblow] 已拦截点击劫持', verdict.reason, targetLink.href ?? topLink.href ?? '');
}

const CLICK_EVENTS = ['click', 'mousedown', 'mouseup', 'auxclick', 'pointerdown', 'touchstart'] as const;
for (const type of CLICK_EVENTS) {
  // window 捕获相最早触发；页面若也在同一相位注册，我们因为 document_start 而排在前面。
  // passive: false 是必须的 —— 否则 touchstart 上不能 preventDefault。
  window.addEventListener(type, clickGuard, { capture: true, passive: false });
  document.addEventListener(type, clickGuard, { capture: true, passive: false });
}

// ── 3) 持久化弹窗状态清理 ────────────────────────────────────────
function scrub(): void {
  for (const holder of [localStorage, sessionStorage]) {
    try {
      for (const key of keysToScrub(Object.keys(holder))) holder.removeItem(key);
    } catch {
      // 某些上下文禁用 storage，忽略
    }
  }
  try {
    window.name = scrubWindowName(window.name);
  } catch {
    // 忽略
  }
}

scrub();
setInterval(scrub, 2000);

// ── 4) 拦截文档级「点击即跳转」处理函数 ──────────────────────────
//
// 实测踩到的第三种点击劫持手法：
//   document.addEventListener('click', () => { location.href = 广告地址 }, true)
// 这种点击的目标是**正常内容**，所以事件层没法拦（拦了就是拦正常点击）；
// 而 `location.href` 的赋值本身**无法被拦截**。唯一可行的位置是在注册时拒绝它。
//
// 只在文档级监听器、且源码里确实做了导航操作时才拒绝 —— 元素级监听器不受影响，
// 因此正常的按钮/链接行为不会被破坏。
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
