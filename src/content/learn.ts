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

/**
 * 自学习数据的格式/信任版本。
 *
 * 递增它会**清空全部已学内容**，用于「旧的学出来的东西已经不可信」的场景。
 *
 * 版本历史：
 *   1 → 2（2026-10-10）：选择器安全闸门收紧。此前自学习能推导出
 *     `.post-card`（正文卡片类名）之类危险选择器并写进 document_start 的样式表，
 *     造成整站内容与图片被隐藏。旧数据一律作废重学。
 */
export const LEARNED_SCHEMA_VERSION = 2;

const SCHEMA_KEY = 'learnedSchemaVersion';
const LEARNED_PREFIX = 'learned:';
const DOMAINS_PREFIX = 'adDomains:';

export type LearnedEntry = {
  selector: string;
  hits: number;
  promoted: boolean;
};

export type LearnedMap = Record<string, LearnedEntry>;

export const learnedKey = (host: string): string => `learned:${host}`;

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

/**
 * 一次性迁移：版本不匹配时清空全部自学习结果（选择器 + 域名）并打上新版本号。
 *
 * 为什么必须做：安全闸门只能防止**将来**学到坏规则，管不了用户浏览器里
 * 已经存着的历史数据。不清理的话，用户即使重载扩展也可能继续被旧规则影响。
 *
 * 返回是否执行了清理。
 */
export async function migrateLearnedSchema(store: KvStore): Promise<boolean> {
  const current = await store.get<number>(SCHEMA_KEY);
  if (current === LEARNED_SCHEMA_VERSION) return false;

  for (const key of await store.keys()) {
    if (key.startsWith(LEARNED_PREFIX) || key.startsWith(DOMAINS_PREFIX)) {
      await store.remove(key);
    }
  }
  await store.set(SCHEMA_KEY, LEARNED_SCHEMA_VERSION);
  return true;
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
