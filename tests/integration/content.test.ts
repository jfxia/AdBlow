import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { buildPristineIndexFromHtml } from '../../src/engine/pristine.ts';
import { validateSitePack, type SitePack } from '../../src/engine/rules.ts';
import {
  isHidden,
  makeInjectionTest,
  processAdded,
  recordableSelector,
  selectorsFrom,
  sweep,
  type Hit,
  type JudgeOptions,
} from '../../src/content/engine.ts';
import { pilotPack } from '../../src/rules/sites/pilot.ts';

// End-to-end regression on a sanitised snapshot of a real page: the strongest sandbox
// check of the "zero ad residue, zero content damage" criterion — real DOM, real rule
// pack, real engine, real server snapshot, everything except the browser.

const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');
const HOST = 'afford.gjvrohros.cc';
const CONTENT = 'article[itemtype*="BlogPosting"]';
/**
 * Server-rendered recommendation images. These are not content thumbnails: all 10 belong
 * to the recommendation ad block, so hiding them is correct. Content thumbnails are loaded
 * dynamically from pic.wvxrrip.cn — see the dedicated case below.
 */
const RECOMMEND_IMG = 'img[data-src*="upload_01"]';

function freshDoc(): Document {
  return new JSDOM(fixture, { url: `https://${HOST}/category/jrxw1/` }).window.document;
}

/**
 * Builds judge options. With reliable=true the fixture itself doubles as the complete
 * server snapshot — exactly what the background backfill path delivers — and only then
 * may heuristics run (see content/engine.ts).
 */
function optionsFor(doc: Document, reliable = true): JudgeOptions {
  const index = buildPristineIndexFromHtml(fixture, new DOMParser());
  return {
    injected: makeInjectionTest(index, reliable),
    host: HOST,
    viewportArea: 1920 * 1080,
    selectors: selectorsFrom([pilotPack], []),
  };
}

/** processAdded returns {rule, hits}; only the hits matter here. */
function addHits(el: Element, options: JudgeOptions): Hit[] {
  return processAdded(el, options).hits;
}

function inject(doc: Document, html: string): Element {
  const host = doc.createElement('div');
  host.innerHTML = html;
  const el = host.firstElementChild!;
  doc.body.appendChild(el);
  return el;
}

describe('集成：真实 fixture 上的首屏清扫', () => {
  it('10 个广告占位符全部被隐藏', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, optionsFor(doc));

    const slots = Array.from(doc.querySelectorAll('[data-ssp-slot-node]'));
    assert.equal(slots.length, 10);
    for (const s of slots) assert.ok(isHidden(s), '广告占位符未被隐藏');
  });

  it('正文 article 一个都没有被隐藏（误伤守卫）', () => {
    const doc = freshDoc();
    const articles = Array.from(doc.querySelectorAll(CONTENT));
    assert.ok(articles.length > 0);

    sweep(doc.documentElement, optionsFor(doc));

    for (const a of articles) assert.ok(!isHidden(a), '正文 article 被误伤');
  });

  it('ssp-list 容器本身没有被隐藏（否则会连带抹掉正文列表）', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, optionsFor(doc));

    const container = doc.querySelector('[data-ssp-container="ssp-list"]');
    assert.ok(container);
    assert.ok(!isHidden(container), 'ssp-list 容器被隐藏了 —— 正文列表会一起消失');
  });

  it('跨站 CDN 的正文缩略图不被隐藏（误伤守卫，风险 A）', () => {
    // Careful: all 10 `img[data-src*="upload_01"]` images belong to the server-rendered
    // recommendation block and must be hidden (asserted below). The content thumbnail is
    // loaded dynamically from pic.wvxrrip.cn by a stripped inline script, so build one here.
    const doc = freshDoc();
    const article = doc.querySelector(CONTENT)!;
    const img = doc.createElement('img');
    img.setAttribute('src', '/usr/themes/Mirages/images/logo-thumb@3x.png');
    img.setAttribute('data-src', 'https://pic.wvxrrip.cn/upload_01/xiao/a.jpeg');
    article.appendChild(img);

    sweep(doc.documentElement, optionsFor(doc));

    assert.ok(!isHidden(img), 'pic.wvxrrip.cn 的正文缩略图被误伤 —— 这是风险 A');
    assert.ok(!isHidden(article), '正文 article 被误伤');
  });

  it('服务端渲染的推荐位图片被隐藏（它们是广告位，不是正文）', () => {
    const doc = freshDoc();
    const imgs = Array.from(doc.querySelectorAll(RECOMMEND_IMG));
    assert.ok(imgs.length > 0, 'fixture 里应当有推荐位图片');

    sweep(doc.documentElement, optionsFor(doc));

    for (const i of imgs) assert.ok(isHidden(i), '推荐位图片未被隐藏');
  });

  it('内容守卫：装着正文的容器绝不因命名被隐藏（事故回归保护）', () => {
    // Self-inflicted incident when the naming tier landed: `data-ssp-container="ssp-list"`
    // carried the `data-ssp-` marker, was scored as strong naming, and hid the whole list.
    const doc = freshDoc();
    const container = doc.querySelector('[data-ssp-container="ssp-list"]')!;
    assert.ok(container, '未找到 ssp-list 容器');

    sweep(doc.documentElement, optionsFor(doc));

    assert.ok(!isHidden(container), '装着正文的容器被命名档隐藏了 —— 正文列表会一起消失');
    assert.ok(
      container.querySelectorAll(CONTENT).length > 0,
      '该容器内应当确实有正文 article，否则这条测试没有意义',
    );
  });

  it('服务端渲染的合法外链盒子没有被隐藏（标定发现的高分元素）', () => {
    // These three reach 8 points on cross-site links and are only spared because the server
    // snapshot tells them apart from script-injected nodes — that is the regression here.
    const doc = freshDoc();
    sweep(doc.documentElement, optionsFor(doc));

    for (const sel of ['.contact-link', 'footer#footer', 'div.container']) {
      const els = Array.from(doc.querySelectorAll(sel));
      assert.ok(els.length > 0, `fixture 里应当有 ${sel}`);
      for (const e of els) assert.ok(!isHidden(e), `${sel} 被误伤（它是服务端渲染的）`);
    }
  });

  it('服务端渲染的推荐位被清掉', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, optionsFor(doc));

    for (const sel of [
      '.xqbj-recommand-item-banner',
      '.xqbj-component-ssp-horizontal-banner-widget',
    ]) {
      const els = Array.from(doc.querySelectorAll(sel));
      assert.ok(els.length > 0, `${sel} 在 fixture 中应当存在`);
      for (const e of els) assert.ok(isHidden(e), `${sel} 未被隐藏`);
    }
  });
});

