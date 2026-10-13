import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAGE_LINK_BUDGET_SHARE,
  PAGE_TEXT_BUDGET_SHARE,
  createHidingBudget,
  hideElement,
} from '../../src/content/engine.ts';
import { brandLabels, isSameBrand, scoreNode } from '../../src/engine/score.ts';

// Regression for "whole page wiped out" false positives (reported on dgav36.xyz). That site has
// a "latest mirror URLs" directory whose body is dozens of mirror-domain cards (dgav39.com,
// dgav40.com, ...); each card was judged separately and each had evidence (2 cross-site links
// = 8 points > threshold 6), so all 96 blocks were hidden. Two fixes: same-brand domains are
// softened (mirrors are not ad evidence) and a page-level budget stops after ~70% is hidden.

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('isSameBrand：镜像/备用域名的识别', () => {
  it('❗编号式镜像域名算同品牌（用户报告的实际形态）', () => {
    assert.equal(isSameBrand('09s97k.dgav36.xyz', 'dgav40.com'), true);
    assert.equal(isSameBrand('dgav36.xyz', 'dgav39.com'), true);
    assert.equal(isSameBrand('javbus1.com', 'javbus2.com'), true);
  });

  it('边界：编号在**子域**上、二级域名相同但 TLD 不同 → 不认', () => {
    // Only the registrable domain is compared, deliberately: widening to subdomains would
    // reintroduce the example.com ↔ ads.example.net false positive.
    assert.equal(isSameBrand('mirror-3.example.com', 'mirror7.example.net'), false);
  });

  it('自身域名的子域算同品牌', () => {
    assert.equal(isSameBrand('www.example.com', 'cdn.example.com'), true);
    assert.equal(isSameBrand('example.com', 'example.com'), true);
  });

  it('❗无编号的同名不同 TLD **不算**同品牌（否则会丢真广告）', () => {
    // The first version failed here: example.com ↔ ads.example.net share "example", so a real
    // ad's cross-site evidence was erased and the acceptance case failed.
    assert.equal(isSameBrand('example.com', 'ads.example.net'), false);
    assert.equal(isSameBrand('news.com', 'news.net'), false);
  });

  it('完全无关的域名不算同品牌', () => {
    assert.equal(isSameBrand('example.com', 'doubleclick.net'), false);
    assert.equal(isSameBrand('example.com', 'a1.com'), false);
    assert.equal(isSameBrand('mynews.com', 'news.com'), false);
  });

  it('品牌词太短时不认（避免 ab1.com / ab2.com 这类噪声）', () => {
    assert.equal(isSameBrand('ab1.com', 'ab2.com'), false);
  });

  it('brandLabels 去掉数字与连字符', () => {
    assert.deepEqual(brandLabels('dgav36.xyz'), ['dgav']);
    assert.deepEqual(brandLabels('mirror-site.io'), ['mirrorsite']);
  });
});

describe('scoreNode：同品牌链接不再算跨站证据', () => {
  it('❗镜像链接不计分（用户报告的误杀场景）', () => {
    const el = root(
      '<div class="url-item"><a href="https://dgav39.com/">A</a><a href="https://dgav40.com/">B</a></div>',
    ).firstElementChild!;
    const r = scoreNode(el, { pageHost: '09s97k.dgav36.xyz', viewportArea: 1600 * 900 });
    assert.equal(r.behavior, 0, '镜像链接不该产生行为分');
    assert.ok(r.reasons.includes('sibling-domain-link'), JSON.stringify(r.reasons));
    assert.ok(r.score < 6, '总分必须低于阈值，否则又会整页隐藏');
  });

  it('对照：真第三方链接照常计分', () => {
    const el = root(
      '<div class="url-item"><a href="https://ads.network-a.com/">A</a><a href="https://ads.network-b.com/">B</a></div>',
    ).firstElementChild!;
    const r = scoreNode(el, { pageHost: '09s97k.dgav36.xyz', viewportArea: 1600 * 900 });
    assert.equal(r.behavior, 8, '两个跨站链接 = 8 分');
    assert.ok(r.reasons.includes('cross-site-link'));
  });
});

