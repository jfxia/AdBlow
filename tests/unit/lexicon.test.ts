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
    // 这是「通用性差」那次反馈的直接回归：旧版用子串匹配 + 小词表，
    // 下列 4 个最直白的命名全部漏判。
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

  it('连写形式（切不出整词）靠子串兜底', () => {
    assert.equal(strength('<ins class="adsbygoogle"></ins>'), NAMING_STRONG);
    assert.equal(strength('<div class="doubleclick-slot"></div>'), NAMING_STRONG);
  });

  it('属性名里的广告词也算', () => {
    assert.equal(strength('<div data-ad-slot="1"></div>'), NAMING_STRONG);
    assert.equal(strength('<div data-ads></div>'), NAMING_STRONG);
  });

  it('SSP 缩写', () => {
    assert.equal(strength('<div class="tjssp"></div>'), NAMING_STRONG);
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

  it('❗驼峰连写必须切词（实测漏拦：站点把横幅广告叫 .topBanner）', () => {
    // 2026-10-13：修完"播放器/推荐栏误杀"后用户反馈"广告图片并未被屏蔽"。
    // 运行时 DOM 显示站点把横幅挂进 `.topBanner` —— 而 `topbanner` 与 `banner`
    // 不是同一个词，旧实现完全匹配不到词表项。
    assert.equal(strength('<div class="topBanner"></div>'), NAMING_WEAK, 'topBanner 应命中 banner');
    assert.equal(strength('<div id="globalBannerTop"></div>'), NAMING_WEAK);
    assert.equal(strength('<div class="adCard0"></div>'), NAMING_STRONG, 'adCard0 → ad card 0');
  });

  it('❗streamer 是弱档（站点广告轮播容器 .streamer-box2）', () => {
    assert.equal(strength('<ul class="streamer-box2"></ul>'), NAMING_WEAK);
    assert.equal(strength('<div class="streamer-container2"></div>'), NAMING_WEAK);
  });

  it('❗驼峰切词不得制造新的误伤', () => {
    // 切开后仍不应命中：这些词里没有广告术语
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
