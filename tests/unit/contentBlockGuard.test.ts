import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEHAVIOR_ONLY_MAX_AREA_RATIO,
  BEHAVIOR_ONLY_MAX_MEDIA,
  createJudge,
  looksLikeContentBlock,
} from '../../src/content/engine.ts';

/**
 * 纯行为档的「内容区块」门槛 —— 用户报告 dgav40 播放器/推荐栏被过滤后的修复。
 *
 * ## 事故（用户在真实浏览器里确认）
 *
 * 关闭 AdBlow 过滤时页面正常；开启后**视频窗口、导航栏、推荐栏**被过滤。
 *
 * ## 机制
 *
 * 这两块都是**脚本运行时创建**的（`injected=true`），而它们的封面/视频流来自
 * 跨站 CDN，于是命中最弱的「纯行为证据」档（没有任何命名线索也隐藏）。
 *
 * ## 修法
 *
 * 没有命名证据时，广告的形态是"小、素材少"；又大又满是缩略图的块是内容：
 *   ① 面积占视口 > 25%
 *   ② 素材（img/picture/video/source/canvas）数量 > 2
 *   ③ 含 `<video>` / iframe / 播放器容器
 *
 * 判据只在**没有命名证据**时生效：带 `.ad-slot` 的整屏视频广告照旧拦得住
 * （验收第 10/13/14 条靠命名）。
 */

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

const judge = (viewportArea = 1600 * 900) =>
  createJudge(() => true, 'example.com', viewportArea, 6);

/** 让 jsdom 里的元素"有面积"（jsdom 不做布局，rect 恒为 0）。 */
function withSize(el: HTMLElement, w: number, h: number): HTMLElement {
  el.getBoundingClientRect = () =>
    ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return el;
}

const crossLinks = (n: number): string =>
  Array.from({ length: n }, (_, i) => `<a href="https://ads.a${i}.net/x">${i}</a>`).join('');

describe('looksLikeContentBlock：素材成片', () => {
  it(`素材数 > ${BEHAVIOR_ONLY_MAX_MEDIA} → 像内容区块`, () => {
    const three = root(`<div>${'<img src="/a.png">'.repeat(3)}</div>`).firstElementChild!;
    assert.equal(looksLikeContentBlock(three, 1600 * 900), true);

    const two = root(`<div>${'<img src="/a.png">'.repeat(2)}</div>`).firstElementChild!;
    assert.equal(looksLikeContentBlock(two, 1600 * 900), false, '1–2 张素材仍是广告形态');
  });

  it('含 video / 播放器容器 → 像内容区块', () => {
    assert.equal(
      looksLikeContentBlock(root('<div><video src="/v.mp4"></video></div>').firstElementChild!, 0),
      true,
    );
    assert.equal(
      looksLikeContentBlock(root('<div class="plyr-player"></div>').firstElementChild!, 0),
      true,
    );
    assert.equal(
      looksLikeContentBlock(
        root('<div><div class="player-box"></div></div>').firstElementChild!,
        0,
      ),
      true,
      '内部装着播放器容器也算',
    );
  });
});

describe('looksLikeContentBlock：面积', () => {
  it(`面积占视口 > ${BEHAVIOR_ONLY_MAX_AREA_RATIO} → 像内容区块`, () => {
    const big = withSize(root('<div></div>').firstElementChild as HTMLElement, 1400, 800);
    assert.equal(looksLikeContentBlock(big, 1600 * 900), true);
  });

  it('面积小的块不算内容区块（广告位通常紧凑）', () => {
    const small = withSize(root('<div></div>').firstElementChild as HTMLElement, 300, 250);
    assert.equal(looksLikeContentBlock(small, 1600 * 900), false);
  });

  it('viewportArea 为 0（未知）时不因面积判定', () => {
    const el = withSize(root('<div></div>').firstElementChild as HTMLElement, 1400, 800);
    assert.equal(looksLikeContentBlock(el, 0), false);
  });
});

describe('❗广告轮播不能被"素材成片"门槛放过', () => {
  const adImgs = (n: number): string =>
    Array.from({ length: n }, (_, i) => `<img src="https://ads.a${i}.net/x.png">`).join('');
  const contentImgs = (n: number): string =>
    Array.from({ length: n }, () => '<img src="https://content.cdn.net/t.jpg">').join('');

  it('3 张广告域素材的轮播（.streamer-box2 真实形态）→ 仍然隐藏', () => {
    // 2026-10-13：修完"播放器/推荐栏误杀"后用户反馈"广告图片并未被屏蔽"。
    // 运行时 DOM 显示站点把广告挂进 ul.streamer-box2，里面有 3 张广告图。
    // 只按"素材数 > 2 就放过"会把这种广告轮播当成内容列表漏掉。
    const el = root(
      `<ul class="streamer-box2">${adImgs(3)}${crossLinks(1)}</ul>`,
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.notEqual(judge()(el), null, '广告轮播必须仍被隐藏');
  });

  it('❗对照：同样数量但来自内容 CDN 的素材 → 仍然不隐藏', () => {
    const judgeWithCdn = createJudge(
      () => true,
      'example.com',
      1600 * 900,
      6,
      new Set(['cdn.net']),
    );
    const el = root(`<div class="zzz">${contentImgs(4)}${crossLinks(2)}</div>`).firstElementChild!;
    document.body.appendChild(el);
    assert.equal(judgeWithCdn(el), null, '内容 CDN 的成片素材仍是内容列表');
  });

  it('广告域素材再多也不构成"内容列表"（混入内容素材时才按内容算）', () => {
    const judgeWithCdn = createJudge(
      () => true,
      'example.com',
      1600 * 900,
      6,
      new Set(['cdn.net']),
    );
    const el = root(
      `<div class="zzz">${adImgs(10)}${crossLinks(2)}</div>`,
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.notEqual(judgeWithCdn(el), null, '10 张广告图不是内容列表');
  });
});

describe('❗createJudge 第③档：纯行为证据不得隐藏内容区块', () => {
  it('脚本创建 + 跨站链接 + 成片缩略图（推荐栏形状）→ 不隐藏', () => {
    const el = root(
      `<div class="pb-3">${crossLinks(2)}${'<img src="https://cdn.site.net/t.jpg">'.repeat(4)}</div>`,
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.equal(judge()(el), null, '推荐栏形状不该被纯行为档拦掉');
  });

  it('脚本创建 + 跨站链接 + 播放器容器（播放器形状）→ 不隐藏', () => {
    const el = root(`<div class="pb-3">${crossLinks(2)}<div class="player-wrap"></div></div>`)
      .firstElementChild!;
    document.body.appendChild(el);
    assert.equal(judge()(el), null, '播放器形状不该被纯行为档拦掉');
  });

  it('❗对照：紧凑的跨站推广盒子仍然拦得住（无命名）', () => {
    const el = root(`<div class="zzz">${crossLinks(2)}</div>`).firstElementChild!;
    document.body.appendChild(el);
    assert.notEqual(judge()(el), null, '纯行为档的基本能力不能丢');
  });

  it('❗对照：带强命名的大块视频广告仍然拦得住（命名是显式证据）', () => {
    const el = root(
      `<div class="ad-slot">${crossLinks(2)}<video src="https://cdn.a.net/v.mp4"></video></div>`,
    ).firstElementChild!;
    withSize(el as HTMLElement, 1400, 800);
    document.body.appendChild(el);
    assert.notEqual(judge()(el), null, '强命名必须可以推翻内容区块门槛（验收 10/13/14 条）');
  });
});
