/**
 * 自研规则模型。
 *
 * 本项目的核心决策之一是**不引入任何第三方过滤列表**，因此这里刻意不实现
 * ABP/EasyList 语法兼容——规则只由我们自己写（站点规则包）或引擎自学习产生。
 */

/**
 * DNR 资源类型。刻意使用自有联合类型而非 chrome.* 类型，
 * 目的是让整个 src/engine/ 保持浏览器无关，可在 Node 里直接单测。
 */
export type ResourceType =
  | 'main_frame'
  | 'sub_frame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xmlhttprequest'
  | 'ping'
  | 'csp_report'
  | 'media'
  | 'websocket'
  | 'webtransport'
  | 'webbundle'
  | 'other';

export type NetworkRule = {
  /** domain → `||host^`；path → 原样子串；regex → 原样正则。 */
  kind: 'domain' | 'path' | 'regex';
  value: string;
  resourceTypes: ResourceType[];
};

export type SitePack = {
  id: string;
  matches: string[];
  network: NetworkRule[];
  cosmetic: string[];
};

/**
 * 误伤护栏（设计文档 §2，2026-10-10 实测取证）。
 *
 * 命中即视为规则包非法。这些改动的共同点是**会让网站直接不可用**，
 * 比漏拦广告严重得多。
 */
const FORBIDDEN_COSMETIC: { re: RegExp; why: string }[] = [
  {
    re: /^\[data-ssp-container\]$/,
    why: 'data-ssp-container 内部承载真实 <article> 正文列表，隐藏它会抹掉正文',
  },
  {
    re: /(^|[\s,>])\.post-card(?![-\w])/,
    why: '.post-card 全站有 110 个 div + 20 个 h2 在用，裸选择器会误伤正文',
  },
];

const FORBIDDEN_NETWORK: { re: RegExp; why: string }[] = [
  {
    re: /pic\.wvxrrip\.cn/,
    why: 'pic.wvxrrip.cn 同时承载正文缩略图（loadBannerDirect 直接绑定到 #post-card-*）',
  },
];

export function validateSitePack(pack: SitePack): string[] {
  const problems: string[] = [];

  for (const sel of pack.cosmetic) {
    for (const f of FORBIDDEN_COSMETIC) {
      if (f.re.test(sel.trim())) problems.push(`cosmetic "${sel}" 被拒绝：${f.why}`);
    }
  }

  for (const r of pack.network) {
    for (const f of FORBIDDEN_NETWORK) {
      if (f.re.test(r.value)) problems.push(`network "${r.value}" 被拒绝：${f.why}`);
    }
  }

  return problems;
}
