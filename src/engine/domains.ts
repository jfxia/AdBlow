/**
 * 从 DOM 元素里提取「跨站资源域名」。
 *
 * 这是**自学习网络层**的输入：我们在 DOM 层把某个元素判定为广告并隐藏之后，
 * 把它用到的跨站域名记下来；同一个域名反复出现在被隐藏的广告里，就晋级为
 * DNR 拦截规则。这样未知站点从第 N 次访问起也能拿到**网络层**保护，
 * 而且完全不需要用户配置，也不需要任何第三方过滤列表。
 *
 * ⚠️ 安全前提（由调用方负责，见 src/content/index.ts）：
 * 本模块只负责"提取"，不负责"判断该不该学"。**必须排除那些同时被可见内容
 * 使用的域名** —— 试点站的 `pic.wvxrrip.cn` 既是广告素材 CDN 又是正文缩略图
 * CDN，学它就会把正文图全废掉。
 */

import { isIpLiteral, registrableDomain, unwrapCdnUrl } from './score.ts';

/** 带外链的资源选择器（不含 a[href]：那是点击目标，不是加载资源）。 */
const RESOURCE_SELECTOR = [
  'img[src]',
  'img[data-src]',
  'script[src]',
  'link[href]',
  'iframe[src]',
  'video[src]',
  'video[poster]',
  'source[src]',
  'embed[src]',
  'object[data]',
].join(',');

/**
 * 只算「媒体」的资源选择器。
 *
 * 单独列出来是因为它承载一条**结构性安全保证**：只要某个域名在本页任何位置
 * 充当过图片/视频来源，就绝不把它学成广告域名。见 learnableAdDomains。
 */
export const MEDIA_SELECTOR = [
  'img[src]',
  'img[data-src]',
  'video[src]',
  'video[poster]',
  'source[src]',
  'embed[src]',
  'object[data]',
].join(',');

/** 从单个元素自身取出资源 URL（不递归子元素）。 */
export function resourceUrls(el: Element): string[] {
  const urls: string[] = [];
  if (!el.matches(RESOURCE_SELECTOR)) return urls;
  for (const attr of ['src', 'data-src', 'href', 'poster', 'data']) {
    const value = el.getAttribute(attr);
    if (value) urls.push(value);
  }
  return urls;
}

/** 从单个元素自身取出外链 URL（`a[href]`）。 */
export function linkUrls(el: Element): string[] {
  if (!el.matches('a[href]')) return [];
  const href = el.getAttribute('href');
  return href ? [href] : [];
}

function isAbsoluteUrl(u: string): boolean {
  return /^https?:/i.test(u) || u.startsWith('//');
}

export type DomainScope = {
  /**
   * 是否把 `a[href]` 也算进去。
   *
   * 为什么需要这个开关：**学习**广告域名时应该算上外链——那些域名是广告落地页，
   * 学会后拦掉它们的**子资源**可以挡住弹窗与强制跳转；而拦截子资源并不影响
   * `<a href>` 导航本身（DNR 规则排除了 main_frame），所以不会妨碍用户点击。
   *
   * 而判断「某域名是否被可见内容使用」时不该算外链——可见内容里出现一个指向
   * 该域名的链接，不构成"该域名是站点的正常资源来源"。
   */
  includeLinks?: boolean;
};

/**
 * 提取元素**及其子树**里所有跨站域名。
 *
 * 返回值已排除：相对地址、与页面同可注册域名的地址、以及无法解析的地址。
 */
