import { toDnrRules } from '../engine/dnr.ts';
import { learnedDomainRules } from '../engine/learnedRules.ts';
import { matchPattern } from '../engine/match.ts';
import { validateSitePack, type NetworkRule } from '../engine/rules.ts';
import { allPromotedDomains } from '../content/domainLearn.ts';
import { disabledKey } from '../content/settings.ts';
import { chromeLocal } from '../content/storage.ts';
import { SITE_PACKS } from '../rules/sites/index.ts';

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
  const msg = message as { type?: string; url?: string } | undefined;

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
