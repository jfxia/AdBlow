import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crossSiteResourceDomains, resourceUrls } from '../../src/engine/domains.ts';

const HOST = 'afford.gjvrohros.cc';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('resourceUrls：只取会加载资源的属性', () => {
  it('img 的 src / data-src', () => {
    assert.deepEqual(resourceUrls(el('<img src="/a.png" data-src="https://x.cc/b.png">')), [
      '/a.png',
      'https://x.cc/b.png',
    ]);
  });

  it('script / link / iframe', () => {
    assert.deepEqual(resourceUrls(el('<script src="https://a.cc/s.js"></script>')), [
      'https://a.cc/s.js',
    ]);
    assert.deepEqual(resourceUrls(el('<link rel="stylesheet" href="https://a.cc/s.css">')), [
      'https://a.cc/s.css',
    ]);
    assert.deepEqual(resourceUrls(el('<iframe src="https://a.cc/f"></iframe>')), ['https://a.cc/f']);
  });

  it('不把 a[href] 当资源（那是点击目标，不是加载）', () => {
    assert.deepEqual(resourceUrls(el('<a href="https://spam.example.com/x"></a>')), []);
  });
});

describe('crossSiteResourceDomains：提取跨站可注册域名', () => {
  it('取出跨站域名', () => {
    const domains = crossSiteResourceDomains(
      el('<div><img src="https://pic.jtzatly.cn/a.jpeg"><script src="https://ads.example.com/s.js"></script></div>'),
      HOST,
    );
    assert.deepEqual(domains.sort(), ['example.com', 'jtzatly.cn']);
  });

  it('排除相对地址与同站地址', () => {
    const domains = crossSiteResourceDomains(
      el('<div><img src="/local.png"><img src="https://afford.gjvrohros.cc/a.png"><img src="https://cdn.gjvrohros.cc/b.png"></div>'),
      HOST,
    );
    assert.deepEqual(domains, []);
  });

  it('协议相对地址按真实主机判定', () => {
    assert.deepEqual(crossSiteResourceDomains(el('<img src="//ads.example.com/a.png">'), HOST), [
      'example.com',
    ]);
  });

  it('递归整棵子树', () => {
    const domains = crossSiteResourceDomains(
      el('<div><p><span><img src="https://deep.example.net/a.png"></span></p></div>'),
      HOST,
    );
    assert.deepEqual(domains, ['example.net']);
  });

  it('可注册域名按末两段归并（同域多个子域只算一个）', () => {
    const domains = crossSiteResourceDomains(
      el('<div><img src="https://a.example.com/1.png"><img src="https://b.example.com/2.png"></div>'),
      HOST,
    );
    assert.deepEqual(domains, ['example.com']);
  });

  it('忽略 a[href]（避免把广告落地页当成要拦截的加载域名）', () => {
    const domains = crossSiteResourceDomains(
      el('<article class="ad-item"><a href="https://00076049.com/landing"></a></article>'),
      HOST,
    );
    assert.deepEqual(domains, []);
  });

  it('无法解析的地址不抛异常', () => {
    assert.doesNotThrow(() => crossSiteResourceDomains(el('<img src="http://[">'), HOST));
  });

  it('空元素返回空数组', () => {
    assert.deepEqual(crossSiteResourceDomains(el('<div></div>'), HOST), []);
  });
});
