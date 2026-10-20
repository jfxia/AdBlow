import { registrableDomain } from '../engine/score.ts';

/**
 * window.open allow policy.
 *
 * Without a user gesture only same-registrable-domain, non-empty targets pass (the site under
 * test opened popups/checkout pages via a gesture-less `window.open` and reopened them after
 * reload from persisted state, design doc §1.4).
 *
 * With a gesture, what matters is **where the gesture landed**. A click on a link, button or
 * other control is the user asking for that window, so it passes. A click on ordinary text or
 * background is not: that is exactly the trigger a popunder SDK waits for (2026-10-20,
 * missav.watch ships `__htapop` with `type:"popunder"`, 1001×800, counting `clickedElement`),
 * so a cross-site window from such a click is refused. Same-site opens still pass, so ordinary
 * pages that open their own popups keep working.
 */
export function shouldAllowOpen(
  url: string,
  pageHost: string,
  hadUserGesture: boolean,
  gestureOnControl = true,
): boolean {
  // Empty and javascript: targets are never a real window, gesture or not.
  if (!url || url === 'about:blank' || url.startsWith('javascript:')) return false;

  if (hadUserGesture && gestureOnControl) return true;

  try {
    const parsed = new URL(url, `https://${pageHost}`);
    return registrableDomain(parsed.hostname) === registrableDomain(pageHost);
  } catch {
    return false;
  }
}

/**
 * Whether a listener on pagehide/beforeunload looks like an ad beacon. Sites re-attach
 * reporting at unload to compensate for requests we blocked. Source-text heuristics only,
 * so it stays deliberately conservative: block only on clear reporting keywords, to avoid
 * killing a site's legitimate cleanup logic.
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
