import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_FARM_MIN_DOMAINS, findLinkFarms } from '../../src/content/engine.ts';

/**
 * 链接农场判据 —— 「零通用信号」广告里唯一能泛化的那一类。
 *
 * 取证来源：用户反馈的 dgav37.com 系列站点页脚有 **39 个不同跨站域名**的链接
 * （`a.referrerLink`，全部 target=_blank），由站点自己的 `/js/partners.js` 注入。
 * 原有判据抓不到：单条跨站链接只值 4 分（低于纯行为档 6 分门槛，这是故意的），
 * 容器又因后代过多（>12）不采信后代信号。
 */

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
    // 真实形态：footer > .container > section.footer-partners > #script_seo_links > 一堆 a
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

  it('多标签也支持（section / ul / nav / aside）', () => {
    for (const tag of ['section', 'ul', 'nav', 'aside', 'div']) {
      const doc = root(
        `<${tag} id="f">${links(['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com'])}</${tag}>`,
      );
      assert.equal(findLinkFarms(doc, { host: HOST }).length, 1, tag);
    }
  });
});
