import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSameBrand, registrableDomain, scoreNode } from '../../src/engine/score.ts';

/**
 * 误杀回归（2026-10-19，finance.sina.com.cn /realstock/company/sh688825/nc.shtml）：
 * 「大V观点」每条是「微博链接 + sinaimg 头像」，「投资研报」每条是「daxue.sina.cn 链接 +
 * z5.sinaimg.cn 配图」。两处都属于同一发布方（sina）的不同域名，但当时被判成跨站：
 * 跨站链接 4 分 + 跨站素材 3 分 = 7 ≥ 阈值 6，整条内容被隐藏。
 *
 * 根因有两层：registrableDomain 把 com.cn 当普通后缀（finance.sina.com.cn → com.cn），
 * 而 isSameBrand 只认"带数字的镜像域名"，认不出同一家的 sina.cn / sinaimg.cn。
 */

function el(html: string): Element {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box.firstElementChild!;
}

describe('registrableDomain：两段式公共后缀', () => {
  it('com.cn 取三段', () => {
    assert.equal(registrableDomain('finance.sina.com.cn'), 'sina.com.cn');
    assert.equal(registrableDomain('www.sina.com.cn'), 'sina.com.cn');
  });

  it('其它常见两段式后缀', () => {
    assert.equal(registrableDomain('news.bbc.co.uk'), 'bbc.co.uk');
    assert.equal(registrableDomain('a.b.com.hk'), 'b.com.hk');
  });

  it('普通后缀与两段域名不变', () => {
    assert.equal(registrableDomain('example.com'), 'example.com');
    assert.equal(registrableDomain('sina.cn'), 'sina.cn');
    assert.equal(registrableDomain('sub.example.com'), 'example.com');
  });

  it('IP 字面量原样返回（仍是已知的粗糙处理）', () => {
    assert.equal(registrableDomain('54.169.219.76'), '54.169.219.76');
  });
});

describe('isSameBrand：同一发布方的不同域名', () => {
  it('同一品牌、不同公共后缀（sina.com.cn / sina.cn）', () => {
    assert.equal(isSameBrand('finance.sina.com.cn', 'daxue.sina.cn'), true);
    assert.equal(isSameBrand('finance.sina.com.cn', 'www.sina.cn'), true);
  });

  it('品牌 + 素材后缀（sinaimg / sohuimg）', () => {
    assert.equal(isSameBrand('finance.sina.com.cn', 'z5.sinaimg.cn'), true);
    assert.equal(isSameBrand('finance.sina.com.cn', 'tvax2.sinaimg.cn'), true);
    assert.equal(isSameBrand('www.sohu.com', 'z.sohuimg.com'), true);
    // 品牌不足 4 个字母时不做同门推断（qq 只有两位，宁可按跨站处理）
    assert.equal(isSameBrand('www.qq.com', 'img.qqstatic.com'), false);
  });

  it('借用了品牌但不是素材域名的广告域名仍算跨站', () => {
    assert.equal(isSameBrand('finance.sina.com.cn', 'sinaads.cn'), false);
  });

  it('不同品牌、同后缀不同所有者都不算同门', () => {
    assert.equal(isSameBrand('finance.sina.com.cn', 'weibo.com'), false);
    assert.equal(isSameBrand('example.com', 'example.net'), false);
    assert.equal(isSameBrand('example.com', 'ads.example.net'), false);
    assert.equal(isSameBrand('sitea.com', 'siteb.com'), false);
  });

  it('带数字的镜像域名仍按既有规则视为同门', () => {
    assert.equal(isSameBrand('site1.com', 'site2.com'), true);
  });

  it('同注册域名仍是同门', () => {
    assert.equal(isSameBrand('a.example.com', 'b.example.com'), true);
  });
});

describe('scoreNode：新浪财经那类内容的分数应低于阈值', () => {
  const ctx = { pageHost: 'finance.sina.com.cn', viewportArea: 1920 * 1080 };

  it('微博链接 + sinaimg 头像 不再构成广告证据（0 分）', () => {
    const node = el(
      '<div><a href="https://weibo.com/u/1234">作者</a><img src="https://tvax2.sinaimg.cn/a.jpg"></div>',
    );
    const result = scoreNode(node, ctx);
    // 微博按社交平台处理（0 分），头像是同门素材（0 分）
    assert.equal(result.score, 0);
    assert.ok(result.reasons.includes('social-link'));
    assert.ok(result.reasons.includes('sibling-domain-media'));
    assert.ok(!result.reasons.includes('cross-site-link'));
    assert.ok(!result.reasons.includes('cross-site-media'));
  });

  it('sina.cn 链接 + sinaimg 配图 得 0 分', () => {
    const node = el(
      '<div><a href="https://daxue.sina.cn/x">研报</a><img src="https://z5.sinaimg.cn/a.jpg"></div>',
    );
    assert.equal(scoreNode(node, ctx).score, 0);
  });

  it('真正的跨站广告（第三方链接 + 第三方素材）仍然达标', () => {
    const node = el(
      '<div><a href="https://ads.example.com/a">a</a><img src="https://img.adnet.example/b.jpg"></div>',
    );
    assert.ok(scoreNode(node, ctx).score >= 6);
  });

  it('微博链接按社交平台处理，不计跨站分（每条大V发言有两个）', () => {
    const node = el(
      `<div>${'正文'.repeat(30)}
        <a href="https://weibo.com/u/1">作者</a>
        <a href="https://weibo.com/u/1/status/2">详情</a>
        <img src="https://tvax2.sinaimg.cn/a.jpg">
      </div>`,
    );
    const result = scoreNode(node, ctx);
    assert.equal(result.score, 0);
    assert.ok(result.reasons.includes('social-link'));
    assert.ok(!result.reasons.includes('cross-site-link'));
  });
});
