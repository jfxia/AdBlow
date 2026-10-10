import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { adSignalStrength, AD_TOKEN } from '../../src/engine/lexicon.ts';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('adSignalStrength', () => {
  it('识别试点站的 SSP 属性', () => {
    assert.ok(adSignalStrength(el('<div data-ssp-slot-root></div>')) > 0);
    assert.ok(adSignalStrength(el('<div data-ssp-sdk-popup-overlay></div>')) > 0);
  });

  it('识别 xqbj SSP 组件类', () => {
    assert.ok(adSignalStrength(el('<div class="xqbj-component-ssp-float-icon"></div>')) > 0);
  });

  it('识别通用广告词', () => {
    for (const s of ['ad-slot', 'advert', 'guanggao', 'sponsor', 'popunder', 'adsbygoogle']) {
      assert.ok(adSignalStrength(el(`<div class="${s}"></div>`)) > 0, s);
    }
  });

  it('不把正文卡片判成广告（误伤守卫）', () => {
    const real = el(
      '<article itemscope itemtype="http://schema.org/BlogPosting" class=""><h2>标题</h2></article>',
    );
    assert.equal(adSignalStrength(real), 0);
  });

  it('不因为 id="post-card-137924" 而误判', () => {
    assert.equal(adSignalStrength(el('<div id="post-card-137924" class="post-card"></div>')), 0);
  });

  it('AD_TOKEN 正则不含裸 post-card', () => {
    assert.equal(AD_TOKEN.test('post-card'), false);
    assert.equal(AD_TOKEN.test('ssp-card-0'), true);
  });
});
