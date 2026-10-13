import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_COSMETIC_ATTR, applyListCosmetic } from '../../src/content/listCosmetic.ts';
import { holdsRealContent } from '../../src/content/engine.ts';

// Injection and content-guard coverage for the community-list cosmetic layer, which
// spans tens of thousands of domains and relies solely on the content guard: selectors
// that would hide content, and invalid selectors, must be dropped — one invalid selector
// makes the browser discard the entire stylesheet.

function docWith(html: string): Document {
  document.body.innerHTML = html;
  // Test isolation: drop the styles element left by the previous case (global document).
  for (const s of Array.from(document.querySelectorAll(`style[${LIST_COSMETIC_ATTR}]`))) {
    s.remove();
  }
  return document;
}

describe('applyListCosmetic：注入与守卫', () => {
  it('合法且不碰正文的选择器被注入', () => {
    const doc = docWith('<div class="ad-banner"></div><div class="ad-slot"></div>');
    const r = applyListCosmetic(doc, ['.ad-banner', '.ad-slot'], holdsRealContent);

    assert.equal(r.injected, 2);
    assert.deepEqual(r.droppedForContent, []);
    const style = doc.querySelector(`style[${LIST_COSMETIC_ATTR}]`);
    assert.ok(style, '应创建样式元素');
    assert.match(style!.textContent!, /\.ad-banner\{display:none!important;\}/);
  });

  it('❗会隐藏正文的选择器被剔除（正文元素本身）', () => {
    const doc = docWith(
      '<article itemtype="http://schema.org/BlogPosting"><p>正文</p></article><div class="ad"></div>',
    );
    const r = applyListCosmetic(doc, ['article', '.ad'], holdsRealContent);

    assert.deepEqual(r.droppedForContent, ['article']);
    assert.equal(r.injected, 1);
    assert.ok(
      !doc.querySelector(`style[${LIST_COSMETIC_ATTR}]`)!.textContent!.includes('article{'),
      '正文选择器不得出现在样式表里',
    );
  });

  it('❗会隐藏正文的选择器被剔除（正文的祖先）', () => {
    const doc = docWith(
      '<div class="wrapper"><article itemtype="http://schema.org/BlogPosting"></article></div>',
    );
    const r = applyListCosmetic(doc, ['.wrapper'], holdsRealContent);
    assert.deepEqual(r.droppedForContent, ['.wrapper']);
    assert.equal(r.injected, 0);
  });

  it('❗非法选择器被剔除，且不影响其它规则（一条非法会毁掉整张样式表）', () => {
    const doc = docWith('<div class="ad"></div>');
    const r = applyListCosmetic(doc, ['div{class:red}', '.ad', ':::bogus', ''], holdsRealContent);

    assert.ok(
      r.droppedInvalid.includes('div{class:red}'),
      '花括号选择器必须被剔除（jsdom 不抛异常，所以需要语法粗筛）',
    );
    assert.ok(r.droppedInvalid.includes(''), '空选择器也应被剔除');
    assert.ok(r.injected >= 1, '合法规则仍应注入');
    assert.match(doc.querySelector(`style[${LIST_COSMETIC_ATTR}]`)!.textContent!, /\.ad\{/);
  });

  it('重复调用复用同一个样式元素（不重复插入）', () => {
    const doc = docWith('<div class="ad"></div>');
    applyListCosmetic(doc, ['.ad'], holdsRealContent);
    applyListCosmetic(doc, ['.ad2'], holdsRealContent);
    assert.equal(doc.querySelectorAll(`style[${LIST_COSMETIC_ATTR}]`).length, 1);
    assert.match(doc.querySelector(`style[${LIST_COSMETIC_ATTR}]`)!.textContent!, /\.ad2\{/);
  });

  it('空列表不创建样式元素', () => {
    const doc = docWith('<div></div>');
    const r = applyListCosmetic(doc, [], holdsRealContent);
    assert.equal(r.injected, 0);
    assert.equal(doc.querySelectorAll(`style[${LIST_COSMETIC_ATTR}]`).length, 0);
  });

  it('选择器未命中任何元素时照常注入（元素可能稍后由脚本创建）', () => {
    const doc = docWith('<div></div>');
    const r = applyListCosmetic(doc, ['.not-there-yet'], holdsRealContent);
    assert.equal(r.injected, 1);
  });
});
