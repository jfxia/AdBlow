import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keysToScrub, scrubWindowName } from '../../src/engine/scrub.ts';

describe('keysToScrub', () => {
  it('命中试点站实测的弹窗状态键', () => {
    const keys = [
      '__ai_float_pending__',
      '__ai_float_pending_winname__',
      '__ai_float_beacon__',
      'unrelated',
    ];
    assert.deepEqual(keysToScrub(keys), [
      '__ai_float_pending__',
      '__ai_float_pending_winname__',
      '__ai_float_beacon__',
    ]);
  });

  it('不误删普通站点数据', () => {
    assert.deepEqual(keysToScrub(['theme', 'token', 'cart']), []);
  });
});

describe('scrubWindowName', () => {
  it('移除 window.name 里的弹窗状态键但保留其他字段', () => {
    const name = JSON.stringify({ keep: 1, __ai_float_pending_winname__: { id: 9 } });
    assert.deepEqual(JSON.parse(scrubWindowName(name)), { keep: 1 });
  });

  it('非 JSON 的 window.name 原样返回', () => {
    assert.equal(scrubWindowName('plain-name'), 'plain-name');
  });

  it('空字符串原样返回', () => {
    assert.equal(scrubWindowName(''), '');
  });
});
