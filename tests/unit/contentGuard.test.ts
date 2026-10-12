import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBSTANTIVE_PARA_MIN,
  SUBSTANTIVE_TEXT_MIN,
  createJudge,
  findLinkFarms,
  hasContentMarker,
  hasSubstantiveText,
  holdsRealContent,
  isInsideNavigation,
  isNavigationLike,
  mustNotHide,
} from '../../src/content/engine.ts';

/**
 * 内容守卫 —— 「正文/导航被成片误杀」的根因修复（用户报告 xchina.co）。
 *
 * ## 事故
 *
 * 原先 `holdsRealContent` 只认 schema.org 的文章标记
 * （`article[itemprop]` / `[itemprop="articleBody"]` / `main article`）。
 * 那是**针对试点站调的** —— 它恰好带这些标注。换成普通站点，
 * `<div class="content">`、`<nav>`、`<ul class="menu">`、纯 `<p>` 段落
 * 一律不被保护，守卫形同虚设。
 *
 * ## 修复的分层（关键设计）
 *
 *   - 语义标记 = 直接证据 → **绝对保护**（任何证据都推翻不了）
 *   - 文字量   = 代理指标 → **强先验**：弱命名与纯行为证据不得隐藏，
 *                但强命名（`.ad-slot` 之类）可以
 *
 * 这样既堵住成片误杀，又没有放弃「带文字的广告位」这一类。
 */

const HOST = 'www.example.com';

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

/** 造一段够长的文字（必须真的超过门槛，否则测的是别的东西）。 */
const prose = (n = SUBSTANTIVE_TEXT_MIN + 60): string => {
  const base = '这是一段用于测试的正文内容，用来模拟真实文章里的段落文字。';
  let out = '';
  while (out.length < n) out += base;
  return out.slice(0, n);
};

const judge = () => createJudge(() => true, HOST, 1600 * 900);

describe('hasContentMarker：语义标记（绝对保护）', () => {
  it('只认 schema.org 的文章标注', () => {
    assert.equal(hasContentMarker(root('<article itemprop="articleBody"></article>')), true);
    assert.equal(hasContentMarker(root('<main><article></article></main>')), true);
    assert.equal(
      hasContentMarker(root('<article itemtype="https://schema.org/BlogPosting"></article>')),
      true,
    );
    // ❗普通站点的正文容器**不是**语义标记 —— 这正是原先的漏洞
    assert.equal(hasContentMarker(root('<div class="content"><p>正文</p></div>')), false);
    assert.equal(hasContentMarker(root('<nav><ul><li>首页</li></ul></nav>')), false);
  });
});

describe('hasSubstantiveText：实质文字量（强先验）', () => {
  it('文字量达到门槛 → 视为有内容', () => {
    assert.equal(hasSubstantiveText(root(`<div>${prose()}</div>`)), true);
  });

  it('两个像样的段落 → 视为有内容', () => {
    const p = 'x'.repeat(SUBSTANTIVE_PARA_MIN + 5);
    assert.equal(hasSubstantiveText(root(`<div><p>${p}</p><p>${p}</p></div>`)), true);
  });

  it('一个段落不够（避免把广告文案当正文）', () => {
    const p = 'x'.repeat(SUBSTANTIVE_PARA_MIN + 5);
    assert.equal(hasSubstantiveText(root(`<div><p>${p}</p></div>`)), false);
  });

  it('短文案不算内容（广告典型的文字量）', () => {
    assert.equal(hasSubstantiveText(root('<div class="ad">立即购买 限时优惠</div>')), false);
  });

  it('少量短段落不算内容', () => {
    assert.equal(hasSubstantiveText(root('<div><p>广告</p><p>点击这里</p></div>')), false);
  });
});

