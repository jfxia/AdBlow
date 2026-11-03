import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORK_RULE_EXCEPTIONS,
  isNetworkRuleException,
} from '../../src/engine/filterList/networkExceptions.ts';

test('Reddit 的 sentry 分块规则被排除（实测导致页面停住）', () => {
  assert.equal(isNetworkRuleException('||redditstatic.com/shreddit/sentry-'), true);
});

test('此前两条 Reddit 规则仍在例外表里', () => {
  assert.equal(isNetworkRuleException('||reddit.com/api/jail^'), true);
  assert.equal(isNetworkRuleException('||embed.reddit.com/svc/shreddit'), true);
});

test('只按完整 urlFilter 精确匹配', () => {
  assert.equal(isNetworkRuleException('||reddit.com/api/'), false, '前缀相同不命中');
  assert.equal(isNetworkRuleException('||reddit.com/api/jail'), false, '缺少 ^ 不命中');
  assert.equal(isNetworkRuleException('||redditstatic.com/shreddit/'), false, '分块前缀不命中');
  assert.equal(isNetworkRuleException('||redditstatic.com^'), false, '域名锚点不命中');
});

test('首尾空白被忽略', () => {
  assert.equal(isNetworkRuleException('  ||redditstatic.com/shreddit/sentry-  '), true);
});

test('每条例外都写明了理由，且长度足以判断', () => {
  for (const entry of NETWORK_RULE_EXCEPTIONS) {
    assert.ok(entry.reason.length >= 40, `${entry.urlFilter} 的理由太短`);
  }
});

test('例外表里没有重复条目', () => {
  const seen = new Set();
  for (const entry of NETWORK_RULE_EXCEPTIONS) {
    assert.equal(seen.has(entry.urlFilter), false, `重复: ${entry.urlFilter}`);
    seen.add(entry.urlFilter);
  }
});
