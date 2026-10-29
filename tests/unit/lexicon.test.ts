import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMING_NONE,
  NAMING_SSP,
  NAMING_STRONG,
  NAMING_WEAK,
  namingSignal,
} from '../../src/engine/lexicon.ts';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

const strength = (html: string): number => namingSignal(el(html)).strength;

describe('词库：站点取证标记（最强档）', () => {
  it('data-ssp-* 属性', () => {
    assert.equal(strength('<div data-ssp-slot-root></div>'), NAMING_SSP);
    assert.equal(strength('<div data-ssp-sdk-popup-overlay></div>'), NAMING_SSP);
  });

  it('xqbj SSP 组件类', () => {
    assert.equal(strength('<div class="xqbj-component-ssp-float-icon"></div>'), NAMING_SSP);
    assert.equal(strength('<div class="xqbj-recommand-item-banner"></div>'), NAMING_SSP);
  });
});

describe('词库：强命名（广告专用术语）', () => {
  it('第二站点（1024cg.com）的广告命名 —— 旧版词库一个都认不出', () => {
    // Regression from the "poor generality" report: the old substring matcher over a tiny
    // word list missed all four of the most obvious names below.
    assert.equal(strength('<article class="ad-item"></article>'), NAMING_STRONG);
    assert.equal(strength('<div class="ads-title"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="post-card-mask post-card-ads"></div>'), NAMING_STRONG);
    assert.equal(strength('<div id="ad-card-0"></div>'), NAMING_STRONG);
  });

  it('整词 ad / ads / adv 及其常见组合', () => {
    for (const cls of [
      'ad',
      'ads',
      'adv',
      'advert',
      'adbox',
      'ad-slot',
      'ad_slot',
      'adslot',
      'ad-unit',
      'ad-container',
      'ad-wrap',
      'ad-frame',
      'ad-banner',
      'adserver',
      'guanggao',
      'popunder',
      'preroll',
      'interstitial',
    ]) {
      assert.equal(strength(`<div class="${cls}"></div>`), NAMING_STRONG, cls);
    }
  });

  it('连写形式（没有分隔符可切）靠显式清单命中，而不是子串兜底', () => {
    assert.equal(strength('<ins class="adsbygoogle"></ins>'), NAMING_STRONG);
    assert.equal(strength('<div class="doubleclick-slot"></div>'), NAMING_STRONG);
  });

  it('❗属性名不参与命名证据（YouTube ytd-shorts 事故）', () => {
    // Real page snapshot (2026-10-29): `<ytd-shorts … move-ads-overlay-to-shorts … role="main">`
    // is the whole Shorts page body. The boolean attribute's *name* contains `ads`, the old
    // implementation scanned every attribute name, scored the container as strong ad naming and
    // hid it: the page went blank while the video kept playing. A boolean attribute name is the
    // site's internal feature switch, not an ad marker.
    assert.equal(strength('<div move-ads-overlay-to-shorts></div>'), NAMING_NONE);
    assert.equal(strength('<div data-ads></div>'), NAMING_NONE);
    assert.equal(strength('<div data-ad-slot="1"></div>'), NAMING_NONE);
  });

  it('标签属性（aria-label / title / data-ad-slot）的**值**仍然计分', () => {
    assert.equal(strength('<div aria-label="advertisement"></div>'), NAMING_STRONG);
    assert.equal(strength('<div title="pre-roll ad"></div>'), NAMING_STRONG);
    assert.equal(strength('<div data-ad-slot="ad-banner-1"></div>'), NAMING_STRONG);
    assert.equal(strength('<div aria-label="关闭"></div>'), NAMING_NONE);
  });

  it('类名 / id 里的广告词照旧计分（真信号不能被一起关掉）', () => {
    assert.equal(strength('<div id="ads-top"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="ytp-ad-overlay"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="ad-slot"></div>'), NAMING_STRONG);
  });

  it('SSP 缩写', () => {
    assert.equal(strength('<div class="tjssp"></div>'), NAMING_STRONG);
  });
});

