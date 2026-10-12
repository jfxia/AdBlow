import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSitePack } from '../../src/engine/rules.ts';
import { SITE_PACKS, packsForUrl } from '../../src/rules/sites/index.ts';
import { dgavPack } from '../../src/rules/sites/dgav.ts';

/**
 * dgav37.com 系列站点规则包（用户反馈驱动，2026-10-10 取证）。
 *
 * 这个包的存在理由要写清：该站广告块**没有任何通用信号** ——
 * 广告图与 logo 共用同一个 CDN、外链指向本站、类名不含广告词、
 * 容器后代过多导致行为分不采信。唯一证据是站点自己的 `/css/inner-ads.css`。
 * 因此规则包是唯一可靠手段。
 */

/** 简易匹配器，语义与 chrome 的 match pattern 一致（只支持 * 通配）。 */
function matchPattern(pattern: string, url: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return re.test(url);
}

describe('dgavPack：必须通过误伤护栏', () => {
  it('validateSitePack 无任何问题', () => {
    assert.deepEqual(validateSitePack(dgavPack), []);
  });

  it('❗不得包含站点自己的资源 CDN（logo 与正文缩略图都在上面）', () => {
    const values = dgavPack.network.map((r) => r.value).join(' ');
    assert.ok(!values.includes('sgvafw.com'), 'sgvafw.com 是站点自己的 CDN，拉黑会废掉 logo 与缩略图');
    assert.ok(!dgavPack.cosmetic.join(' ').includes('sgvafw'));
  });

  it('❗不得隐藏列表正文（.post / .posts 是内容区）', () => {
    const cosmetic = dgavPack.cosmetic.join(' ');
    assert.ok(!/(^|[\s,>])\.post(?![\w-])/.test(cosmetic), '不得命中 .post');
    assert.ok(!/(^|[\s,>])\.posts(?![\w-])/.test(cosmetic), '不得命中 .posts');
  });

  it('❗只拦注入器脚本，不拦广告样式表（拦 CSS 会让广告块失去样式反而更扎眼）', () => {
    for (const r of dgavPack.network) {
      assert.ok(!r.value.includes('inner-ads.css'), '不应拦 inner-ads.css');
    }
  });

  it('网络规则的资源类型里不含 main_frame / image / media', () => {
    for (const r of dgavPack.network) {
      assert.ok(!r.resourceTypes.includes('main_frame'), `${r.value} 不得拦主文档`);
      assert.ok(!r.resourceTypes.includes('image'), `${r.value} 不应拦图片`);
      assert.ok(!r.resourceTypes.includes('media'), `${r.value} 不应拦媒体`);
    }
  });

  it('partners.js 的拦截用 regex 限定在本站（避免误伤别站同名文件）', () => {
    const rule = dgavPack.network.find((r) => r.value.includes('partners'));
    assert.ok(rule, '应有一条针对 partners.js 的规则');
    assert.equal(rule!.kind, 'regex');
    const re = new RegExp(rule!.value);
    assert.ok(re.test('https://javeve-2026085.dgav37.com/js/partners.js?v=1'), '应命中本站');
    assert.ok(re.test('https://dgav37.com/js/partners.js'), '应命中主域');
    assert.ok(!re.test('https://other-site.com/js/partners.js'), '不应命中别的站点');
  });
});

describe('dgavPack：取证过的选择器', () => {
  it('覆盖链接农场的服务端与注入两种形态', () => {
    for (const sel of ['#script_seo_links', '[data-javeve-partners]', '.javeve-partners', 'a.referrerLink']) {
      assert.ok(dgavPack.cosmetic.includes(sel), `缺少链接农场选择器 ${sel}`);
    }
  });

  it('覆盖 inner-ads.css 里的广告图片条与图标广告位', () => {
    for (const sel of ['.streamer-container2', '.streamer-box2', '#ads-tubiao']) {
      assert.ok(dgavPack.cosmetic.includes(sel), `缺少广告块选择器 ${sel}`);
    }
  });

  it('规则包能匹配到该系列站点的子域', () => {
    const matched = packsForUrl(
      'https://javeve-2026085.dgav37.com/ja/list/44247.html',
      matchPattern,
    );
    assert.ok(
      matched.some((p) => p.id === 'dgav-javeve'),
      '子域也应命中该规则包',
    );
  });
});

describe('全部内置规则包', () => {
  it('每一个都通过误伤护栏', () => {
    for (const pack of SITE_PACKS) {
      assert.deepEqual(validateSitePack(pack), [], `规则包 ${pack.id} 未通过护栏`);
    }
  });

  it('id 不重复', () => {
    const ids = SITE_PACKS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
