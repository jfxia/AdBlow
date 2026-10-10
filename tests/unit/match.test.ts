import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchPattern } from '../../src/engine/match.ts';

describe('matchPattern', () => {
  it('精确 host 匹配', () => {
    assert.equal(matchPattern('*://afford.gjvrohros.cc/*', 'https://afford.gjvrohros.cc/category/jrxw1/'), true);
    assert.equal(matchPattern('*://afford.gjvrohros.cc/*', 'https://other.cc/x'), false);
  });

  it('通配子域匹配（含裸域）', () => {
    const p = '*://*.gjvrohros.cc/*';
    assert.equal(matchPattern(p, 'https://afford.gjvrohros.cc/a'), true);
    assert.equal(matchPattern(p, 'https://gjvrohros.cc/a'), true);
    assert.equal(matchPattern(p, 'https://a.b.gjvrohros.cc/a'), true);
    assert.equal(matchPattern(p, 'https://notgjvrohros.cc/a'), false);
    assert.equal(matchPattern(p, 'https://gjvrohros.cc.evil.com/a'), false);
  });

  it('scheme 通配与限定', () => {
    assert.equal(matchPattern('*://x.cc/*', 'http://x.cc/p'), true);
    assert.equal(matchPattern('https://x.cc/*', 'http://x.cc/p'), false);
    assert.equal(matchPattern('https://x.cc/*', 'https://x.cc/p'), true);
  });

  it('路径通配', () => {
    assert.equal(matchPattern('*://x.cc/ad/*', 'https://x.cc/ad/1'), true);
    assert.equal(matchPattern('*://x.cc/ad/*', 'https://x.cc/content/1'), false);
    assert.equal(matchPattern('*://x.cc/*', 'https://x.cc/'), true);
  });

  it('非法输入不抛异常', () => {
    assert.equal(matchPattern('garbage', 'https://x.cc/'), false);
    assert.equal(matchPattern('*://x.cc/*', 'not a url'), false);
    assert.equal(matchPattern('*://x.cc/*', ''), false);
  });

  it('试点站规则包的每条 match 都能命中真实 URL', () => {
    const url = 'https://afford.gjvrohros.cc/category/jrxw1/';
    assert.equal(matchPattern('*://afford.gjvrohros.cc/*', url), true);
    assert.equal(matchPattern('*://*.gjvrohros.cc/*', url), true);
  });
});
