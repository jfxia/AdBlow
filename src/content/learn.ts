/**
 * 自学习规则库。
 *
 * 「完全自研不用第三方列表」这条路线下，普通网站的覆盖只能靠引擎自己长规则。
 * 这就是那个增长闭环的存储层。
 *
 * 抗污染（关键）：命中一次就入库会让误判永久固化。因此同一泛化选择器必须
 * 累计命中 PROMOTE_AFTER 次才晋级为持久规则；未晋级的仍在本页面即时生效。
 * 另外提供 forgetSelector 供 UI 一键撤销。
 *
 * 存储通过注入的 KvStore 访问，因此本模块不依赖 chrome.*，可在 Node 里直接测。
 */
import type { KvStore } from './storage.ts';

export const PROMOTE_AFTER = 3;

export type LearnedEntry = {
  selector: string;
  hits: number;
  promoted: boolean;
};

export type LearnedMap = Record<string, LearnedEntry>;

export const learnedKey = (host: string): string => `learned:${host}`;

const LEARNED_PREFIX = 'learned:';

export function hostFromLearnedKey(key: string): string | null {
  return key.startsWith(LEARNED_PREFIX) ? key.slice(LEARNED_PREFIX.length) : null;
}

export async function recordHit(
  store: KvStore,
  host: string,
  selector: string,
): Promise<LearnedEntry> {
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  const entry = current[selector] ?? { selector, hits: 0, promoted: false };

  entry.hits += 1;
  if (entry.hits >= PROMOTE_AFTER) entry.promoted = true;

  current[selector] = entry;
  await store.set(key, current);
  return entry;
}

export async function promotedSelectors(store: KvStore, host: string): Promise<string[]> {
  const current = (await store.get<LearnedMap>(learnedKey(host))) ?? {};
  return Object.values(current)
    .filter((e) => e.promoted)
    .map((e) => e.selector)
    .sort();
}

export async function allEntries(store: KvStore, host: string): Promise<LearnedEntry[]> {
  const current = (await store.get<LearnedMap>(learnedKey(host))) ?? {};
  return Object.values(current).sort((a, b) => b.hits - a.hits);
}

export async function forgetSelector(
  store: KvStore,
  host: string,
  selector: string,
): Promise<void> {
  const key = learnedKey(host);
  const current = (await store.get<LearnedMap>(key)) ?? {};
  delete current[selector];
  await store.set(key, current);
}

export async function clearSite(store: KvStore, host: string): Promise<void> {
  await store.remove(learnedKey(host));
}

/** 列出所有有自学习规则的站点及其条目。 */
export async function listAllSites(
  store: KvStore,
): Promise<{ host: string; entries: LearnedEntry[] }[]> {
  const keys = await store.keys();
  const hosts = keys.map(hostFromLearnedKey).filter((h): h is string => h !== null).sort();

  const out: { host: string; entries: LearnedEntry[] }[] = [];
  for (const host of hosts) out.push({ host, entries: await allEntries(store, host) });
  return out;
}
