import { registrableDomain } from '../engine/score.ts';

/**
 * window.open allow policy: without a user gesture only same-registrable-domain, non-empty
 * targets pass. The site under test opened popups/checkout pages via a gesture-less
 * window.open and reopened them after reload from persisted state (design doc §1.4).
 * Pure function, directly testable in Node.
 */
export function shouldAllowOpen(
  url: string,
  pageHost: string,
  hadUserGesture: boolean,
): boolean {
  // Links the user clicked themselves always pass, so normal features keep working.
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
