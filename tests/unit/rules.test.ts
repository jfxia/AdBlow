import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSitePack, type SitePack } from '../../src/engine/rules.ts';
import { toDnrRules } from '../../src/engine/dnr.ts';

const good: SitePack = {
  id: 'pilot',
  matches: ['*://afford.gjvrohros.cc/*', '*://cgw666.com/*'],
  network: [
    { kind: 'domain', value: 'apiad01.cc', resourceTypes: ['xmlhttprequest'] },
    { kind: 'path', value: '/ad-sdk-v', resourceTypes: ['script'] },
  ],
  cosmetic: ['[data-ssp-slot-node]', '[data-ssp-slot-root]', '.xqbj-component-ssp-float-icon'],
};

describe('validateSitePack', () => {
  it('接受合法规则包', () => {
    assert.deepEqual(validateSitePack(good), []);
  });

  it('拒绝隐藏广告容器的规则（会抹掉正文列表）', () => {
    const bad: SitePack = { ...good, cosmetic: ['[data-ssp-container]'] };
    assert.match(validateSitePack(bad).join(), /data-ssp-container/);
  });

  it('拒绝裸 .post-card 规则（全站 110 个 div 在用）', () => {
    const bad: SitePack = { ...good, cosmetic: ['.post-card'] };
    assert.match(validateSitePack(bad).join(), /post-card/);
  });

  it('拒绝拉黑素材 CDN（同时承载正文缩略图）', () => {
    const bad: SitePack = {
      ...good,
      network: [{ kind: 'domain', value: 'pic.wvxrrip.cn', resourceTypes: ['image'] }],
    };
    assert.match(validateSitePack(bad).join(), /pic\.wvxrrip\.cn/);
  });
});

describe('toDnrRules', () => {
  it('把 domain 规则编译成 DNR 条件', () => {
    const rules = toDnrRules(
      [{ kind: 'domain', value: 'apiad01.cc', resourceTypes: ['xmlhttprequest'] }],
      1000,
    );
    assert.deepEqual(rules[0]!.action, { type: 'block' });
    assert.equal(rules[0]!.condition.urlFilter, '||apiad01.cc^');
    assert.ok(rules[0]!.priority > 0);
  });

  it('把 path 规则编译成不绑域名的 urlFilter', () => {
    const rules = toDnrRules(
      [{ kind: 'path', value: '/ad-sdk-v', resourceTypes: ['script'] }],
      2000,
    );
    assert.equal(rules[0]!.condition.urlFilter, '/ad-sdk-v');
    assert.deepEqual(rules[0]!.condition.resourceTypes, ['script']);
  });

  it('id 连续且不重复', () => {
    const rules = toDnrRules(good.network, 500);
    const ids = rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
