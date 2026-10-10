import type { KvStore } from './storage.ts';

/**
 * 站点开关与运行统计。
 *
 * 站点开关是**安全阀**：一个会在某站点上出错的过滤器必须有「本站关掉」的出口，
 * 否则用户只能整个禁用扩展。因此内容脚本启动的第一件事就是查它。
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
  // 启用时删键而不是写 false，保持存储干净
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
