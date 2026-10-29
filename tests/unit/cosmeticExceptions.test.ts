import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COSMETIC_EXCEPTIONS,
  isCosmeticException,
  isCosmeticExceptionRaw,
} from '../../src/engine/filterList/cosmeticExceptions.ts';

test('新浪财经个股页的研报面板规则被排除', () => {
  assert.equal(isCosmeticException('finance.sina.com.cn', '.m-s-tab + div'), true);
});

test('只按精确域名与选择器匹配', () => {
  assert.equal(isCosmeticException('finance.sina.com.cn', '.m-s-tab'), false, '选择器不同不命中');
  assert.equal(isCosmeticException('www.finance.sina.com.cn', '.m-s-tab + div'), false, '子域不命中');
  assert.equal(isCosmeticException('finance.sina.com.cn', '.m-s-tab + div .x'), false, '前缀相同不命中');
});

test('大小写与空白被规范化', () => {
  assert.equal(isCosmeticException(' Finance.Sina.Com.Cn ', '.m-s-tab + div '), true);
});

test('每条例外都写明了理由', () => {
  for (const entry of COSMETIC_EXCEPTIONS) {
    assert.ok(entry.reason.length >= 20, `${entry.host} 的理由太短`);
  }
});

test('整条规则匹配（生成器用这条路径）', () => {
  assert.equal(isCosmeticExceptionRaw('finance.sina.com.cn##.m-s-tab + div'), true);
  assert.equal(isCosmeticExceptionRaw('  finance.sina.com.cn##.m-s-tab + div  '), true, '首尾空白被忽略');
  assert.equal(isCosmeticExceptionRaw('www.sina.com.cn##.m-s-tab + div'), false, '域名不同不命中');
  assert.equal(isCosmeticExceptionRaw('finance.sina.com.cn#@#.m-s-tab + div'), false, '例外规则不命中');
});
