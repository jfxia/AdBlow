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
  /**
   * 站点自己的内容 CDN 域名（**可注册域名**，如 `site.net`，不是完整主机名）。
   * 由 `frequentMediaDomains` 产出；这些域名不贡献「跨站素材」分。
   */
  contentCdnDomains?: Set<string>;
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
 * 还原被**站点 CDN 的 base64 路径**包装的真实地址。
 *
 * 实测形态（2026-10-13，某视频站）：
 *   `https://cache-2610.sgvafw.com/base/aHR0cHM6Ly9uMDIyOC5jZG4uc3ZscWdoLmNvbS8…==.cache`
 *   → `https://n0228.cdn.svlqgh.com/…`
 *
 * ⚠️ 为什么必须还原（这是本轮误判的根因之一）：
 * 站点把**广告素材与内容缩略图都**代理到同一个 CDN 域名下，于是"跨站素材"判据
 * 完全失效 —— 广告图看起来和内容图同源。不还原就分不清两者：
 *   - 广告图真实来源：`n0228.cdn.svlqgh.com` / `adeh334g.uwcng.com` / `img.alicdn.com`…
 *   - 内容图真实来源：站点自己的内容 CDN（本例 `fourhoi.com`，被整页大量使用）
 * 还原后再交给既有的"跨站素材 / 内容 CDN"判据，两者自然分开。
 */