describe('词库：词元边界（AdBlow 误伤回归，2026-10-29）', () => {
  it('❗品牌名与碰巧以 ad 开头的普通词都不产生命名证据', () => {
    for (const value of [
      'AdBlow',
      'adblow.com',
      'adventure',
      'adaptive',
      'loading',
      'badge',
      'header',
    ]) {
      assert.equal(strength(`<div class="${value}"></div>`), NAMING_NONE, value);
    }
  });

  it('❗事故现场原样：title="AdBlow" 与 aria-label="AdBlow In the Store"', () => {
    // 微软 Partner Center 的扩展列表页把 AdBlow 自己的条目渲染成这两个元素，结果被自己的
    // 扩展隐藏（data-adblow-why="ad-naming"）。
    assert.equal(strength('<img src="/store/logoicon" title="AdBlow">'), NAMING_NONE);
    assert.equal(strength('<a href="/store" aria-label="AdBlow In the Store"></a>'), NAMING_NONE);
    assert.equal(strength('<div title="adblow.com"></div>'), NAMING_NONE, '域名里的点也是分隔符');
  });

  it('按分隔符切词：- _ 空白与其它非字母数字字符', () => {
    assert.equal(strength('<div class="ad-slot"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="ad_slot"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="video-ads"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="ytp-ad-overlay"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="Ads/Sponsored"></div>'), NAMING_STRONG);
    assert.equal(strength('<div aria-label="advertisement"></div>'), NAMING_STRONG);
    assert.equal(strength('<div title="pre-roll ad"></div>'), NAMING_STRONG);
  });

  it('紧凑拼写靠显式清单命中，而不是把匹配放宽成前缀', () => {
    for (const cls of [
      'adslot',
      'adblk',
      'adbox',
      'adunit',
      'adframe',
      'adwrap',
      'adsbygoogle',
    ]) {
      assert.equal(strength(`<div class="${cls}"></div>`), NAMING_STRONG, cls);
    }
    // 前缀相同但不在清单里、又没有分隔符的写法，故意不命中：放宽成前缀正是本次事故的成因。
    assert.equal(strength('<div class="adblow"></div>'), NAMING_NONE);
    assert.equal(strength('<div class="adrest"></div>'), NAMING_NONE);
  });

  it('数字后缀按词干判定：ad1 / ad300x250 / ad_300 / banner2', () => {
    assert.equal(strength('<div class="ad1"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="ad300x250"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="ad_300"></div>'), NAMING_STRONG);
    assert.equal(strength('<div class="banner2"></div>'), NAMING_WEAK);
    // 数字后缀不能把普通词变成广告词
    assert.equal(strength('<div class="header2"></div>'), NAMING_NONE);
    assert.equal(strength('<div class="loading3"></div>'), NAMING_NONE);
  });

  it('ssp 只认连写的**后缀**：tjssp 命中，passport 不命中', () => {
    assert.equal(strength('<div class="tjssp"></div>'), NAMING_STRONG);
    assert.equal(
      strength('<div class="passport"></div>'),
      NAMING_NONE,
      'passport 里的字母 ssp 不是缩写（子串匹配的老毛病）',
    );
  });
});

describe('词库：labelOnly —— 学习闸门的判据', () => {
  it('只有属性值命名 → labelOnly', () => {
    assert.equal(namingSignal(el('<div aria-label="advertisement"></div>')).labelOnly, true);
    assert.equal(namingSignal(el('<div title="pre-roll ad"></div>')).labelOnly, true);
    assert.equal(namingSignal(el('<div data-ad-slot="adslot-1"></div>')).labelOnly, true);
  });

  it('类名 / id 自带广告命名 → 不是 labelOnly（属性值只是补充）', () => {
    assert.equal(namingSignal(el('<div class="ad-slot"></div>')).labelOnly, false);
    assert.equal(
      namingSignal(el('<div class="ad-slot" title="advertisement"></div>')).labelOnly,
      false,
    );
    assert.equal(
      namingSignal(el('<div data-ssp-slot-root></div>')).labelOnly,
      false,
      '取证标记读的是属性名，不是标签值',
    );
  });

  it('完全没有命名 → 不是 labelOnly（纯行为学习不受这条限制）', () => {
    assert.equal(namingSignal(el('<div class="plain-box"></div>')).labelOnly, false);
    assert.equal(namingSignal(el('<div class="store-card" title="AdBlow"></div>')).labelOnly, false);
  });
});

