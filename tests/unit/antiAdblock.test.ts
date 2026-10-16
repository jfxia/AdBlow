import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALL_MIN_AREA_RATIO,
  WALL_MIN_OPACITY,
  WALL_PHRASES,
  WALL_SHAPED_MIN_SCORE,
  WALL_TEXT_ONLY_MAX_CHARS,
  WALL_TEXT_ONLY_MIN_SCORE,
  detectWall,
  findWallPrompts,
  isOverlayShaped,
  isWallPrompt,
  normalizeWallText,
  wallMatchKey,
  wallPhraseEvidence,
  type WallContext,
  type WallPhraseLang,
} from '../../src/engine/antiAdblock.ts';
import { hasContentMarker } from '../../src/content/engine.ts';

/**
 * Anti-adblock wall detection: copy signatures plus a shape requirement.
 *
 * The suite is deliberately split into positives and **false-positive** cases: an article that
 * discusses ad blockers carries the same vocabulary as a wall, and hiding a normal page is far
 * worse than missing one wall (see the module doc in src/engine/antiAdblock.ts).
 *
 * Geometry is injected — jsdom has no layout engine (same approach as tests/unit/overlay.test.ts).
 */

const VIEWPORT = 1920 * 1080;
const BIG = { w: 1600, h: 900 };

type Geo = {
  position?: string;
  display?: string;
  visibility?: string;
  opacity?: string;
  w?: number;
  h?: number;
};

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

const keyOf = (el: Element): string =>
  el.id || (el.getAttribute('class') ?? '').split(/\s+/)[0] || '';

/** Real inline styles are honoured, so a fixture can declare `position:fixed` itself. */
function ctxFor(geo: Record<string, Geo> = {}): WallContext {
  return {
    viewportArea: VIEWPORT,
    styleOf: (el) => {
      const g = geo[keyOf(el)];
      const inline = (el as HTMLElement).style;
      return {
        position: g?.position ?? (inline?.position || 'static'),
        display: g?.display ?? (inline?.display || undefined),
        visibility: g?.visibility ?? (inline?.visibility || undefined),
        opacity: g?.opacity ?? (inline?.opacity || undefined),
      };
    },
    rectOf: (el) => {
      const g = geo[keyOf(el)];
      return g ? { width: g.w ?? 0, height: g.h ?? 0 } : null;
    },
    // The content layer injects this; tests use the real implementation.
    hasContentMarker,
  };
}

const TECHCRUNCH_WALL = `<div id="ab-wall" style="position:fixed">
  <h2>Something went wrong. Disable your adblocker on TechCrunch</h2>
  <p>It looks like your adblocker is attempting to interfere with the intended operation of
  this site. Please add your adblocker's allowlist.</p>
</div>`;

describe('反过滤墙文案表（数据而非散落逻辑）', () => {
  it('五种语言都有强特征，且英/中各不止一条', () => {
    const langs = new Set<WallPhraseLang>(WALL_PHRASES.map((p) => p.lang));
    for (const lang of ['en', 'zh', 'ja', 'fr', 'es'] as const) {
      assert.ok(langs.has(lang), `缺少 ${lang} 文案`);
      const strong = WALL_PHRASES.filter((p) => p.lang === lang && p.weight === 'strong');
      assert.ok(strong.length >= 1, `${lang} 没有强特征短语`);
    }
    assert.ok(WALL_PHRASES.filter((p) => p.lang === 'en' && p.weight === 'strong').length >= 3);
    assert.ok(WALL_PHRASES.filter((p) => p.lang === 'zh' && p.weight === 'strong').length >= 3);
  });

  it('匹配键忽略大小写、空格、连字符与重音', () => {
    assert.equal(wallMatchKey('Ad-Blocker'), wallMatchKey('ad blocker'));
    assert.equal(wallMatchKey('Désactivez  votre bloqueur'), wallMatchKey('desactivez votre bloqueur'));
    assert.equal(normalizeWallText('a\u00a0 b'), 'a b');
    const variants = ['disable your ad blocker', 'DISABLE YOUR AD-BLOCKER', 'disable youradblocker'];
    for (const v of variants) {
      assert.ok(
        wallPhraseEvidence(v).strong.includes('en-disable-adblocker'),
        `未命中：${v}`,
      );
    }
  });

  it('英文特征：disable your adblocker / allowlist / interfere / detected', () => {
    const e = wallPhraseEvidence(
      'Something went wrong. Disable your adblocker. It is interfering with the intended ' +
        "operation of this site. Please add your adblocker's allowlist.",
    );
    assert.ok(e.strong.includes('en-disable-adblocker'));
    assert.ok(e.strong.includes('en-interfere'));
    assert.ok(e.strong.includes('en-allowlist'));
    assert.ok(wallPhraseEvidence('Adblock detected on this page.').strong.includes('en-adblock-detected'));
    assert.ok(e.score >= WALL_SHAPED_MIN_SCORE);
  });

  it('中文特征：关闭广告拦截 / 加入白名单', () => {
    const e = wallPhraseEvidence('检测到广告拦截插件，请关闭广告拦截后继续浏览，或将本站加入白名单。');
    assert.ok(e.strong.includes('zh-adblock-detected'));
    assert.ok(e.strong.includes('zh-disable-adblock'));
    assert.ok(e.strong.includes('zh-allowlist'));
  });

  it('日/法/西各至少一条常见表述', () => {
    assert.ok(wallPhraseEvidence('広告ブロッカーを無効にしてください').strong.length >= 1);
    assert.ok(wallPhraseEvidence('Merci de désactiver votre bloqueur de publicités').strong.length >= 1);
    assert.ok(wallPhraseEvidence('Desactiva tu bloqueador de anuncios para continuar').strong.length >= 1);
  });

  it('只提到概念（弱特征）不构成证据', () => {
    const e = wallPhraseEvidence('Ad blockers are used by millions of readers every day.');
    assert.deepEqual(e.strong, []);
    assert.ok(e.score < WALL_SHAPED_MIN_SCORE);
    assert.ok(e.weak.includes('en-concept'));
  });
});

