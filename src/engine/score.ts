import { NAMING_NONE, NAMING_SSP, NAMING_STRONG, NAMING_WEAK, namingSignal } from './lexicon.ts';

/**
 * Ad-likelihood scoring: generality comes from a node's naming and behavioral
 * features alone, with no third-party list.
 *
 * ⚠️ Calibrated 2026-10-10: (1) descendant link/media signals count only while the
 * element stays compact — unconditional aggregation scored `<html>` 20 and blanked
 * whole pages; (2) naming (deterministic) and behavioral (indirect) evidence are
 * returned separately because the judgement layer weights them differently.
 */

export const COMPACT_MAX_DESCENDANTS = 12;

export type ScoreContext = {
  pageHost: string;
  viewportArea: number;
  /** Descendant cap; above it, descendant signals are ignored. Overridable in tests. */
  compactMax?: number;
  /**
   * The site's own content CDN (registrable domains, not hostnames) from
   * `frequentMediaDomains`; these contribute no cross-site-asset points.
   */
  contentCdnDomains?: Set<string>;
};

export type ScoreResult = {
  score: number;
  naming: number;
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
/** Note data-src: this site lazy-loads via loadBannerDirect + data-src, so src alone misses it. */
const MEDIA_SELECTOR = 'img[src],img[data-src],video[src],source[src]';
/** iframes are a common delivery vehicle too (ad networks use them widely), so they must count. */
const IFRAME_SELECTOR = 'iframe[src],iframe[srcdoc]';

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[?[0-9a-f:]+\]?$/i;

/**
 * Public suffixes that take two labels (`com.cn`, `co.uk`). Small hand-written list, not the
 * full PSL: it covers the suffixes the supported locales actually use, and anything missing
 * degrades to the old two-label rule instead of misbehaving.
 *
 * Why it matters (2026-10-19, finance.sina.com.cn): `registrableDomain('finance.sina.com.cn')`
 * used to return `com.cn`, so `sina.cn` and `sinaimg.cn` were compared against `com.cn`, counted
 * as cross-site, and every "大V观点" item (cross-site link + avatar = 7 points) was hidden.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'com.cn',
  'net.cn',
  'org.cn',
  'gov.cn',
  'edu.cn',
  'ac.cn',
  'com.hk',
  'com.tw',
  'com.mo',
  'com.sg',
  'co.uk',
  'org.uk',
  'ac.uk',
  'co.jp',
  'ne.jp',
  'or.jp',
  'co.kr',
  'or.kr',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.mx',
  'com.ar',
  'com.tr',
  'co.in',
  'co.za',
  'com.my',
  'com.vn',
  'com.sa',
  'co.il',
]);

export function isIpLiteral(host: string): boolean {
  return IPV4.test(host) || (host.includes(':') && IPV6.test(host));
}

/**
 * Crude registrable domain: the last two labels, or three when the last two are a known
 * two-label public suffix (`.com.cn`). IP literals are returned as-is — the last two labels of
 * `54.169.219.76` would give `219.76`, i.e. a `||219.76^` rule matching unrelated hosts.
 */
export function registrableDomain(host: string): string {
  if (isIpLiteral(host)) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  if (parts.length >= 3 && MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

function isAbsoluteUrl(u: string): boolean {
  return /^https?:/i.test(u) || u.startsWith('//');
}

/**
 * Recover the address wrapped in a site CDN's base64 path (`.../base/<b64>...`).
 * Required because ad assets and content thumbnails are proxied through one CDN and
 * would otherwise look same-origin to the cross-site-asset criteria.
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

/** Base64 text decode (tries the standard and URL-safe alphabets). Returns null on failure. */
function tryBase64Text(value: string): string | null {
  if (!/^[A-Za-z0-9+/=_-]{16,4096}$/.test(value)) return null;
  for (const variant of [value, value.replace(/-/g, '+').replace(/_/g, '/')]) {
    try {
      const padded = variant.padEnd(Math.ceil(variant.length / 4) * 4, '=');
      const decoded = atob(padded);
      // printable text only, so binary noise is not taken for a payload
      if (decoded.length > 8 && /^[\x20-\x7e\u00a0-\uffff]+$/.test(decoded)) return decoded;
    } catch {
      /* try the next alphabet */
    }
  }
  return null;
}

/**
 * Detect ad links wrapped in a first-party redirect: `<site>/traffic/go?t=<base64>`
 * decodes to a payload like `{"kind":"ad","url":...}`. Routing clicks through its own
 * domain dodges cross-site criteria, but the payload's `"kind":"ad"` is deterministic
 * evidence. Returns `declaredAd` and the payload's `target`.
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
 * Media address: src counts only when absolute, else data-src — the site
 * lazy-loads with `src=placeholder + data-src=real`, so trusting any present src
 * would miss whole batches. The CDN base64 wrapper is unwrapped too (unwrapCdnUrl).
 */
function mediaUrl(el: Element): string {
  const src = el.getAttribute('src') ?? '';
  const lazy = el.getAttribute('data-src') ?? '';
  const chosen = isAbsoluteUrl(src) ? src : lazy || src;
  return unwrapCdnUrl(chosen);
}

/** Naming points: SSP markers score like strong naming; weak naming is halved. */
function namingScore(strength: number): { points: number; reason: string | null } {
  if (strength >= NAMING_SSP) return { points: 6, reason: 'ssp-marker' };
  if (strength === NAMING_STRONG) return { points: 6, reason: 'ad-naming' };
  if (strength === NAMING_WEAK) return { points: 2, reason: 'ad-naming-weak' };
  return { points: 0, reason: null };
}

export { NAMING_NONE, NAMING_SSP, NAMING_STRONG, NAMING_WEAK };

/** Host labels usable as "brand words": digits and hyphens stripped, length >= 4. */

export function brandLabels(host: string): string[] {
  return host
    .split('.')
    .map((label) => label.replace(/[0-9-]/g, ''))
    .filter((label) => label.length >= 4);
}

/**
 * Suffixes publishers append to their brand for static/media hosts: `sinaimg.cn`, `qqstatic.com`,
 * `sohuimg.cn`. Such a host is the site's own asset CDN, not an ad network.
 */
const BRAND_ASSET_SUFFIXES = /^(?:imgs?|cdn|static|res|pic|pics|assets?|video|media|s\d*|\d+)$/;

/**
 * Social platforms: an outbound link to one of these is editorial furniture (the author's page,
 * "follow us", a share link), not ad evidence.
 *
 * Measured 2026-10-19 on finance.sina.com.cn/realstock: each "大V观点" item carries two links to
 * `weibo.com` (author + detail). At 4 points per cross-site link that is 8 ≥ threshold, so every
 * item was hidden even though its avatar had already been recognised as a sibling asset.
 */
const SOCIAL_DOMAINS = new Set([
  'weibo.com',
  'weibo.cn',
  'x.com',
  'twitter.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'youtu.be',
  'tiktok.com',
  'douyin.com',
  'bilibili.com',
  'zhihu.com',
  'douban.com',
  'linkedin.com',
  'reddit.com',
  'telegram.org',
  't.me',
]);

/** Image hosts owned by the same social platforms (avatars and thumbnails). */
const SOCIAL_MEDIA_DOMAINS = new Set([
  'twimg.com',
  'ytimg.com',
  'fbcdn.net',
  'cdninstagram.com',
  'hdslb.com',
  'douyinpic.com',
  'weibocdn.com',
]);

/**
 * Same publisher, so **not** cross-site evidence.
 *
 * Same-brand relations are not cross-site evidence (mirror-index pages scored 8 per card and
 * were hidden whole). Matches need >=4 letters, so `example.com` ≠ `ads.example.net`.
 *
 * Two shapes count (2026-10-19, finance.sina.com.cn — "大V观点" and "投资研报" items were hidden
 * because their avatars live on `sinaimg.cn` and their links on `daxue.sina.cn`):
 *   1. identical brand with a different public suffix (`sina.com.cn` / `sina.cn`), provided one
 *      side is a three-label domain — the number-only rule below stays for same-TLD mirrors;
 *   2. an asset suffix appended to the brand (`sinaimg`, `tvax2.sinaimg` → `sinaimg`).
 * An ad domain that merely borrows the brand (`sinaads`) does not match: `ads` is not an
 * asset suffix. Wrongly treating a real ad as a sibling only costs a missed ad; wrongly
 * treating a sibling as cross-site hides a reader's content, so the balance is deliberate.
 */
export function isSameBrand(hostA: string, hostB: string): boolean {
  const a = registrableDomain(hostA);
  const b = registrableDomain(hostB);
  if (a === b) return true;

  const labelA = a.split('.')[0] ?? '';
  const labelB = b.split('.')[0] ?? '';
  const brandA = labelA.replace(/[0-9-]/g, '');
  const brandB = labelB.replace(/[0-9-]/g, '');

  // 1) same brand, different public suffix (sina.cn vs sina.com.cn)
  if (brandA.length >= 4 && brandA === brandB) {
    const labelsA = a.split('.').length;
    const labelsB = b.split('.').length;
    // A two-label brand on both sides is more likely a different owner than one publisher
    // spread across regional suffixes, so require a three-label side.
    return labelsA >= 3 || labelsB >= 3 || /\d/.test(labelA) || /\d/.test(labelB);
  }

  // 2) asset CDN of the same brand (sinaimg, qqstatic, sohuimg)
  const longer = brandA.length >= brandB.length ? brandA : brandB;
  const shorter = brandA.length >= brandB.length ? brandB : brandA;
  if (shorter.length >= 4 && longer.startsWith(shorter)) {
    return BRAND_ASSET_SUFFIXES.test(longer.slice(shorter.length));
  }

  return false;
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
   * ❗Descendants we already hid contribute no evidence: their parent still holds the
   * same links/assets, so hiding would eat upward into the article (measured: 4 levels
   * on dgav40). A parent needs new evidence of its own.
   */
  const alreadyHandled = (node: Element): boolean =>
    node.parentElement?.closest('[data-adblow-hidden]') !== null;

  const addLinks = (links: Element[]): void => {
    for (const a of links) {
      if (alreadyHandled(a)) continue;
      const href = a.getAttribute('href') ?? '';
      if (!isAbsoluteUrl(href)) continue; // same-site relative links do not count
      let parsed: URL;
      try {
        parsed = new URL(href, base);
      } catch {
        continue;
      }
      if (registrableDomain(parsed.hostname) !== pageReg) {
        // same-brand mirror/backup domains are not cross-site ad evidence (see isSameBrand)
        if (isSameBrand(parsed.hostname, ctx.pageHost)) {
          reasons.add('sibling-domain-link');
        } else if (SOCIAL_DOMAINS.has(registrableDomain(parsed.hostname))) {
          // Author pages and share links: common in editorial content, never an ad by itself.
          reasons.add('social-link');
        } else {
          behavior += 4;
          reasons.add('cross-site-link');
        }
      } else {
        // Same site: may be an ad link wrapped in a first-party redirect; a payload
        // declaring `"kind":"ad"` is deterministic evidence, scoring like a cross-site link.
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
              // a wrapped outbound link may be a legitimate redirect service: score low only
              behavior += 1;
              reasons.add('wrapped-cross-site-link');
            }
          } catch {
            /* payload URL unparseable, ignore */
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
        } else if (SOCIAL_MEDIA_DOMAINS.has(reg)) {
          reasons.add('social-media');
        } else if (ctx.contentCdnDomains?.has(reg)) {
          // the site's own content CDN is not ad evidence
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
      // about:blank / srcdoc / javascript: iframes are a common vehicle for injected content
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
          // 4 points like a cross-site link, but a cross-site iframe can be a legitimate
          // third-party embed, so it is never decisive alone.
          behavior += 4;
          reasons.add('cross-site-iframe');
        }
      }
    }
  };

  // 1) the element itself is a link / media / iframe
  if (el.matches(LINK_SELECTOR)) addLinks([el]);
  if (el.matches(MEDIA_SELECTOR)) addMedia([el]);
  if (el.matches(IFRAME_SELECTOR)) addIframes([el]);

  // 2) descendant signals: counted only while the element is compact (see file header)
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
