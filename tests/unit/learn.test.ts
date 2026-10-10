import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMOTE_AFTER,
  allEntries,
  clearSite,
  forgetSelector,
  hostFromLearnedKey,
  learnedKey,
  listAllSites,
  promotedSelectors,
  recordHit,
} from '../../src/content/learn.ts';
import { memoryStore } from '../../src/content/storage.ts';

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

  it('clearSite 清空整站学习结果', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '.ad-one');
    await clearSite(store, 'a.cc');
    assert.deepEqual(await allEntries(store, 'a.cc'), []);
    assert.ok(!(await store.keys()).includes(learnedKey('a.cc')));
  });
});

describe('自学习规则库：UI 所需的枚举能力', () => {
  it('hostFromLearnedKey 只认学习键', () => {
    assert.equal(hostFromLearnedKey('learned:a.cc'), 'a.cc');
    assert.equal(hostFromLearnedKey('disabled:a.cc'), null);
    assert.equal(hostFromLearnedKey('stats:a.cc'), null);
  });

  it('listAllSites 只列出有学习规则的站点，且跳过其他键', async () => {
    const store = memoryStore({ 'disabled:x.cc': true, 'stats:x.cc': { rule: 1 } });
    for (let i = 0; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '.ad-a');
    await recordHit(store, 'b.cc', '.ad-b');

    const sites = await listAllSites(store);
    assert.deepEqual(
      sites.map((s) => s.host),
      ['a.cc', 'b.cc'],
    );
    assert.equal(sites[0]!.entries.length, 1);
    assert.equal(sites[0]!.entries[0]!.promoted, true);
    assert.equal(sites[1]!.entries[0]!.promoted, false);
  });
});
