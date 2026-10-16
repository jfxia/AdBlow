import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareRuleText, sortByHost, sortByRule } from '../../src/ui/ruleSorting.ts';

/**
 * 规则管理页的排序：站点按域名、站点内按规则文本。
 * 起因：页面此前按存储返回顺序渲染，规则一多就像随机排列。
 * 这些断言同时锁住"与浏览器区域设置无关"这一点（不用 localeCompare）。
 */
describe('compareRuleText', () => {
  it('字母顺序，且大小写不敏感', () => {
    assert.ok(compareRuleText('a.example', 'b.example') < 0);
    assert.ok(compareRuleText('B.example', 'a.example') > 0);
    assert.equal(compareRuleText('ad.example', 'ad.example'), 0);
  });

  it('大小写不同的同名字符串有稳定次序（不会逐次渲染互换）', () => {
    assert.ok(compareRuleText('Ad.example', 'ad.example') < 0);
    assert.ok(compareRuleText('ad.example', 'Ad.example') > 0);
  });

  it('按代码位比较，不受区域设置影响', () => {
    // '#'(0x23) < '.'(0x2e) < 'd'，选择器排序应与字符本身一致
    assert.ok(compareRuleText('#ad', '.ad') < 0);
    assert.ok(compareRuleText('.ad', 'div.ad') < 0);
  });
});

describe('sortByHost / sortByRule', () => {
  const sites = [
    { host: 'zeta.example', entries: [{ selector: 'div.b' }, { selector: '.a' }] },
    { host: 'Alpha.example', entries: [{ selector: '#z' }, { selector: '.m' }] },
    { host: 'beta.example', entries: [] },
  ];

  it('站点按域名升序（大小写不敏感）', () => {
    assert.deepEqual(
      sortByHost(sites, (s) => s.host).map((s) => s.host),
      ['Alpha.example', 'beta.example', 'zeta.example'],
    );
  });

  it('站点内规则按规则文本升序', () => {
    assert.deepEqual(
      sortByRule(sites[0]!.entries, (e) => e.selector).map((e) => e.selector),
      ['.a', 'div.b'],
    );
    assert.deepEqual(
      sortByRule(sites[1]!.entries, (e) => e.selector).map((e) => e.selector),
      ['#z', '.m'],
    );
  });

  it('不改动入参（返回新数组）', () => {
    const original = [...sites];
    sortByHost(sites, (s) => s.host);
    assert.deepEqual(sites, original);
  });

  it('学习到的广告域名同样可用于排序', () => {
    const entries = [{ host: 'tracker.example' }, { host: 'ads.example' }, { host: 'cdn.example' }];
    assert.deepEqual(
      sortByRule(entries, (e) => e.host).map((e) => e.host),
      ['ads.example', 'cdn.example', 'tracker.example'],
    );
  });
});