describe('集成：脚本注入的动态内容', () => {
  it('SDK 注入的覆盖层被静态规则拦住', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const overlay = inject(doc, '<div data-ssp-sdk-popup-overlay></div>');

    const hits = addHits(overlay, options);
    assert.ok(isHidden(overlay), 'SDK 覆盖层未被隐藏');
    assert.equal(hits.length, 0, '静态规则命中不计入启发式');
  });

  it('processAdded 回报静态规则命中数（统计用，实测踩过计 0 的坑）', () => {
    // The placeholder is already caught by the MutationObserver during parsing, so the
    // DOMContentLoaded sweep sees it hidden and skips it. This hit must still be counted,
    // or the popup reports "0 blocked by rules" while 10 elements were hidden.
    const doc = freshDoc();
    const options = optionsFor(doc);
    const overlay = inject(doc, '<div data-ssp-sdk-popup-overlay></div>');

    const result = processAdded(overlay, options);
    assert.equal(result.rule, 1, '静态规则命中数应为 1');
    assert.deepEqual(result.hits, []);
  });

  it('processAdded 回报启发式命中，且不重复计入规则数', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const promo = inject(
      doc,
      '<div class="tg-promo-float"><a href="https://spam.example.com/x?click_id=1"></a></div>',
    );

    const result = processAdded(promo, options);
    assert.equal(result.rule, 0);
    assert.equal(result.hits.length, 1);
  });

  it('SDK 注入的悬浮球被静态规则拦住', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const ball = inject(doc, '<div class="xqbj-component-ssp-float-icon"></div>');

    addHits(ball, options);
    assert.ok(isHidden(ball));
  });

  it('纯启发式路径：跨站推广盒子被隐藏且产出可用规则', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const promo = inject(
      doc,
      '<div class="tg-promo-float"><a href="https://spam.example.com/x?click_id=1"><img src="/i.png"></a></div>',
    );

    const hits = addHits(promo, options);
    assert.ok(isHidden(promo), '跨站推广位未被隐藏');
    assert.equal(hits.length, 1, `应产生 1 条命中，实际 ${hits.length}`);
    // Weak naming (promo/float +2) plus behaviour (cross-site link +4, promo param +2).
    assert.equal(hits[0]!.score, 8, JSON.stringify(hits[0]));
    assert.deepEqual(hits[0]!.selector, '.tg-promo-float');
    assert.equal(recordableSelector(hits[0]!, doc), '.tg-promo-float');
  });

  it('隐藏自身后不再深入子树，避免往自学习库灌噪声', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const promo = inject(
      doc,
      '<div class="tg-promo-float"><a href="https://spam.example.com/x?click_id=1"></a><i></i><b></b></div>',
    );

    const hits = addHits(promo, options);
    assert.equal(hits.length, 1);
    assert.equal(promo.querySelectorAll('[data-adblow-hidden]').length, 0, '子树不应被逐个标记');
  });

  it('没有稳定特征的推广链接被隐藏，但绝不产出裸标签名规则', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const link = inject(doc, '<a href="https://spam.example.com/x?click_id=1"></a>');

    const hits = addHits(link, options);
    assert.ok(isHidden(link), '该链接应当被隐藏');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.selector, null, '不得泛化出裸标签名');
    assert.equal(recordableSelector(hits[0]!, doc), null, '不得入库');
  });

  it('注入的同源正文不被隐藏（误伤守卫）', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const article = inject(
      doc,
      '<article itemscope itemtype="http://schema.org/BlogPosting"><a href="/archives/999999/"><h2>x</h2></a></article>',
    );

    const hits = addHits(article, options);
    assert.ok(!isHidden(article), '动态加载的同源正文被误伤');
    assert.equal(hits.length, 0);
  });

  it('注入的跨站 CDN 正文图不被隐藏（误伤守卫：只有 3 分，不该过阈值）', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const img = inject(doc, '<img src="https://pic.wvxrrip.cn/upload_01/xiao/new.jpeg">');

    const hits = addHits(img, options);
    assert.ok(!isHidden(img), '跨站 CDN 的正文图被误伤');
    assert.equal(hits.length, 0);
  });

  it('注入的纯外链盒子（无推广参数）只有 4 分，不过阈值（误伤守卫）', () => {
    const doc = freshDoc();
    const options = optionsFor(doc);
    const box = inject(doc, '<div class="social-links"><a href="https://t.me/somechannel"></a></div>');

    const hits = addHits(box, options);
    assert.ok(!isHidden(box), '4 分不应过阈值 —— 否则所有社交链接块都会被误伤');
    assert.equal(hits.length, 0);
  });
});

