import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generalizeSelector } from '../../src/engine/selector.ts';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('generalizeSelector', () => {
  it('优先使用稳定数据属性', () => {
    assert.equal(
      generalizeSelector(el('<div class="post-card" id="ssp-card-3" data-ssp-slot-node></div>')),
      '[data-ssp-slot-node]',
    );
  });

  it('优先使用语义属性而不是易变类名', () => {
    assert.equal(
      generalizeSelector(el('<div class="a1b2c3" data-ssp-slot-root=""></div>')),
      '[data-ssp-slot-root]',
    );
  });

  it('丢弃看起来随机的哈希类名', () => {
    const s = generalizeSelector(el('<div class="xqbj-component-ssp-float-icon css-1x9f2kd"></div>'));
    assert.ok(!s.includes('css-1x9f2kd'), s);
    assert.ok(s.includes('xqbj-component-ssp-float-icon'), s);
  });

  it('把数字后缀的 id 泛化为前缀匹配', () => {
    assert.equal(generalizeSelector(el('<div id="promo-banner-42"></div>')), '[id^="promo-banner-"]');
  });

  it('输出可用于 querySelector 的合法选择器', () => {
    const target = el('<div class="post-card" id="ssp-card-7" data-ssp-slot-node></div>');
    document.body.appendChild(target);
    const s = generalizeSelector(target);
    assert.doesNotThrow(() => document.querySelector(s));
    assert.equal(document.querySelector(s), target);
    target.remove();
  });
});
