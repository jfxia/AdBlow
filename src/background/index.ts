import { toDnrRules } from '../engine/dnr.ts';
import { matchPattern } from '../engine/match.ts';
import { validateSitePack, type NetworkRule } from '../engine/rules.ts';
import { SITE_PACKS } from '../rules/sites/index.ts';

/**
 * Service Worker。
 *
 * 职责：把自研网络规则同步为 DNR 动态规则；按 URL 分发站点规则包；
 * 统计。MV3 已无阻塞式 webRequest，网络拦截只能走 declarativeNetRequest。
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

async function syncDnrRules(): Promise<void> {
  const desired = toDnrRules(usableRules(), ID_BASE);

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: desired as unknown as chrome.declarativeNetRequest.Rule[],
    });
    console.log(`[adblow] 已同步 ${desired.length} 条 DNR 规则`);
  } catch (error) {
    console.error('[adblow] 同步 DNR 规则失败', error);
  }
}

chrome.runtime.onInstalled.addListener(() => void syncDnrRules());
chrome.runtime.onStartup.addListener(() => void syncDnrRules());

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