describe('词库：弱命名（需要旁证，单独不足以判定）', () => {
  it('banner / popup / sponsor / float / promo 属于弱档', () => {
    for (const cls of ['banner', 'popup', 'pop', 'sponsor', 'sponsored', 'float', 'promo', 'gg']) {
      assert.equal(strength(`<div class="${cls}"></div>`), NAMING_WEAK, cls);
    }
  });

  it('horizontal-banner 是弱档 —— 它需要跨站外链旁证才会被隐藏', () => {
    assert.equal(strength('<div class="horizontal-banner"></div>'), NAMING_WEAK);
  });

  it('❗不再按驼峰切词 —— AdBlow 事故后的收紧，代价是驼峰写法漏判', () => {
    // 2026-10-29: Microsoft Partner Center hid AdBlow's own store entry. `title="AdBlow"` used
    // to be split into `ad` + `blow` by the camelCase rule and matched the ad word `ad`, so the
    // brand name itself became ad evidence. CamelCase is therefore no longer a word boundary.
    //
    // Known, deliberate cost of the tightening (this is the old assertion, kept visible instead
    // of deleted): a site that writes `.topBanner` / `#globalBannerTop` / `directAd_*` in
    // camelCase now yields **no** naming evidence — `topbanner` is not the token `banner`.
    // Such ad slots are only caught through behaviour, or by a site pack.
    assert.equal(strength('<div class="topBanner"></div>'), NAMING_NONE, 'topBanner 不再切出 banner');
    assert.equal(strength('<div id="globalBannerTop"></div>'), NAMING_NONE);

    // Compact spellings still match, but through the explicit COMPACT_TOKENS list — not
    // because any camelCase split happened.
    assert.equal(
      strength('<div class="adCard0"></div>'),
      NAMING_STRONG,
      'adCard0 → adcard（紧凑清单）+ 数字后缀',
    );
  });

  it('❗streamer 是弱档（站点广告轮播容器 .streamer-box2）', () => {
    assert.equal(strength('<ul class="streamer-box2"></ul>'), NAMING_WEAK);
    assert.equal(strength('<div class="streamer-container2"></div>'), NAMING_WEAK);
  });

  it('❗驼峰写法不得制造误伤（`topBar` 等普通 UI 词保持零信号）', () => {
    // None of these holds an ad word, and with camelCase gone each is a single token
    // (`topbar`, `sidebar`, …) that no word list contains.
    for (const cls of ['topBar', 'sideBar', 'progressBar', 'toolBar', 'scrollBar']) {
      assert.equal(strength(`<div class="${cls}"></div>`), NAMING_NONE, cls);
    }
  });
});

describe('词库：误伤守卫（含 "ad" 字母的正常词绝不能命中）', () => {
  it('正常的英文词', () => {
    for (const cls of [
      'download',
      'header',
      'thread',
      'shadow',
      'gradient',
      'add',
      'read-more',
      'upload',
      'badge',
      'ladder',
      'adaptive',
      'readonly',
      'gallery',
      'media',
      'loader',
    ]) {
      assert.equal(strength(`<div class="${cls}"></div>`), NAMING_NONE, cls);
    }
  });

  it('试点站的正文与卡片命名', () => {
    assert.equal(
      strength('<article itemscope itemtype="http://schema.org/BlogPosting" class=""></article>'),
      NAMING_NONE,
    );
    assert.equal(strength('<div class="post-card" id="post-card-137924"></div>'), NAMING_NONE);
    assert.equal(strength('<div class="container"></div>'), NAMING_NONE);
    assert.equal(strength('<div class="contact-link"></div>'), NAMING_NONE);
    assert.equal(strength('<footer id="footer"></footer>'), NAMING_NONE);
  });

  it('否定前缀让弱词失效：no-banner-image 不算信号', () => {
    assert.equal(strength('<div class="no-banner-image"></div>'), NAMING_NONE);
    assert.equal(
      strength('<header class="align-center align-middle no-banner-image"></header>'),
      NAMING_NONE,
    );
    assert.equal(strength('<div class="without-banner"></div>'), NAMING_NONE);
  });

  it('完全无属性时零信号', () => {
    assert.equal(strength('<div></div>'), NAMING_NONE);
    assert.equal(strength('<a href="/x"></a>'), NAMING_NONE);
  });
});

describe('词库：matched 便于调试', () => {
  it('回报命中的词', () => {
    const s = namingSignal(el('<div class="ad-item"></div>'));
    assert.ok(s.matched.length > 0, JSON.stringify(s));
  });

  it('无命中时为空数组', () => {
    assert.deepEqual(namingSignal(el('<div class="post-card"></div>')).matched, []);
  });
});
