import type { SitePack } from '../../engine/rules.ts';

/**
 * dgav37.com site pack (forensics 2026-10-10, driven by a user report).
 *
 * Its ad blocks carry no generic signals, so behavioural detection cannot see them:
 * creatives share the site's own CDN (`cache-2610.sgvafw.com`), their wrapping `<a>`
 * points at the same site, the container class (`streamer-box2`) contains no ad word,
 * and the container has 31 descendants — past the "compact" limit of 12, so
 * descendant signals are not trusted. The only evidence is the site's own stylesheet
 * `/css/inner-ads.css` (literally "inner ads"), which defines those class names.
 *
 * Forensics: `/css/inner-ads.css` defines `#ads-tubiao`, `.streamer-container2`,
 * `.streamer-box2`; `/css/footer-links.css` defines `.javeve-partners*`;
 * `/js/partners.js` (1.8 KB) injects `[data-javeve-partners]` + `a.referrerLink`; the
 * live DOM had 39 distinct cross-site domains in `#script_seo_links`.
 *
 * Never add:
 *   - `sgvafw.com` — the site's own asset CDN, serving the logo and body thumbnails
 *   - `/css/inner-ads.css` — blocking CSS leaves the images but strips their layout,
 *     making the ad block more conspicuous, not less
 *   - `.post` / `.posts` — article bodies, not ads
 */
export const dgavPack: SitePack = {
  id: 'dgav-javeve',
  matches: ['*://dgav37.com/*', '*://*.dgav37.com/*'],
  network: [
    // Link-farm injector, regex-limited to this site so a same-named partners.js
    // elsewhere is untouched. Blocking it stops the 39 links from being created at
    // all — fixing the cause beats hiding the result.
    {
      kind: 'regex',
      value: '^https?://([^/]*\\.)?dgav37\\.com/js/partners\\.js',
      resourceTypes: ['script'],
    },
    // Tracking/analytics reporting on a non-standard port; site-wide blocking is standard
    {
      kind: 'domain',
      value: 'aizhantj.com',
      resourceTypes: ['script', 'xmlhttprequest', 'ping'],
    },
  ],
  cosmetic: [
    // Link farm (39 distinct cross-site domains)
    // Server-rendered container
    '#script_seo_links',
    // Containers and link classes injected at runtime by partners.js
    '[data-javeve-partners]',
    '.javeve-partners',
    'a.referrerLink',
    // Ad image strip (10 images, defined in inner-ads.css)
    '.streamer-container2',
    '.streamer-box2',
    // Icon ad slots (name heuristics already hit these; spelled out so a future
    // word-list change cannot regress)
    '#ads-tubiao',
  ],
};
