import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN_ATTR,
  REASON_ATTR,
  hasContentMarker,
  hideElement,
} from '../../src/content/engine.ts';
import {
  RESTORED_ATTR,
  WALL_REASON,
  captureContentBaseline,
  neutralizeWall,
  refreshContentBaseline,
  wallContext,
  type ContentBaseline,
  type NeutralizeResult,
} from '../../src/content/wallFix.ts';
import type { WallContext } from '../../src/engine/antiAdblock.ts';

/**
 * Page-side wall neutralisation under jsdom: hide the prompt, re-show the content the page hid,
 * and — the hard invariant — never undo our own ad hiding.
 *
 * jsdom has no layout engine, so only the wall's geometry is injected; style reads use the real
 * `getComputedStyle`, and fixtures are attached to the global document because the restore pass
 * skips elements that left the document.
 */

const VIEWPORT = 1920 * 1080;

/** Article text with schema.org markup: `holdsRealContent` accepts it via the content marker. */
const CONTENT = `<div id="content" style="max-width:760px">
  <h1>Normal article heading</h1>
  <p>${'This is a normal paragraph of the page. '.repeat(8)}</p>
  <article itemtype="http://schema.org/BlogPosting"><h2>Marked body</h2><p>Body paragraph.</p></article>
</div>`;

/** Copy taken from the measured shape (acceptance fixture 24 / techcrunch.com). */
const WALL = `<div id="ab-wall" style="position:fixed;width:100%;height:100%;z-index:2147483647">
  <h2>Something went wrong. Disable your adblocker</h2>
  <p>It looks like your adblocker is attempting to interfere with the intended operation of this
  site. Please add your adblocker's allowlist. Advertising keeps our newsroom running, so an
  allowlisted site stays free to read for everyone.</p>
</div>`;

function page(body: string): Document {
  document.body.innerHTML = body;
  return document;
}

/** Real styles; injected geometry for the wall only (jsdom reports 0x0 for everything). */
function wallCtx(wallId = 'ab-wall'): WallContext {
  return {
    viewportArea: VIEWPORT,
    rectOf: (el) => (el.id === wallId ? { width: 1600, height: 900 } : null),
    hasContentMarker,
  };
}

function el(doc: Document, id: string): HTMLElement {
  const node = doc.getElementById(id);
  assert.ok(node, `缺少 #${id}`);
  return node;
}

function restoredOf(result: NeutralizeResult, node: Element): string | undefined {
  return result.restored.find((r) => r.element === node)?.reason;
}

describe('neutralizeWall：隐藏提示 + 恢复被页面隐藏的正文', () => {
  it('提示层被 hideElement 隐藏（带 data-adblow-hidden 与原因）', () => {
    const doc = page(CONTENT + WALL);
    const baseline = captureContentBaseline(doc);
    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    const wall = el(doc, 'ab-wall');
    assert.equal(r.hiddenPrompts.length, 1);
    assert.equal(wall.getAttribute(HIDDEN_ATTR), '1');
    assert.equal(wall.getAttribute(REASON_ATTR), WALL_REASON);
    assert.equal(getComputedStyle(wall).display, 'none');
    assert.equal(getComputedStyle(wall).visibility, 'hidden');
  });

  it('基线里可见、随后被页面隐藏的正文被恢复（display:none !important）', () => {
    const doc = page(CONTENT + WALL);
    const baseline = captureContentBaseline(doc);
    const content = el(doc, 'content');
    content.style.setProperty('display', 'none', 'important');

    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(restoredOf(r, content), 'baseline-visible');
    assert.equal(getComputedStyle(content).display, 'block');
    assert.equal(content.getAttribute(RESTORED_ATTR), '1');
    assert.equal(content.getAttribute(HIDDEN_ATTR), null, '正文不得被打上我们的隐藏标记');
  });

  it('页面用样式表类隐藏正文时同样恢复（内联 !important 压过页面规则）', () => {
    const doc = page(`<style>#content.hidden{display:none !important}</style>${CONTENT}${WALL}`);
    const baseline = captureContentBaseline(doc);
    const content = el(doc, 'content');
    content.classList.add('hidden');
    assert.equal(getComputedStyle(content).display, 'none');

    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(restoredOf(r, content), 'baseline-visible');
    assert.equal(getComputedStyle(content).display, 'block');
  });

  it('❗我们自己的隐藏不会被撤销（广告拦截不放宽）', () => {
    const doc = page(
      `${CONTENT}<div id="ad-slot" class="ad-banner">${'promo offer text '.repeat(20)}</div>${WALL}`,
    );
    const ad = el(doc, 'ad-slot');
    // We hid it with the engine's own helper; it even holds substantive text, so it would pass
    // the content test — the `data-adblow-hidden` guard is what must protect it.
    hideElement(ad, 'heuristic');

    const baseline = captureContentBaseline(doc);
    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(ad.getAttribute(HIDDEN_ATTR), '1');
    assert.equal(ad.getAttribute(REASON_ATTR), 'heuristic');
    assert.equal(ad.getAttribute(RESTORED_ATTR), null);
    assert.equal(getComputedStyle(ad).display, 'none');
    assert.equal(restoredOf(r, ad), undefined);
  });

  it('❗被我们隐藏的子树里的正文也不恢复（祖先隐藏即整体不可见）', () => {
    const doc = page(`<div id="wrapped"><div id="inner-ad"><article itemtype="http://schema.org/BlogPosting">${CONTENT}</article></div></div>${WALL}`);
    const wrapper = el(doc, 'inner-ad');
    hideElement(wrapper, 'heuristic');
    const baseline = captureContentBaseline(doc);

    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(wrapper.getAttribute(HIDDEN_ATTR), '1');
    assert.equal(el(doc, 'content').getAttribute(RESTORED_ATTR), null);
    assert.ok(!r.restored.some((x) => x.element === el(doc, 'content')));
  });

  it('❗提示元素即使进了基线也不会被恢复路径撤销（复跑仍保持隐藏）', () => {
    const doc = page(CONTENT + WALL);
    const baseline = captureContentBaseline(doc);
    // The wall holds substantive text, so it is a baseline entry; it must still stay hidden.
    assert.ok(baseline.visible.has(el(doc, 'ab-wall')));

    neutralizeWall(doc, { baseline, wall: wallCtx() });
    const wall = el(doc, 'ab-wall');
    const afterFirst = wall.getAttribute('style');
    const second = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(wall.getAttribute(HIDDEN_ATTR), '1');
    assert.equal(wall.getAttribute(RESTORED_ATTR), null);
    assert.equal(wall.getAttribute('style'), afterFirst, '复跑不得改写提示元素的样式');
    assert.ok(second.keptHiddenByUs >= 1);
  });
});

