import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANARY_SITES,
  canStall,
  domainsInRule,
  findingKey,
  hostMatchesDomain,
  inspectRuleSet,
  newFindings,
} from '../../src/engine/filterList/ownDomainRisk.ts';

const rule = (over) => ({ id: 1, action: { type: 'block' }, condition: {}, ...over });

test('Reddit sentry 规则会被高亮（这次的根因形态）', () => {
  const findings = inspectRuleSet(
    [rule({ id: 15753, condition: { urlFilter: '||redditstatic.com/shreddit/sentry-', resourceTypes: ['script'] } })],
    'list-4.json',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].site, 'reddit');
  assert.equal(findings[0].types, 'script');
});

test('只拦图片不算停住风险', () => {
  assert.equal(canStall(rule({ condition: { urlFilter: '||redditstatic.com/x.png', resourceTypes: ['image'] } })), false);
});

test('不限类型的 block 规则算风险', () => {
  assert.equal(canStall(rule({ condition: { urlFilter: '||redditstatic.com^' } })), true);
});

test('allow 规则不算风险', () => {
  assert.equal(canStall(rule({ action: { type: 'allow' }, condition: { urlFilter: '||reddit.com/x' } })), false);
});

test('域名按标签边界匹配：notreddit.com 不算 reddit.com', () => {
  assert.equal(hostMatchesDomain('www.reddit.com', 'reddit.com'), true);
  assert.equal(hostMatchesDomain('reddit.com', 'reddit.com'), true);
  assert.equal(hostMatchesDomain('notreddit.com', 'reddit.com'), false);
  const hit = domainsInRule(rule({ condition: { urlFilter: '||notreddit.com/x', resourceTypes: ['script'] } }), ['reddit.com']);
  assert.deepEqual(hit, []);
});

test('无关域名不产生命中', () => {
  assert.equal(
    inspectRuleSet([rule({ condition: { urlFilter: '||ads.example/x', resourceTypes: ['script'] } })], 'list-1.json').length,
    0,
  );
});

test('新条目与基线比较：已有条目不算新', () => {
  const findings = inspectRuleSet([rule({ id: 7, condition: { urlFilter: '||reddit.com/a', resourceTypes: ['script'] } })], 'list-1.json');
  const key = findingKey(findings[0]);
  assert.equal(newFindings(findings, [key]).length, 0);
  assert.equal(newFindings(findings, []).length, 1);
});

test('清单里的每个站点都配了自有域名', () => {
  for (const site of CANARY_SITES) {
    assert.ok(site.ownDomains.length > 0, site.name);
  }
});
