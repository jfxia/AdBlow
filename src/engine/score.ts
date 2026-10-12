import { NAMING_NONE, NAMING_SSP, NAMING_STRONG, NAMING_WEAK, namingSignal } from './lexicon.ts';

/**
 * 广告度打分。
 *
 * 这是「完全自研不用第三方列表」路线下通用性的来源：不依赖任何名单，
 * 只看节点的命名与行为特征。
 *
 * ⚠️ 两条结构约束都是 2026-10-10 用真实页面标定出来的，改了会出事：
 *
 * 1. **后代链接/媒体信号只在元素足够紧凑时计入。**
 *    早期版本对整棵子树无条件聚合，结果 `<html>` 拿到 20 分、`<body>` 20 分——
 *    盒子越大分越高，一旦过阈值就是整页消失。大容器不是广告，小而密的外链盒子才是。
 *
 * 2. **命名证据与行为证据必须分开返回。**
 *    命名（class/id 里的广告术语）是确定性证据；行为（跨站外链、推广参数）
 *    是间接证据。两者可信度不同，判定层要区别对待，因此不能只吐一个总分。
 */

export const COMPACT_MAX_DESCENDANTS = 12;

export type ScoreContext = {
  pageHost: string;
  viewportArea: number;
  /** 后代数量上限，超过则忽略后代信号。测试可覆盖。 */
  compactMax?: number;
};

export type ScoreResult = {
  /** 命名分 + 行为分 */
  score: number;
  /** 仅命名证据所得分 */
  naming: number;
  /** 仅行为证据所得分 */
  behavior: number;
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
/** iframe 也是常见投放方式（广告联盟普遍用它），必须计入。 */
const IFRAME_SELECTOR = 'iframe[src],iframe[srcdoc]';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[?[0-9a-f:]+\]?$/i;

/** 主机名是否为 IP 字面量（v4 或 v6）。 */
export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || (host.includes(':') && IPV6.test(host));
}

/**
 * 粗略取可注册域名：末两段。
 *
 * ⚠️ IP 字面量必须原样返回。实测踩过：对 `54.169.219.76` 取末两段会得到
 * `219.76`，进而生成 `||219.76^` 这种会误配无关主机的拦截规则。
 * 对 .com.cn 这类多段后缀仍会不准，v1 接受。
 */
export function registrableDomain(host: string): string {
  if (isIpLiteral(host)) return host;
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

function isAbsoluteUrl(u: string): boolean {
  return /^https?:/i.test(u) || u.startsWith('//');
}

/**
 * 取媒体地址。
 *
 * 必须先看 src 是否**绝对地址**再退回 data-src：
 * 该站用 `src=占位图 + data-src=真实图` 做懒加载，若因为 src 存在就直接采用，
 * 跨站的真实图会被整批漏掉。
 */
function mediaUrl(el: Element): string {
  const src = el.getAttribute('src') ?? '';
  if (isAbsoluteUrl(src)) return src;
  const lazy = el.getAttribute('data-src') ?? '';
  return lazy || src;
}

/** 命名分：SSP 标记与强命名同分（都是确定性证据），弱命名减半。 */
function namingScore(strength: number): { points: number; reason: string | null } {
  if (strength >= NAMING_SSP) return { points: 6, reason: 'ssp-marker' };
  if (strength === NAMING_STRONG) return { points: 6, reason: 'ad-naming' };
  if (strength === NAMING_WEAK) return { points: 2, reason: 'ad-naming-weak' };
  return { points: 0, reason: null };
}

export { NAMING_NONE, NAMING_SSP, NAMING_STRONG, NAMING_WEAK };

export function scoreNode(el: Element, ctx: ScoreContext): ScoreResult {
  const reasons = new Set<string>();

  const signal = namingSignal(el);
  const naming = namingScore(signal.strength);
  if (naming.reason) reasons.add(naming.reason);

  let behavior = 0;

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
        behavior += 4;
        reasons.add('cross-site-link');
      }
      const search = parsed.search.toLowerCase();
      if (PROMO_PARAMS.some((p) => search.includes(p))) {
        behavior += 2;
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
        behavior += 3;
        reasons.add('cross-site-media');
      }
    }
  };

  const addIframes = (frames: Element[]): void => {
    for (const f of frames) {
      const src = f.getAttribute('src') ?? '';
      // about:blank / srcdoc / javascript: 的 iframe 是脚本注入内容的常见载体
      if (!isAbsoluteUrl(src)) {
        if (f.hasAttribute('srcdoc') || src === '' || src === 'about:blank') {
          behavior += 2;
          reasons.add('inline-iframe');
        }
        continue;
      }
      let parsed: URL;
      try {
        parsed = new URL(src, base);
      } catch {
        continue;
      }
      if (registrableDomain(parsed.hostname) !== pageReg) {
        // 4 分与跨站链接同权：跨站 iframe 也可能是正常的第三方嵌入
        // （视频、地图、评论），所以**不足以单独判定**，需要别的证据。
        behavior += 4;
        reasons.add('cross-site-iframe');
      }
    }
  };

  // ① 自身即链接 / 自身即媒体 / 自身即 iframe
  if (el.matches(LINK_SELECTOR)) addLinks([el]);
  if (el.matches(MEDIA_SELECTOR)) addMedia([el]);
  if (el.matches(IFRAME_SELECTOR)) addIframes([el]);

  // ② 后代信号：仅在该元素紧凑时计入（见文件头说明）
  const compactMax = ctx.compactMax ?? COMPACT_MAX_DESCENDANTS;
  if (el.querySelector(`${LINK_SELECTOR},${MEDIA_SELECTOR},${IFRAME_SELECTOR}`)) {
    if (el.querySelectorAll('*').length <= compactMax) {
      addLinks(Array.from(el.querySelectorAll(LINK_SELECTOR)));
      addMedia(Array.from(el.querySelectorAll(MEDIA_SELECTOR)));
      addIframes(Array.from(el.querySelectorAll(IFRAME_SELECTOR)));
    }
  }

  return {
    score: naming.points + behavior,
    naming: naming.points,
    behavior,
    reasons: [...reasons],
  };
}
