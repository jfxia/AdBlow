import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findLinkFarms, hideElement, HIDDEN_ATTR } from '../../src/content/engine.ts';
import { scoreNode, unwrapAdRedirect, unwrapCdnUrl } from '../../src/engine/score.ts';

/**
 * 「地址包装」的两类解包 —— 2026-10-13 用户反馈"广告图片并未被屏蔽"后的修复。
 *
 * 背景：站点把广告链接与广告素材都**包装过**，让基于"跨站"的判据完全失效：
 *   ① 素材：`https://cache-2610.sgvafw.com/base/<base64 of 广告图真实地址>.cache`
 *      —— 看起来与内容图同源（同一个 CDN 域名）
 *   ② 链接：`http://<本站>/traffic/go?t=<base64 {"kind":"ad","url":"https://广告落地页"}>`
 *      —— 看起来是同站链接
 * 结果是整个广告轮播容器（`ul.streamer-box2`，10 个广告位）完全没被隐藏。
 */

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
    // 两者都走同一个 CDN 域名；不还原的话跨站判据完全失效
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
    // 实测形态：ul.streamer-box2（30+ 后代，超过"紧凑"阈值，后代证据不被采信）
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
