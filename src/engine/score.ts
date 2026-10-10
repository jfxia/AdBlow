import { adSignalStrength } from './lexicon.ts';

/**
 * 广告度打分。
 *
 * 这是「完全自研不用第三方列表」路线下通用性的来源：不依赖任何名单，
 * 只看节点的行为特征。阈值由调用方决定（内容脚本初始用 6）。
 */

export type ScoreContext = {
  pageHost: string;
  viewportArea: number;
};

export type ScoreResult = {
  score: number;
  reasons: string[];
};

const PROMO_PARAMS = [
  'utm_',
  'click_id',
  'clickid',
  'aff',
  'affid',
  'invite',
  'channel',
  'tg_id',
];

/** 粗略取可注册域名：末两段。对 .com.cn 这类多段后缀会不准，v1 接受。 */
export function registrableDomain(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/** 只看元素自身时 querySelectorAll 会漏掉它，所以把自身也纳入匹配。 */
function selfAndDescendants(el: Element, selector: string): Element[] {
  const out: Element[] = [];
  if (el.matches(selector)) out.push(el);
  out.push(...Array.from(el.querySelectorAll(selector)));
  return out;
}

function isAbsoluteUrl(u: string): boolean {
  return /^https?:/i.test(u) || u.startsWith('//');
}

export function scoreNode(el: Element, ctx: ScoreContext): ScoreResult {
  const reasons = new Set<string>();
  let score = 0;

  const lex = adSignalStrength(el);
  if (lex >= 3) {
    score += 6;
    reasons.add('ssp-marker');
  } else if (lex > 0) {
    score += 2;
    reasons.add('ad-token');
  }

  const pageReg = registrableDomain(ctx.pageHost);
  const base = `https://${ctx.pageHost}`;

  for (const a of selfAndDescendants(el, 'a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!isAbsoluteUrl(href)) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (registrableDomain(u.hostname) !== pageReg) {
      score += 4;
      reasons.add('cross-site-link');
    }
    const search = u.search.toLowerCase();
    if (PROMO_PARAMS.some((p) => search.includes(p))) {
      score += 2;
      reasons.add('promo-params');
    }
  }

  for (const m of selfAndDescendants(el, 'img[src],video[src],source[src]')) {
    const src = m.getAttribute('src') ?? '';
    if (!isAbsoluteUrl(src)) continue;
    let u: URL;
    try {
      u = new URL(src, base);
    } catch {
      continue;
    }
    if (registrableDomain(u.hostname) !== pageReg) {
      score += 3;
      reasons.add('cross-site-media');
    }
  }

  return { score, reasons: [...reasons] };
}