export function crossSiteResourceDomains(
  el: Element,
  pageHost: string,
  scope: DomainScope = {},
): string[] {
  const pageReg = registrableDomain(pageHost);
  const base = `https://${pageHost}`;
  const out = new Set<string>();

  const consider = (raw: string): void => {
    if (!isAbsoluteUrl(raw)) return;
    let parsed: URL;
    try {
      parsed = new URL(raw, base);
    } catch {
      return;
    }
    /**
     * ⚠️ 跳过 IP 字面量。
     *
     * 实测踩过：站点把追踪端点放在裸 IP 上（`https://54.169.219.76:15212/...`），
     * 而裸 IP 往往是**共享基础设施**（CDN 边缘）；按 `||ip^` 拦截既不够精确，
     * 命中范围又可能波及无关服务。收益小、风险实在，因此不学。
     */
    if (isIpLiteral(parsed.hostname)) return;

    const reg = registrableDomain(parsed.hostname);
    if (reg && reg !== pageReg) out.add(reg);
  };

  const collect = (node: Element): void => {
    for (const url of resourceUrls(node)) consider(url);
    if (scope.includeLinks) for (const url of linkUrls(node)) consider(url);
  };

  collect(el);
  for (const child of Array.from(el.querySelectorAll(RESOURCE_SELECTOR))) collect(child);
  if (scope.includeLinks) {
    for (const a of Array.from(el.querySelectorAll('a[href]'))) collect(a);
  }

  return [...out];
}

/**
 * 提取元素**及其子树**里所有跨站**媒体**域名（图片/视频/嵌入）。
 *
 * 用途见 learnableAdDomains：这些域名一律不学。
 */
export function crossSiteMediaDomains(el: Element, pageHost: string): string[] {
  const pageReg = registrableDomain(pageHost);
  const base = `https://${pageHost}`;
  const out = new Set<string>();

  const consider = (raw: string): void => {
    if (!isAbsoluteUrl(raw)) return;
    let parsed: URL;
    try {
      parsed = new URL(raw, base);
    } catch {
      return;
    }
    if (isIpLiteral(parsed.hostname)) return;
    const reg = registrableDomain(parsed.hostname);
    if (reg && reg !== pageReg) out.add(reg);
  };

  const collect = (node: Element): void => {
    if (!node.matches(MEDIA_SELECTOR)) return;
    for (const attr of ['src', 'data-src', 'poster', 'data']) {
      const value = node.getAttribute(attr);
      if (value) consider(value);
    }
  };

  collect(el);
  for (const child of Array.from(el.querySelectorAll(MEDIA_SELECTOR))) collect(child);

  return [...out];
}

/** 整页所有跨站媒体域名（含被隐藏的部分）。 */
export function pageWideMediaDomains(root: ParentNode, pageHost: string): Set<string> {
  const out = new Set<string>();
  for (const el of Array.from(root.querySelectorAll(MEDIA_SELECTOR))) {
    for (const d of crossSiteMediaDomains(el, pageHost)) out.add(d);
  }
  return out;
}

/** 一个媒体域名要被多少个元素使用，才算"站点自己的内容 CDN"。 */
export const CONTENT_CDN_MIN_USES = 3;

/**
 * 找出**站点自己的内容 CDN**：被多个媒体元素共同使用的跨站媒体域名。
 *
 * ## 为什么需要（用户报告的真实误杀）
 *
 * 「跨站素材」原本每张计 3 分，于是**任何脚本渲染的块只要有 2 张以上来自 CDN
 * 的图片就够 6 分被隐藏** —— 而把缩略图放 CDN 是全网通行做法。
 * 用户报告的视频站「推荐栏被屏蔽」、xchina.co「正文被屏蔽」都符合这个特征。
 *
 * 判据：**被 ≥3 个媒体元素使用的跨站域名 = 内容 CDN**（广告素材通常只有
 * 一两张，而内容缩略图是成片的）。这些域名不再贡献"跨站素材"分。
 *
 * 代价方向是有意的：宁可漏掉"只靠素材域名判定"的广告（这类广告还有命名、
 * 网络层名单兜着），也不要因为图片放 CDN 就把正文成片隐藏。
 */
export function frequentMediaDomains(
  root: ParentNode,
  pageHost: string,
  minUses = CONTENT_CDN_MIN_USES,
): Set<string> {
  const counts = new Map<string, number>();
  for (const el of Array.from(root.querySelectorAll(MEDIA_SELECTOR))) {
    for (const d of crossSiteMediaDomains(el, pageHost)) {
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [domain, n] of counts) if (n >= minUses) out.add(domain);
  return out;
}
