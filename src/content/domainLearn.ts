import type { KvStore } from './storage.ts';

/**
 * 网络层自学习：把「被隐藏的广告用到的域名」晋级为 DNR 拦截规则。
 *
 * 为什么需要它：DOM 层隐藏只能让广告看不见，请求照发（浪费带宽、可能带追踪）。
 * 而未知站点原本完全没有网络层规则。这个闭环让扩展**越用越准且零配置**：
 * 同一域名累计在广告里出现 PROMOTE_DOMAIN_AFTER 次即晋级，此后该域名的请求
 * 在真正发起前就被拦掉。
 *
 * 抗污染与上一层的规则学习一致：需累计命中才晋级，且可逐条撤销。
 */

export const PROMOTE_DOMAIN_AFTER = 3;

export type DomainEntry = {
  host: string;
  hits: number;
  promoted: boolean;
  lastSeenAt: number;
  /** 首次出现的页面，便于用户判断这条学得对不对 */
  samplePage: string;
};

export type DomainMap = Record<string, DomainEntry>;

export const domainsKey = (pageHost: string): string => `adDomains:${pageHost}`;

const PREFIX = 'adDomains:';

export function hostFromDomainsKey(key: string): string | null {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}

export async function recordDomains(
  store: KvStore,
  pageHost: string,
  domains: string[],
  pageUrl: string,
): Promise<void> {
  if (domains.length === 0) return;

  const key = domainsKey(pageHost);
  const current = (await store.get<DomainMap>(key)) ?? {};
  const now = Date.now();

  for (const host of domains) {
    const entry = current[host] ?? {
      host,
      hits: 0,
      promoted: false,
      lastSeenAt: now,
      samplePage: pageUrl,
    };
    entry.hits += 1;
    entry.lastSeenAt = now;
    if (entry.hits >= PROMOTE_DOMAIN_AFTER) entry.promoted = true;
    current[host] = entry;
  }

  await store.set(key, current);
}

/** 某个页面宿主下已晋级的域名。 */
export async function promotedDomainsFor(store: KvStore, pageHost: string): Promise<string[]> {
  const current = (await store.get<DomainMap>(domainsKey(pageHost))) ?? {};
  return Object.values(current)
    .filter((e) => e.promoted)
    .map((e) => e.host)
    .sort();
}

/**
 * **全局**已晋级的域名（去重）。
 *
 * 域名是全局概念：`ads.example.com` 在哪个站点都是广告域名。
 * 因此 DNR 规则也是全局的，只在「用户手动关掉了某个站点」时按站点豁免。
 */
export async function allPromotedDomains(store: KvStore): Promise<string[]> {
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX));
  const out = new Set<string>();
  for (const key of keys) {
    const current = (await store.get<DomainMap>(key)) ?? {};
    for (const entry of Object.values(current)) {
      if (entry.promoted) out.add(entry.host);
    }
  }
  return [...out].sort();
}

/**
 * **全局**已晋级的域名 + **教会它的站点清单**。
 *
 * 为什么需要站点清单（2026-10-13 第二次同类事故后加的）：
 * 自学习域名原本编译成**全局** DNR 规则。但"这个域名在本站是广告域名"
 * 不等于"它在别的站点也是" —— 第三方 CDN 被多个站点共用时，
 * 在 A 站学到的域名很可能正是 B 站自己的资源来源。
 * 实测事故：某视频站的关键脚本与播放器库全部来自它自己的 CDN，
 * 一旦该 CDN 域名被学走，整页渲染与功能一起崩掉
 * （页面 JS 运行时创建的图片全部消失、播放器容器高度归零）。
 *
 * 返回 `Map<域名, 页面宿主[]>`，供 `learnedDomainRules` 写成
 * `initiatorDomains` 条件 —— 把爆炸半径限制在教会它的站点内。
 */
export async function allPromotedDomainScopes(store: KvStore): Promise<Map<string, string[]>> {
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX)).sort();
  const out = new Map<string, Set<string>>();
  for (const key of keys) {
    const pageHost = hostFromDomainsKey(key);
    if (!pageHost) continue;
    const current = (await store.get<DomainMap>(key)) ?? {};
    for (const entry of Object.values(current)) {
      if (!entry.promoted) continue;
      if (!out.has(entry.host)) out.set(entry.host, new Set());
      out.get(entry.host)!.add(pageHost);
    }
  }
  return new Map([...out].map(([host, hosts]) => [host, [...hosts].sort()]));
}

export async function allDomainEntries(
  store: KvStore,
): Promise<{ pageHost: string; entries: DomainEntry[] }[]> {
  const keys = (await store.keys()).filter((k) => k.startsWith(PREFIX)).sort();
  const out: { pageHost: string; entries: DomainEntry[] }[] = [];
  for (const key of keys) {
    const pageHost = hostFromDomainsKey(key);
    if (!pageHost) continue;
    const current = (await store.get<DomainMap>(key)) ?? {};
    out.push({ pageHost, entries: Object.values(current).sort((a, b) => b.hits - a.hits) });
  }
  return out;
}

export async function forgetDomain(
  store: KvStore,
  pageHost: string,
  host: string,
): Promise<void> {
  const key = domainsKey(pageHost);
  const current = (await store.get<DomainMap>(key)) ?? {};
  if (!(host in current)) return;

  delete current[host];
  // 删空后连键一起删掉，避免留下一堆空键（否则 UI 会列出空分组）
  if (Object.keys(current).length === 0) await store.remove(key);
  else await store.set(key, current);
}

export async function clearDomains(store: KvStore, pageHost: string): Promise<void> {
  await store.remove(domainsKey(pageHost));
}
