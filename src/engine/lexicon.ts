/**
 * 自研广告特征词库。
 *
 * 硬约束（见设计文档 §2 风险 B，2026-10-10 实测）：
 *   - 不得包含裸 "post-card"：试点站全站有 110 个 div + 20 个 h2 使用该类名。
 *   - 不得包含 "article" / "BlogPosting"：那是真内容的标记。
 * 任何新增词条都必须先在 tests/unit/lexicon.test.ts 里加一条误伤守卫用例。
 */

/** 与站点无关的通用广告词根。 */
const GENERIC = [
  'advert',
  'ad-slot',
  'ad_slot',
  'adslot',
  'adbox',
  'ad-box',
  'adbanner',
  'guanggao',
  'sponsor',
  'promoted',
  'popunder',
  'pop-under',
  'interstitial',
  'adsbygoogle',
  'doubleclick',
  'preroll',
  'pre-roll',
];

/** 试点站自研 SSP 的专属标记（取证自 2026-10-10 的 ad-sdk-v0.0.4.10.js 与 ssp.css）。 */
const SSP_MARKERS = [
  'xqbj-component-ssp',
  'xqbj-recommand-item-banner',
  'ssp-slot',
  'ssp-card',
  'ssp-container',
  'ssp-banner',
];

export const AD_TOKEN = new RegExp([...GENERIC, ...SSP_MARKERS, 'data-ssp-[a-z-]+'].join('|'), 'i');

/**
 * 返回广告信号强度：3 = SDK/SSP 注入标记，1 = 通用广告词，0 = 无信号。
 *
 * 只看 class、id 与属性名——**不看属性值**。属性值里含有正文 URL
 * （例如 itemtype="http://schema.org/BlogPosting"），纳入会引入误判。
 */
export function adSignalStrength(el: Element): number {
  const hay = [
    el.getAttribute('class') ?? '',
    el.getAttribute('id') ?? '',
    Array.from(el.attributes)
      .map((a) => a.name)
      .join(' '),
  ].join(' ');

  if (/data-ssp-|xqbj-component-ssp/.test(hay)) return 3;
  if (AD_TOKEN.test(hay)) return 1;
  return 0;
}
