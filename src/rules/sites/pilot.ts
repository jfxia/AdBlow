import type { SitePack } from '../../engine/rules.ts';

/**
 * 试点站规则包（afford.gjvrohros.cc / cgw666.com，2026-10-10 取证）。
 *
 * 用 TS 模块而非 JSON，理由有二：
 *   1. 得到 SitePack 的类型检查，写错字段编译期就报；
 *   2. Node ESM 导入 JSON 需要 import attributes、Rollup 还要额外插件，没必要。
 *
 * ⚠️ 改动前先读设计文档 §2。以下三件事**绝对不能加**，会被 validateSitePack 拒绝：
 *   - `[data-ssp-container]`：容器内包裹真实 <article> 正文列表
 *   - 裸 `.post-card`：全站 110 个 div + 20 个 h2 在用
 *   - `pic.wvxrrip.cn`：同时承载正文缩略图（loadBannerDirect 绑定到 #post-card-*）
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
    // 单条收益最高的规则：SDK 不加载，广告组件根本不会生成
    { kind: 'path', value: '/ad-sdk-v', resourceTypes: ['script'] },
    // 唯一必需的第三方域名：自研 SSP 的竞价接口
    { kind: 'domain', value: 'apiad01.cc', resourceTypes: ['xmlhttprequest'] },
    // 归因与 A/B 分流上报
    { kind: 'domain', value: 'ads.zyudkkup.com', resourceTypes: ['xmlhttprequest', 'ping', 'image'] },
    { kind: 'domain', value: 'api.zzlprxy.cc', resourceTypes: ['xmlhttprequest'] },
    { kind: 'domain', value: 'wj-api-abtest.yvyjdhr.com', resourceTypes: ['xmlhttprequest'] },
    // 第三方统计
    { kind: 'domain', value: 'mc.yandex.ru', resourceTypes: ['script', 'image', 'ping'] },
    { kind: 'domain', value: 'googletagmanager.com', resourceTypes: ['script'] },
  ],
  cosmetic: [
    // 服务端就存在的空占位符（可安全隐藏：实测为空元素，不含正文）
    '[data-ssp-slot-node]',
    '[id^="ssp-card-"]',
    // SDK 运行时注入的组件（服务端 HTML 中出现次数均为 0）
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
    // 服务端渲染的推荐位（含 <img>，不含正文）
    '.xqbj-recommand-item-banner',
    '.xqbj-recommand-item-banner-mesosphere',
  ],
};
