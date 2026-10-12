import type { SitePack } from '../../engine/rules.ts';

/**
 * dgav37.com 系列站点规则包（2026-10-10 取证，用户反馈驱动）。
 *
 * ## 为什么这个站点需要规则包
 *
 * 它的广告块**没有任何通用信号**，行为检测在结构上抓不到：
 *
 * - 广告图与站点 logo **用同一个 CDN**（`cache-2610.sgvafw.com`）→ 没有"跨站素材"这个信号
 * - 广告图外面包的 `<a>` 指向**本站** → 没有"跨站链接"这个信号
 * - 广告块的类名（`streamer-box2`）**不含任何广告词** → 命名档 0 分
 * - 容器有 31 个后代，超过"紧凑"上限（12）→ 后代信号一律不采信
 *
 * 唯一的证据来自**站点自己的样式表**：这些类名定义在
 * `/css/inner-ads.css`（字面意思就是"内嵌广告"）里。
 * 这类"零通用信号"的站点广告，规则包是唯一可靠手段。
 *
 * ## 取证来源
 *
 * | 依据 | 内容 |
 * |---|---|
 * | `/css/inner-ads.css`（2.3 KB） | 定义 `#ads-tubiao`、`.streamer-container2`、`.streamer-box2` |
 * | `/css/footer-links.css`（6 KB） | 定义 `.javeve-partners`、`.javeve-partners__link`、`.footer-links--footer` |
 * | `/js/partners.js`（1.8 KB） | `querySelector('[data-javeve-partners]')` + 创建 `class="javeve-partners__link referrerLink"` |
 * | 实时 DOM 清点 | 页脚 `#script_seo_links` 内有 **39 个不同跨站域名**的链接；`.streamer-box2` 内有 10 张图 |
 *
 * ## 绝不能加的东西
 *
 * - **`sgvafw.com`**：站点自己的资源 CDN，logo 与正文缩略图都在上面（风险 A 同类）
 * - **`/css/inner-ads.css`**：只拦 JS 不拦 CSS。拦掉广告样式表会让广告块**失去样式**
 *   反而更扎眼（图片还在，只是排版乱了）
 * - **`.post` / `.posts`**：列表正文，不是广告
 */
export const dgavPack: SitePack = {
  id: 'dgav-javeve',
  matches: ['*://dgav37.com/*', '*://*.dgav37.com/*'],
  network: [
    // 链接农场的注入器。用 regex 限定在本站，避免在别的站点误伤同名的 partners.js。
    // 拦掉它，那 39 个外站链接根本不会被创建 —— 从源头解决，比事后隐藏更彻底。
    {
      kind: 'regex',
      value: '^https?://([^/]*\\.)?dgav37\\.com/js/partners\\.js',
      resourceTypes: ['script'],
    },
    // 统计/追踪上报（非标准端口），全站范围拉黑是标准做法
    {
      kind: 'domain',
      value: 'aizhantj.com',
      resourceTypes: ['script', 'xmlhttprequest', 'ping'],
    },
  ],
  cosmetic: [
    // ── 链接农场（39 个不同跨站域名）──
    // 服务端渲染的容器
    '#script_seo_links',
    // partners.js 运行时注入的容器与链接类
    '[data-javeve-partners]',
    '.javeve-partners',
    'a.referrerLink',
    // ── 广告图片条（10 张图，定义在 inner-ads.css）──
    '.streamer-container2',
    '.streamer-box2',
    // ── 图标广告位（命名档本已能命中，显式写出以免将来词库调整后回退）──
    '#ads-tubiao',
  ],
};
