import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findLinkFarms, sweep, type JudgeOptions } from '../../src/content/engine.ts';
import { selectorsFrom } from '../../src/content/engine.ts';
import { dgavPack } from '../../src/rules/sites/dgav.ts';

// Structural regression for the dgav37 series, rebuilt with neutral markup (no site
// content). Only the shapes matter: a footer container holding 5+ links to distinct
// cross-site domains (39 on the real page), an image strip
// `.streamer-container2 > ul.streamer-box2 > li > a > img` whose images sit on the
// site's own CDN (zero generic signal), and the post list `div.posts > div.post`
// which must never be touched.

const HOST = 'javeve-2026085.dgav37.com';
const URL_UNDER_TEST = `https://${HOST}/ja/list/44247.html`;
const FARM_DOMAINS = ['a1.com', 'a2.com', 'a3.com', 'a4.com', 'a5.com', 'a6.com', 'a7.com'];

const PAGE = `<!doctype html><html><head></head><body>
  <header class="header"><a href="/"><img class="logo" src="https://cache-2610.sgvafw.com/base/logo.webp"></a></header>

  <div class="content">
    <div class="posts clearfix">
      ${Array.from(
        { length: 3 },
        (_, i) => `<div class="post">
          <a class="img" href="/item/${i}" rel="bookmark">
            <img class="thumb" src="data:image/gif;base64,R0lGOD" style="display:inline">
            <span class="tag">标签</span>
          </a>
          <div class="con"><h3><a href="/item/${i}" rel="bookmark">条目标题</a></h3>
            <div class="meta"><span class="date">2026-01-01</span></div></div>
        </div>`,
      ).join('')}
    </div>
  </div>

  <div id="ads-tubiao"><div class="container-outer"><span class="icon-ad"></span>
    <span class="icon-image-container"><img class="icon-image" src="https://cache-2610.sgvafw.com/base/icon.webp"></span>
    <span class="icon-title">图标广告</span></div></div>

  <div id="ADSRANDOM" style="width:100%">
    <div id="streamer-container2-ABC123" class="streamer-container2">
      <ul id="streamer-box2-ABC123" class="streamer-box2">
        ${Array.from(
          { length: 10 },
          (_, i) => `<li><a href="/go/${i}" target="_blank" rel="noopener">
            <img src="https://cache-2610.sgvafw.com/base/aHR0cHM${i}"></a></li>`,
        ).join('')}
      </ul>
    </div>
  </div>

  <footer class="footer">
    <div class="container">
      <section class="footer-partners">
        <div class="footer-links footer-links--footer">
          <div id="script_seo_links" class="footer-links">
            ${FARM_DOMAINS.map((d) => `<a class="referrerLink" href="https://${d}/x" target="_blank">${d}</a>`).join('')}
          </div>
        </div>
      </section>
      <div class="nav"><div class="container"><a href="/about">关于</a><a href="/tos">条款</a></div></div>
      <div class="copyright"><div class="container">© 2026</div></div>
    </div>
  </footer>

  <article itemtype="http://schema.org/BlogPosting">
    <div id="refs">${Array.from({ length: 6 }, (_, i) => `<a href="https://ref${i}.org/x">参考${i}</a>`).join('')}</div>
  </article>
</body></html>`;

function makeDoc(): Document {
  return new JSDOM(PAGE, { url: URL_UNDER_TEST }).window.document;
}

function optionsFor(): JudgeOptions {
  const set = selectorsFrom([dgavPack], []);
  return {
    injected: () => false,
    host: HOST,
    viewportArea: 1600 * 900,
    selectors: set,
  };
}

const hidden = (el: Element | null): boolean => el?.closest('[data-adblow-hidden]') !== null;

describe('结构化回归：站点规则包与链接农场判据', () => {
  it('❗链接农场被判据抓住（跨站域名 >= 5）', () => {
    const doc = makeDoc();
    const farms = findLinkFarms(doc, { host: HOST });
    assert.equal(farms.length, 1);
    assert.equal(farms[0]!.id, 'script_seo_links', '应命中农场容器本身而不是整个 footer');
  });

  it('❗链接农场被隐藏，且页脚导航与版权未被牵连', () => {
    const doc = makeDoc();
    sweep(doc.documentElement, optionsFor());

    assert.ok(hidden(doc.querySelector('#script_seo_links')), '链接农场未被隐藏');
    const nav = doc.querySelector('footer .nav');
    const copyright = doc.querySelector('footer .copyright');
    assert.ok(!hidden(nav), '页脚导航被误伤');
    assert.ok(!hidden(copyright), '版权声明被误伤');
    assert.ok(!hidden(doc.querySelector('footer.footer')), '整个 footer 被误伤');
  });

  it('❗广告图片条被规则包选择器隐藏（零通用信号，只能靠规则包）', () => {
    const doc = makeDoc();
    sweep(doc.documentElement, optionsFor());
    assert.ok(hidden(doc.querySelector('.streamer-container2')), '广告图片条未被隐藏');
  });

  it('图标广告位被隐藏（命名档 + 规则包双重保障）', () => {
    const doc = makeDoc();
    sweep(doc.documentElement, optionsFor());
    assert.ok(hidden(doc.querySelector('#ads-tubiao')), '图标广告位未被隐藏');
  });

  it('❗正文列表、logo、文章内参考链接一律不动', () => {
    const doc = makeDoc();
    sweep(doc.documentElement, optionsFor());

    for (const post of Array.from(doc.querySelectorAll('.post'))) {
      assert.ok(!hidden(post), '.post 列表项被误伤');
    }
    assert.ok(!hidden(doc.querySelector('.posts')), '.posts 容器被误伤');
    assert.ok(!hidden(doc.querySelector('img.logo')), 'logo 被误伤（它在站点自己的 CDN 上）');
    assert.ok(
      !hidden(doc.querySelector('#refs')),
      '文章内的参考链接区块被误伤（那是作者写的内容）',
    );
  });

  it('统计一下确实隐藏了东西（否则这些断言没有意义）', () => {
    const doc = makeDoc();
    const r = sweep(doc.documentElement, optionsFor());
    assert.ok(
      r.hiddenByRule + r.hiddenByHeuristic >= 3,
      `隐藏数过少：rule=${r.hiddenByRule} heuristic=${r.hiddenByHeuristic}`,
    );
  });
});
