import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJudge,
  isInsideNavigation,
  isNavigationLike,
} from '../../src/content/engine.ts';
import { CONTENT_CDN_MIN_USES, frequentMediaDomains } from '../../src/engine/domains.ts';
import { scoreNode } from '../../src/engine/score.ts';

/**
 * 用户报告 dgav40 视频页「视频窗口、导航栏、推荐栏也被屏蔽」后的加固回归。
 *
 * 三个根因/设计点：
 *   1. **跨站素材没有排除站点自己的内容 CDN** —— 任何脚本渲染的块只要有
 *      2 张以上 CDN 图片就够 6 分被隐藏（缩略图放 CDN 是全网做法）
 *   2. **含 `<video>` 的块**不靠弱证据隐藏
 *   3. **类名类导航标记不能向后代传播** —— 传播会命中 `.navbar-box` 这类
 *      页面级包装容器，把整页后代都"保护"起来，广告反而拦不住（实测 6 个测试挂掉）
 */

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

const judge = (opts: { contentCdnDomains?: Set<string> } = {}) =>
  createJudge(() => true, 'example.com', 1600 * 900, 6, opts.contentCdnDomains);

describe('❗内容 CDN 排除：缩略图放 CDN 不该被判成广告', () => {
  it('frequentMediaDomains：被 ≥3 个媒体元素使用的跨站域名算内容 CDN', () => {
    document.body.innerHTML = Array.from(
      { length: 5 },
      () => '<img src="https://cdn.example-cdn.net/t.jpg">',
    ).join('') + '<img src="https://ads.only-one.net/a.png">';
    const cdn = frequentMediaDomains(document.body, 'example.com');
    assert.ok(cdn.has('example-cdn.net'), '成片使用的域名应判为内容 CDN');
    assert.ok(!cdn.has('only-one.net'), '只用一次的域名不算（更像广告素材）');
    assert.equal(CONTENT_CDN_MIN_USES, 3);
  });

  it('❗来自内容 CDN 的素材不再产生行为分', () => {
    const el = root(
      '<div class="post-card"><img src="https://cdn.site.net/1.jpg"><img src="https://cdn.site.net/2.jpg"></div>',
    ).firstElementChild!;
    const without = scoreNode(el, { pageHost: 'example.com', viewportArea: 1600 * 900 });
    assert.equal(without.behavior, 6, '不排除时 2 张跨站图 = 6 分（就是原漏洞）');

    const withCdn = scoreNode(el, {
      pageHost: 'example.com',
      viewportArea: 1600 * 900,
      contentCdnDomains: new Set(['site.net']),
    });
    assert.equal(withCdn.behavior, 0, '排除内容 CDN 后不该有分');
    assert.ok(withCdn.reasons.includes('content-cdn-media'));
  });

  it('❗对照：广告素材域名仍照常计分', () => {
    const el = root(
      '<div class="post-card"><img src="https://ads.network-a.net/1.jpg"><img src="https://ads.network-b.net/2.png"></div>',
    ).firstElementChild!;
    const r = scoreNode(el, {
      pageHost: 'example.com',
      viewportArea: 1600 * 900,
      contentCdnDomains: new Set(['site.net']),
    });
    assert.equal(r.behavior, 6, '不在内容 CDN 集合里的素材照常计分');
  });

  it('❗推荐栏形状（脚本渲染 + 多张 CDN 缩略图）不再被隐藏', () => {
    const el = root(
      '<div class="recommend-list"><a href="/v/1"><img src="https://cdn.site.net/1.jpg"></a>' +
        '<a href="/v/2"><img src="https://cdn.site.net/2.jpg"></a></div>',
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.equal(
      judge({ contentCdnDomains: new Set(['site.net']) })(el),
      null,
      '推荐栏不该被判成广告（原漏洞：2 张 CDN 图 = 6 分）',
    );
  });
});

describe('❗含 <video> 的块不靠弱证据隐藏（视频窗口）', () => {
  it('弱证据 + video → 不隐藏', () => {
    const el = root(
      '<div class="banner-wrapper"><video src="https://cdn.site.net/v.mp4"></video><a href="https://a1.com/x">1</a><a href="https://a2.com/x">2</a></div>',
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.equal(judge()(el), null, '播放器容器不该被弱证据判成广告');
  });

  it('❗但带广告强命名的视频位仍然隐藏（验收第 10/13/14 条）', () => {
    const el = root(
      '<div class="ad-slot"><video src="https://cdn.site.net/v.mp4"></video></div>',
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.notEqual(judge()(el), null, '强命名可以推翻视频保护');
  });
});

describe('❗导航保护：语义标记可传播，类名标记只保护自身', () => {
  it('语义 nav：自身与内部都受保护', () => {
    const nav = root('<nav><div class="inner"><a href="/x">首页</a></div></nav>').firstElementChild!;
    assert.equal(isNavigationLike(nav), true);
    assert.equal(isInsideNavigation(nav.querySelector('.inner')!), true, '语义标记应传播');
  });

  it('类名 navbar：自身受保护，但**不传播**给后代', () => {
    const box = root('<div class="navbar-box"><div class="inner"><a href="/x">首页</a></div></div>')
      .firstElementChild!;
    assert.equal(isNavigationLike(box), true, '类名导航自身应受保护（用户报告的场景）');
    assert.equal(
      isInsideNavigation(box.querySelector('.inner')!),
      false,
      '❗类名标记绝不能传播：否则 .navbar-box 这类页面级容器会把整页后代都保护起来',
    );
  });

  it('页面级包装容器不会因为类名像导航就保护整页', () => {
    const wrap = root('<div class="top-navbar"><div class="ad-slot"></div></div>').firstElementChild!;
    const ad = wrap.querySelector('.ad-slot')!;
    assert.equal(isInsideNavigation(ad), false);
    assert.notEqual(judge()(ad), null, '包装容器内的广告仍应被拦');
  });
});
