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

/**
 * 在真实页面的脱敏快照上做端到端回归。
 *
 * 这是「广告零残留、内容零误伤」这个验收标准在沙箱内能做到的最强验证：
 * 真实 DOM 结构 + 真实规则包 + 真实引擎 + 真实服务端快照，唯独没有浏览器。
 */

const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');
const HOST = 'afford.gjvrohros.cc';
const CONTENT = 'article[itemtype*="BlogPosting"]';
/**
 * 服务端渲染的推荐位图片。
 * ⚠️ 它们**不是正文缩略图**：这 10 张全部属于「推荐位广告块」，隐藏是正确行为。
 * 正文缩略图由内联脚本从 pic.wvxrrip.cn 动态加载，见下面的专项用例。
 */
const RECOMMEND_IMG = 'img[data-src*="upload_01"]';

function freshDoc(): Document {
  return new JSDOM(fixture, { url: `https://${HOST}/category/jrxw1/` }).window.document;
}

/**
 * 造判定选项。
 *
 * reliable=true 时用 fixture 本身当「完整服务端快照」——这正是 background
 * 回填通道交付的东西。只有在这个前提下启发式才允许启用（见 content/engine.ts）。
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

/** processAdded 现返回 {rule, hits} 统计对象，这里只取命中，保持用例可读。 */
function addHits(el: Element, options: JudgeOptions): Hit[] {
  return processAdded(el, options).hits;
}

/** 造一个脚本注入的元素。 */
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
    // ⚠️ 注意别搞错：fixture 里 `img[data-src*="upload_01"]` 那 10 张**全部属于
    // 「服务端推荐位」**，隐藏它们是正确的（下面单独断言）。真正要守的是正文缩略图，
    // 而试点站的正文缩略图由内联脚本 loadBannerDirect 从 pic.wvxrrip.cn 动态加载
    // （那段内联脚本在脱敏时被抹掉了），所以这里手工构造一张放进正文 article。
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
    // 这是加命名档时自己踩出来的事故：`<div data-ssp-container="ssp-list">`
    // 的属性名含 `data-ssp-`，被判成强命名，于是整个正文列表被隐藏。
    // 命名证据再强也不能推翻「这里面装着正文」这个事实。
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
    // 这三个元素广告度高达 8 分（跨站链接），全靠「服务端快照」把它们
    // 与脚本注入区分开。这条断言就是那套机制的回归保护。
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
    // 占位符在解析过程中就会被 MutationObserver 拦掉，此时 DOMContentLoaded
    // 那一趟 sweep 看到的是已隐藏状态而跳过。统计必须把观察器这次的命中算上，
    // 否则 Popup 会显示「规则拦截 0」而实际隐藏了 10 个元素。
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
    // 弱命名（promo/float → +2）加行为旁证（跨站链接 +4、推广参数 +2）
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
    // 刻意用没有任何广告命名的 class：这样才能真正测到「纯行为档」
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

describe('集成：规则包护栏在链路中生效', () => {
  it('合法规则包被完整采用', () => {
    const selectors = selectorsFrom([pilotPack], []);
    assert.equal(selectors.length, pilotPack.cosmetic.length);
    assert.ok(selectors.includes('[data-ssp-slot-node]'));
  });

  it('被护栏拒绝的规则包整包丢弃，并回报原因', () => {
    const bad: SitePack = {
      ...pilotPack,
      id: 'bad-pack',
      cosmetic: [...pilotPack.cosmetic, '[data-ssp-container]'],
    };
    const rejected: string[] = [];
    const selectors = selectorsFrom([bad], [], (r) => rejected.push(r.packId));

    assert.equal(validateSitePack(bad).length > 0, true);
    assert.deepEqual(rejected, ['bad-pack']);
    assert.deepEqual(selectors, [], '整包丢弃，连它合法的选择器也不采用');
  });

  it('自学习选择器与规则包选择器合并去重', () => {
    const selectors = selectorsFrom([pilotPack], ['[data-ssp-slot-node]', '.learned-ad']);
    assert.equal(new Set(selectors).size, selectors.length, '不应有重复');
    assert.ok(selectors.includes('.learned-ad'));
  });
});