describe('❗createHidingBudget：页级兜底，不许清空整页', () => {
  function pageWith(cards: number): HTMLElement {
    document.body.innerHTML =
      '<div id="wrap">' +
      Array.from(
        { length: cards },
        (_, i) =>
          `<div class="url-item"><a href="https://m${i}.example.net/">镜像${i}</a>这里是一些说明文字内容</div>`,
      ).join('') +
      '</div>';
    return document.body;
  }

  it('少量隐藏正常放行', () => {
    pageWith(20);
    const budget = createHidingBudget(document);
    const first = document.querySelector('.url-item')!;
    assert.equal(budget.canHide(first), true);
    hideElement(first, 'test');
    budget.commit(first);
    const s = budget.stats();
    assert.equal(s.links, 1);
    assert.ok(s.text > 0);
  });

  it('❗累计隐藏超过全页 70% 链接后停手（阻止整页清空）', () => {
    pageWith(20);
    const budget = createHidingBudget(document);
    const items = Array.from(document.querySelectorAll('.url-item'));
    let hidden = 0;
    for (const el of items) {
      if (!budget.canHide(el)) break;
      hideElement(el, 'test');
      budget.commit(el);
      hidden += 1;
    }
    assert.ok(hidden > 0, '前面应正常隐藏');
    assert.ok(hidden < items.length, `不应把整页全隐藏，实际隐藏 ${hidden}/${items.length}`);
    const s = budget.stats();
    assert.ok(s.suppressed > 0, '应记录被兜底拒绝的次数');
    // Hidden-link ratio must stay within the cap (equality allowed).
    assert.ok(
      s.links <= s.totalLinks * PAGE_LINK_BUDGET_SHARE + 1,
      `隐藏链接 ${s.links}/${s.totalLinks} 超过上限`,
    );
  });

  it('基线在动手之前测量（否则预算永远用不完）', () => {
    pageWith(10);
    const budget = createHidingBudget(document);
    const before = budget.stats();
    assert.ok(before.totalText > 0 && before.totalLinks === 10, '基线应是未隐藏前的全页量');
    for (const el of Array.from(document.querySelectorAll('.url-item'))) {
      if (!budget.canHide(el)) break;
      hideElement(el, 'test');
      budget.commit(el);
    }
    const after = budget.stats();
    assert.equal(after.totalText, before.totalText, '分母不得因为隐藏而变小');
    assert.equal(after.totalLinks, before.totalLinks);
  });

  it('没有链接、没有文字的页面不会因除零出错', () => {
    document.body.innerHTML = '<div></div>';
    const budget = createHidingBudget(document);
    const el = document.querySelector('div')!;
    assert.equal(budget.canHide(el), true);
    assert.doesNotThrow(() => budget.commit(el));
  });

  it('阈值可覆盖（便于测试与将来调参）', () => {
    pageWith(10);
    const budget = createHidingBudget(document, { textShare: 0.1, linkShare: 0.1 });
    const items = Array.from(document.querySelectorAll('.url-item'));
    budget.canHide(items[0]!);
    budget.commit(items[0]!);
    assert.equal(budget.canHide(items[1]!), false, '10% 阈值下第二个就该被拒');
  });

  it('❗内容太少的页面不启用兜底（否则广告反而拦不住）', () => {
    // Added because acceptance forced it: the fixture page holds a single ad probe, hiding it is
    // 100% of that page's links, the 70% cap rejected it, and acceptance fell from 21/21 to 12/21.
    document.body.innerHTML =
      '<div class="ad-slot"><a href="https://ads.example.net/x">广告</a></div>';
    const budget = createHidingBudget(document);
    const el = document.querySelector('.ad-slot')!;
    assert.equal(budget.stats().enabled, false, '内容量太少的页面不应启用兜底');
    assert.equal(budget.canHide(el), true, '应放行（让广告能被拦住）');
  });

  it('❗基线排除 <script> / <style> 里的代码文本', () => {
    document.body.innerHTML =
      '<script>' + 'var x = 1;'.repeat(2000) + '</script>' +
      '<style>' + '.a{color:red}'.repeat(2000) + '</style>' +
      '<div id="wrap">' +
      Array.from({ length: 12 }, (_, i) => `<a href="https://m${i}.com/">镜像${i}</a>`).join('') +
      '</div>';
    const budget = createHidingBudget(document);
    const s = budget.stats();
    assert.ok(
      s.totalText < 2000,
      `文字基线不该把脚本算进去，实际 ${s.totalText}（内含 ${'var x = 1;'.repeat(2000).length} 字符脚本）`,
    );
    assert.equal(s.totalLinks, 12);
  });

  it('❗refresh 让分母只增不减（页面后续加载出更多内容）', () => {
    document.body.innerHTML = Array.from(
      { length: 12 },
      (_, i) => `<a href="https://m${i}.com/">镜像${i}</a>`,
    ).join('');
    const budget = createHidingBudget(document);
    const before = budget.stats();
    assert.equal(before.totalLinks, 12);

    // The page loads 12 more links.
    document.body.innerHTML += Array.from(
      { length: 12 },
      (_, i) => `<a href="https://n${i}.com/">新增${i}</a>`,
    ).join('');
    budget.refresh(document);
    assert.equal(budget.stats().totalLinks, 24, '分母应增长');

    // Conversely, when content shrinks (we hid some ourselves) the denominator must not shrink.
    document.body.innerHTML = '<a href="https://only.com/">只剩一个</a>';
    budget.refresh(document);
    assert.equal(budget.stats().totalLinks, 24, '分母只增不减，否则预算永远用不完');
  });

  it('上限常量与注释一致（70% 是有意宽松，只兜灾难）', () => {
    assert.equal(PAGE_TEXT_BUDGET_SHARE, 0.7);
    assert.equal(PAGE_LINK_BUDGET_SHARE, 0.7);
  });
});