describe('集成：快照不可信时启发式必须整体关闭', () => {
  it('reliable=false 时，纯行为档关闭（无命名线索的推广盒子不被隐藏）', () => {
    const doc = freshDoc();
    const options = optionsFor(doc, false);
    // Deliberately ad-free class name, so this really exercises the behaviour-only tier.
    const promo = inject(
      doc,
      '<div class="zzz-plain"><a href="https://spam.example.com/x?click_id=1"></a></div>',
    );

    const hits = addHits(promo, options);
    assert.ok(!isHidden(promo), '快照不可信时不得跑启发式');
    assert.equal(hits.length, 0);
  });

  it('reliable=false 时静态规则仍然生效（精确锚点不依赖快照）', () => {
    const doc = freshDoc();
    const options = optionsFor(doc, false);

    const overlay = inject(doc, '<div data-ssp-sdk-popup-overlay></div>');
    addHits(overlay, options);
    assert.ok(isHidden(overlay), '静态规则必须与快照可靠性无关');

    sweep(doc.documentElement, options);
    for (const s of Array.from(doc.querySelectorAll('[data-ssp-slot-node]'))) {
      assert.ok(isHidden(s));
    }
  });

  it('reliable=false 时服务端高分元素同样不被隐藏（无假阳性）', () => {
    const doc = freshDoc();
    sweep(doc.documentElement, optionsFor(doc, false));

    for (const sel of ['.contact-link', 'footer#footer']) {
      for (const e of Array.from(doc.querySelectorAll(sel))) {
        assert.ok(!isHidden(e));
      }
    }
  });
});

describe('集成：规则包护栏与「可信 / 自学习」分离', () => {
  it('合法规则包被完整采用为 curated', () => {
    const set = selectorsFrom([pilotPack], []);
    assert.equal(set.curated.length, pilotPack.cosmetic.length);
    assert.ok(set.curated.includes('[data-ssp-slot-node]'));
    assert.deepEqual(set.learned, []);
  });

  it('被护栏拒绝的规则包整包丢弃，并回报原因', () => {
    const bad: SitePack = {
      ...pilotPack,
      id: 'bad-pack',
      cosmetic: [...pilotPack.cosmetic, '[data-ssp-container]'],
    };
    const rejected: string[] = [];
    const set = selectorsFrom([bad], [], (r) => rejected.push(r.packId));

    assert.equal(validateSitePack(bad).length > 0, true);
    assert.deepEqual(rejected, ['bad-pack']);
    assert.deepEqual(set.curated, [], '整包丢弃，连它合法的选择器也不采用');
  });

  it('❗自学习选择器必须与规则包分开，绝不混进 curated', () => {
    // Incident regression: while the two were merged, learned selectors reached the
    // document_start stylesheet, which has no element-level guard.
    const set = selectorsFrom([pilotPack], ['[data-ssp-slot-node]', '.learned-ad']);

    assert.ok(
      !set.curated.includes('.learned-ad'),
      '自学习选择器绝不能进入 curated（它会进样式表）',
    );
    assert.deepEqual(set.learned, ['[data-ssp-slot-node]', '.learned-ad']);
    assert.equal(new Set(set.learned).size, set.learned.length);
  });
});
