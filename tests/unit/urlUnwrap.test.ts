import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findLinkFarms, hideElement, HIDDEN_ATTR } from '../../src/content/engine.ts';
import { scoreNode, unwrapAdRedirect, unwrapCdnUrl } from '../../src/engine/score.ts';

// The two URL wrappers that had to be unwrapped — fixed after the 2026-10-13 report that ad
// images were still not blocked. The site wrapped both ad creatives (base64 inside the CDN
// path, so they looked same-origin, sharing the content images' CDN domain) and ad links
// (base64 payload in a same-site /traffic/go URL). Cross-site judging failed entirely and the
// whole carousel container (ul.streamer-box2, 10 ad slots) went unhidden.

const HOST = 'www.example.com';

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('unwrapCdnUrl：还原站点 CDN 的 base64 包装', () => {
  it('还原出真实来源地址', () => {
    const real = 'https://n0228.cdn.svlqgh.com/img/a.png';
    const wrapped = `https://cache-2610.sgvafw.com/base/${b64(real)}.cache`;
    assert.equal(unwrapCdnUrl(wrapped), real);
  });

  it('不是包装的地址原样返回', () => {
    for (const url of [
      'https://cdn.example.com/a.png',
      'https://cache-2610.sgvafw.com/base/not-base64!!.cache',
      '/images/a.png',
    ]) {
      assert.equal(unwrapCdnUrl(url), url);
    }
  });

  it('❗还原后才分得清"广告素材"与"内容图"', () => {
    // Both live on the same CDN domain; without unwrapping, cross-site judging fails entirely.
    const adImg = `https://cache-2610.sgvafw.com/base/${b64('https://ads.bad.net/a.png')}.cache`;
    const contentImg = `https://cache-2610.sgvafw.com/base/${b64('https://fourhoi.com/x.jpg')}.cache`;
    assert.equal(new URL(unwrapCdnUrl(adImg)).hostname, 'ads.bad.net');
    assert.equal(new URL(unwrapCdnUrl(contentImg)).hostname, 'fourhoi.com');
  });
});

describe('unwrapAdRedirect：识别自家域名跳转包装的广告', () => {
  const payload = (url: string): string =>
    `https://${HOST}/traffic/go?t=${b64(JSON.stringify({ kind: 'ad', id: 1, url, host: HOST }))}`;

  it('载荷声明 kind=ad → 判定为广告并取出落地页', () => {
    const r = unwrapAdRedirect(payload('https://153.43.231.211:63776/?cid=1'), `https://${HOST}`);
    assert.equal(r.declaredAd, true);
    assert.equal(r.target, 'https://153.43.231.211:63776/?cid=1');
  });

  it('普通站内链接 → 空结果', () => {
    assert.deepEqual(unwrapAdRedirect(`https://${HOST}/zh/videos/x`, `https://${HOST}`), {
      declaredAd: false,
      target: null,
    });
    assert.deepEqual(unwrapAdRedirect(`https://${HOST}/a?b=c`, `https://${HOST}`), {
      declaredAd: false,
      target: null,
    });
  });

  it('❗载荷声明是广告时，按跨站外链同分计（否则容器判不出来）', () => {
    const html =
      `<div class="streamer">` +
      ['a', 'b', 'c'].map((x) => `<a href="${payload(`https://ads-${x}.net/`)}">${x}</a>`).join('') +
      `</div>`;
    const el = root(html).firstElementChild!;
    const r = scoreNode(el, { pageHost: HOST, viewportArea: 1600 * 900 });
    assert.ok(r.reasons.includes('ad-redirect-link'), `证据: ${r.reasons.join(',')}`);
    assert.ok(r.behavior >= 12, `三条广告跳转链接应计 12 分，实际 ${r.behavior}`);
  });

  it('只是包装了外链（未声明广告）只给低分，不能单独触发隐藏', () => {
    const wrapped = `https://${HOST}/go?u=${b64('https://partner.example.net/x')}`;
    const el = root(`<div class="zzz"><a href="${wrapped}">x</a></div>`).firstElementChild!;
    const r = scoreNode(el, { pageHost: HOST, viewportArea: 1600 * 900 });
    assert.ok(r.reasons.includes('wrapped-cross-site-link'));
    assert.ok(r.behavior < 6, `未声明广告的包装不应够到隐藏门槛，实际 ${r.behavior}`);
  });
});

describe('聚合趟：自家域名跳转广告块', () => {
  const payload = (url: string): string =>
    `https://${HOST}/traffic/go?t=${b64(JSON.stringify({ kind: 'ad', url }))}`;
  const adLinks = (n: number): string =>
    Array.from({ length: n }, (_, i) => `<a href="${payload(`https://ads-${i}.net/`)}">${i}</a>`).join('');

  it('❗带广告命名 + ≥3 个声明广告的跳转链接 → 判为广告块', () => {
    // Real shape: ul.streamer-box2 with 30+ descendants, past the "compact" threshold, so its
    // descendant evidence is ignored.
    const doc = root(`<div><ul class="streamer-box2">${adLinks(10)}</ul></div>`);
    const farms = findLinkFarms(doc, { host: HOST });
    assert.deepEqual(
      farms.map((e) => e.className),
      ['streamer-box2'],
    );
  });

  it('❗没有广告命名的通用包装不算（实测误伤：div.text-center 里夹着几个广告链接）', () => {
    const doc = root(`<div><div class="text-center">${adLinks(10)}</div></div>`);
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), [], '通用包装不得被当成广告块');
  });

  it('数量不足（<3）时不算', () => {
    const doc = root(`<div><ul class="streamer-box2">${adLinks(2)}</ul></div>`);
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });

  it('已经隐藏过该块的容器不会被再吃一层', () => {
    const doc = root(`<div><ul class="streamer-box2">${adLinks(10)}</ul></div>`);
    const inner = doc.querySelector('.streamer-box2')!;
    hideElement(inner, 'linkfarm');
    assert.equal(inner.getAttribute(HIDDEN_ATTR), '1');
    assert.deepEqual(findLinkFarms(doc, { host: HOST }), []);
  });
});