describe('neutralizeWall：恢复判据的边界', () => {
  it('❗非我们隐藏、且无实质内容的隐藏元素不被乱动', () => {
    const doc = page(`${CONTENT}
      <div id="menu" style="display:none !important"><a href="/a">Home</a><a href="/b">News</a></div>
      <div id="blank" style="visibility:hidden !important"></div>
      ${WALL}`);
    const baseline = captureContentBaseline(doc);

    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    const menu = el(doc, 'menu');
    assert.equal(menu.getAttribute(RESTORED_ATTR), null);
    assert.equal(menu.style.getPropertyValue('display'), 'none');
    assert.equal(getComputedStyle(menu).display, 'none');
    assert.equal(restoredOf(r, menu), undefined);

    const blank = el(doc, 'blank');
    assert.equal(blank.getAttribute(RESTORED_ATTR), null);
    assert.equal(blank.style.getPropertyValue('visibility'), 'hidden');
  });

  it('❗页面设计上就隐藏的内容（hidden 属性、样式表规则）不被恢复', () => {
    const doc = page(`<style>#panel{display:none}</style>
      <div id="panel"><article itemtype="http://schema.org/BlogPosting"><p>Body</p></article></div>
      <div id="attr-hidden" hidden><article itemprop="articleBody"><p>Body</p></article></div>
      ${CONTENT}${WALL}`);
    const panel = el(doc, 'panel');
    const attrHidden = el(doc, 'attr-hidden');
    assert.equal(getComputedStyle(panel).display, 'none', '样式表规则必须生效，否则本用例无效');
    assert.equal(getComputedStyle(attrHidden).display, 'none');

    const baseline = captureContentBaseline(doc);
    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(getComputedStyle(panel).display, 'none');
    assert.equal(getComputedStyle(attrHidden).display, 'none');
    assert.equal(panel.getAttribute(RESTORED_ATTR), null);
    assert.equal(attrHidden.getAttribute(RESTORED_ATTR), null);
    assert.ok(!r.restored.some((x) => x.element === panel || x.element === attrHidden));
  });

  it('页面在解析期用内联 !important 硬隐藏正文时，基线没看到也能恢复（夹具 24 的形态）', () => {
    const doc = page(CONTENT + WALL);
    const content = el(doc, 'content');
    // The site hides the article before our first look: no baseline entry exists.
    content.style.setProperty('display', 'none', 'important');
    const baseline = captureContentBaseline(doc);
    assert.ok(!baseline.visible.has(content));

    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(restoredOf(r, content), 'runtime-inline-hide');
    assert.equal(content.style.getPropertyValue('display'), '', '页面写的内联声明应被移除');
    assert.equal(getComputedStyle(content).display, 'block');
  });

  it('内联但没有 !important 的隐藏：基线看到过才恢复，否则不动（无法与页面自身写法区分）', () => {
    // (a) no baseline entry: left alone. This is the narrow side of the criterion.
    const late = page(CONTENT + WALL);
    const lateContent = el(late, 'content');
    lateContent.style.display = 'none';
    const lateBaseline = captureContentBaseline(late);
    const lateResult = neutralizeWall(late, { baseline: lateBaseline, wall: wallCtx() });
    assert.equal(restoredOf(lateResult, lateContent), undefined);
    assert.equal(getComputedStyle(lateContent).display, 'none');

    // (b) baseline captured before the hide: restored.
    const early = page(CONTENT + WALL);
    const earlyBaseline = captureContentBaseline(early);
    const earlyContent = el(early, 'content');
    earlyContent.style.display = 'none';
    const earlyResult = neutralizeWall(early, { baseline: earlyBaseline, wall: wallCtx() });
    assert.equal(restoredOf(earlyResult, earlyContent), 'baseline-visible');
    assert.equal(getComputedStyle(earlyContent).display, 'block');
  });

  it('页面上没有反过滤提示时什么都不做', () => {
    const doc = page(
      `${CONTENT}<div id="cookie" style="position:fixed;width:100%;height:100%"><p>We use cookies. Accept all cookies.</p></div>`,
    );
    const baseline = captureContentBaseline(doc);

    const r = neutralizeWall(doc, { baseline, wall: wallCtx('cookie') });

    assert.deepEqual(r.hiddenPrompts, []);
    assert.deepEqual(r.restored, []);
    assert.equal(el(doc, 'cookie').getAttribute(HIDDEN_ATTR), null);
  });

  it('后插入的正文在刷新基线后同样可恢复（初次与后续 DOM 变化都覆盖）', () => {
    const doc = page(WALL);
    const baseline = captureContentBaseline(doc);
    document.body.insertAdjacentHTML('beforeend', CONTENT);
    assert.ok(refreshContentBaseline(baseline, doc) > 0);

    const content = el(doc, 'content');
    content.style.setProperty('display', 'none', 'important');
    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.equal(restoredOf(r, content), 'baseline-visible');
    assert.equal(getComputedStyle(content).display, 'block');
  });

  it('复跑幂等：页面再次隐藏正文时再次恢复，已恢复的元素不再重复计数', () => {
    const doc = page(CONTENT + WALL);
    const baseline = captureContentBaseline(doc);
    const content = el(doc, 'content');

    content.style.setProperty('display', 'none', 'important');
    const first = neutralizeWall(doc, { baseline, wall: wallCtx() });
    assert.equal(restoredOf(first, content), 'baseline-visible');

    const second = neutralizeWall(doc, { baseline, wall: wallCtx() });
    assert.deepEqual(second.restored, [], '已经可见的正文不重复处理');

    content.style.setProperty('display', 'none', 'important');
    const third = neutralizeWall(doc, { baseline, wall: wallCtx() });
    assert.equal(restoredOf(third, content), 'baseline-visible');
  });

  it('已离开文档的基线条目只记数、不恢复', () => {
    const doc = page(CONTENT + WALL);
    const baseline: ContentBaseline = captureContentBaseline(doc);
    const content = el(doc, 'content');
    content.remove();

    const r = neutralizeWall(doc, { baseline, wall: wallCtx() });

    assert.ok(r.gone >= 1);
    assert.ok(!baseline.visible.has(content), '离开文档的条目应从基线移除');
  });

  it('异常不逃逸：空文档与缺失样式读取都不抛', () => {
    document.body.innerHTML = '';
    const baseline = captureContentBaseline(document);
    assert.doesNotThrow(() => neutralizeWall(document, { baseline, wall: wallCtx() }));
    assert.doesNotThrow(() =>
      neutralizeWall(document, {
        baseline,
        wall: wallCtx(),
        // A hostile page can break style reads; the pass must survive it.
        styleOf: () => {
          throw new Error('boom');
        },
      }),
    );
  });
});

describe('wallContext：内容层启发式只在调用点注入', () => {
  it('提供内容标记判定，供引擎层使用', () => {
    const ctx = wallContext(VIEWPORT);
    assert.equal(ctx.viewportArea, VIEWPORT);
    assert.equal(typeof ctx.hasContentMarker, 'function');
    assert.equal(ctx.hasContentMarker?.(document.createElement('article')) ?? false, false);
    const marked = document.createElement('article');
    marked.setAttribute('itemprop', 'articleBody');
    assert.equal(ctx.hasContentMarker?.(marked), true);
  });
});
