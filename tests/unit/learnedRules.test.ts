import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNED_DOMAIN_ID_BASE,
  SUBRESOURCE_TYPES,
  learnedDomainRules,
} from '../../src/engine/learnedRules.ts';

describe('learnedDomainRules：自学习域名 → DNR 拦截规则', () => {
  it('编译成 ||domain^ 形式', () => {
    const rules = learnedDomainRules(['ads.example.com']);
    assert.equal(rules[0]!.condition.urlFilter, '||ads.example.com^');
    assert.deepEqual(rules[0]!.action, { type: 'block' });
  });

  it('❗绝不拦 main_frame（否则用户主动点击会直接导航失败）', () => {
    const rules = learnedDomainRules(['ads.example.com']);
    assert.ok(
      !rules[0]!.condition.resourceTypes.includes('main_frame'),
      '学习到的域名绝不能拦主文档',
    );
    assert.ok(!SUBRESOURCE_TYPES.includes('main_frame'));
  });

  it('❗❗绝不拦 image / media（事故回归：曾导致整站图片不显示）', () => {
    // Incident 2026-10-10: every image on 1024cg vanished — content thumbnails and ad
    // creatives shared one CDN, so learning the domain blocked the content images too.
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    assert.ok(!types.includes('image'), '自学习规则不得拦图片');
    assert.ok(!types.includes('media'), '自学习规则不得拦音视频');
    assert.ok(!SUBRESOURCE_TYPES.includes('image'));
    assert.ok(!SUBRESOURCE_TYPES.includes('media'));
  });

  it('❗❗绝不拦 script / stylesheet / font（事故回归：曾让整页渲染崩掉）', () => {
    // Incident 2026-10-13: a video site's player and recommendation rail vanished. Its own
    // CDN served the site's CSS/JS and player libs; learning it as an ad domain blocked them
    // and broke rendering. Structural guarantee: learned rules can never break a page's own
    // styles or scripts.
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    for (const t of ['script', 'stylesheet', 'font']) {
      assert.ok(!types.includes(t as never), `自学习规则不得拦 ${t}`);
      assert.ok(!SUBRESOURCE_TYPES.includes(t as never));
    }
  });

  it('覆盖真正有价值的类型（弹窗 / 信标 / 追踪）', () => {
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    for (const t of ['sub_frame', 'xmlhttprequest', 'ping', 'websocket', 'object']) {
      assert.ok(types.includes(t as never), `缺少资源类型 ${t}`);
    }
  });

  it('❗爆炸半径：只在教会它的站点上生效', () => {
    // "This domain is an ad domain here" does not mean "there too": a third-party CDN shared
    // by many sites can be A's ad host and B's own resource host.
    const rules = learnedDomainRules([
      { domain: 'ads.example.com', initiators: ['a.com', 'b.com', 'a.com'] },
    ]);
    assert.deepEqual(rules[0]!.condition.initiatorDomains, ['a.com', 'b.com'], '去重并排序');
  });

  it('兼容纯字符串入参（不写 initiatorDomains）', () => {
    const rules = learnedDomainRules(['ads.example.com']);
    assert.equal('initiatorDomains' in rules[0]!.condition, false);
  });

  it('按站点豁免：用户关掉的站点下不生效', () => {
    const rules = learnedDomainRules(['ads.example.com'], ['off.cc', 'off.cc', '']);
    assert.deepEqual(rules[0]!.condition.excludedInitiatorDomains, ['off.cc']);
  });

  it('没有豁免站点时不写这个字段（避免生成无意义的空数组）', () => {
    const rules = learnedDomainRules(['ads.example.com'], []);
    assert.equal('excludedInitiatorDomains' in rules[0]!.condition, false);
  });

  it('id 落在专用区间且不重复', () => {
    const rules = learnedDomainRules(['a.cc', 'b.cc', 'c.cc']);
    const ids = rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id >= LEARNED_DOMAIN_ID_BASE));
    // Must not overlap the site-pack id range (starts at 10000).
    assert.ok(Math.min(...ids) > 19999);
  });

  it('空列表产出空数组', () => {
    assert.deepEqual(learnedDomainRules([]), []);
  });

  it('priority 为正（DNR 要求）', () => {
    assert.ok(learnedDomainRules(['a.cc'])[0]!.priority > 0);
  });
});
