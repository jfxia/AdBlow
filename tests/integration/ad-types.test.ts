import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OVERLAY_CONTAINER_COVERAGE,
  OVERLAY_CONTAINER_MIN_RATIO,
  findFakeCloseAds,
  isOverlay,
  judgeGrownElement,
  looksLikeCloseControl,
  type JudgeOptions,
  type OverlayContext,
} from '../../src/content/engine.ts';
import { namingSignal, NAMING_STRONG, NAMING_WEAK } from '../../src/engine/lexicon.ts';

// Regression coverage for the 21 disruptive-ad acceptance items: each describe maps
// to one case that used to slip through on real sites.

const HOST = 'www.example.com';
const VIEWPORT = 1280 * 900;

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

function optionsFor(host = HOST): JudgeOptions {
  return {
    injected: () => false,
    host,
    viewportArea: VIEWPORT,
    selectors: { curated: [], learned: [] },
  };
}

describe('词库：视频广告行业术语（验收第 10/11/12 条）', () => {
  it('outstream / instream 判为强命名', () => {
    for (const cls of ['outstream-video', 'instream-player', 'video-outstream']) {
      assert.equal(namingSignal(root(`<div class="${cls}"></div>`).firstElementChild!).strength, NAMING_STRONG, cls);
    }
  });

  it('IAB 协议名 vast / vmap / vpaid 判为强命名', () => {
    for (const cls of ['vast-ad', 'vmap-container', 'vpaid-slot']) {
      assert.equal(namingSignal(root(`<div class="${cls}"></div>`).firstElementChild!).strength, NAMING_STRONG, cls);
    }
  });

  it('sticky 只作为弱命名（粘性页头也会用这个词）', () => {
    assert.equal(namingSignal(root('<div class="sticky"></div>').firstElementChild!).strength, NAMING_WEAK);
    // Weak words don't stack: sticky + bottom + banner all weak, total stays weak.
    assert.equal(
      namingSignal(root('<div class="sticky-bottom-banner"></div>').firstElementChild!).strength,
      NAMING_WEAK,
      '弱词不会因为数量多而升级为强命名',
    );
  });

  it('❗刻意不收录 overlay / video（会误伤正常对话框与播放器）', () => {
    assert.equal(
      namingSignal(root('<div class="modal-overlay"></div>').firstElementChild!).strength,
      0,
      'overlay 是合法对话框通用类名，不能收',
    );
    assert.equal(
      namingSignal(root('<div class="video"></div>').firstElementChild!).strength,
      0,
      'video 会命中所有播放器，不能收',
    );
  });
});

describe('judgeGrownElement：展开型广告（验收第 8/14/18/21 条）', () => {
  it('撑大后带跨站链接 + 跨站素材 → 隐藏（不要求证明脚本注入）', () => {
    const el = root(
      `<div style="position:fixed"><a href="https://ads.example.net/x"><img src="https://ads.example.net/b.png"></a></div>`,
    ).firstElementChild!;
    const verdict = judgeGrownElement(el, optionsFor());
    assert.ok(verdict, '几何突增 + 跨站证据应当判定为广告');
    assert.equal(verdict!.kind, 'heuristic');
    assert.ok(
      verdict!.kind === 'heuristic' && verdict!.hit.reasons.includes('geometry-growth'),
      '理由里应标注几何突增',
    );
  });

  it('❗产出的 hit 不带 selector —— 几何是瞬时证据，不能固化成永久规则', () => {
    const el = root(
      `<div style="position:fixed"><a href="https://ads.example.net/x"></a></div>`,
    ).firstElementChild!;
    const verdict = judgeGrownElement(el, optionsFor());
    assert.ok(verdict && verdict.kind === 'heuristic');
    assert.equal(verdict!.kind === 'heuristic' ? verdict!.hit.selector : 'x', null);
  });

  it('撑大但只有弱命名、无其它证据 → 仍算（弱命名即达标）', () => {
    const el = root('<div class="sticky" style="position:fixed"></div>').firstElementChild!;
    assert.ok(judgeGrownElement(el, optionsFor()));
  });

  it('❗撑大但毫无证据 → 不隐藏（误伤守卫）', () => {
    const el = root('<div class="panel" style="position:fixed"><p>说明文字</p></div>').firstElementChild!;
    assert.equal(judgeGrownElement(el, optionsFor()), null);
  });

  it('❗撑大但内部装着正文 → 绝不隐藏', () => {
    const el = root(
      `<div style="position:fixed"><article itemtype="http://schema.org/BlogPosting"></article></div>`,
    ).firstElementChild!;
    assert.equal(judgeGrownElement(el, optionsFor()), null);
  });

  it('已隐藏的元素不再重复判定', () => {
    // Value must be '1' — that is what hideElement writes; an empty value isn't "hidden".
    const el = root(
      `<div data-adblow-hidden="1"><a href="https://ads.example.net/x"></a></div>`,
    ).firstElementChild!;
    assert.equal(judgeGrownElement(el, optionsFor()), null);
  });
});