describe('findWallPrompts：正例', () => {
  it('英文整屏遮罩（实测 techcrunch 文案）被识别', () => {
    const el = root(TECHCRUNCH_WALL);
    const found = findWallPrompts(el, ctxFor({ 'ab-wall': BIG }));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 'ab-wall');
  });

  it('中文遮罩被识别', () => {
    const el = root(`<div id="wall" style="position:fixed">
      <h2>检测到广告拦截插件</h2>
      <p>请关闭广告拦截后继续浏览，或将本站加入白名单。</p>
    </div>`);
    const found = findWallPrompts(el, ctxFor({ wall: BIG }));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 'wall');
  });

  it('文案在内层、遮罩在外层时提升到外层（只隐藏内层会留下遮罩底板）', () => {
    const el = root(`<div id="backdrop" style="position:fixed">
      <div class="notice"><p>Please disable your ad blocker to continue reading.</p></div>
    </div>`);
    const found = findWallPrompts(el, ctxFor({ backdrop: BIG }));
    assert.equal(found.length, 1, JSON.stringify(found.map((x) => x.id)));
    assert.equal(found[0]!.id, 'backdrop');
  });

  it('没有形状证据时，需要更密集的文案（2 强 + 1 弱）', () => {
    const el = root(`<div id="plain">
      Please disable your ad blocker. Interfering with the intended operation of this site.
      Whitelist us.
    </div>`);
    const evidence = wallPhraseEvidence(el.textContent ?? '');
    assert.ok(evidence.score >= WALL_TEXT_ONLY_MIN_SCORE, `score=${evidence.score}`);
    const found = findWallPrompts(el, ctxFor());
    assert.equal(found.length, 1);
    assert.equal(found[0]!.id, 'plain');
  });

  it('❗已被我们隐藏的遮罩不再算候选（隐藏即不可见）', () => {
    const el = root(`<div id="ab-wall" data-adblow-hidden="1" style="position:fixed">
      Disable your adblocker. Add your adblocker's allowlist.
    </div>`);
    assert.deepEqual(findWallPrompts(el, ctxFor({ 'ab-wall': BIG })), []);
  });

  it('detectWall 汇总命中的短语 id', () => {
    const el = root(TECHCRUNCH_WALL);
    const d = detectWall(el, ctxFor({ 'ab-wall': BIG }));
    assert.equal(d.detected, true);
    assert.equal(d.count, 1);
    assert.ok(d.phrases.includes('en-disable-adblocker'));
    assert.ok(d.phrases.includes('en-interfere'));
    assert.equal(detectWall(root('<div id="x">hello</div>'), ctxFor()).detected, false);
  });
});

