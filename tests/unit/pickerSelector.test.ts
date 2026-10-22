/**
 * 拾取器的选择器生成与保存前校验。
 *
 * 重点：泛化结果不安全时必须退化，且退化结果永远不是裸标签名；用户改过的选择器
 * 必须复用自学习路径的两道闸门（forbiddenSelectorReason + isSelectorSafe）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICKER_MAX_MATCHES,
  pickerSelector,
  pickerSelectorProblem,
} from '../../src/engine/picker.ts';
import { isSelectorSafe } from '../../src/engine/selector.ts';

function container(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('拾取器：安全的泛化选择器优先', () => {
  it('语义 data 属性优先于类名与 id', () => {
    const root = container('<div class="ad-slot" id="banner-1" data-ssp-slot-node></div>');
    assert.equal(pickerSelector(root.firstElementChild!, root), '[data-ssp-slot-node]');
  });

  it('有 id 而没有更稳定特征时生成 #id', () => {
    const root = container('<div id="promo-banner"></div>');
    assert.equal(pickerSelector(root.firstElementChild!, root), '#promo-banner');
  });

  it('普通类名可用时生成 .class', () => {
    const root = container('<div class="ad-slot"></div>');
    assert.equal(pickerSelector(root.firstElementChild!, root), '.ad-slot');
  });
});

describe('拾取器：泛化不可用时的退化策略', () => {
  it('❗泛化结果过宽时退化，且退化结果仍精确命中目标', () => {
    const root = container(`<div>${'<i class="everywhere"></i>'.repeat(40)}</div>`);
    const target = root.querySelectorAll('i')[30]!;

    const selector = pickerSelector(target, root);
    assert.ok(selector, '必须给出一个可用选择器');
    assert.notEqual(selector, '.everywhere', '过宽的类名不能作为拾取结果');
    assert.equal(root.querySelector(selector), target);
    assert.equal(isSelectorSafe(selector, root, PICKER_MAX_MATCHES), true);
    assert.ok(selector!.includes(':nth-of-type('), String(selector));
  });

  it('❗没有稳定特征时用逐级 tag:nth-of-type(n)，绝不返回裸标签名', () => {
    const root = container('<div><section><span></span><b></b></section></div>');
    const target = root.querySelector('b')!;

    const selector = pickerSelector(target, root);
    assert.ok(selector);
    assert.ok(!/^[a-z][\w-]*$/.test(selector!), `不得是裸标签名：${selector}`);
    assert.ok(selector!.includes(':nth-of-type('), String(selector));
    assert.equal(root.querySelector(selector!), target);
  });

  it('❗禁用类名不会被生成为拾取结果（改走安全路径）', () => {
    const root = container('<div class="post-card"></div>');
    const target = root.firstElementChild!;

    const selector = pickerSelector(target, root);
    assert.ok(selector);
    assert.equal(selector!.includes('post-card'), false, String(selector));
    assert.equal(pickerSelectorProblem(selector!, root), null);
  });

  it('同名兄弟不唯一时逐级向上加路径', () => {
    const root = container('<div><div><span></span></div><div><span></span></div></div>');
    const target = root.querySelectorAll('span')[1]!;

    const selector = pickerSelector(target, root);
    assert.ok(selector);
    assert.ok(selector!.includes(' > '), String(selector));
    assert.equal(root.querySelector(selector!), target);
  });

  it('❗html / body / head 不可拾取（隐藏它们会清空整页）', () => {
    assert.equal(pickerSelector(document.body, document), null);
    assert.equal(pickerSelector(document.documentElement, document), null);
  });
});

describe('拾取器：保存前的选择器校验', () => {
  it('合法的精确选择器通过', () => {
    const root = container('<div class="ad-slot"></div>');
    assert.equal(pickerSelectorProblem('.ad-slot', root), null);
  });

  it('空串与空选择器被拒绝', () => {
    const root = container('<div></div>');
    assert.equal(pickerSelectorProblem('', root), 'empty');
    assert.equal(pickerSelectorProblem('   ', root), 'empty');
  });

  it('❗裸标签名被拒绝（即使它当前只匹配一个元素）', () => {
    const root = container('<div></div>');
    assert.equal(pickerSelectorProblem('div', root), 'bare-tag');
  });

  it('禁用选择器被拒绝（复用规则包的禁区）', () => {
    const root = container('<div class="post-card"></div>');
    assert.equal(pickerSelectorProblem('.post-card', root), 'forbidden');
  });

  it('语法非法、无命中、过宽分别被拒绝', () => {
    const root = container(`<div>${'<i class="wide"></i>'.repeat(40)}</div>`);
    assert.equal(pickerSelectorProblem('[[[', root), 'invalid');
    assert.equal(pickerSelectorProblem('.nope', root), 'no-match');
    assert.equal(pickerSelectorProblem('.wide', root), 'too-wide');
    assert.equal(pickerSelectorProblem('.wide', root, 50), null);
  });
});
