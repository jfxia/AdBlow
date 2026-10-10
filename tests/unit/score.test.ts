import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNode, type ScoreContext } from '../../src/engine/score.ts';

const ctx: ScoreContext = { pageHost: 'afford.gjvrohros.cc', viewportArea: 1920 * 1080 };

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('scoreNode', () => {
  it('SSP 注入标记直接高分', () => {
    const r = scoreNode(el('<div data-ssp-sdk-popup-overlay></div>'), ctx);
    assert.ok(r.score >= 6, `score=${r.score}`);
    assert.ok(r.reasons.includes('ssp-marker'), JSON.stringify(r.reasons));
  });

  it('跨可注册域名的出站链接加分（元素自身即链接）', () => {
    const r = scoreNode(
      el('<a href="https://spam.example.com/landing?click_id=1"><img src="/a.png"></a>'),
      ctx,
    );
    assert.ok(r.reasons.includes('cross-site-link'), JSON.stringify(r.reasons));
  });

  it('推广参数加分', () => {
    const r = scoreNode(
      el('<a href="https://afford.gjvrohros.cc/x?utm_source=ad&channel=tg"></a>'),
      ctx,
    );
    assert.ok(r.reasons.includes('promo-params'), JSON.stringify(r.reasons));
  });

  it('同源普通正文链接不加分', () => {
    const r = scoreNode(el('<a href="/archives/137924/"><h2>帖子标题</h2></a>'), ctx);
    assert.equal(r.score, 0);
  });

  it('跨站图片加分（元素自身即图片）', () => {
    const r = scoreNode(el('<img src="https://pic.wvxrrip.cn/upload_01/xiao/a.jpeg">'), ctx);
    assert.ok(r.reasons.includes('cross-site-media'), JSON.stringify(r.reasons));
  });

  it('data-src 懒加载图片同样计入跨站媒体', () => {
    // 试点站用 loadBannerDirect + data-src 懒加载，只认 src 会漏
    const r = scoreNode(el('<img src="/local.png" data-src="https://ads.example.com/a.png">'), ctx);
    assert.ok(r.reasons.includes('cross-site-media'), JSON.stringify(r.reasons));
  });

  it('正文 <article> 不加分', () => {
    const r = scoreNode(
      el('<article itemscope itemtype="http://schema.org/BlogPosting"><a href="/archives/1/"><h2>t</h2></a></article>'),
      ctx,
    );
    assert.equal(r.score, 0);
  });
});

describe('scoreNode 的聚合结构约束（2026-10-10 实测标定）', () => {
  // 早期版本对整棵子树无条件聚合跨站链接，导致 <html> 得 20 分、<body> 20 分、
  // <footer> 12 分——盒子越大分越高，一过阈值就是整页消失。

  it('紧凑盒子里的跨站链接计入（小而密的外链盒子确实是广告形态）', () => {
    const r = scoreNode(el('<div class="x"><a href="https://spam.example.com/a"></a></div>'), ctx);
    assert.equal(r.score, 4, JSON.stringify(r.reasons));
  });

  it(`后代超过 ${12} 个元素时，后代信号被忽略（大容器不是广告）`, () => {
    const filler = '<i></i>'.repeat(15);
    const r = scoreNode(
      el(`<div class="x">${filler}<a href="https://spam.example.com/a?click_id=1"></a></div>`),
      ctx,
    );
    assert.equal(r.score, 0, `大容器不应累加子树信号，reasons=${JSON.stringify(r.reasons)}`);
  });

  it('大容器自身若带 SSP 标记仍然高分（自身信号不受紧凑度影响）', () => {
    const filler = '<i></i>'.repeat(200);
    const r = scoreNode(el(`<div data-ssp-slot-root>${filler}</div>`), ctx);
    assert.equal(r.score, 6);
  });

  it('容器规模可调，便于按站点标定', () => {
    const filler = '<i></i>'.repeat(15);
    const html = `<div>${filler}<a href="https://spam.example.com/a"></a></div>`;
    assert.equal(scoreNode(el(html), { ...ctx, compactMax: 100 }).score, 4);
    assert.equal(scoreNode(el(html), { ...ctx, compactMax: 5 }).score, 0);
  });
});