describe('findWallPrompts：反例（降误报是关键）', () => {
  it('❗讨论广告过滤器的新闻文章不得误报（长文 + 引用了一句强特征文案）', () => {
    const body = `Long-running reporting about the advertising business. `.repeat(8) +
      `One publisher even shows the message "please disable your ad blocker" to readers. ` +
      `Analysts say whitelist requests and advertising revenue pressure explain the trend. ` +
      `Readers who use an ad blocker are asked to add us to your whitelist on some sites.`;
    const el = root(`<div><article itemprop="articleBody"><h1>Inside the ad-blocking wars</h1><p>${body}</p></article></div>`);
    const article = el.querySelector('article')!;
    assert.ok(
      (article.textContent ?? '').length > WALL_TEXT_ONLY_MAX_CHARS,
      '反例文章必须比"文案上限"长，否则测的不是篇幅护栏',
    );
    assert.deepEqual(findWallPrompts(el, ctxFor()), []);
  });

  it('❗短文但只命中一处强特征也不判定（文案阈值）', () => {
    const el = root(
      `<div id="quote">A reader asked how to add your adblocker's allowlist.</div>`,
    );
    const evidence = wallPhraseEvidence(el.textContent ?? '');
    assert.ok(evidence.strong.length >= 1, '本例必须命中强特征，否则测的不是阈值');
    assert.ok(evidence.score < WALL_TEXT_ONLY_MIN_SCORE);
    assert.deepEqual(findWallPrompts(el, ctxFor()), []);
  });

  it('❗文章标记里的短文案不判定（内容标记注入生效）', () => {
    const el = root(`<div><article itemtype="http://schema.org/BlogPosting">
      Please disable your ad blocker. Interfering with the intended operation. Whitelist us.
    </article></div>`);
    const article = el.querySelector('article')!;
    assert.ok(wallPhraseEvidence(article.textContent ?? '').score >= WALL_TEXT_ONLY_MIN_SCORE);
    assert.deepEqual(findWallPrompts(el, ctxFor()), [], '正文标记必须压过文案证据');
  });

  it('❗含文章标记的遮罩祖先被拒绝（不提升到含正文的包装器，元素本身也不判定）', () => {
    const el = root(`<div id="gate" style="position:fixed">
      <article itemprop="articleBody"><p>Real article body.</p></article>
      <div class="notice">
        <p>Please disable your ad blocker to continue reading. Interfering with the intended
        operation of this site. Whitelist us.</p>
      </div>
    </div>`);
    const gate = el.querySelector('#gate')!;
    assert.ok(wallPhraseEvidence(gate.textContent ?? '').score >= WALL_SHAPED_MIN_SCORE);
    assert.equal(isWallPrompt(gate, ctxFor({ gate: BIG })), false, '含正文标记的包装器不能当遮罩');

    const found = findWallPrompts(el, ctxFor({ gate: BIG }));
    assert.equal(found.length, 1);
    assert.equal(found[0]!.getAttribute('class'), 'notice', '只隐藏文案块，不动含正文的祖先');
  });

  it('没有反过滤文案的浮层（Cookie 条）不判定', () => {
    const el = root(`<div id="cookie" style="position:fixed">
      We use cookies to improve your experience. Accept all cookies.
    </div>`);
    assert.deepEqual(findWallPrompts(el, ctxFor({ cookie: BIG })), []);
  });

  it('不可见（display:none / opacity:0）的遮罩不判定', () => {
    const el = root(`<div id="w" style="position:fixed">Disable your adblocker.</div>`);
    assert.deepEqual(
      findWallPrompts(el, ctxFor({ w: { ...BIG, display: 'none' } })),
      [],
      'display:none 的元素不是用户看到的遮罩',
    );
    assert.deepEqual(
      findWallPrompts(el, ctxFor({ w: { ...BIG, visibility: 'hidden' } })),
      [],
    );
    const faded = root(`<div id="w" style="position:fixed;opacity:0">Disable your adblocker.</div>`);
    assert.deepEqual(findWallPrompts(faded, ctxFor({ w: BIG })), []);
    assert.ok(WALL_MIN_OPACITY > 0);
  });

  it('body/html 不参与（隐藏它们会清空整页）', () => {
    assert.equal(isWallPrompt(document.body, ctxFor({ w: BIG })), false);
    assert.equal(isWallPrompt(document.documentElement, ctxFor({ w: BIG })), false);
  });

  it('❗固定定位但文案过长的整页包装器不判定（篇幅上限）', () => {
    const long = `Filler sentence about the site and its authors. `.repeat(60);
    const el = root(`<div id="wrapper" style="position:fixed">
      Disable your adblocker. ${long}
    </div>`);
    const wrapper = el.firstElementChild!;
    assert.ok((wrapper.textContent ?? '').length > 2000);
    assert.deepEqual(findWallPrompts(el, ctxFor({ wrapper: BIG })), []);
  });

  it('页面完全没有反过滤词汇时提前返回（性能门槛）', () => {
    const el = root(`<div id="main"><h1>News</h1><p>${'word '.repeat(200)}</p></div>`);
    assert.deepEqual(findWallPrompts(el, ctxFor()), []);
  });
});

describe('isOverlayShaped：形状判据', () => {
  it('固定/绝对定位 + 覆盖视口 20% 以上', () => {
    const el = root(`<div id="a" style="position:fixed"></div>`).firstElementChild!;
    assert.equal(isOverlayShaped(el, ctxFor({ a: BIG })), true);
    assert.equal(isOverlayShaped(el, ctxFor({ a: { position: 'absolute', ...BIG } })), true);
  });

  it('静态定位或面积不足不算', () => {
    const el = root(`<div id="a" style="position:fixed"></div>`).firstElementChild!;
    assert.equal(isOverlayShaped(el, ctxFor({ a: { position: 'static', ...BIG } })), false);
    assert.equal(isOverlayShaped(el, ctxFor({ a: { position: 'fixed', w: 400, h: 60 } })), false);
    assert.equal(isOverlayShaped(el, ctxFor({ a: { position: 'fixed', w: 0, h: 0 } })), false);
  });

  it('阈值常量如实证记录', () => {
    assert.equal(WALL_MIN_AREA_RATIO, 0.2);
    assert.equal(WALL_SHAPED_MIN_SCORE, 2);
    assert.equal(WALL_TEXT_ONLY_MIN_SCORE, 5);
    assert.equal(WALL_TEXT_ONLY_MAX_CHARS, 400);
  });
});
