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
    // 2026-10-10 真实事故：1024cg 首页所有图片不显示。
    // 内容缩略图与广告素材共用同一个 CDN，域名被学走后连带把正文图一起拦掉了。
    // 结构性保证：自学习来的网络规则**永远不可能弄坏页面的图片与视频**。
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    assert.ok(!types.includes('image'), '自学习规则不得拦图片');
    assert.ok(!types.includes('media'), '自学习规则不得拦音视频');
    assert.ok(!SUBRESOURCE_TYPES.includes('image'));
    assert.ok(!SUBRESOURCE_TYPES.includes('media'));
  });

  it('覆盖常见子资源类型', () => {
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    for (const t of ['script', 'xmlhttprequest', 'sub_frame', 'ping', 'stylesheet']) {
      assert.ok(types.includes(t as never), `缺少资源类型 ${t}`);
    }
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
    // 与站点规则包的区间（10000 起）不重叠
    assert.ok(Math.min(...ids) > 19999);
  });

  it('空列表产出空数组', () => {
    assert.deepEqual(learnedDomainRules([]), []);
  });

  it('priority 为正（DNR 要求）', () => {
    assert.ok(learnedDomainRules(['a.cc'])[0]!.priority > 0);
  });
});