describe('isOverlay：播放器内叠加层（验收第 13 条）', () => {
  const overlayCtx = (sizes: Record<string, { width: number; height: number }>): OverlayContext => ({
    viewportArea: VIEWPORT,
    styleOf: (el) => ({
      position: (el.getAttribute('style') ?? '').includes('absolute') ? 'absolute' : 'static',
      zIndex: el.getAttribute('data-z') ?? '1000',
      opacity: '1',
      backgroundColor: 'rgb(0, 0, 0)',
      visibility: 'visible',
    }),
    rectOf: (el) => sizes[el.getAttribute('data-k') ?? ''] ?? null,
  });

  it('盖住含 <video> 的祖先 → 判为覆盖层（按视口算不到 40% 也能命中）', () => {
    const doc = root(
      `<div data-k="player" style="position:relative"><video></video>
         <div data-k="layer" style="position:absolute"></div></div>`,
    );
    const layer = doc.querySelector('[data-k="layer"]')!;
    const ctx = overlayCtx({ layer: { width: 640, height: 360 }, player: { width: 640, height: 360 } });
    assert.equal(isOverlay(layer, ctx), true);
  });

  it('❗祖先里没有 <video> → 不按这条判据命中（避免误伤轮播图/卡片图）', () => {
    const doc = root(
      `<div data-k="carousel" style="position:relative"><img src="/a.png">
         <div data-k="layer" style="position:absolute"></div></div>`,
    );
    const layer = doc.querySelector('[data-k="layer"]')!;
    const ctx = overlayCtx({ layer: { width: 640, height: 360 }, carousel: { width: 640, height: 360 } });
    assert.equal(isOverlay(layer, ctx), false);
  });

  it('❗只盖住容器一小部分 → 不命中', () => {
    const doc = root(
      `<div data-k="player" style="position:relative"><video></video>
         <div data-k="layer" style="position:absolute"></div></div>`,
    );
    const layer = doc.querySelector('[data-k="layer"]')!;
    const ctx = overlayCtx({ layer: { width: 100, height: 60 }, player: { width: 900, height: 600 } });
    assert.equal(isOverlay(layer, ctx), false);
  });

  it('❗所在容器太小（占视口不到 8%）→ 不命中，避免为角落小控件触发', () => {
    const doc = root(
      `<div data-k="player" style="position:relative"><video></video>
         <div data-k="layer" style="position:absolute"></div></div>`,
    );
    const layer = doc.querySelector('[data-k="layer"]')!;
    // 200x150 = 30000 / 1152000, about 2.6% of the viewport — below the 8% floor.
    const ctx = overlayCtx({ layer: { width: 200, height: 150 }, player: { width: 200, height: 150 } });
    assert.equal(isOverlay(layer, ctx), false);
  });

  it('阈值常量如实证记录', () => {
    assert.equal(OVERLAY_CONTAINER_COVERAGE, 0.8);
    assert.equal(OVERLAY_CONTAINER_MIN_RATIO, 0.08);
  });
});

describe('looksLikeCloseControl', () => {
  it('识别类名/属性里的 close / dismiss / 关闭', () => {
    for (const html of [
      '<a class="close-btn">×</a>',
      '<span id="dialog-close"></span>',
      '<button aria-label="Close"></button>',
      '<div aria-label="关闭"></div>',
      '<a title="close"></a>',
      '<a class="dismiss-btn"></a>',
    ]) {
      assert.equal(looksLikeCloseControl(root(html).firstElementChild!), true, html);
    }
  });

  it('识别关闭符号文本', () => {
    for (const t of ['×', '✕', '✖', 'x', 'X', '关闭']) {
      assert.equal(looksLikeCloseControl(root(`<a>${t}</a>`).firstElementChild!), true, t);
    }
  });

  it('普通元素不算', () => {
    assert.equal(looksLikeCloseControl(root('<a>下一步</a>').firstElementChild!), false);
  });
});

describe('findFakeCloseAds：伪装成关闭的跨站链接（验收第 16 条）', () => {
  it('❗小浮窗（占视口不到 40%）也能被抓住 —— 靠"关闭控件却是跨站链接"', () => {
    const doc = root(
      `<div class="page-wrap"><div class="fake-close-modal" style="position:fixed;z-index:9999">
         <img src="https://ads.example.net/b.png" width="420" height="280">
         <a class="close-btn" href="https://ads.example.net/landed" style="position:absolute">✕</a>
       </div></div>`,
    );
    const found = findFakeCloseAds(doc, { host: HOST });
    assert.equal(found.length, 1);
    assert.equal(
      found[0]!.element.getAttribute('class'),
      'fake-close-modal',
      '必须选中广告浮窗本身，而不是外层无关的包裹层',
    );
    assert.ok(found[0]!.hit.reasons.includes('fake-close-cross-site'));
  });

  it('❗真正的关闭按钮（同站链接或非链接）不触发', () => {
    const sameSite = root(
      `<div class="modal" style="position:fixed"><a class="close-btn" href="/close">×</a></div>`,
    );
    assert.deepEqual(findFakeCloseAds(sameSite, { host: HOST }), []);

    const notLink = root('<div class="modal" style="position:fixed"><span class="close-btn">×</span></div>');
    assert.deepEqual(findFakeCloseAds(notLink, { host: HOST }), []);
  });

  it('❗祖先装着正文时停手（宁可漏，不可误伤内容）', () => {
    const doc = root(
      `<article itemtype="http://schema.org/BlogPosting">
         <a class="close-btn" href="https://ads.example.net/x">×</a>
       </article>`,
    );
    assert.deepEqual(findFakeCloseAds(doc, { host: HOST }), []);
  });

  it('同一容器只返回一次（重复的关闭控件不会重复隐藏）', () => {
    const doc = root(
      `<div class="modal" style="position:fixed">
         <a class="close-btn" href="https://a.example.net/1">×</a>
         <a class="close-btn" href="https://b.example.net/2">×</a>
       </div>`,
    );
    assert.equal(findFakeCloseAds(doc, { host: HOST }).length, 1);
  });

  it('已隐藏的不再返回', () => {
    const doc = root(
      `<div class="modal" data-adblow-hidden style="position:fixed">
         <a class="close-btn" href="https://ads.example.net/x">×</a>
       </div>`,
    );
    assert.deepEqual(findFakeCloseAds(doc, { host: HOST }), []);
  });
});
