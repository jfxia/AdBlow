import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_FARM_MIN_DOMAINS, findLinkFarms } from '../../src/content/engine.ts';

// Link-farm heuristic — the one generalisable class among "zero generic signal" ads.
// Evidence: the dgav37.com series puts 39 distinct cross-site domains in its footer
// (a.referrerLink, all target=_blank), injected by the site's own /js/partners.js. Existing
// heuristics missed it: a single cross-site link scores only 4 (below the deliberate 6-point
// behaviour threshold) and the container has too many descendants (>12) for descendant signals.

const HOST = 'www.example.com';

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

const links = (hosts: string[]): string =>
  hosts.map((h) => `<a href="https://${h}/x">${h}</a>`).join('');

describe('findLinkFarms：识别外站链接堆出来的块', () => {
  it('❗一个块里 5 个不同跨站域名 → 命中', () => {
    const doc = root(`<div id="farm">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</div>`);
    const farms = findLinkFarms(doc, { host: HOST });
    assert.equal(farms.length, 1);
    assert.equal(farms[0]!.id, 'farm');
  });

  it('同一域名重复多次不算（必须是不同域名）', () => {
    const doc = root(`<div id="x">${links(['a1.com', 'a1.com', 'a1.com', 'a1.com', 'a1.com'])}</div>`);
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('4 个域名不命中（阈值 5）', () => {
    const doc = root(`<div id="x">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com'])}</div>`);
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('阈值常量如实证记录', () => {
    assert.equal(LINK_FARM_MIN_DOMAINS, 5);
  });

  it('站内链接不算（正常导航不该被隐藏）', () => {
    const doc = root(
      `<div id="nav">${['a', 'b', 'c', 'd', 'e', 'f'].map((p) => `<a href="/${p}">${p}</a>`).join('')}</div>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('同可注册域名的子域不算跨站', () => {
    const doc = root(
      `<div id="x">${links(['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'])}</div>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('❗只返回最深的那层（否则会把整个 footer 一起隐藏）', () => {
    // Real shape: footer > .container > section.footer-partners > #script_seo_links > many <a>.
    const doc = root(
      `<footer><div class="container"><section class="partners">` +
        `<div id="script_seo_links">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com'])}</div>` +
        `</section><nav><a href="/about">关于</a></nav></div></footer>`,
    );
    const farms = findLinkFarms(doc, { host: HOST });
    assert.equal(farms.length, 1);
    assert.equal(farms[0]!.id, 'script_seo_links', '应命中农场容器本身，而不是外层 footer');
  });

  it('❗装着正文的块即使外链多也不隐藏', () => {
    const doc = root(
      `<article itemtype="http://schema.org/BlogPosting"><div id="x">` +
        links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com']) +
        `</div></article>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('已隐藏的不再返回', () => {
    const doc = root(
      `<div id="farm" data-adblow-hidden="1">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</div>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('忽略 javascript: 与锚点链接', () => {
    const doc = root(
      `<div id="x">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com'])}` +
        `<a href="javascript:void(0)">x</a><a href="#top">t</a></div>`,
    );
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), [], '只应数真外链，仍是 4 个域名');
  });

  it('多标签也支持（section / ul / aside / div）', () => {
    for (const tag of ['section', 'ul', 'aside', 'div']) {
      const doc = root(
        `<${tag} id="f">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</${tag}>`,
      );
      assert.equal(findLinkFarms(doc, { host: HOST }).length, 1, tag);
    }
  });

  it('❗导航默认不判农场（用户报告过「导航列表被屏蔽」）', () => {
    const nav = root(`<nav id="f">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</nav>`);
    assert.deepEqual(findLinkFarms(nav, { host: HOST }), [], '导航是页面骨架，不能当农场端掉');

    // Same for links inside a nav.
    const inner = root(
      `<nav><div id="f">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</div></nav>`,
    );
    assert.deepEqual(findLinkFarms(inner, { host: HOST }), []);
  });

  it('❗但伪装成导航的广告位仍要判（强命名是显式证据）', () => {
    const fake = root(`<nav id="f" class="ad-links">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</nav>`);
    assert.equal(findLinkFarms(fake, { host: HOST }).length, 1);
  });
});
