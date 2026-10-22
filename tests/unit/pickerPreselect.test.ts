/**
 * 右键预选：把“最近一次右键元素”变成可单测的纯判断。
 *
 * 原生菜单点击不携带 DOM 事件，点击到达时元素可能已被移除、替换，或根本就是拾取器
 * 自己的面板。四种情况都必须安全退回普通拾取，否则面板会开在一个已脱离文档的节点上，
 * 生成的选择器毫无意义。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePreselect } from '../../src/content/picker.ts';
import { PICKER_UI_ATTR } from '../../src/content/engine.ts';

function mount(html: string): { root: HTMLElement; el: Element } {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return { root, el: root.firstElementChild! };
}

describe('右键预选：可用性判断', () => {
  it('❗预选元素仍在文档中 → 采用，无需再次悬停或点击', () => {
    const { root, el } = mount('<div class="ad-slot"></div>');
    try {
      const decision = resolvePreselect(el, document);
      assert.equal(decision.target, el);
      assert.equal(decision.fallback, null);
    } finally {
      root.remove();
    }
  });

  it('❗预选元素已从文档移除 → 退回普通拾取', () => {
    const { root, el } = mount('<div class="ad-slot"></div>');
    root.remove();
    const decision = resolvePreselect(el, document);
    assert.equal(decision.target, null);
    assert.equal(decision.fallback, 'detached');
  });

  it('❗预选元素是拾取器自己的 UI → 退回（不能自己隐藏自己）', () => {
    const host = document.createElement('div');
    host.setAttribute(PICKER_UI_ATTR, '');
    document.body.appendChild(host);
    try {
      const decision = resolvePreselect(host, document);
      assert.equal(decision.target, null);
      assert.equal(decision.fallback, 'picker-ui');
    } finally {
      host.remove();
    }
  });

  it('没有预选记录 → 退回普通拾取', () => {
    const decision = resolvePreselect(null, document);
    assert.equal(decision.target, null);
    assert.equal(decision.fallback, 'none');
  });

  it('html / body / head 不可预选 → 退回（面板只会空转报错）', () => {
    for (const el of [document.documentElement, document.body, document.head]) {
      const decision = resolvePreselect(el, document);
      assert.equal(decision.target, null);
      assert.equal(decision.fallback, 'unpickable', `${el.tagName} 不应被预选`);
    }
  });
});
