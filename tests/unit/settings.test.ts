import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  disabledKey,
  isSiteDisabled,
  readStats,
  setSiteDisabled,
  statsKey,
  writeStats,
} from '../../src/content/settings.ts';
import { memoryStore } from '../../src/content/storage.ts';

describe('站点开关（安全阀）', () => {
  it('默认启用', async () => {
    const store = memoryStore();
    assert.equal(await isSiteDisabled(store, 'a.cc'), false);
  });

  it('可以关闭并读回', async () => {
    const store = memoryStore();
    await setSiteDisabled(store, 'a.cc', true);
    assert.equal(await isSiteDisabled(store, 'a.cc'), true);
  });

  it('重新开启时删键而不是写 false（保持存储干净）', async () => {
    const store = memoryStore();
    await setSiteDisabled(store, 'a.cc', true);
    await setSiteDisabled(store, 'a.cc', false);
    assert.equal(await isSiteDisabled(store, 'a.cc'), false);
    assert.ok(!(await store.keys()).includes(disabledKey('a.cc')));
  });

  it('站点之间互不影响', async () => {
    const store = memoryStore();
    await setSiteDisabled(store, 'a.cc', true);
    assert.equal(await isSiteDisabled(store, 'b.cc'), false);
  });

  it('存储里是别的真值时不误判为关闭（只有 === true 才算）', async () => {
    const store = memoryStore({ [disabledKey('a.cc')]: 'yes' });
    assert.equal(await isSiteDisabled(store, 'a.cc'), false);
  });
});

describe('运行统计', () => {
  it('写入后可读回，并自动带上时间戳', async () => {
    const store = memoryStore();
    await writeStats(store, 'a.cc', { rule: 10, heuristic: 2 });

    const stats = await readStats(store, 'a.cc');
    assert.equal(stats?.rule, 10);
    assert.equal(stats?.heuristic, 2);
    assert.ok(typeof stats?.at === 'number' && stats.at > 0);
  });

  it('没有记录时返回 undefined', async () => {
    const store = memoryStore();
    assert.equal(await readStats(store, 'a.cc'), undefined);
  });

  it('站点之间互不影响', async () => {
    const store = memoryStore();
    await writeStats(store, 'a.cc', { rule: 1, heuristic: 0 });
    assert.equal(await readStats(store, 'b.cc'), undefined);
    assert.ok(statsKey('a.cc') !== statsKey('b.cc'));
  });
});
