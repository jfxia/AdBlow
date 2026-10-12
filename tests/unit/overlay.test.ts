import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_BONUS,
  OVERLAY_MIN_Z,
  OVERLAY_PRESELECTOR,
  findOverlayAds,
  findOverlays,
  isOverlay,
} from '../../src/content/engine.ts';

/**
 * 覆盖层检测是**独立一趟**，不参与逐元素打分。
 *
 * 原因见 src/content/engine.ts 的注释：把 getComputedStyle 塞进逐元素打分、
 * 同时又在扫描中改内联样式，会让样式/布局反复失效，大页面上整趟扫描跑不完。
 */

const HOST = 'afford.gjvrohros.cc';
const VIEWPORT = 1920 * 1080;

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

/** 几何与样式全部注入，测试里不依赖真实布局。 */
function ctxFor(
  map: Record<string, { position: string; zIndex: string; w: number; h: number }>,
) {
  return {
    viewportArea: VIEWPORT,
    styleOf: (el: Element) => {
      const c = map[el.getAttribute('class') ?? ''];
      return c ? { position: c.position, zIndex: c.zIndex } : null;
    },
    rectOf: (el: Element) => {
      const c = map[el.getAttribute('class') ?? ''];
      return c ? { width: c.w, height: c.h } : null;
    },
  };
}

const BIG = { position: 'fixed', zIndex: '9999', w: 1600, h: 900 };

describe('isOverlay：形态判定', () => {
  it('固定定位 + 高层级 + 大块视口', () => {
    assert.equal(isOverlay(root('<div class="a" style="position:fixed"></div>').firstElementChild!, ctxFor({ a: BIG })), true);
  });

  it('层级不够不算（正常内容也用 absolute）', () => {
    const el = root('<div class="a" style="position:absolute"></div>').firstElementChild!;
    assert.equal(isOverlay(el, ctxFor({ a: { ...BIG, position: 'absolute', zIndex: '10' } })), false);
  });

  it('面积不到视口 40% 不算（Cookie 条、返回顶部按钮）', () => {
    const el = root('<div class="a" style="position:fixed"></div>').firstElementChild!;
    assert.equal(isOverlay(el, ctxFor({ a: { ...BIG, w: 400, h: 60 } })), false);
  });

  it('静态定位不算', () => {
    const el = root('<div class="a" style="position:fixed"></div>').firstElementChild!;
    assert.equal(isOverlay(el, ctxFor({ a: { ...BIG, position: 'static' } })), false);
  });

  it('拿不到样式或几何时安全退化', () => {
    const el = root('<div class="a" style="position:fixed"></div>').firstElementChild!;
    assert.doesNotThrow(() => isOverlay(el, { viewportArea: VIEWPORT, styleOf: () => null }));
    assert.equal(isOverlay(el, { viewportArea: VIEWPORT, styleOf: () => null }), false);
  });

  it('阈值常量如实证记录', () => {
    assert.equal(OVERLAY_MIN_Z, 1000);
    assert.equal(OVERLAY_BONUS, 4);
  });
});

describe('findOverlays：廉价预筛 + 只对候选测几何', () => {
  it('预筛只挑写了内联位置样式的元素', () => {
    assert.equal(OVERLAY_PRESELECTOR, '[style*="position"]');
  });

  it('只返回覆盖层候选', () => {
    const el = root(
      '<div><div class="overlay" style="position:fixed"></div><div class="normal" style="color:red"></div></div>',
    );
    const found = findOverlays(el, ctxFor({ overlay: BIG, normal: { ...BIG } }));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.getAttribute('class'), 'overlay');
  });

  it('已在隐藏子树里的不算', () => {
    const el = root(
      '<div data-adblow-hidden><div class="overlay" style="position:fixed"></div></div>',
    );
    assert.deepEqual(findOverlays(el, ctxFor({ overlay: BIG })), []);
  });
});

describe('findOverlayAds：覆盖层必须另有旁证（关键误伤防线）', () => {
  it('❗纯覆盖层形态、无命名、无跨站链接 → 不判定（Cookie 同意条/登录弹层就长这样）', () => {
    const el = root('<div class="cookie-consent" style="position:fixed"><a href="/privacy"></a></div>');
    const ads = findOverlayAds(el, {
      host: HOST,
      viewportArea: VIEWPORT,
      overlay: ctxFor({ 'cookie-consent': BIG }),
    });
    assert.deepEqual(ads, [], '不能因为"长得像弹层"就隐藏 —— 那会误伤 Cookie 条与登录层');
  });

  it('覆盖层 + 跨站推广链接 → 判定', () => {
    const el = root(
      '<div class="popup-ad" style="position:fixed"><a href="https://spam.example.com/x?click_id=1"></a></div>',
    );
    const ads = findOverlayAds(el, {
      host: HOST,
      viewportArea: VIEWPORT,
      overlay: ctxFor({ 'popup-ad': BIG }),
    });
    assert.equal(ads.length, 1);
    assert.ok(ads[0]!.hit.reasons.includes('overlay'), JSON.stringify(ads[0]!.hit.reasons));
    assert.deepEqual(ads[0]!.hit.selector, '.popup-ad');
  });

  it('覆盖层 + 弱命名（banner/popup/float）→ 判定', () => {
    const el = root('<div class="float-layer" style="position:fixed"></div>');
    const ads = findOverlayAds(el, {
      host: HOST,
      viewportArea: VIEWPORT,
      overlay: ctxFor({ 'float-layer': BIG }),
    });
    assert.equal(ads.length, 1, '弱命名本身就是覆盖层的旁证');
  });

  it('覆盖层 + 跨站 iframe → 判定（广告联盟常见形态）', () => {
    const el = root(
      '<div class="layer-x" style="position:fixed"><iframe src="https://ads.example.com/f"></iframe></div>',
    );
    const ads = findOverlayAds(el, {
      host: HOST,
      viewportArea: VIEWPORT,
      overlay: ctxFor({ 'layer-x': BIG }),
    });
    assert.equal(ads.length, 1);
  });

  it('命中分数计入覆盖层加分', () => {
    const el = root(
      '<div class="popup-ad" style="position:fixed"><a href="https://spam.example.com/x?click_id=1"></a></div>',
    );
    const ads = findOverlayAds(el, {
      host: HOST,
      viewportArea: VIEWPORT,
      overlay: ctxFor({ 'popup-ad': BIG }),
    });
    // 'popup-ad' 切词为 ['popup','ad']，其中 'ad' 是强命名 → 6
    // 跨站链接 4 + 推广参数 2 + 覆盖层加分 4 = 16
    assert.equal(ads[0]!.hit.score, 16, JSON.stringify(ads[0]!.hit));
  });
});
