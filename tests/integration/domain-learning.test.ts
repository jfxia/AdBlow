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

/**
 * 网络层自学习的**安全过滤**回归。
 *
 * 这里守的是两起「学错一个域名就把整站搞坏」的事故：
 *   风险 A：pic.wvxrrip.cn 既是广告素材 CDN 又是正文缩略图 CDN
 *   镜像域：cgw666.com 是试点站的 canonical 域名且托管正文图
 */

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
    // 同站图标不应被算成"自有跨站域名"，但算进去也无害
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
    // 用 script 而不是 img：媒体域名一律不学（见上面的事故回归用例）
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
    // 拦截子资源不影响 <a href> 导航（DNR 规则排除 main_frame），
    // 所以学落地页域名是安全的，而且能挡住弹窗与强制跳转。
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

    // 确认清扫确实隐藏了东西（否则这条测试没有意义）
    assert.ok(doc.querySelectorAll('[data-adblow-hidden]').length > 0, '清扫未隐藏任何元素');

    const learnable = learnableAdDomains(doc, PILOT);
    for (const forbidden of ['cgw666.com', 'wvxrrip.cn', 'gjvrohros.cc']) {
      assert.ok(!learnable.includes(forbidden), `学到了不该学的域名 ${forbidden}`);
    }
  });

  it('❗❗ 事故回归：内容图尚未懒加载出来时，共用 CDN 绝不能被学走', () => {
    // 这是 1024cg 首页「所有图片都不显示」的直接原因：
    //   - 内容缩略图与广告素材共用同一个 CDN（pic.jtzatly.cn 之类）
    //   - 内容缩略图是**懒加载**的，检查时它的 src/data-src 还没填上
    //   - 于是「是否被可见内容使用」这一判断被骗过，域名被学走并晋级，
    //     随后网络层把该 CDN 全部拦掉 —— 整站图片不显示
    // 现在改成结构性判断：只要某域名在本页充当过**媒体来源**，一律不学。
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
    // 学到的域名必须是跨站的，且不能是站点自己
    for (const d of learnable) {
      assert.ok(!d.endsWith('1024cg.com'), `学到了站点自己的域名 ${d}`);
    }
  });
});
