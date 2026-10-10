import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMOTE_AFTER,
  allEntries,
  forgetSelector,
  learnedKey,
  promotedSelectors,
  recordHit,
  type LearnedMap,
  type LearnedStore,
} from '../../src/content/learn.ts';

function memoryStore(): LearnedStore & { dump: () => Record<string, LearnedMap> } {
  const data: Record<string, LearnedMap> = {};
  return {
    async get(key) {
      return data[key];
    },
    async set(key, value) {
      data[key] = value;
    },
    dump: () => data,
  };
}

describe('自学习规则库', () => {
  it('首次命中只记录，不晋级', async () => {
    const store = memoryStore();
    const e = await recordHit(store, 'a.cc', '[data-x]');
    assert.equal(e.hits, 1);
    assert.equal(e.promoted, false);
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), []);
  });

  it(`累计命中 ${PROMOTE_AFTER} 次才晋级为持久规则（抗污染）`, async () => {
    const store = memoryStore();
    for (let i = 1; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '[data-x]');
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), [], '未到阈值不应晋级');

    await recordHit(store, 'a.cc', '[data-x]');
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), ['[data-x]']);
  });

  it('不同站点互不干扰', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '.ad-one');
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), ['.ad-one']);
    assert.deepEqual(await promotedSelectors(store, 'b.cc'), []);
    assert.ok(Object.keys(store.dump()).includes(learnedKey('a.cc')));
  });

  it('多个选择器按命中次数排序，晋级结果有序', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '.zzz');
    for (let i = 0; i < PROMOTE_AFTER + 2; i++) await recordHit(store, 'a.cc', '.aaa');

    const entries = await allEntries(store, 'a.cc');
    assert.equal(entries[0]!.selector, '.aaa');
    assert.equal(entries[0]!.hits, PROMOTE_AFTER + 2);
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), ['.aaa', '.zzz']);
  });

  it('可一键撤销（自学习必须可回滚）', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '.ad-one');
    await forgetSelector(store, 'a.cc', '.ad-one');
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), []);
  });

  it('撤销不存在的选择器不抛异常', async () => {
    const store = memoryStore();
    await forgetSelector(store, 'a.cc', '.nope');
    assert.deepEqual(await allEntries(store, 'a.cc'), []);
  });
});
