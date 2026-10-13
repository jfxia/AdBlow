import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildPristineIndexFromHtml } from '../../src/engine/pristine.ts';
import {
  isHidden,
  makeInjectionTest,
  processAdded,
  selectorsFrom,
  sweep,
  type JudgeOptions,
} from '../../src/content/engine.ts';

// Second-site regression (1024cg.com), filed after "filtering stopped working on another
// site". Two real defects: the lexicon's substring matching over a tiny word list missed
// `ad-item` / `ads-title` / `post-card-ads` / `id="ad-card-N"`, and the only judging tier
// was script injection while this site renders its ads into the server HTML — so no ad
// was caught. No site rule pack is loaded on purpose: the generic path is under test.

const HOST = '1024cg.com';
const fixture = readFileSync(new URL('../fixtures/1024cg-home.html', import.meta.url), 'utf8');
const DOMParserImpl = new JSDOM('').window.DOMParser;

const CONTENT = 'article[itemtype*="BlogPosting"]';
const CONTENT_CARD = 'div.post-card[id^="post-card-"]';
const AD_ITEM = 'article.ad-item';
const AD_CARD = 'div.post-card[id^="ad-card-"]';

const pristineIndex = buildPristineIndexFromHtml(fixture, new DOMParserImpl);

function freshDoc(): Document {
  return new JSDOM(fixture, { url: `https://${HOST}/` }).window.document;
}

/** No rule pack — generic path only. */
function options(reliable = true): JudgeOptions {
  return {
    injected: makeInjectionTest(pristineIndex, reliable),
    host: HOST,
    viewportArea: 1920 * 1080,
    selectors: selectorsFrom([], []),
  };
}

describe('第二站点：fixture 的广告与正文判据', () => {
  const doc = freshDoc();

  it('正文与广告数量符合取证结论', () => {
    assert.equal(doc.querySelectorAll(CONTENT).length, 20, '正文 article');
    assert.equal(doc.querySelectorAll(AD_ITEM).length, 21, '广告 article.ad-item');
    assert.equal(doc.querySelectorAll('[id^="ad-card-"]').length, 21, '广告位 id="ad-card-N"');
  });

  it('广告卡没有 BlogPosting 标记，正文有 —— 这是它们的关键区别', () => {
    for (const a of Array.from(doc.querySelectorAll(AD_ITEM))) {
      assert.equal(a.hasAttribute('itemtype'), false, '广告卡不应带 itemtype');
    }
    for (const a of Array.from(doc.querySelectorAll(CONTENT))) {
      assert.ok(a.hasAttribute('itemtype'));
    }
  });

  it('广告位的 ad 来自 id 而不是 class（易错点）', () => {
    const card = doc.querySelector(AD_CARD);
    assert.ok(card, 'fixture 里应当有 id="ad-card-N" 的广告位');
    assert.equal(card.getAttribute('class'), 'post-card', 'class 只有 post-card，没有 ad');
    assert.match(card.getAttribute('id') ?? '', /^ad-card-/);
  });
});

describe('第二站点：无规则包时通用路径必须拦住服务端渲染的广告', () => {
  it('21 个广告卡 article.ad-item 全部被隐藏', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, options());

    const ads = Array.from(doc.querySelectorAll(AD_ITEM));
    assert.equal(ads.length, 21);
    for (const a of ads) assert.ok(isHidden(a), '广告卡未被隐藏');
  });

  it('21 个广告位 div.post-card#ad-card-N 全部被隐藏', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, options());

    const slots = Array.from(doc.querySelectorAll(AD_CARD));
    assert.equal(slots.length, 21);
    for (const s of slots) assert.ok(isHidden(s), '广告位未被隐藏');
  });

  it('广告标题与广告遮罩被隐藏', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, options());

    for (const sel of ['.ads-title', '.post-card-ads']) {
      const els = Array.from(doc.querySelectorAll(sel));
      assert.ok(els.length > 0, `fixture 里应当有 ${sel}`);
      for (const e of els) assert.ok(isHidden(e), `${sel} 未被隐藏`);
    }
  });

  it('20 篇正文 article 一篇都没被隐藏（误伤守卫）', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, options());

    const contents = Array.from(doc.querySelectorAll(CONTENT));
    assert.equal(contents.length, 20);
    for (const c of contents) assert.ok(!isHidden(c), '正文 article 被误伤');
  });

  it('20 个正文卡片 div.post-card#post-card-N 一个都没被隐藏（误伤守卫）', () => {
    // Content and ads share a class and differ only by id prefix, so any rule keyed on
    // the class would wipe the content out too.
    const doc = freshDoc();
    sweep(doc.documentElement, options());

    const cards = Array.from(doc.querySelectorAll(CONTENT_CARD));
    assert.equal(cards.length, 20);
    for (const c of cards) assert.ok(!isHidden(c), '正文卡片被误伤');
  });

  it('页头页脚与站内文章链接不被误伤', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, options());

    for (const sel of ['header.no-banner-image', 'footer', 'a[href^="/archives/"]']) {
      const els = Array.from(doc.querySelectorAll(sel));
      assert.ok(els.length > 0, `fixture 里应当有 ${sel}`);
      for (const e of els) assert.ok(!isHidden(e), `${sel} 被误伤`);
    }
  });
});

