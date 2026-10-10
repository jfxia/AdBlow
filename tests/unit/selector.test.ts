import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generalizeSelector, isSelectorSafe } from '../../src/engine/selector.ts';

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
    assert.ok(s !== null && !s.includes('css-1x9f2kd'), String(s));
    assert.ok(s !== null && s.includes('xqbj-component-ssp-float-icon'), String(s));
  });

  it('把数字后缀的 id 泛化为前缀匹配', () => {
    assert.equal(generalizeSelector(el('<div id="promo-banner-42"></div>')), '[id^="promo-banner-"]');
  });

  it('输出可用于 querySelector 的合法选择器', () => {
    const target = el('<div class="post-card" id="ssp-card-7" data-ssp-slot-node></div>');
    document.body.appendChild(target);
    const s = generalizeSelector(target);
    assert.ok(s !== null);
    assert.doesNotThrow(() => document.querySelector(s));
    assert.equal(document.querySelector(s), target);
    target.remove();
  });

  it('没有任何稳定特征时返回 null，绝不返回裸标签名', () => {
    // 这是防「隐藏页面上所有链接」这类灾难的硬约束：
    // 自学习规则会进入静态规则集，静态规则命中即隐藏、不做判定。
    assert.equal(generalizeSelector(el('<a href="https://spam.example.com/x"></a>')), null);
    assert.equal(generalizeSelector(el('<div></div>')), null);
    assert.equal(generalizeSelector(el('<img src="/a.png">')), null);
  });
});

describe('isSelectorSafe（入库前的宽度闸门）', () => {
  it('接受精确选择器', () => {
    const root = el('<div><i data-ssp-slot-root></i><b class="other"></b></div>');
    assert.equal(isSelectorSafe('[data-ssp-slot-root]', root), true);
  });

  it('拒绝命中过多的选择器', () => {
    const root = el(`<div>${'<i class="everywhere"></i>'.repeat(50)}</div>`);
    assert.equal(isSelectorSafe('.everywhere', root), false);
    assert.equal(isSelectorSafe('.everywhere', root, 100), true);
  });

  it('拒绝空串与过短选择器', () => {
    const root = el('<div></div>');
    assert.equal(isSelectorSafe('', root), false);
    assert.equal(isSelectorSafe('a', root), false); // 长度 < 2
  });

  it('非法选择器不抛异常，直接拒绝', () => {
    const root = el('<div></div>');
    assert.equal(isSelectorSafe('[[[', root), false);
  });
});