export function unwrapCdnUrl(url: string): string {
  const m = /\/base\/([A-Za-z0-9+/=_-]{16,})/.exec(url);
  if (!m) return url;
  try {
    const decoded = atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/'));
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** base64 文本解码（标准与 URL-safe 两种字母表都试）。失败返回 null。 */
function tryBase64Text(value: string): string | null {
  if (!/^[A-Za-z0-9+/=_-]{16,4096}$/.test(value)) return null;
  for (const variant of [value, value.replace(/-/g, '+').replace(/_/g, '/')]) {
    try {
      const padded = variant.padEnd(Math.ceil(variant.length / 4) * 4, '=');
      const decoded = atob(padded);
      // 只接受可打印文本，避免把二进制噪声当载荷
      if (decoded.length > 8 && /^[\x20-\x7e\u00a0-\uffff]+$/.test(decoded)) return decoded;
    } catch {
      /* 换下一种字母表 */
    }
  }
  return null;
}

/**
 * 识别「**自家域名跳转**」包装的广告链接。
 *
 * 实测形态（2026-10-13，某视频站）：广告链接不直接指向外站，而是走自己的域名：
 *   `http://<本站>/traffic/go?t=eyJraW5kIjoiYWQiLCJ1cmwiOiJodHRwczovLzE1My40My4yMzEuMjEx…`
 *   `t` 的 base64 解码 → `{"kind":"ad","id":9668,"url":"https://153.43.231.211:63776/?…","host":"…"}`
 *
 * 站点这样做是为了**绕过跨站判据**（也让广告统计更可控）。但载荷自己写了
 * `"kind":"ad"` —— 那是确定性证据，比几何/命名推断都硬。
 *
 * 返回 `declaredAd`（载荷明确声明是广告）与 `target`（载荷里的落地页）。
 * 两者都拿不到时返回空结果，调用方忽略。
 */
export function unwrapAdRedirect(
  href: string,
  base: string,
): { declaredAd: boolean; target: string | null } {
  const none = { declaredAd: false, target: null };
  if (!href || href.length < 24) return none;
  let parsed: URL;
  try {
    parsed = new URL(href, base);
  } catch {
    return none;
  }

  for (const [, value] of parsed.searchParams) {
    const decoded = tryBase64Text(value);
    if (!decoded) continue;
    const declaredAd =
      /"kind"\s*:\s*"ads?"/i.test(decoded) ||
      /"type"\s*:\s*"ads?"/i.test(decoded) ||
      /"(?:isAd|is_ad)"\s*:\s*true/i.test(decoded) ||
      /"ads?"\s*:\s*true/i.test(decoded);
    const target = /https?:\/\/[^\s"'\\]+/i.exec(decoded)?.[0] ?? null;
    if (declaredAd || target) return { declaredAd, target };
  }
  return none;
}

/**
 * 取媒体地址。
 *
 * 必须先看 src 是否**绝对地址**再退回 data-src：
 * 该站用 `src=占位图 + data-src=真实图` 做懒加载，若因为 src 存在就直接采用，
 * 跨站的真实图会被整批漏掉。
 *
 * 另外要**还原 CDN 的 base64 包装**，否则广告素材与内容图看起来同源（见 unwrapCdnUrl）。
 */
function mediaUrl(el: Element): string {
  const src = el.getAttribute('src') ?? '';
  const lazy = el.getAttribute('data-src') ?? '';
  const chosen = isAbsoluteUrl(src) ? src : lazy || src;
  return unwrapCdnUrl(chosen);
}

/** 命名分：SSP 标记与强命名同分（都是确定性证据），弱命名减半。 */
function namingScore(strength: number): { points: number; reason: string | null } {
  if (strength >= NAMING_SSP) return { points: 6, reason: 'ssp-marker' };
  if (strength === NAMING_STRONG) return { points: 6, reason: 'ad-naming' };
  if (strength === NAMING_WEAK) return { points: 2, reason: 'ad-naming-weak' };
  return { points: 0, reason: null };
}

export { NAMING_NONE, NAMING_SSP, NAMING_STRONG, NAMING_WEAK };

/**
 * 主机名里可以作为「品牌词」的标签：去掉数字与连字符、长度 ≥ 4。
 */

export function brandLabels(host: string): string[] {
  return host
    .split('.')
    .map((label) => label.replace(/[0-9-]/g, ''))
    .filter((label) => label.length >= 4);
}

/**
 * 两个域名是否属于**同一品牌**（互为镜像/备用域名）。
 *
 * ## 为什么需要它（用户报告的真实误杀）
 *
 * dgav36.xyz 上有张「最新镜像网址」目录页，正文就是几十张镜像域名卡片
 * （链到 dgav39.com / dgav40.com…）。这些链接按"可注册域名"算是**跨站**的，
 * 于是每张卡片拿到 8 分（2 个跨站链接 × 4），超过阈值被整页隐藏 ——
 * 而它们其实**是同一个站点自己的备用域名**，根本不是广告基础设施。
 *
 * ## 判据为什么必须收紧到"编号式域名"
 *
 * 第一版只比较"去掉数字后的品牌词"，结果把测试夹具里的
 * `example.com` → `ads.example.net` 也算成了同品牌（都含 `example`），
 * 直接把跨站证据抹掉、丢掉了真广告。那个口径太宽。
 *
 * 镜像域名的真实形态是**带编号**：`dgav36.xyz` / `dgav40.com`、
 * `javbus1.com` / `javbus2.com`。所以额外要求**至少一方含数字**：
 * 这样 `example.com` ↔ `example.net` 不会被误判成同品牌，
 * 而编号式镜像能命中。
 *
 * 判据整体仍然偏宽（作用只是**减少**证据，不是宣布安全）：
 * 万一漏判，代价是少扣几分、可能漏拦一个广告；而错判成同品牌才会误杀。
 */
export function isSameBrand(hostA: string, hostB: string): boolean {
  const a = registrableDomain(hostA);
  const b = registrableDomain(hostB);
  if (a === b) return true;

  const sldA = a.split('.')[0] ?? '';
  const sldB = b.split('.')[0] ?? '';
  const brandA = sldA.replace(/[0-9-]/g, '');
  const brandB = sldB.replace(/[0-9-]/g, '');
  if (brandA.length < 4 || brandA !== brandB) return false;

  // 只在"编号式域名"这一种形态上认定为镜像（见上）
  return /\d/.test(sldA) || /\d/.test(sldB);
}

export function scoreNode(el: Element, ctx: ScoreContext): ScoreResult {
  const reasons = new Set<string>();

  const signal = namingSignal(el);
  const naming = namingScore(signal.strength);
  if (naming.reason) reasons.add(naming.reason);

  let behavior = 0;

  const pageReg = registrableDomain(ctx.pageHost);
  const base = `https://${ctx.pageHost}`;

  /**
   * ❗已经被我们隐藏的后代不再贡献证据。
   *
   * 为什么必须这样（实测发现）：隐藏一个广告/农场之后，**它的父容器仍然
   * "装着同一批外链、同一批素材"**，于是下一轮又被判定为广告，逐层往上吃 ——
   * 症状就是"外层容器连同正文一起消失"。
   * 实测证据：dgav40 一个页脚农场被连隐藏了 4 层
   * （`#script_seo_links` → `.footer-links` → `section.footer-partners` → `.container`）。
   *
   * 已经处理过的证据不该被重复采信：父容器若没有**自己的**新证据，
   * 就不该被隐藏。
   */
  const alreadyHandled = (node: Element): boolean =>
    node.parentElement?.closest('[data-adblow-hidden]') !== null;

  const addLinks = (links: Element[]): void => {
    for (const a of links) {
      if (alreadyHandled(a)) continue;
      const href = a.getAttribute('href') ?? '';
      if (!isAbsoluteUrl(href)) continue; // 站内相对链接不算
      let parsed: URL;
      try {
        parsed = new URL(href, base);
      } catch {
        continue;
      }
      if (registrableDomain(parsed.hostname) !== pageReg) {
        // 同品牌的镜像/备用域名不算跨站广告证据（见 isSameBrand 的说明）
        if (isSameBrand(parsed.hostname, ctx.pageHost)) {
          reasons.add('sibling-domain-link');
        } else {
          behavior += 4;
          reasons.add('cross-site-link');
        }
      } else {
        // 同一站点：可能是「自家域名跳转」包装的广告链接（实测形态见 unwrapAdRedirect）。
        // 载荷自己声明 `"kind":"ad"` 是确定性证据，按跨站外链同分处理。
        const wrapped = unwrapAdRedirect(href, base);
        if (wrapped.declaredAd) {
          behavior += 4;
          reasons.add('ad-redirect-link');
        } else if (wrapped.target) {
          try {
            const target = new URL(wrapped.target);
            if (
              registrableDomain(target.hostname) !== pageReg &&
              !isSameBrand(target.hostname, ctx.pageHost)
            ) {
              // 只是"包装了外链"：可能是正常的外链跳转服务，给低分（不能单独触发隐藏）
              behavior += 1;
              reasons.add('wrapped-cross-site-link');
            }
          } catch {
            /* 载荷里的地址不可解析，忽略 */
          }
        }
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
      if (alreadyHandled(m)) continue;
      const url = mediaUrl(m);
      if (!isAbsoluteUrl(url)) continue;
      let parsed: URL;
      try {
        parsed = new URL(url, base);
      } catch {
        continue;
      }
      if (registrableDomain(parsed.hostname) !== pageReg) {
        const reg = registrableDomain(parsed.hostname);
        if (isSameBrand(parsed.hostname, ctx.pageHost)) {
          reasons.add('sibling-domain-media');
        } else if (ctx.contentCdnDomains?.has(reg)) {
          // 站点自己的内容 CDN（被整页多个媒体元素使用）→ 不算广告证据
          reasons.add('content-cdn-media');
        } else {
          behavior += 3;
          reasons.add('cross-site-media');
        }
      }
    }
  };

  const addIframes = (frames: Element[]): void => {
    for (const f of frames) {
      if (alreadyHandled(f)) continue;
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
        if (isSameBrand(parsed.hostname, ctx.pageHost)) {
          reasons.add('sibling-domain-iframe');
        } else {
          // 4 分与跨站链接同权：跨站 iframe 也可能是正常的第三方嵌入
          // （视频、地图、评论），所以**不足以单独判定**，需要别的证据。
          behavior += 4;
          reasons.add('cross-site-iframe');
        }
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
