import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_RULE_EXCEPTIONS,
  isNetworkRuleException,
} from '../../src/engine/filterList/networkExceptions.ts';

test('Reddit 的两条网络规则被排除', () => {
  assert.equal(isNetworkRuleException('||reddit.com/api/jail^'), true);
  assert.equal(isNetworkRuleException('||embed.reddit.com/svc/shreddit'), true);
});

test('只按完整 urlFilter 精确匹配', () => {
  assert.equal(isNetworkRuleException('||reddit.com/api/'), false, '前缀相同不命中');
  assert.equal(isNetworkRuleException('||reddit.com/api/jail'), false, '缺少 ^ 不命中');
  assert.equal(isNetworkRuleException('||reddit.com^'), false, '域名锚点不命中');
});

test('首尾空白被忽略', () => {
  assert.equal(isNetworkRuleException('  ||reddit.com/api/jail^  '), true);
});

test('每条例外都写明了理由', () => {
  for (const entry of NETWORK_RULE_EXCEPTIONS) {
    assert.ok(entry.reason.length >= 20, `${entry.urlFilter} 的理由太短`);
  }
});
