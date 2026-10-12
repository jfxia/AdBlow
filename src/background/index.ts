import { toDnrRules } from '../engine/dnr.ts';
import { learnedDomainRules } from '../engine/learnedRules.ts';
import { matchPattern } from '../engine/match.ts';
import { validateSitePack, type NetworkRule } from '../engine/rules.ts';
import {
  COSMETIC_SHARD_COUNT,
  selectorsFromShards,
  shardsForHost,
  type CosmeticShard,
} from '../engine/filterList/cosmetic.ts';
import { allPromotedDomains } from '../content/domainLearn.ts';
import { migrateLearnedSchema } from '../content/learn.ts';
import { disabledKey } from '../content/settings.ts';
import { chromeLocal } from '../content/storage.ts';
import { SITE_PACKS } from '../rules/sites/index.ts';

/**
 * cosmetic 分片的进程内缓存。
 *
 * key 是分片下标；value 是分片内容（取不到时记 null，避免反复重试）。
 * SW 会被回收，缓存随之失效，这是可接受的——重读本地文件很便宜。
 */
const cosmeticShardCache = new Map<number, CosmeticShard | null>();

async function loadShard(index: number): Promise<CosmeticShard | null> {
  const cached = cosmeticShardCache.get(index);
  if (cached !== undefined) return cached;

  try {
    const url = chrome.runtime.getURL(`cosmetic/shard-${index}.json`);
    const res = await fetch(url);
    const shard = res.ok ? ((await res.json()) as CosmeticShard) : null;
    cosmeticShardCache.set(index, shard);
    return shard;
  } catch {
    cosmeticShardCache.set(index, null);
    return null;
  }
}

/**
 * 取某主机名应生效的域名专用 cosmetic 选择器。
 *
 * 只读该主机名及其各级父域落到的分片（实测通常 2–3 片、单片几 KB）。
 * 没有分片文件时返回空数组（列表未生成或未抓取，扩展照常工作）。
 */
async function cosmeticForHost(host: string): Promise<string[]> {
  const indexes = shardsForHost(host, COSMETIC_SHARD_COUNT);
  const shards = await Promise.all(indexes.map((i) => loadShard(i)));
  return selectorsFromShards(shards, host);
}


/**
 * Service Worker。
 *
 * 职责：把网络规则同步为 DNR 动态规则、按 URL 分发站点规则包、快照回填。
 * MV3 已无阻塞式 webRequest，网络拦截只能走 declarativeNetRequest。
 *
 * 网络规则有两个来源：
 *   1. 内置站点规则包的显式规则
 *   2. **自学习到的广告域名** —— 这是「未知站点也会变好」的关键：
 *      域名在广告里累计出现足够次数后晋级，此后在真正发起请求前就被拦掉，
 *      用户不需要配置任何东西。
 */

const ID_BASE = 10000;

function usableRules(): NetworkRule[] {
  return SITE_PACKS.flatMap((pack) => {
    const problems = validateSitePack(pack);
    if (problems.length) {
      console.warn('[adblow] 规则包被误伤护栏拒绝，不生成网络规则', pack.id, problems);
      return [];
    }
    return pack.network;
  });
}

async function disabledHosts(): Promise<string[]> {
  const store = chromeLocal();
  const keys = await store.keys();
  return keys
    .filter((k) => k.startsWith('disabled:'))
    .map((k) => k.slice('disabled:'.length))
    .sort();
}

async function syncDnrRules(): Promise<void> {
  const store = chromeLocal();

  try {
    // 先做数据迁移：旧的（安全闸门之前的）自学习结果不可信，一律作废重学。
    // 必须在生成规则之前跑，否则会把作废的域名又写成 DNR 规则。
    try {
      const cleaned = await migrateLearnedSchema(store);
      if (cleaned) console.log('[adblow] 自学习数据版本已更新，旧的学习结果已清空');
    } catch (error) {
      console.warn('[adblow] 自学习数据迁移失败', error);
    }

    const packRules = toDnrRules(usableRules(), ID_BASE);
    // 用户手动关掉的站点下要豁免全部网络规则，否则「关掉本站」只停了 DOM 层
    const excluded = await disabledHosts();
    const learnedDomains = await allPromotedDomains(store);
    const learnedRules = learnedDomainRules(learnedDomains, excluded);

    const desired = [...packRules, ...learnedRules];

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: desired as unknown as chrome.declarativeNetRequest.Rule[],
    });
    console.log(
      `[adblow] 已同步 ${desired.length} 条 DNR 规则` +
        `（站点包 ${packRules.length} + 自学习域名 ${learnedRules.length}，豁免 ${excluded.length} 个站点）`,
    );
  } catch (error) {
    console.error('[adblow] 同步 DNR 规则失败', error);
  }
}

