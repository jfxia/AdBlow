import { keysToScrub, scrubWindowName } from '../engine/scrub.ts';
import { looksLikeTrackingListener, shouldAllowOpen } from './guards.ts';

/**
 * MAIN world 注入。
 *
 * 必须在 MAIN world：window.open 只能在页面自身上下文里改。因此这里
 * **不能**用任何 chrome.* API（MAIN world 拿不到）。
 *
 * 依据：设计文档 §1.4 —— 站点的「本地降级体系」用 localStorage +
 * sessionStorage + window.name 三处持久化弹窗状态，并在 pagehide 重挂 beacon。
 */

let hadUserGesture = false;
for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
  addEventListener(type, () => { hadUserGesture = true; }, { capture: true, passive: true });
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

// ── 2) 持久化弹窗状态清理 ────────────────────────────────────────
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

// ── 3) 拦截挂在 pagehide / beforeunload 上的广告 beacon ──────────
const rawAddEventListener = EventTarget.prototype.addEventListener;

EventTarget.prototype.addEventListener = function patched(
  this: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void {
  if ((type === 'pagehide' || type === 'beforeunload') && this === window) {
    if (looksLikeTrackingListener(listener)) {
      console.debug('[adblow] 已拦截卸载期上报监听器', type);
      return;
    }
  }
  return rawAddEventListener.call(this, type, listener, options);
};
