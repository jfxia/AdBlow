import type { DnrRule } from './dnr.ts';
import type { ResourceType } from './rules.ts';

/**
 * 把「自学习到的广告域名」编译成 DNR 拦截规则。
 *
 * ⚠️ 三条硬性安全约束（每一条都对应一次真实故障或明确的误伤风险）：
 *
 * 1. **绝不拦 `main_frame`。** 这些域名是从被隐藏的广告里学来的，通常也是广告
 *    落地页。用户完全可能主动点击（或者域名被复用于正常站点）——拦掉 main_frame
 *    会让导航直接失败，那是最难排查的故障。只拦子资源。
 *
 * 2. **绝不拦 `image` / `media`。** 见 SUBRESOURCE_TYPES 的说明：
 *    内容图与广告素材共用 CDN 太常见，拦图片会让「整站图片不显示」。
 *
 * 3. **按站点豁免。** 域名是全局概念（`ads.x.com` 在哪个站点都是广告域名），
 *    所以规则是全局的；但用户手动关掉某个站点时，那些站点下必须全部豁免，
 *    否则「关掉本站」只停了 DOM 层、网络层照旧，用户会觉得开关没用。
 */

/** 「学习到的广告域名」规则占用的 id 区间，避免与站点规则包冲突。 */
export const LEARNED_DOMAIN_ID_BASE = 30000;

/**
 * 自学习域名规则允许拦截的资源类型。
 *
 * ⚠️ **刻意不含 `image` 与 `media`**（2026-10-10 一次真实事故的教训）：
 * 曾经把全部子资源类型都放进来自学习规则，结果 1024cg 首页**所有图片都不显示**——
 * 该站的内容缩略图与广告素材共用同一个 CDN（`pic.jtzatly.cn`），
 * 域名被学走后连带把正文图片一起拦掉了。
 *
 * 结构性保证：**自学习来的网络规则永远不可能弄坏页面的图片与视频。**
 * 代价很小 —— 拦广告的价值主要在 `script` / `sub_frame` / `xmlhttprequest`
 * （广告 SDK、追踪上报、弹窗），而不是图片本身。
 */
export const SUBRESOURCE_TYPES: ResourceType[] = [
  'sub_frame',
  'stylesheet',
  'script',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'websocket',
  'other',
];

export function learnedDomainRules(
  domains: string[],
  excludedInitiatorDomains: string[] = [],
  idBase: number = LEARNED_DOMAIN_ID_BASE,
): DnrRule[] {
  const exclusions = [...new Set(excludedInitiatorDomains)].filter(Boolean).sort();

  return domains.map((domain, i) => ({
    id: idBase + i,
    /**
     * 优先级 2：**高于列表普通拦截（1）、低于列表例外（3）**。
     *
     * 这个次序是有意的：自学习会学错（域名被复用于正常服务、或站点改版），
     * 所以必须留一条"列表例外能推翻自学习"的退路。
     * 见 filterList/compile.ts 的 PRIORITY 表。
     */
    priority: 2,
    action: { type: 'block' as const },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: SUBRESOURCE_TYPES,
      ...(exclusions.length ? { excludedInitiatorDomains: exclusions } : {}),
    },
  }));
}
