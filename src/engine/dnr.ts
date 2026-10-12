import type { NetworkRule, ResourceType } from './rules.ts';

/**
 * 把自研网络规则编译成 declarativeNetRequest 规则。
 *
 * MV3 已无阻塞式 webRequest，网络拦截只能走 DNR。返回结构化类型而非
 * chrome.* 类型，保持引擎浏览器无关；background 侧再断言成 chrome 类型。
 */

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'block' };
  condition: {
    urlFilter?: string;
    regexFilter?: string;
    resourceTypes: ResourceType[];
    /** 这些发起方域名下不生效（用于「用户关掉了某站点」时豁免） */
    excludedInitiatorDomains?: string[];
  };
}

export function toDnrRules(rules: NetworkRule[], idBase: number): DnrRule[] {
  return rules.map((r, i) => ({
    id: idBase + i,
    priority: 1,
    action: { type: 'block' as const },
    condition: {
      ...(r.kind === 'domain'
        ? { urlFilter: `||${r.value}^` }
        : r.kind === 'path'
          ? { urlFilter: r.value }
          : { regexFilter: r.value }),
      resourceTypes: r.resourceTypes,
    },
  }));
}
