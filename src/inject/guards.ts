import { registrableDomain } from '../engine/score.ts';

/**
 * window.open 放行策略。
 *
 * 试点站用无手势的 window.open 开弹窗/充值页，并靠持久化状态在刷新后重开
 * （见设计文档 §1.4）。策略：无用户手势时只允许同可注册域名且非空目标。
 *
 * 纯函数，可在 Node 里直接测。
 */
export function shouldAllowOpen(
  url: string,
  pageHost: string,
  hadUserGesture: boolean,
): boolean {
  // 用户自己点的链接一律放行，避免把正常功能一起打死
  if (hadUserGesture) return true;

  if (!url || url === 'about:blank' || url.startsWith('javascript:')) return false;

  try {
    const parsed = new URL(url, `https://${pageHost}`);
    return registrableDomain(parsed.hostname) === registrableDomain(pageHost);
  } catch {
    return false;
  }
}

/**
 * 判断某个挂在 pagehide / beforeunload 上的监听器是否像广告 beacon。
 *
 * 站点在页面卸载时重挂上报，用来补偿被拦掉的请求。这里只能靠源码特征识别，
 * 因此宁可保守：只在明显命中上报关键词时才阻断，避免误杀站点的正常清理逻辑。
 */
export function looksLikeTrackingListener(listener: unknown): boolean {
  const source =
    typeof listener === 'function'
      ? listener.toString()
      : typeof (listener as { handleEvent?: unknown })?.handleEvent === 'function'
        ? String((listener as { handleEvent: () => unknown }).handleEvent)
        : '';
  if (!source) return false;
  return /beacon|navigator\.sendBeacon|report\.json|eventTracking|ab-test|pending/i.test(source);
}