describe('holdsRealContent：语义标记或实质文字量', () => {
  it('❗普通站点的正文容器被保护（原漏洞的回归）', () => {
    assert.equal(holdsRealContent(root(`<div class="content">${prose()}</div>`)), true);
    assert.equal(holdsRealContent(root(`<div class="post-body"><p>${prose()}</p></div>`)), true);
  });

  it('❗导航列表被结构性保护（短标签达不到文字门槛）', () => {
    const items = Array.from({ length: 12 }, (_, i) => `<li><a href="/c/${i}">分类${i}</a></li>`).join('');
    const nav = root(`<nav><ul>${items}</ul></nav>`).firstElementChild!;
    // 12 项导航合计才 ~40 字，靠文字量保护不住 —— 必须靠 nav 这个显式声明
    assert.equal(hasSubstantiveText(nav), false, '前提：文字量确实不够');
    assert.equal(mustNotHide(nav), true, 'nav 是显式声明的导航 → 绝对保护');
    assert.equal(isNavigationLike(nav), true);
    assert.equal(isInsideNavigation(nav.querySelector('li')!), true, '导航内部也受保护');
  });

  it('对照：同样文字量的普通 div 不被结构性保护', () => {
    const items = Array.from({ length: 12 }, (_, i) => `<a href="/c/${i}">分类${i}</a>`).join('');
    const div = root(`<div class="links">${items}</div>`).firstElementChild!;
    assert.equal(mustNotHide(div), false, '普通容器不能因为"像导航"就被保护');
  });

  it('空壳 / 纯图片广告容器不被保护（否则广告就拦不住了）', () => {
    assert.equal(holdsRealContent(root('<div class="ad-slot"></div>')), false);
    assert.equal(holdsRealContent(root('<div class="ad-slot"><img src="/a.gif"></div>')), false);
  });
});

describe('createJudge：弱证据不得隐藏带实质文字的块', () => {
  it('❗弱命名 banner + 跨站链接 + 大量文字 → 不隐藏（原先会被误杀）', () => {
    const el = root(
      `<div class="banner"><a href="https://a1.com/x">a1</a><a href="https://a2.com/x">a2</a><p>${prose()}</p></div>`,
    ).firstElementChild!;
    document.body.appendChild(el);
    assert.equal(judge()(el), null, '文字量大的块不能靠弱命名+行为隐藏');
  });

  it('❗强命名 ad-slot + 大量文字 → 仍然隐藏（命名是显式证据）', () => {
    const el = root(`<div class="ad-slot"><p>${prose()}</p></div>`).firstElementChild!;
    document.body.appendChild(el);
    assert.notEqual(judge()(el), null, '强命名可以推翻文字量这个代理指标');
  });

  it('❗对照：弱命名 + 跨站链接 + 短文字 → 照常隐藏（广告检出未放弃）', () => {
    const el = root(
      '<div class="banner"><a href="https://a1.com/x">a1</a><a href="https://a2.com/x">a2</a>立即抢购</div>',
    ).firstElementChild!;
    document.body.appendChild(el);
    const hit = judge()(el);
    assert.notEqual(hit, null, '带少量文案的广告位仍应被拦');
  });
});

describe('findLinkFarms：链接墙不能连正文一起端掉', () => {
  const links = (hosts: string[]): string =>
    hosts.map((h) => `<a href="https://${h}/x">${h}</a>`).join('');

  it('❗带实质文字的链接块不算农场（导航/索引页的形状）', () => {
    const doc = root(
      `<div>${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}<p>${prose()}</p></div>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), [], '带正文的块不能被当成链接农场');
  });

  it('❗导航里的链接块不算农场（即使全是外链）', () => {
    const doc = root(
      `<nav>${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</nav>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), [], '导航是页面骨架，不能当链接农场端掉');
  });

  it('对照：纯链接墙（无文字）仍然判定为农场', () => {
    const doc = root(`<div id="farm">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</div>`);
    assert.equal(findLinkFarms(doc, { host: HOST }).length, 1);
  });
});