describe('第二站点：命名档不依赖快照（架构修复的回归保护）', () => {
  it('快照不可信时，广告卡仍被拦住 —— 因为这靠命名而不是行为', () => {
    // This site's ads are server-rendered, so the behaviour-only tier (which requires
    // script injection) never applies — binding the naming tier to injection was the bug.
    const doc = freshDoc();
    sweep(doc.documentElement, options(false));

    for (const sel of [AD_ITEM, AD_CARD, '.ads-title']) {
      const els = Array.from(doc.querySelectorAll(sel));
      assert.ok(els.length > 0);
      for (const e of els) assert.ok(isHidden(e), `${sel} 在快照不可信时未被拦住`);
    }
  });

  it('快照不可信时，正文依然零误伤', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, options(false));

    for (const sel of [CONTENT, CONTENT_CARD, 'header.no-banner-image', 'footer']) {
      for (const e of Array.from(doc.querySelectorAll(sel))) {
        assert.ok(!isHidden(e), `${sel} 被误伤`);
      }
    }
  });

  it('纯行为档在快照不可信时确实关闭（新注入的推广盒子不被隐藏）', () => {
    const doc = freshDoc();
    const host = doc.createElement('div');
    host.innerHTML = '<div class="zzz-plain"><a href="https://spam.example.com/x?click_id=1"></a></div>';
    const promo = host.firstElementChild as Element;
    doc.body.appendChild(promo);

    const hits = processAdded(promo, options(false)).hits;
    assert.ok(!isHidden(promo), '快照不可信时纯行为档不得生效');
    assert.equal(hits.length, 0);
  });

  it('快照可信时，同样的推广盒子被拦住（对照）', () => {
    const doc = freshDoc();
    const host = doc.createElement('div');
    host.innerHTML = '<div class="zzz-plain"><a href="https://spam.example.com/x?click_id=1"></a></div>';
    const promo = host.firstElementChild as Element;
    doc.body.appendChild(promo);

    const hits = processAdded(promo, options(true)).hits;
    assert.ok(isHidden(promo), '快照可信时应当通过纯行为档拦住');
    assert.equal(hits.length, 1);
  });
});

describe('第二站点：弱命名需要旁证（避免误伤正常 UI）', () => {
  it('horizontal-banner 单独出现不足以判定', () => {
    const doc = freshDoc();
    const host = doc.createElement('div');
    host.innerHTML = '<div class="horizontal-banner"></div>';
    const el = host.firstElementChild as Element;
    doc.body.appendChild(el);

    assert.equal(processAdded(el, options(true)).hits.length, 0, '弱命名不该单独成立');
    assert.ok(!isHidden(el));
  });

  it('弱命名 + 跨站外链才成立', () => {
    const doc = freshDoc();
    const host = doc.createElement('div');
    host.innerHTML = '<div class="horizontal-banner"><a href="https://spam.example.com/a"></a></div>';
    const el = host.firstElementChild as Element;
    doc.body.appendChild(el);

    assert.equal(processAdded(el, options(true)).hits.length, 1);
    assert.ok(isHidden(el));
  });

  it('否定前缀让页头的 no-banner-image 逃过弱命名档', () => {
    const doc = freshDoc();
    const header = doc.querySelector('header.no-banner-image');
    assert.ok(header, 'fixture 里应当有 header.no-banner-image');
    assert.equal(processAdded(header, options(true)).hits.length, 0);
    assert.ok(!isHidden(header));
  });
});
