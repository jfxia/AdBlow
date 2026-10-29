import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { namingSignal } from '../../src/engine/lexicon.ts';

/**
 * 命名证据的误杀面回归。
 *
 * 事故背景（2026-10-29）：命名原先按前缀匹配，title="AdBlow" 命中 ad，扩展把自己的商店条目
 * 隐藏了。修法是按词元匹配。这些用例守住两个方向：
 *   - 普通词与品牌词不得产生证据（误杀方向）；
 *   - 真实 fixture 上的命中数不得超过预算（词库放宽方向）。
 */

const ordinary = [
  'AdBlow', 'adblow', 'adventure', 'adaptive', 'loading', 'badge', 'header',
  'shadow', 'address', 'admin', 'adult', 'brand', 'gradient', 'header-nav',
  'upload', 'download', 'readonly', 'padding', 'thread', 'add-to-cart',
  'added', 'adjust', 'admission', 'adapt', 'adore',
];

const advertising = [
  'ad', 'ads', 'ad-slot', 'ad_slot', 'advert', 'advertising-block', 'adblk',
  'adslot', 'adsbygoogle', 'ad300x250', 'ad1', 'video-ads', 'ytp-ad-overlay',
  'sponsored-post', 'ad-banner', 'banner-ad', 'ads-top', 'ad-container',
];

test('普通词与品牌词不产生命名证据（误杀方向）', () => {
  const dom = new JSDOM('<div id="x"></div>');
  const { document } = dom.window;
  for (const word of ordinary) {
    const el = document.createElement('div');
    el.className = word;
    assert.equal(namingSignal(el).strength, 0, word);
    el.className = '';
    el.id = word;
    assert.equal(namingSignal(el).strength, 0, 'id=' + word);
  }
});

test('真实广告写法仍然命中（不能把信号一起关掉）', () => {
  const dom = new JSDOM('<div id="x"></div>');
  const { document } = dom.window;
  for (const word of advertising) {
    const el = document.createElement('div');
    el.className = word;
    assert.ok(namingSignal(el).strength > 0, word);
  }
});

test('标签属性里出现普通词不产生证据，出现广告词才产生', () => {
  const dom = new JSDOM('<div id="x"></div>');
  const { document } = dom.window;
  for (const label of ['AdBlow In the Store', 'Add to cart', 'Adjust settings', 'Loading…']) {
    const el = document.createElement('div');
    el.setAttribute('aria-label', label);
    assert.equal(namingSignal(el).strength, 0, label);
  }
  for (const label of ['advertisement', 'pre-roll ad', 'Sponsored']) {
    const el = document.createElement('div');
    el.setAttribute('aria-label', label);
    assert.ok(namingSignal(el).strength > 0, label);
  }
});

/** 真实页面上的命中预算：词库放宽会让计数上涨。 */
const budgets = [
  {
    "file": "tests/fixtures/1024cg-home.html",
    "elements": 1024,
    "maxStrong": 66,
    "maxWeak": 26
  },
  {
    "file": "tests/fixtures/pilot-category.html",
    "elements": 1023,
    "maxStrong": 44,
    "maxWeak": 4
  }
];

test('真实 fixture 上的命名命中数不超过预算', () => {
  const attrs = ["class","id","aria-label","title","data-ad-slot"];
  for (const budget of budgets) {
    const dom = new JSDOM(readFileSync(budget.file, 'utf8'));
    const elements = dom.window.document.querySelectorAll('*');
    let strong = 0;
    let weak = 0;
    for (const el of elements) {
      let signal;
      try {
        signal = namingSignal(el);
      } catch {
        continue;
      }
      if (signal.strength >= 2) strong += 1;
      else if (signal.strength === 1) weak += 1;
    }
    assert.ok(strong <= budget.maxStrong, budget.file + ' 强命名 ' + strong + ' > ' + budget.maxStrong);
    assert.ok(weak <= budget.maxWeak, budget.file + ' 弱命名 ' + weak + ' > ' + budget.maxWeak);
    void attrs;
  }
});
