import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNED_SCHEMA_VERSION,
  PROMOTE_AFTER,
  allEntries,
  clearSite,
  forgetSelector,
  hostFromLearnedKey,
  learnedKey,
  listAllSites,
  migrateLearnedSchema,
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

describe('自学习数据迁移（安全闸门收紧后作废旧数据）', () => {
  it('首次运行时清空选择器与域名，并打上版本号', async () => {
    const store = memoryStore({
      'learned:a.cc': { '.post-card': { selector: '.post-card', hits: 9, promoted: true } },
      'adDomains:a.cc': { 'ads.example.com': { host: 'ads.example.com', hits: 9, promoted: true } },
      'adDomains:b.cc': { 'x.cc': { host: 'x.cc', hits: 3, promoted: true } },
    });

    assert.equal(await migrateLearnedSchema(store), true);
    assert.deepEqual(await store.keys(), ['learnedSchemaVersion']);
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), []);
  });

  it('不清除非自学习数据（站点开关、统计）', async () => {
    const store = memoryStore({
      'disabled:x.cc': true,
      'stats:x.cc': { rule: 3 },
      'learned:a.cc': { '.old': { selector: '.old', hits: 9, promoted: true } },
    });
    await migrateLearnedSchema(store);
    const keys = await store.keys();
    assert.ok(keys.includes('disabled:x.cc'));
    assert.ok(keys.includes('stats:x.cc'));
  });

  it('版本已是最新时不重复清理', async () => {
    const store = memoryStore();
    assert.equal(await migrateLearnedSchema(store), true);
    // 之后又学了点东西
    for (let i = 0; i < PROMOTE_AFTER; i++) await recordHit(store, 'a.cc', '.keep-me');

    assert.equal(await migrateLearnedSchema(store), false, '不应重复清理');
    assert.deepEqual(await promotedSelectors(store, 'a.cc'), ['.keep-me'], '新学的必须保留');
  });

  it('版本常量是预期值（改它等于清空所有用户的学习结果，需慎重）', () => {
    assert.equal(LEARNED_SCHEMA_VERSION, 2);
  });
});
