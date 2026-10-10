import { adSignalStrength } from './lexicon.ts';

/**
 * 广告度打分。
 *
 * 这是「完全自研不用第三方列表」路线下通用性的来源：不依赖任何名单，
 * 只看节点的行为特征。
 *
 * ⚠️ 结构约束（2026-10-10 用真实页面标定得出，改了会出事）：
 * 后代链接/媒体信号**只在元素足够紧凑时**才计入。
 * 早期版本对整棵子树无条件聚合，结果 `<html>` 拿到 20 分、`<body>` 20 分、
 * `<footer>` 12 分——盒子越大分越高，一旦过阈值就是整页消失。
 * 那不是阈值问题，是模型问题：**大容器不是广告，小而密的外链盒子才是。**
 */

export const COMPACT_MAX_DESCENDANTS = 12;

export type ScoreContext = {
  pageHost: string;
  viewportArea: number;
  /** 后代数量上限，超过则忽略后代信号。测试可覆盖。 */
  compactMax?: number;
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

const LINK_SELECTOR = 'a[href]';
/** 注意 data-src：该站用 loadBannerDirect + data-src 做懒加载，只认 src 会漏。 */
const MEDIA_SELECTOR = 'img[src],img[data-src],video[src],source[src]';

/** 粗略取可注册域名：末两段。对 .com.cn 这类多段后缀会不准，v1 接受。 */
export function registrableDomain(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function isAbsoluteUrl(u: string): boolean {
  return /^https?:/i.test(u) || u.startsWith('//');
}

/**
 * 取媒体地址。
 *
 * 注意这里必须先看 src 是否**绝对地址**再退回 data-src：
 * 该站用 `src=占位图 + data-src=真实图` 做懒加载（loadBannerDirect），
 * 若因为 src 存在就直接采用，跨站的真实图会被整批漏掉。
 */
function mediaUrl(el: Element): string {
  const src = el.getAttribute('src') ?? '';
  if (isAbsoluteUrl(src)) return src;
  const lazy = el.getAttribute('data-src') ?? '';
  return lazy || src;
}

export function scoreNode(el: Element, ctx: ScoreContext): ScoreResult {
  const reasons = new Set<string>();
  let score = 0;

  const lexicon = adSignalStrength(el);
  if (lexicon >= 3) {
    score += 6;
    reasons.add('ssp-marker');
  } else if (lexicon > 0) {
    score += 2;
    reasons.add('ad-token');
  }

  const pageReg = registrableDomain(ctx.pageHost);
  const base = `https://${ctx.pageHost}`;

  const addLinks = (links: Element[]): void => {
    for (const a of links) {
      const href = a.getAttribute('href') ?? '';
      if (!isAbsoluteUrl(href)) continue; // 站内相对链接不算
      let parsed: URL;
      try {
        parsed = new URL(href, base);
      } catch {
        continue;
      }
      if (registrableDomain(parsed.hostname) !== pageReg) {
        score += 4;
        reasons.add('cross-site-link');
      }
      const search = parsed.search.toLowerCase();
      if (PROMO_PARAMS.some((p) => search.includes(p))) {
        score += 2;
        reasons.add('promo-params');
      }
    }
  };

  const addMedia = (media: Element[]): void => {
    for (const m of media) {
      const url = mediaUrl(m);
      if (!isAbsoluteUrl(url)) continue;
      let parsed: URL;
      try {
        parsed = new URL(url, base);
      } catch {
        continue;
      }
      if (registrableDomain(parsed.hostname) !== pageReg) {
        score += 3;
        reasons.add('cross-site-media');
      }
    }
  };

  // ① 自身即链接 / 自身即媒体
  if (el.matches(LINK_SELECTOR)) addLinks([el]);
  if (el.matches(MEDIA_SELECTOR)) addMedia([el]);

  // ② 后代信号：仅在该元素紧凑时计入（见文件头说明）
  const compactMax = ctx.compactMax ?? COMPACT_MAX_DESCENDANTS;
  if (el.querySelector(`${LINK_SELECTOR},${MEDIA_SELECTOR}`)) {
    if (el.querySelectorAll('*').length <= compactMax) {
      addLinks(Array.from(el.querySelectorAll(LINK_SELECTOR)));
      addMedia(Array.from(el.querySelectorAll(MEDIA_SELECTOR)));
    }
  }

  return { score, reasons: [...reasons] };
}
