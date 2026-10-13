import type { SitePack } from '../../engine/rules.ts';

/**
 * Pilot site packs (afford.gjvrohros.cc / cgw666.com, forensics 2026-10-10).
 *
 * A TS module rather than JSON, so SitePack typings catch field mistakes at compile
 * time (no import attributes or extra Rollup plugin needed either).
 *
 * ⚠️ Read design doc §2 first. Never add these three — validateSitePack rejects them:
 *   - `[data-ssp-container]`: wraps the real <article> body list
 *   - bare `.post-card`: used by 110 divs + 20 h2 site-wide
 *   - `pic.wvxrrip.cn`: also serves body thumbnails (loadBannerDirect, #post-card-*)
 */
export const pilotPack: SitePack = {
  id: 'pilot-cgw',
  matches: [
    '*://afford.gjvrohros.cc/*',
    '*://*.gjvrohros.cc/*',
    '*://cgw666.com/*',
    '*://*.cgw666.com/*',
  ],
  network: [
    // Highest-value single rule: no SDK means no ad components are ever created
    { kind: 'path', value: '/ad-sdk-v', resourceTypes: ['script'] },
    // The one required third party: the in-house SSP bidding endpoint
    { kind: 'domain', value: 'apiad01.cc', resourceTypes: ['xmlhttprequest'] },
    // Attribution and A/B assignment reporting
    { kind: 'domain', value: 'ads.zyudkkup.com', resourceTypes: ['xmlhttprequest', 'ping', 'image'] },
    { kind: 'domain', value: 'api.zzlprxy.cc', resourceTypes: ['xmlhttprequest'] },
    { kind: 'domain', value: 'wj-api-abtest.yvyjdhr.com', resourceTypes: ['xmlhttprequest'] },
    // Third-party analytics
    { kind: 'domain', value: 'mc.yandex.ru', resourceTypes: ['script', 'image', 'ping'] },
    { kind: 'domain', value: 'googletagmanager.com', resourceTypes: ['script'] },
  ],
  cosmetic: [
    // Empty server-rendered placeholders (measured: empty elements, no body content)
    '[data-ssp-slot-node]',
    '[id^="ssp-card-"]',
    // Injected by the SDK at runtime (0 occurrences in the server HTML)
    '[data-ssp-slot-root]',
    '[data-ssp-sdk-popup-overlay]',
    '[data-ssp-sdk-fullscreen]',
    '[data-ssp-marquee]',
    '[data-ssp-marquee-viewport]',
    '[data-ssp-landing]',
    '.xqbj-component-ssp-float-icon',
    '.xqbj-component-ssp-float-icon-mix-node',
    '.xqbj-component-ssp-popup-icon-container',
    '.xqbj-component-ssp-horizontal-banner-widget',
    '.xqbj-component-ssp-icon-grid',
    '.xqbj-component-ssp-text-grid',
    '.xqbj-component-ssp-list-card',
    // Server-rendered recommendation slots (contain <img>, not body text)
    '.xqbj-recommand-item-banner',
    '.xqbj-recommand-item-banner-mesosphere',
  ],
};
