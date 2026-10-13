/**
 * Our own rule model: ABP/EasyList syntax is deliberately not implemented, because
 * rules come only from our own site packs or from engine self-learning.
 */

/**
 * DNR resource types. Deliberately our own union rather than chrome.* types, so all
 * of src/engine/ stays browser-agnostic and unit-testable in Node.
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
  /** domain → `||host^`; path → raw substring; regex → raw regex. */
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
 * False-positive guardrails (design doc §2): a hit makes the pack invalid. These
 * all make a site unusable outright, which is far worse than missing an ad.
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

/**
 * Verdict for a single selector. **The self-learning path must run through this
 * too** (2026-10-10): it derived the banned `.post-card`, which `validateSitePack`
 * only checked for packs, so whole article card lists were hidden.
 * Returns the reason, or null when allowed.
 */
export function forbiddenSelectorReason(selector: string): string | null {
  const trimmed = selector.trim();
  for (const f of FORBIDDEN_COSMETIC) {
    if (f.re.test(trimmed)) return f.why;
  }
  return null;
}

export function validateSitePack(pack: SitePack): string[] {
  const problems: string[] = [];

  for (const sel of pack.cosmetic) {
    const reason = forbiddenSelectorReason(sel);
    if (reason) problems.push(`cosmetic "${sel}" 被拒绝：${reason}`);
  }

  for (const r of pack.network) {
    for (const f of FORBIDDEN_NETWORK) {
      if (f.re.test(r.value)) problems.push(`network "${r.value}" 被拒绝：${f.why}`);
    }
  }

  return problems;
}
