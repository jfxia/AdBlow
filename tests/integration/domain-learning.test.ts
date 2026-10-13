import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  isHidden,
  learnableAdDomains,
  makeInjectionTest,
  siteOwnedDomains,
  sweep,
  type JudgeOptions,
} from '../../src/content/engine.ts';
import { buildPristineIndexFromHtml } from '../../src/engine/pristine.ts';
import { selectorsFrom } from '../../src/content/engine.ts';
import { pilotPack } from '../../src/rules/sites/pilot.ts';

// Safety-filter regression for network-layer domain learning, covering two incidents
// where learning one domain broke a whole site: risk A (pic.wvxrrip.cn served both ad
// creatives and content thumbnails) and mirror domains (cgw666.com is the pilot site's
// canonical host and also hosts content images).

const PILOT = 'afford.gjvrohros.cc';
const PILOT2 = '1024cg.com';

const pilotFixture = readFileSync(
  new URL('../fixtures/pilot-category.html', import.meta.url),
  'utf8',
);
const secondFixture = readFileSync(
  new URL('../fixtures/1024cg-home.html', import.meta.url),
  'utf8',
);

const DOMParserImpl = new JSDOM('').window.DOMParser;

function docFor(html: string, host: string): Document {
  return new JSDOM(html, { url: `https://${host}/` }).window.document;
}

function optionsFor(doc: Document, host: string, selectors: string[]): JudgeOptions {
  const index = buildPristineIndexFromHtml(doc.documentElement.outerHTML, new DOMParserImpl());
  return {
    injected: makeInjectionTest(index, true),
    host,
    viewportArea: 1920 * 1080,
    selectors: { curated: selectors, learned: [] },
  };
}

describe('siteOwnedDomains：识别站点自有域名', () => {
  it('从 canonical / og / 图标提取', () => {
    const doc = docFor(
      `<html><head>
        <link rel="canonical" href="https://cgw666.com/x/">
        <meta property="og:image" content="https://cdn.example.net/a.jpg">
        <link rel="icon" href="/favicon.ico">
      </head><body></body></html>`,
      PILOT,
    );
    const owned = siteOwnedDomains(doc, PILOT);
    assert.ok(owned.has('cgw666.com'), JSON.stringify([...owned]));
    assert.ok(owned.has('example.net'));
    // A same-site icon is not an owned cross-site domain, but counting it is harmless.
    assert.ok(owned.size <= 3);
  });

  it('试点站 fixture 的 canonical 指向镜像域名', () => {
    const doc = docFor(pilotFixture, PILOT);
    const owned = siteOwnedDomains(doc, PILOT);
    assert.ok(owned.has('cgw666.com'), `未识别出镜像域名：${JSON.stringify([...owned])}`);
  });
});

describe('learnableAdDomains：只学「被隐藏广告独占」的域名', () => {
  it('被隐藏广告引用的跨站脚本域名会被学到', () => {
    // Uses script rather than img: media domains are never learned (see incident case below).
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><script src="https://adserver.example.com/s.js"></script></div>
      </body></html>`,
      PILOT,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT), ['example.com']);
  });

  it('被隐藏广告里的跨站 iframe 域名会被学到', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><iframe src="https://ads.example.net/frame"></iframe></div>
      </body></html>`,
      PILOT,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT), ['example.net']);
  });

  it('❗风险 A：也被可见内容使用的域名**绝不**学', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><img src="https://pic.wvxrrip.cn/ad-creative.jpeg"></div>
        <article itemtype="http://schema.org/BlogPosting">
          <img data-src="https://pic.wvxrrip.cn/upload_01/xiao/content-thumb.jpeg">
        </article>
      </body></html>`,
      PILOT,
    );
    const learnable = learnableAdDomains(doc, PILOT);
    assert.ok(
      !learnable.includes('wvxrrip.cn'),
      'pic.wvxrrip.cn 同时承载正文缩略图，学它会把正文图全废掉',
    );
  });

  it('❗镜像域名：canonical 指向的域名**绝不**学', () => {
    const doc = docFor(
      `<html><head><link rel="canonical" href="https://cgw666.com/category/x/"></head><body>
        <div data-adblow-hidden><img data-src="https://cgw666.com/upload_01/xiao/ad.jpeg"></div>
      </body></html>`,
      PILOT,
    );
    const learnable = learnableAdDomains(doc, PILOT);
    assert.ok(!learnable.includes('cgw666.com'), '镜像域名不能学');
  });

  it('被隐藏元素内部的资源才算；隐藏元素之后跟随的可见资源不算', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><script src="https://ads.example.com/a.js"></script></div>
        <script src="https://content.example.net/b.js"></script>
      </body></html>`,
      PILOT,
    );
    const learnable = learnableAdDomains(doc, PILOT);
    assert.deepEqual(learnable, ['example.com']);
    assert.ok(!learnable.includes('example.net'));
  });

  it('祖先被隐藏时，后代引用的域名也算广告域名', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><span><script src="https://ads.example.com/a.js"></script></span></div>
      </body></html>`,
      PILOT,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT), ['example.com']);
  });

  it('没有隐藏元素时不学任何东西', () => {
    const doc = docFor(
      `<html><head></head><body><img src="https://ads.example.com/a.png"></body></html>`,
      PILOT,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT), []);
  });

  it('只有 a[href] 的广告**会**产出可学域名（落地页域名，用于挡弹窗）', () => {
    // DNR rules exclude main_frame, so blocking a subresource cannot break <a href>
    // navigation: learning landing-page domains is safe and stops popups/forced redirects.
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><a href="https://00076049.com/landing"></a></div>
      </body></html>`,
      PILOT,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT), ['00076049.com']);
  });
});

