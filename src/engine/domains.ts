/**
 * Extract cross-site resource domains from DOM elements — input to the self-learning
 * network layer, where domains used by hidden ads are promoted to DNR block rules.
 *
 * ⚠️ The caller decides what may be learned (src/content/index.ts) and must exclude
 * domains visible content uses too: the pilot site's `pic.wvxrrip.cn` serves both ad
 * assets and body thumbnails.
 */

import { isIpLiteral, registrableDomain, unwrapCdnUrl } from './score.ts';

/** Resource selectors with an off-site URL (a[href] is a click target, not a resource). */
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
 * Media-only selectors, kept separate for a structural safety guarantee: a domain
 * that ever serves an image/video here is never learned as an ad domain.
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

/** Resource URLs from the element itself (does not recurse into children). */
export function resourceUrls(el: Element): string[] {
  const urls: string[] = [];
  if (!el.matches(RESOURCE_SELECTOR)) return urls;
  for (const attr of ['src', 'data-src', 'href', 'poster', 'data']) {
    const value = el.getAttribute(attr);
    if (value) urls.push(value);
  }
  return urls;
}

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
   * Whether `a[href]` counts. Learning **should** include outbound links (ad
   * landing pages whose subresources we block; main_frame is never blocked, so
   * navigation still works), but judging "used by visible content" must not: a
   * mere link does not make a domain a normal resource source.
   */
  includeLinks?: boolean;
};

/**
 * All cross-site domains in the element and its subtree; relative URLs,
 * same-registrable-domain URLs and unparseable URLs are already excluded.
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
     * ⚠️ Skip IP literals: the site's tracking endpoint sat on a bare IP
     * (`https://54.169.219.76:15212/...`), and bare IPs are shared CDN
     * infrastructure — a `||ip^` block is imprecise and spills onto unrelated
     * services. Small upside, real risk, so never learned.
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
 * All cross-site **media** domains in the element and its subtree; these are never learned.
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

/** All cross-site media domains page-wide (including hidden parts). */
export function pageWideMediaDomains(root: ParentNode, pageHost: string): Set<string> {
  const out = new Set<string>();
  for (const el of Array.from(root.querySelectorAll(MEDIA_SELECTOR))) {
    for (const d of crossSiteMediaDomains(el, pageHost)) out.add(d);
  }
  return out;
}

/** How many elements must use a media domain before it counts as the site's own content CDN. */
export const CONTENT_CDN_MIN_USES = 3;

/**
 * Find the site's own content CDN: a cross-site media domain used by >=3 media
 * elements (ad assets are 1-2 images; content thumbnails come in bulk). Those stop
 * counting as cross-site assets.
 *
 * Why: at 3 points per asset, any block with 2 CDN images hit the 6-point threshold
 * and was hidden, while CDN thumbnails are universal practice.
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
