import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNode, type ScoreContext } from '../../src/engine/score.ts';

const ctx: ScoreContext = { pageHost: 'afford.gjvrohros.cc', viewportArea: 1920 * 1080 };

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('scoreNode：命名证据', () => {
  it('站点取证标记直接高分', () => {
    const r = scoreNode(el('<div data-ssp-sdk-popup-overlay></div>'), ctx);
    assert.ok(r.score >= 6, `score=${r.score}`);
    assert.ok(r.reasons.includes('ssp-marker'), JSON.stringify(r.reasons));
    assert.equal(r.behavior, 0, '命名证据不应混进行为分');
  });

  it('强广告命名直接高分', () => {
    const r = scoreNode(el('<article class="ad-item"></article>'), ctx);
    assert.equal(r.naming, 6);
    assert.ok(r.reasons.includes('ad-naming'), JSON.stringify(r.reasons));
  });

  it('弱广告命名只给低分（需旁证）', () => {
    const r = scoreNode(el('<div class="horizontal-banner"></div>'), ctx);
    assert.equal(r.naming, 2);
    assert.ok(r.reasons.includes('ad-naming-weak'), JSON.stringify(r.reasons));
  });

  it('命名分与行为分可分离，判定层才能分档处理', () => {
    // Server-rendered ad card: naming is definite evidence, behaviour only supporting.
    const r = scoreNode(
      el('<article class="ad-item"><a href="https://spam.example.com/x"></a></article>'),
      ctx,
    );
    assert.equal(r.naming, 6);
    assert.equal(r.behavior, 4);
    assert.equal(r.score, 10);
  });

  it('正文 article 零分', () => {
    const r = scoreNode(
      el('<article itemscope itemtype="http://schema.org/BlogPosting"><a href="/archives/1/"><h2>t</h2></a></article>'),
      ctx,
    );
    assert.equal(r.score, 0);
    assert.equal(r.naming, 0);
    assert.equal(r.behavior, 0);
  });
});

describe('scoreNode：行为证据', () => {
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
    // The pilot site lazy-loads via loadBannerDirect + data-src, so checking src alone misses it.
    const r = scoreNode(el('<img src="/local.png" data-src="https://ads.example.com/a.png">'), ctx);
    assert.ok(r.reasons.includes('cross-site-media'), JSON.stringify(r.reasons));
  });
});

describe('scoreNode 的聚合结构约束（2026-10-10 实测标定）', () => {
  // An early version aggregated cross-site links across the whole subtree, so <html> scored 20,
  // <body> 20 and <footer> 12 — the bigger the box, the higher the score, wiping entire pages.

  it('紧凑盒子里的跨站链接计入（小而密的外链盒子确实是广告形态）', () => {
    const r = scoreNode(el('<div class="x"><a href="https://spam.example.com/a"></a></div>'), ctx);
    assert.equal(r.behavior, 4, JSON.stringify(r.reasons));
  });

  it('后代超过 12 个元素时，后代信号被忽略（大容器不是广告）', () => {
    const filler = '<i></i>'.repeat(15);
    const r = scoreNode(
      el(`<div class="x">${filler}<a href="https://spam.example.com/a?click_id=1"></a></div>`),
      ctx,
    );
    assert.equal(r.behavior, 0, `大容器不应累加子树信号，reasons=${JSON.stringify(r.reasons)}`);
  });

  it('大容器自身若带命名证据仍然高分（自身信号不受紧凑度影响）', () => {
    const filler = '<i></i>'.repeat(200);
    const r = scoreNode(el(`<div data-ssp-slot-root>${filler}</div>`), ctx);
    assert.equal(r.naming, 6);
    assert.equal(r.score, 6);
  });
  it('容器规模可调，便于按站点标定', () => {
    const filler = '<i></i>'.repeat(15);
    const html = `<div>${filler}<a href="https://spam.example.com/a"></a></div>`;
    assert.equal(scoreNode(el(html), { ...ctx, compactMax: 100 }).behavior, 4);
    assert.equal(scoreNode(el(html), { ...ctx, compactMax: 5 }).behavior, 0);
  });
});

describe('scoreNode：iframe 信号（不依赖命名）', () => {
  it('跨站 iframe 计入行为分', () => {
    const r = scoreNode(el('<iframe src="https://ads.example.com/f"></iframe>'), ctx);
    assert.equal(r.behavior, 4);
    assert.ok(r.reasons.includes('cross-site-iframe'), JSON.stringify(r.reasons));
  });

  it('跨站 iframe 单独**不足以**判定（视频/地图/评论都是跨站 iframe）', () => {
    const r = scoreNode(el('<iframe src="https://www.youtube.com/embed/x"></iframe>'), ctx);
    assert.ok(r.behavior < 6, `behavior=${r.behavior}，不应单独过阈值`);
  });

  it('srcdoc / about:blank 的 iframe 是脚本注入内容的常见载体', () => {
    const r = scoreNode(el('<iframe srcdoc="<p>x</p>"></iframe>'), ctx);
    assert.equal(r.behavior, 2);
    assert.ok(r.reasons.includes('inline-iframe'), JSON.stringify(r.reasons));
  });

  it('同站 iframe 不加分', () => {
    const r = scoreNode(el('<iframe src="/local/frame"></iframe>'), ctx);
    assert.equal(r.behavior, 0);
  });

  it('跨站 iframe + 推广链接一起才过阈值（典型的广告位形态）', () => {
    const r = scoreNode(
      el('<div><iframe src="https://ads.example.com/f"></iframe><a href="https://spam.example.com/x?click_id=1"></a></div>'),
      ctx,
    );
    assert.ok(r.behavior >= 6, `behavior=${r.behavior}`);
  });
});

describe('scoreNode：覆盖层**不参与**逐元素打分（架构约束）', () => {
  // Overlay judging used to live inside scoreNode, so every element needed getComputedStyle
  // while the scan kept mutating inline styles; the two invalidated each other and a full scan
  // of a large page like 1024cg never finished (styles injected, nothing hidden). Overlays are
  // now a separate pass — findOverlayAds in src/content/engine.ts.
  it('scoreNode 的结果不受定位样式影响', () => {
    const r = scoreNode(el('<div class="horizontal-banner"></div>'), ctx);
    assert.ok(!r.reasons.includes('overlay'), '覆盖层不应再出现在打分理由里');
  });
});

