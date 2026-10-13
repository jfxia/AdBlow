import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findLinkFarms,
  hideElement,
  sweep,
} from '../../src/content/engine.ts';
import { scoreNode } from '../../src/engine/score.ts';

// Regression for "eating its way up the tree", found while diagnosing dgav40's hidden player,
// nav and recommendation rail: after an ad or farm is hidden, its parent still "holds the same
// links and media", so the next pass judges it an ad too and climbs outward, taking the content
// with it (one dgav40 footer farm was hidden 4 levels deep: #script_seo_links → .footer-links →
// section.footer-partners → .container). Fix: evidence already processed is not reused —
// scoreNode ignores links/media/iframes inside hidden descendants, and findLinkFarms skips
// elements that contain a hidden farm.

const HOST = 'www.example.com';

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

const farmLinks = (domains: string[]): string =>
  domains.map((h) => `<a href="https://${h}/x">${h}</a>`).join('');

describe('❗scoreNode：已被隐藏的后代不再贡献证据', () => {
  it('父容器不会因为"装着已隐藏的广告"而被再次判成广告', () => {
    document.body.innerHTML =
      '<div class="wrapper"><div class="ad-slot">' +
      '<a href="https://ads.a1.net/x">1</a><a href="https://ads.a2.net/x">2</a>' +
      '</div></div>';
    const wrapper = document.querySelector('.wrapper')!;
    const ad = document.querySelector('.ad-slot')!;

    const before = scoreNode(wrapper, { pageHost: HOST, viewportArea: 1600 * 900 });
    assert.equal(before.behavior, 8, '隐藏前：两条跨站链接 = 8 分（这就是往上吃的动力）');

    hideElement(ad, 'heuristic');
    const after = scoreNode(wrapper, { pageHost: HOST, viewportArea: 1600 * 900 });
    assert.equal(after.behavior, 0, '隐藏后：父容器不该再拿到同一批证据');
    assert.ok(after.score < 6, '分数必须低于阈值，否则父容器会被吃掉');
  });

  it('对照：父容器自己的新证据仍然算数', () => {
    document.body.innerHTML =
      '<div class="wrapper"><div class="ad-slot"><a href="https://ads.a1.net/x">1</a></div>' +
      '<a href="https://other.b.net/y">外链</a></div>';
    const wrapper = document.querySelector('.wrapper')!;
    hideElement(document.querySelector('.ad-slot')!, 'heuristic');
    const r = scoreNode(wrapper, { pageHost: HOST, viewportArea: 1600 * 900 });
    assert.equal(r.behavior, 4, '父容器自己那条跨站链接仍应计分');
  });

  it('媒体与 iframe 同样不再重复采信', () => {
    document.body.innerHTML =
      '<div class="wrap"><div class="ad-slot">' +
      '<img src="https://ads.a1.net/1.png"><iframe src="https://ads.a2.net/f"></iframe>' +
      '</div></div>';
    const wrap = document.querySelector('.wrap')!;
    assert.ok(scoreNode(wrap, { pageHost: HOST, viewportArea: 1600 * 900 }).behavior >= 6);
    hideElement(document.querySelector('.ad-slot')!, 'heuristic');
    assert.equal(
      scoreNode(wrap, { pageHost: HOST, viewportArea: 1600 * 900 }).behavior,
      0,
      '已隐藏后代里的素材/iframe 不该再给父容器加分',
    );
  });
});

describe('❗findLinkFarms：同一个农场不再逐层重复隐藏', () => {
  const NESTED = `
    <div class="container" id="outer">
      <section class="footer-partners" id="mid">
        <div class="footer-links" id="inner">
          <div id="farm">${farmLinks(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</div>
        </div>
      </section>
    </div>`;

  it('第一轮：只返回最深的那一层', () => {
    const doc = root(NESTED);
    const farms = findLinkFarms(doc, { host: HOST });
    assert.equal(farms.length, 1, `只应命中最深的一层，实际 ${farms.map((f) => f.id).join(',')}`);
    assert.equal(farms[0]!.id, 'farm');
  });

  it('❗第二轮：外层容器不再被当成新农场（这正是"往上吃"的回归）', () => {
    const doc = root(NESTED);
    // First pass.
    for (const el of findLinkFarms(doc, { host: HOST })) hideElement(el, 'linkfarm');
    assert.equal(doc.querySelector('#farm')!.getAttribute('data-adblow-hidden'), '1');

    // Second pass: inner / mid / outer all "hold the same links" but must not be hidden again.
    const second = findLinkFarms(doc, { host: HOST });
    assert.deepEqual(
      second.map((e) => e.id),
      [],
      `第二轮不该再命中任何外层容器，实际 ${second.map((e) => e.id).join(',')}`,
    );
  });

  it('对照：另一个独立的农场在第一轮照常命中，第二轮也不重复', () => {
    const doc = root(
      NESTED +
        `<div id="other">${farmLinks(['b1.com', 'b2.com', 'b3.com', 'b4.com', 'b5.com'])}</div>`,
    );
    // First pass: the deepest element in each branch must match (independent farms unaffected).
    const first = findLinkFarms(doc, { host: HOST }).map((e) => e.id).sort();
    assert.deepEqual(first, ['farm', 'other'], `实际 ${first.join(',')}`);
    for (const el of findLinkFarms(doc, { host: HOST })) hideElement(el, 'linkfarm');
    // Second pass: neither repeats.
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });
});

describe('sweep 集成：外层容器不被连带隐藏', () => {
  it('❗绝不隐藏 body / html（隐藏它们等于清空整页）', () => {
    document.body.innerHTML = '<div class="ad"><a href="https://a1.net/x">1</a></div>';
    hideElement(document.body, 'heuristic');
    hideElement(document.documentElement, 'heuristic');
    assert.equal(document.body.getAttribute('data-adblow-hidden'), null, 'body 不该被隐藏');
    assert.equal(
      document.documentElement.getAttribute('data-adblow-hidden'),
      null,
      'html 不该被隐藏',
    );
  });

  it('❗广告在上一趟已被隐藏后，主容器不会被下一趟吃掉', () => {
    document.body.innerHTML = `
      <div id="main-content">
        <h1>标题</h1>
        <div class="ad-slot">
          <a href="https://ads.a1.net/x">1</a>
          <a href="https://ads.a2.net/x">2</a>
        </div>
        <p>正文段落</p>
      </div>`;
    const options = {
      injected: () => true,
      host: 'www.example.com',
      viewportArea: 1600 * 900,
      selectors: { curated: [], learned: [] },
    };
    // Simulates the ad already handled in an earlier pass (farm / overlay pass, or a prior sweep).
    hideElement(document.querySelector('.ad-slot')!, 'overlay');

    // This pass sees the main container as "compact" (3 descendants), so reusing the hidden ad's
    // evidence would eat it — exactly the case being guarded.
    sweep(document.documentElement, options);
    assert.equal(
      document.querySelector('#main-content')!.getAttribute('data-adblow-hidden'),
      null,
      '主内容容器不能被已隐藏广告的同一批证据吃掉',
    );
  });
});
