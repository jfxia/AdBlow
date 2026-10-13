import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOMETRY_MAX_CANDIDATES,
  GROWTH_FACTOR,
  GROWTH_MIN_AREA_RATIO,
  collectGrownElements,
  createGrowthTracker,
  type Rect,
} from '../../src/engine/geometry.ts';

// Geometry-growth tracking — the only way to find expand-type ads (auto-resizing,
// hover-expand, auto-enlarge). Incident: the engine judged an element once, when it entered
// the DOM, while these ads work by pure CSS change (the element stays, it just grows) and add
// no nodes, so a re-judge never fired. Acceptance cases 8, 18 and 21 all sat in that blind spot.

const VIEWPORT = 1280 * 900;

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

/** A mutable size table drives rectOf to simulate growth; styles are injected too, so the
 * test doesn't depend on jsdom's getComputedStyle. */
function sizedCtx(sizes: Record<string, Rect>, positions: Record<string, string> = {}) {
  return {
    viewportArea: VIEWPORT,
    rectOf: (el: Element) => sizes[el.getAttribute('data-k') ?? ''] ?? null,
    styleOf: (el: Element) => ({ position: positions[el.getAttribute('data-k') ?? ''] ?? 'static' }),
  };
}

describe('collectGrownElements：发现被撑大的元素', () => {
  it('第一次见到的元素只记基线，不算「变大」', () => {
    const doc = root('<div data-k="box" style="position:fixed"></div>');
    const tracker = createGrowthTracker();
    const sizes = { box: { width: 80, height: 60 } };
    assert.deepEqual(collectGrownElements(doc, tracker, sizedCtx(sizes)), []);
  });

  it('面积涨到阈值倍数且占视口足够大 → 命中', () => {
    const doc = root('<div data-k="box" style="position:fixed"></div>');
    const tracker = createGrowthTracker();
    const sizes = { box: { width: 80, height: 60 } };
    collectGrownElements(doc, tracker, sizedCtx(sizes)); // establish the baseline

    sizes.box = { width: 640, height: 440 };
    const grown = collectGrownElements(doc, tracker, sizedCtx(sizes));
    assert.ok(
      grown.some((e) => e.getAttribute('data-k') === 'box'),
      '撑大的元素本身必须被返回',
    );
  });

  it('涨了倍数但占视口太小 → 不命中（避免为小控件展开误伤）', () => {
    const doc = root('<div data-k="box" style="position:absolute"></div>');
    const tracker = createGrowthTracker();
    const sizes = { box: { width: 10, height: 10 } };
    collectGrownElements(doc, tracker, sizedCtx(sizes));

    // 25x growth, but only 2500px² ≈ 0.2% of the viewport.
    sizes.box = { width: 50, height: 50 };
    assert.deepEqual(collectGrownElements(doc, tracker, sizedCtx(sizes)), []);
  });

  it('只是缓慢变大（不到倍数阈值）→ 不命中', () => {
    const doc = root('<div data-k="box" style="position:fixed"></div>');
    const tracker = createGrowthTracker();
    const sizes = { box: { width: 640, height: 440 } };
    collectGrownElements(doc, tracker, sizedCtx(sizes));

    sizes.box = { width: 700, height: 480 }; // only 1.2x
    assert.deepEqual(collectGrownElements(doc, tracker, sizedCtx(sizes)), []);
  });

  it('命中时会连带返回值得作为候选的祖先（定位的，或内部含媒体的）', () => {
    // Real shape: the grown box holds an image, wrapped in a positioned outer container with
    // a plain div in between.
    const doc = root(
      '<div data-k="outer" style="position:fixed"><div data-k="mid"><div data-k="box" style="position:absolute"><img src="/x.png"></div></div></div>',
    );
    const tracker = createGrowthTracker();
    const sizes: Record<string, Rect> = {
      outer: { width: 700, height: 500 },
      mid: { width: 700, height: 500 },
      box: { width: 80, height: 60 },
    };
    const positions = { outer: 'fixed', mid: 'static', box: 'absolute' };
    collectGrownElements(doc, tracker, sizedCtx(sizes, positions));

    sizes.box = { width: 640, height: 440 };
    const grown = collectGrownElements(doc, tracker, sizedCtx(sizes, positions));
    const keys = grown.map((e) => e.getAttribute('data-k'));
    assert.ok(keys.includes('box'), '撑大的元素本身');
    assert.ok(keys.includes('mid'), '内部含媒体的祖先应作为候选');
    assert.ok(keys.includes('outer'), '定位祖先应作为候选');
  });

  it('❗不含定位也无可视媒体的普通包裹层不作为候选（减少噪声）', () => {
    const doc = root('<div data-k="wrap"><div data-k="box" style="position:fixed"></div></div>');
    const tracker = createGrowthTracker();
    const sizes: Record<string, Rect> = { wrap: { width: 900, height: 700 }, box: { width: 80, height: 60 } };
    collectGrownElements(doc, tracker, sizedCtx(sizes));

    sizes.box = { width: 640, height: 440 };
    const keys = collectGrownElements(doc, tracker, sizedCtx(sizes)).map((e) => e.getAttribute('data-k'));
    assert.ok(keys.includes('box'));
    assert.ok(!keys.includes('wrap'), '普通包裹 div 不该作为候选');
  });

  it('跳过已隐藏子树里的元素', () => {
    const doc = root(
      '<div data-adblow-hidden><div data-k="box" style="position:fixed"></div></div>',
    );
    const tracker = createGrowthTracker();
    const sizes = { box: { width: 80, height: 60 } };
    collectGrownElements(doc, tracker, sizedCtx(sizes));
    sizes.box = { width: 640, height: 440 };
    assert.deepEqual(collectGrownElements(doc, tracker, sizedCtx(sizes)), []);
  });

  it('拿不到尺寸时安全跳过', () => {
    const doc = root('<div data-k="box" style="position:fixed"></div>');
    const tracker = createGrowthTracker();
    assert.deepEqual(
      collectGrownElements(doc, tracker, { viewportArea: VIEWPORT, rectOf: () => null }),
      [],
    );
  });

  it('视口面积非法时直接返回空', () => {
    const doc = root('<div data-k="box" style="position:fixed"></div>');
    assert.deepEqual(
      collectGrownElements(doc, createGrowthTracker(), { viewportArea: 0, rectOf: () => ({ width: 1, height: 1 }) }),
      [],
    );
  });

  it('元素数量上限生效（防止超大页面拖慢主线程）', () => {
    const many = Array.from({ length: GEOMETRY_MAX_CANDIDATES + 50 }, (_, i) =>
      `<img data-k="i${i}" src="/x.png">`,
    ).join('');
    const doc = root(many);
    const tracker = createGrowthTracker();
    let calls = 0;
    // Every element "grows": even well past the cap, only the capped number may be processed.
    const ctx = {
      viewportArea: VIEWPORT,
      rectOf: (): Rect => {
        calls += 1;
        return { width: 800, height: 700 };
      },
      styleOf: () => ({ position: 'static' }),
    };
    collectGrownElements(doc, tracker, ctx);
    calls = 0;
    collectGrownElements(doc, tracker, ctx);
    assert.ok(calls <= GEOMETRY_MAX_CANDIDATES, `只应处理至多 ${GEOMETRY_MAX_CANDIDATES} 个候选，实际 ${calls}`);
  });
});

describe('阈值常量（改动会影响灵敏度与误伤率，需有意识）', () => {
  it('如实证记录', () => {
    assert.equal(GROWTH_FACTOR, 2.5);
    assert.equal(GROWTH_MIN_AREA_RATIO, 0.15);
    assert.equal(GEOMETRY_MAX_CANDIDATES, 600);
  });
});
