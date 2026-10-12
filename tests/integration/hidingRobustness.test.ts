import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFOUGHT_ATTR,
  hideElement,
  isHidden,
  verifyHiding,
} from '../../src/content/engine.ts';

/**
 * 「隐藏被打回去」的回归 —— 用户报告 1024cg 上「留下一个覆盖页面的层，
 * 所有链接都点不动」的真实根因。
 *
 * ## 事故
 *
 * 站点脚本用**同样带 `!important` 的内联样式**把 `display` 改回 `block`。
 * 同优先级下后写的赢，于是我们"已经隐藏"的元素又显示出来：
 * 那是一个 `position:fixed; z-index:9999`、覆盖 99.5% 视口的广告弹层，
 * **整页链接都点不动**，而 `data-adblow-hidden` 标记还挂着 —— 标记成了谎话。
 *
 * ## 两道防线
 *
 *   1. `hideElement` 同时设 `pointer-events:none` / `visibility:hidden` ——
 *      即使显示被改回来，**点击也能穿透到下面的链接**
 *   2. `verifyHiding` 复核并重新隐藏，且记录"顽固"元素
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

/** 模拟站点脚本"完整反制"：把三处都改回来（这才是真正需要复核的情形）。 */
function siteFightsBack(el: HTMLElement): void {
  el.style.setProperty('display', 'block', 'important');
  el.style.setProperty('visibility', 'visible', 'important');
  el.style.setProperty('pointer-events', 'auto', 'important');
}

describe('hideElement：多管齐下，站点改回 display 也点得动', () => {
  it('设置了 display / visibility / pointer-events 三处 !important', () => {
    const el = mount('<div class="popup-container"></div>') as HTMLElement;
    hideElement(el, 'heuristic');
    assert.equal(el.style.getPropertyValue('display'), 'none');
    assert.equal(el.style.getPropertyPriority('display'), 'important');
    assert.equal(el.style.getPropertyValue('visibility'), 'hidden');
    assert.equal(el.style.getPropertyPriority('visibility'), 'important');
    assert.equal(el.style.getPropertyValue('pointer-events'), 'none');
    assert.equal(el.style.getPropertyPriority('pointer-events'), 'important');
    assert.equal(el.getAttribute('data-adblow-reason'), 'heuristic');
  });
});

describe('❗verifyHiding：复核并重新隐藏（真实事故回归）', () => {
  it('站点把 display 改回 block → 复核发现并重新隐藏', () => {
    const el = mount('<div class="popup-container"></div>') as HTMLElement;
    hideElement(el, 'heuristic');

    // 模拟站点脚本用同样 !important 的内联样式反制
    el.style.setProperty('display', 'block', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    assert.equal(isHidden(el), true, '标记还在（这正是"谎话"的那一刻）');

    const audit = verifyHiding(document);
    assert.equal(audit.checked, 1);
    assert.equal(audit.refought, 1, '应发现并重新隐藏');
    assert.equal(el.style.getPropertyValue('display'), 'none');
    assert.equal(el.style.getPropertyPriority('display'), 'important');
    assert.equal(el.style.getPropertyValue('pointer-events'), 'none', '点击必须能穿透');
  });

  it('原因被保留（便于事后统计是谁判的）', () => {
    const el = mount('<div class="ad"></div>') as HTMLElement;
    hideElement(el, 'linkfarm');
    el.style.setProperty('display', 'block', 'important');
    verifyHiding(document);
    assert.equal(el.getAttribute('data-adblow-reason'), 'linkfarm');
  });

  it('站点只把 display 改回来时仍然挡得住（三管齐下更抗打）', () => {
    const el = mount('<div class="popup-container"></div>') as HTMLElement;
    hideElement(el, 'heuristic');
    // 只改 display：visibility:hidden 还挡着，元素依然不可见
    el.style.setProperty('display', 'block', 'important');
    const audit = verifyHiding(document);
    assert.equal(audit.refought, 0, 'visibility 仍然生效 → 不算被改回来');
  });

  it('反复被改回的元素会被标出来（站点在主动对抗）', () => {
    const el = mount('<div class="popup-container stubborn"></div>') as HTMLElement;
    hideElement(el, 'heuristic');
    for (let i = 0; i < 3; i += 1) {
      siteFightsBack(el);
      verifyHiding(document);
    }
    assert.equal(el.getAttribute(REFOUGHT_ATTR), '3');

    siteFightsBack(el);
    const a = verifyHiding(document);
    assert.ok(a.stubborn.length >= 1, `应报告顽固元素，实际 ${JSON.stringify(a.stubborn)}`);
    assert.match(a.stubborn[0]!, /popup-container/);
    assert.match(a.stubborn[0]!, /×4/);
  });

  it('没有被改回的元素不会被重复处理', () => {
    const el = mount('<div class="ad"></div>') as HTMLElement;
    hideElement(el, 'heuristic');
    const audit = verifyHiding(document);
    assert.equal(audit.checked, 1);
    assert.equal(audit.refought, 0, '仍然隐藏着就不该重新动手');
    assert.equal(el.getAttribute(REFOUGHT_ATTR), null);
  });

  it('没有 defaultView（非文档根）时安全返回', () => {
    const el = document.createElement('div');
    hideElement(el, 'heuristic');
    const audit = verifyHiding(el);
    assert.deepEqual(audit, { checked: 0, refought: 0, stubborn: [] });
  });
});
