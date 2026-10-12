import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICK_LAYER_MIN_AREA,
  CLICK_LAYER_MIN_Z,
  CLICK_LAYER_PRESELECTOR,
  findInvisibleClickLayers,
  isInvisibleClickLayer,
  isTransparentBackground,
} from '../../src/engine/clickLayer.ts';

/**
 * 隐形点击层识别 —— 点击劫持（「随便点哪里都跳走」）的正面防线。
 *
 * 安全性来自这条性质：**一个铺满视口、层级很高、却渲染不出任何可见内容的元素，
 * 隐藏它在视觉上零影响**，所以几乎没有误伤代价。
 */

const VIEWPORT = 1920 * 1080;

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

type StyleSpec = Partial<{
  position: string;
  zIndex: string;
  opacity: string;
  backgroundColor: string;
  visibility: string;
}>;

/** 注入样式与几何，测试里不依赖真实布局。 */
function ctxFor(
  specs: Record<string, StyleSpec>,
  rects: Record<string, { width: number; height: number }> = { full: { width: 1920, height: 1080 } },
) {
  const key = (el: Element) => el.getAttribute('data-k') ?? el.getAttribute('class') ?? '';
  return {
    viewportArea: VIEWPORT,
    styleOf: (el: Element) => {
      const s = specs[key(el)];
      if (!s) return null;
      return {
        position: s.position ?? 'fixed',
        zIndex: s.zIndex ?? '99999',
        opacity: s.opacity ?? '0',
        backgroundColor: s.backgroundColor ?? 'rgba(0, 0, 0, 0)',
        visibility: s.visibility ?? 'visible',
      };
    },
    rectOf: (el: Element) => rects[key(el)] ?? rects.full ?? null,
  };
}

describe('isTransparentBackground', () => {
  it('识别透明背景', () => {
    for (const v of ['transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0.0)', '']) {
      assert.equal(isTransparentBackground(v), true, v);
    }
  });

  it('不透明背景不算', () => {
    for (const v of ['rgb(255, 255, 255)', '#fff', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,1)']) {
      assert.equal(isTransparentBackground(v), false, v);
    }
  });
});

describe('isInvisibleClickLayer：命中（这就是点击劫持层）', () => {
  it('全屏 + 高层级 + opacity:0 + 无内容', () => {
    const el = root('<a data-k="layer" style="position:fixed"></a>').firstElementChild!;
    assert.equal(isInvisibleClickLayer(el, ctxFor({ layer: { opacity: '0' } })), true);
  });

  it('全屏 + 高层级 + 背景全透明 + 无内容（不靠 opacity）', () => {
    const el = root('<div data-k="layer" style="position:fixed"></div>').firstElementChild!;
    assert.equal(
      isInvisibleClickLayer(el, ctxFor({ layer: { opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0)' } })),
      true,
    );
  });

  it('阈值常量如实证记录', () => {
    assert.equal(CLICK_LAYER_MIN_AREA, 0.5);
    assert.equal(CLICK_LAYER_MIN_Z, 100);
  });
});

describe('isInvisibleClickLayer：不命中（误伤守卫）', () => {
  const notLayer = (html: string, spec: StyleSpec, rect?: { width: number; height: number }) => {
    const el = root(html).firstElementChild!;
    return isInvisibleClickLayer(el, ctxFor({ layer: spec }, rect ? { layer: rect } : undefined));
  };

  it('有可见文字的不算（内容元素，不是隐形层）', () => {
    assert.equal(notLayer('<div data-k="layer">正文内容</div>', { opacity: '0' }), false);
  });

  it('有够大的媒体的不算（图片/视频层是内容）', () => {
    // 用真实 <img>：jsdom 里尺寸为 0，所以这里显式给一个大的 svg 元素
    const el = root('<div data-k="layer"></div>').firstElementChild!;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    Object.defineProperty(svg, 'getBoundingClientRect', {
      value: () => ({ width: 300, height: 200 }),
    });
    el.appendChild(svg);
    assert.equal(isInvisibleClickLayer(el, ctxFor({ layer: { opacity: '0' } })), false);
  });

  it('半透明遮罩不算（模态背景是正常的）', () => {
    assert.equal(
      notLayer('<div data-k="layer"></div>', { opacity: '1', backgroundColor: 'rgba(0, 0, 0, 0.5)' }),
      false,
    );
  });

  it('面积不到视口一半的不算', () => {
    assert.equal(
      notLayer('<div data-k="layer"></div>', { opacity: '0' }, { width: 300, height: 100 }),
      false,
    );
  });

  it('z-index 太低的不算', () => {
    assert.equal(notLayer('<div data-k="layer"></div>', { opacity: '0', zIndex: '10' }), false);
  });

  it('静态定位的不算', () => {
    assert.equal(notLayer('<div data-k="layer"></div>', { opacity: '0', position: 'static' }), false);
  });

  it('visibility:hidden 的不算（已经不可见，无需处理）', () => {
    assert.equal(notLayer('<div data-k="layer"></div>', { opacity: '0', visibility: 'hidden' }), false);
  });

  it('拿不到样式或几何时安全退化', () => {
    const el = root('<div data-k="layer"></div>').firstElementChild!;
    assert.doesNotThrow(() => isInvisibleClickLayer(el, { viewportArea: VIEWPORT, styleOf: () => null }));
    assert.equal(isInvisibleClickLayer(el, { viewportArea: VIEWPORT, styleOf: () => null }), false);
  });
});

describe('findInvisibleClickLayers：廉价预筛', () => {
  it('预筛选择器覆盖内联定位与常见类名', () => {
    assert.ok(CLICK_LAYER_PRESELECTOR.includes('[style*="position"]'));
    assert.ok(CLICK_LAYER_PRESELECTOR.includes('overlay'));
  });

  it('只返回隐形层，跳过有内容的兄弟节点', () => {
    const el = root(
      '<div><a data-k="layer" style="position:fixed"></a><div class="overlay">可见文字</div></div>',
    );
    const found = findInvisibleClickLayers(el, ctxFor({ layer: { opacity: '0' } }));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.getAttribute('data-k'), 'layer');
  });

  it('已在隐藏子树里的不再返回', () => {
    const el = root(
      '<div data-adblow-hidden><a data-k="layer" style="position:fixed"></a></div>',
    );
    assert.deepEqual(findInvisibleClickLayers(el, ctxFor({ layer: { opacity: '0' } })), []);
  });
});
