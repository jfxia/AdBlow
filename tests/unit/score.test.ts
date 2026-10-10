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

  it('正文 <article> 不加分', () => {
    const r = scoreNode(
      el('<article itemscope itemtype="http://schema.org/BlogPosting"><a href="/archives/1/"><h2>t</h2></a></article>'),
      ctx,
    );
    assert.equal(r.score, 0);
  });
});