describe('learnableAdDomains：跑在真实 fixture 上', () => {
  it('试点站：跑完清扫后，学到的域名里不含镜像域与素材 CDN', () => {
    const doc = docFor(pilotFixture, PILOT);
    sweep(doc.documentElement, optionsFor(doc, PILOT, selectorsFrom([pilotPack], []).curated));

    // Guard: the sweep must actually hide something, or this test proves nothing.
    assert.ok(doc.querySelectorAll('[data-adblow-hidden]').length > 0, '清扫未隐藏任何元素');

    const learnable = learnableAdDomains(doc, PILOT);
    for (const forbidden of ['cgw666.com', 'wvxrrip.cn', 'gjvrohros.cc']) {
      assert.ok(!learnable.includes(forbidden), `学到了不该学的域名 ${forbidden}`);
    }
  });

  it('❗❗ 事故回归：内容图尚未懒加载出来时，共用 CDN 绝不能被学走', () => {
    // Regression: every image on 1024cg's home page vanished. Content thumbnails and
    // ad creatives shared one CDN, and the lazy-loading thumbnails had no src yet when
    // the "used by visible content" check ran, so the CDN was learned and then blocked
    // wholesale. Now any domain that has served media on the page is never learned.
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><img src="https://pic.jtzatly.cn/ad-creative.jpeg"></div>
        <article itemtype="http://schema.org/BlogPosting">
          <img class="lazy" src="/placeholder.png">
        </article>
      </body></html>`,
      PILOT2,
    );
    const learnable = learnableAdDomains(doc, PILOT2);
    assert.ok(
      !learnable.includes('jtzatly.cn'),
      '共用 CDN 被学走了 —— 这会让整站图片不显示',
    );
  });

  it('被隐藏广告里的图片域名不学（哪怕它不在可见内容里）', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><img src="https://ads.example.com/creative.png"></div>
      </body></html>`,
      PILOT2,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT2), []);
  });

  it('只做点击跳转（a[href]）的域名仍然可以学 —— 它不承载媒体', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden><a href="https://00076049.com/landing"></a></div>
      </body></html>`,
      PILOT2,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT2), ['00076049.com']);
  });

  it('同一域名既被广告外链又被广告图片引用时不学（媒体优先）', () => {
    const doc = docFor(
      `<html><head></head><body>
        <div data-adblow-hidden>
          <a href="https://mixed.example.com/landing"></a>
          <img src="https://mixed.example.com/creative.png">
        </div>
      </body></html>`,
      PILOT2,
    );
    assert.deepEqual(learnableAdDomains(doc, PILOT2), []);
  });

  it('第二站点：跑完清扫后能学到广告落地页域名', () => {
    const doc = docFor(secondFixture, PILOT2);
    sweep(doc.documentElement, optionsFor(doc, PILOT2, []));

    const learnable = learnableAdDomains(doc, PILOT2);
    assert.ok(doc.querySelectorAll('[data-adblow-hidden]').length > 0, '清扫未隐藏任何元素');
    assert.ok(
      learnable.length > 0,
      '第二站点的广告卡里有一批随机跨站落地页域名，应当学到它们',
    );
    // Learned domains must be cross-site and must not be the site's own.
    for (const d of learnable) {
      assert.ok(!d.endsWith('1024cg.com'), `学到了站点自己的域名 ${d}`);
    }
  });
});