/** 自学习域名晋级或站点开关变化后需要重新同步，这里做去抖。 */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncDnrRules();
  }, 400);
}

chrome.runtime.onInstalled.addListener(() => void syncDnrRules());
chrome.runtime.onStartup.addListener(() => void syncDnrRules());

/**
 * Service Worker 每次被唤醒都重建一次规则。
 *
 * 为什么需要（用户反馈驱动）：DNR 动态规则是**持久化**的，代码升级后旧规则
 * 仍然生效。曾经因此出过一次事故 —— 自学习把内容图 CDN 学成拦截域名并写进了
 * 规则，修复了学习逻辑但用户浏览器里的旧规则还在，图片依然不显示。
 * 无条件重建保证「规则策略永远与当前代码一致」。
 *
 * 开销可忽略（一次 getDynamicRules + 一次 updateDynamicRules，且幂等）。
 */
void syncDnrRules();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('adDomains:') || key.startsWith('disabled:')) {
      scheduleSync();
      return;
    }
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  const msg = message as { type?: string; url?: string; host?: string } | undefined;

  /**
   * cosmetic（页面元素隐藏）规则：按主机名返回该站应生效的**域名专用**选择器。
   *
   * 为什么由 SW 读文件而不是内容脚本直接读：
   * 内容脚本读扩展内文件需要把文件列进 `web_accessible_resources`，
   * 那等于把它们暴露给页面（多一个指纹面）。uBlock Origin Lite 也是这个架构：
   * 数据由 SW 读、经消息回给内容脚本。
   *
   * 分片按**域名哈希**切分，这里只读当前主机名及其各级父域所在的那几片
   * （实测 256 片、单片最大 6.3 KB），并有进程内缓存。
   */
  if (msg?.type === 'get-cosmetic') {
    const host = msg.host;
    if (!host) {
      respond([]);
      return true;
    }
    void (async () => {
      try {
        const selectors = await cosmeticForHost(host);
        respond({ selectors });
      } catch (error) {
        console.warn('[adblow] 读取 cosmetic 分片失败', error);
        respond({ selectors: [] });
      }
    })();
    return true;
  }

  if (msg?.type === 'get-site-packs') {
    const url = msg.url ?? '';
    respond(SITE_PACKS.filter((p) => p.matches.some((m) => matchPattern(m, url))));
    return true;
  }

  /**
   * 快照回填：把该 URL 服务端返回的完整 HTML 交给内容脚本。
   *
   * 为什么必须由 SW 做：内容脚本拿不到「原始响应」，而 document_start 时 DOM
   * 才刚开始解析。没有完整快照就无法区分「服务端渲染的合法外链盒子」与
   * 「脚本注入的广告」，启发式就只能整体关闭（原因见 content/engine.ts）。
   *
   * 代价：未知站点**每页多一次同源请求**。因此由内容脚本按策略决定是否发起
   * （已匹配到站点规则包的站点不需要）。
   */
  if (msg?.type === 'get-pristine') {
    const url = msg.url;
    if (!url) {
      respond(null);
      return true;
    }
    void (async () => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          redirect: 'follow',
          cache: 'no-cache',
        });
        respond(res.ok ? { html: await res.text() } : null);
      } catch (error) {
        console.warn('[adblow] 回填快照请求失败', error);
        respond(null);
      }
    })();
    return true; // 异步响应
  }

  if (msg?.type === 'list-packs') {
    respond(
      SITE_PACKS.map((p) => ({
        id: p.id,
        matches: p.matches,
        network: p.network.length,
        cosmetic: p.cosmetic.length,
      })),
    );
    return true;
  }

  return false;
});
