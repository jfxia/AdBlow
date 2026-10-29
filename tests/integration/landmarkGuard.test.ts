import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN_ATTR,
  REASON_ATTR,
  WHY_ATTR,
  hideElement,
  isHidden,
  judgeElement,
  selectorsFrom,
  sweep,
  type JudgeOptions,
} from '../../src/content/engine.ts';
import { NAMING_STRONG, namingSignal } from '../../src/engine/lexicon.ts';

// Regression for the real YouTube Shorts page (snapshot, 2026-10-29): the whole page body
// `<ytd-shorts … role="main">` was hidden, a blank page remained and the sound kept playing.
// Two independent causes, both fixed here:
//
//   1. Naming evidence used to scan **every attribute name**, so the boolean feature switch
//      `move-ads-overlay-to-shorts` scored as strong ad naming.
//   2. `role="main"` was not in the absolute-protection list, so even a correct naming score
//      could hide the page container.
//
// The role declaration is the stronger fix: it does not depend on the heuristic at all.

const HOST = 'www.youtube.com';

function options(selectors = selectorsFrom([], [])): JudgeOptions {
  return {
    injected: () => true,
    host: HOST,
    viewportArea: 1920 * 1080,
    selectors,
  };
}

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild!;
}

/** The real page container, reduced to the attributes that mattered. */
const SHORTS_ROOT =
  '<ytd-shorts class="style-scope ytd-page-manager" enable-previous-continuation="" ' +
  'move-ads-overlay-to-shorts="" is-up-arrow-hidden="" short-layout="2" role="main">' +
  '<div id="shorts-container"><div id="shorts-video-shell"></div></div></ytd-shorts>';

describe('❗命名证据只来自类名/id/标签值：布尔属性名不算', () => {
  it('move-ads-overlay-to-shorts 不产生命名证据', () => {
    const el = mount(SHORTS_ROOT);
    assert.ok(
      namingSignal(el).strength < NAMING_STRONG,
      `布尔属性名不该计分，实际 ${JSON.stringify(namingSignal(el))}`,
    );
  });

  it('没有 role=main 的同类容器也不会因为布尔属性名被隐藏', () => {
    // The naming fix must stand on its own: take the role marker away and the (empty) container
    // must still escape the naming tier. Nothing else here is evidence.
    const el = mount(
      '<div id="shorts-shell" move-ads-overlay-to-shorts=""><div id="inner"></div></div>',
    );
    assert.equal(judgeElement(el, options()), null);
    sweep(document.documentElement, options());
    assert.equal(isHidden(el), false);
  });

  it('类名 / id 里的广告词照旧计分并照旧隐藏（真信号不被关掉）', () => {
    const el = mount('<div id="ad-slot"><span>x</span></div>');
    assert.ok(namingSignal(el).strength >= NAMING_STRONG);
    sweep(document.documentElement, options());
    assert.equal(isHidden(el), true);
  });
});

describe('❗ARIA 地标角色 = 绝对保护（与 <main>/<article>/<nav> 同等）', () => {
  it('role=main 的页面容器即使命名很强也不隐藏（ytd-shorts 实证）', () => {
    const el = mount(SHORTS_ROOT);
    // Make it maximally suspicious apart from the role: an ad-named class.
    el.className = 'ad-slot style-scope ytd-page-manager';
    assert.equal(judgeElement(el, options()), null);
    sweep(document.documentElement, options());
    assert.equal(isHidden(el), false, 'role=main 是作者自己的声明，任何启发式都不能推翻');
    assert.equal(el.getAttribute(REASON_ATTR), null);
  });

  it('role=main / navigation / banner / contentinfo 四个地标都是绝对保护', () => {
    for (const role of ['main', 'navigation', 'banner', 'contentinfo']) {
      document.body.innerHTML = `<div role="${role}" class="ad-banner ad-slot"></div>`;
      const el = document.body.firstElementChild!;
      assert.equal(judgeElement(el, options()), null, role);
      sweep(document.documentElement, options());
      assert.equal(isHidden(el), false, role);
    }
  });

  it('容器里有 role=main 时，容器本身也不得被隐藏（隐藏它同样会抹掉正文）', () => {
    const wrapper = mount('<div id="page" class="ad-slot"><div role="main">正文</div></div>');
    sweep(document.documentElement, options());
    assert.equal(isHidden(wrapper), false);
  });

  it('地标角色只保护自身与容器，不保护里面的广告位（否则广告全放出来）', () => {
    const main = mount(
      '<div role="main"><article>正文</article><div class="ad-slot" id="in-main"></div></div>',
    );
    const ad = main.querySelector('#in-main')!;
    sweep(document.documentElement, options());
    assert.equal(isHidden(ad), true);
  });
});

describe('hideElement 不碰不可见元素（快照里的 removePlayerAD 噪声）', () => {
  it('<style id="removePlayerAD"> / <script> 不留下任何隐藏属性', () => {
    const style = document.createElement('style');
    style.id = 'removePlayerAD';
    const script = document.createElement('script');
    script.id = 'ad_status';
    document.body.append(style, script);

    assert.equal(hideElement(style, 'heuristic'), false);
    assert.equal(hideElement(script, 'heuristic'), false);
    sweep(document.documentElement, options());
    for (const el of [style, script]) {
      assert.equal(el.getAttribute(HIDDEN_ATTR), null);
      assert.equal(el.getAttribute(REASON_ATTR), null);
      assert.equal(el.getAttribute(WHY_ATTR), null);
    }
  });

  it('SVG/MathML 不在 HTML 命名空间，同样不标记（否则是"假装隐藏"）', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ad-slot');
    document.body.appendChild(svg);
    assert.equal(hideElement(svg, 'heuristic'), false);
    sweep(document.documentElement, options());
    assert.equal(svg.getAttribute(HIDDEN_ATTR), null);
  });
});
