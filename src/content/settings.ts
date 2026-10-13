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
