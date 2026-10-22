import type { KvStore } from './storage.ts';

/**
 * Per-site kill switch and run stats.
 *
 * The switch is a safety valve: a filter misfiring on one site must be
 * disableable there, else the only escape is disabling the whole extension.
 */

export const disabledKey = (host: string): string => `disabled:${host}`;

export async function isSiteDisabled(store: KvStore, host: string): Promise<boolean> {
  return (await store.get<boolean>(disabledKey(host))) === true;
}

export async function setSiteDisabled(
  store: KvStore,
  host: string,
  disabled: boolean,
): Promise<void> {
  // Delete the key instead of writing false, so storage stays clean.
  if (disabled) await store.set(disabledKey(host), true);
  else await store.remove(disabledKey(host));
}

/**
 * Per-site popup escape hatch.
 *
 * The MAIN-world policy refuses cross-site windows by default, which is right for ads but can
 * break a site that opens a real window from a scripted button (OAuth, "share to", payment
 * redirect). The user decides per site instead of the extension guessing. Same storage shape as
 * the kill switch: key present = allowed, absent = not allowed.
 *
 * This is independent of `disabled:<host>` on purpose: turning filtering off should not silently
 * re-open the popup gate, and vice versa.
 *
 * The switch is written for the tab's top-level host; frames ask the worker about that host so
 * enabling it on a page also covers a window opened from an embedded frame (and the MAIN-world
 * guard runs in every frame).
 */
export const POPUP_ALLOW_PREFIX = 'popupallow:';

export const popupAllowKey = (host: string): string => `${POPUP_ALLOW_PREFIX}${host}`;

export async function isPopupAllowed(store: KvStore, host: string): Promise<boolean> {
  return (await store.get<boolean>(popupAllowKey(host))) === true;
}

export async function setPopupAllowed(
  store: KvStore,
  host: string,
  allowed: boolean,
): Promise<void> {
  if (allowed) await store.set(popupAllowKey(host), true);
  else await store.remove(popupAllowKey(host));
}

/**
 * Anti-adblock wall fix, per site — **an explicit user confirmation, never automatic**.
 *
 * Default is off: the extension does not touch the page until the user asks for the fix on that
 * site. The key is the confirmation itself (`wallfix:<host>`), and it lives in
 * `chrome.storage.local`, so the acceptance harness can seed it and the content script reads it
 * on load (and again when storage changes).
 */
export const wallFixKey = (host: string): string => `wallfix:${host}`;

export async function isWallFixEnabled(store: KvStore, host: string): Promise<boolean> {
  return (await store.get<boolean>(wallFixKey(host))) === true;
}

export async function setWallFixEnabled(
  store: KvStore,
  host: string,
  on: boolean,
): Promise<void> {
  // Same shape as setSiteDisabled: delete the key instead of writing false.
  if (on) await store.set(wallFixKey(host), true);
  else await store.remove(wallFixKey(host));
}

/**
 * When a wall was last detected on this site (timestamp).
 *
 * Detection runs even while the fix is off — that is what lets the popup say "a wall was found
 * here, fix it?" — and the timestamp is what makes the hint actionable rather than permanent.
 */
export const wallDetectedKey = (host: string): string => `walldetected:${host}`;

export async function markWallDetected(store: KvStore, host: string): Promise<void> {
  await store.set(wallDetectedKey(host), Date.now());
}

export async function readWallDetected(store: KvStore, host: string): Promise<number | undefined> {
  const at = await store.get<number>(wallDetectedKey(host));
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined;
}

export const statsKey = (host: string): string => `stats:${host}`;

export type SiteStats = {
  rule: number;
  heuristic: number;
  at: number;
};

export async function readStats(store: KvStore, host: string): Promise<SiteStats | undefined> {
  return store.get<SiteStats>(statsKey(host));
}

export async function writeStats(
  store: KvStore,
  host: string,
  stats: Omit<SiteStats, 'at'>,
): Promise<void> {
  await store.set(statsKey(host), { ...stats, at: Date.now() } satisfies SiteStats);
}
