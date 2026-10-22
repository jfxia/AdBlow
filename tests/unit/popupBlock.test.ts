import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  POPUP_BLOCK_PREFIX,
  mergePopupBlockRecord,
  popupBlockKey,
} from '../../src/engine/popupBlock.ts';

/**
 * Denying cross-site windows by default is silent, so a false positive must be checkable: one
 * popupblock record per site, with at least the count and the last host the page tried to open.
 * This fixes the key name and the merge behaviour.
 */
describe('弹窗拦截记录', () => {
  it('键名固定为 popupblock:<host>', () => {
    assert.equal(POPUP_BLOCK_PREFIX, 'popupblock:');
    assert.equal(popupBlockKey('videos.example'), 'popupblock:videos.example');
  });

  it('第一次拦截建立记录', () => {
    const record = mergePopupBlockRecord(null, 'videos.example', 'ads.example', 1000);
    assert.deepEqual(record, {
      host: 'videos.example',
      count: 1,
      firstAt: 1000,
      lastAt: 1000,
      lastTargetHost: 'ads.example',
    });
  });

  it('再次拦截累加次数，firstAt 不变，lastAt 与目标更新', () => {
    const first = mergePopupBlockRecord(undefined, 'a.cc', 'ads.one', 1000);
    const second = mergePopupBlockRecord(first, 'a.cc', 'ads.two', 2000);
    assert.equal(second.count, 2);
    assert.equal(second.firstAt, 1000);
    assert.equal(second.lastAt, 2000);
    assert.equal(second.lastTargetHost, 'ads.two');
    assert.equal(second.host, 'a.cc');
  });

  it('存储里是坏值时不抛异常，从 1 重新开始', () => {
    for (const existing of [
      { count: -1, firstAt: 0, lastAt: 0, lastTargetHost: '', host: '' },
      { count: 'many' },
      null,
    ]) {
      const record = mergePopupBlockRecord(existing as never, 'a.cc', 'ads.example', 5);
      assert.equal(record.count, 1);
      assert.equal(record.lastTargetHost, 'ads.example');
    }
  });
});
