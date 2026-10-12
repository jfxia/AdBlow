import type { DnrRule } from './dnr.ts';
import type { ResourceType } from './rules.ts';

/**
 * 把「自学习到的广告域名」编译成 DNR 拦截规则。
 *
 * ⚠️ 两条硬性安全约束：
 *
 * 1. **绝不拦 `main_frame`。** 这些域名是从被隐藏的广告里学来的，通常也是广告
 *    落地页。用户完全可能主动点击（或者域名被复用于正常站点）——拦掉 main_frame
 *    会让导航直接失败，那是最难排查的故障。只拦子资源。
 *
 * 2. **按站点豁免。** 域名是全局概念（`ads.x.com` 在哪个站点都是广告域名），
 *    所以规则是全局的；但用户手动关掉某个站点时，那些站点下必须全部豁免，
 *    否则「关掉本站」只停了 DOM 层、网络层照旧，用户会觉得开关没用。
 */

/** 「学习到的广告域名」规则占用的 id 区间，避免与站点规则包冲突。 */
export const LEARNED_DOMAIN_ID_BASE = 30000;

/**
 * 除 main_frame 外的全部资源类型。
 * 用白名单方式列出（而不是"全部"），是为了让新增类型时有人工确认的机会。
 */
export const SUBRESOURCE_TYPES: ResourceType[] = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'media',
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
    priority: 1,
    action: { type: 'block' as const },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: SUBRESOURCE_TYPES,
      ...(exclusions.length ? { excludedInitiatorDomains: exclusions } : {}),
    },
  }));
}
