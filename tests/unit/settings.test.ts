import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  disabledKey,
  isSiteDisabled,
  isWallFixEnabled,
  markWallDetected,
  readStats,
  readWallDetected,
  setSiteDisabled,
  setWallFixEnabled,
  statsKey,
  wallDetectedKey,
  wallFixKey,
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

describe('反过滤墙：按站点的手动确认开关', () => {
  it('默认关闭（绝不自动改变页面）', async () => {
    const store = memoryStore();
    assert.equal(await isWallFixEnabled(store, 'a.cc'), false);
  });

  it('确认后读回为开启；键名固定为 wallfix:<host>', async () => {
    const store = memoryStore();
    assert.equal(wallFixKey('example.com'), 'wallfix:example.com');
    await setWallFixEnabled(store, 'example.com', true);
    assert.equal(await store.get<boolean>(wallFixKey('example.com')), true);
    assert.equal(await isWallFixEnabled(store, 'example.com'), true);
  });

  it('关闭时删键而不是写 false（与 disabled 同形）', async () => {
    const store = memoryStore();
    await setWallFixEnabled(store, 'a.cc', true);
    await setWallFixEnabled(store, 'a.cc', false);
    assert.equal(await isWallFixEnabled(store, 'a.cc'), false);
    assert.ok(!(await store.keys()).includes(wallFixKey('a.cc')));
  });

  it('站点之间互不影响，且非 true 的值不算开启', async () => {
    const store = memoryStore({ [wallFixKey('b.cc')]: 'yes' });
    await setWallFixEnabled(store, 'a.cc', true);
    assert.equal(await isWallFixEnabled(store, 'a.cc'), true);
    assert.equal(await isWallFixEnabled(store, 'b.cc'), false);
    assert.equal(await isWallFixEnabled(store, 'c.cc'), false);
  });
});

describe('反过滤墙：检测记录（供弹窗提示）', () => {
  it('键名固定为 walldetected:<host>，记录时间戳', async () => {
    const store = memoryStore();
    assert.equal(wallDetectedKey('example.com'), 'walldetected:example.com');
    assert.equal(await readWallDetected(store, 'example.com'), undefined);

    await markWallDetected(store, 'example.com');
    const at = await readWallDetected(store, 'example.com');
    assert.ok(typeof at === 'number' && at > 0);
  });

  it('存储里不是数字时返回 undefined（而不是把脏值当时间戳）', async () => {
    const store = memoryStore({ [wallDetectedKey('a.cc')]: 'yesterday' });
    assert.equal(await readWallDetected(store, 'a.cc'), undefined);
  });

  it('网站之间互不影响', async () => {
    const store = memoryStore();
    await markWallDetected(store, 'a.cc');
    assert.equal(await readWallDetected(store, 'b.cc'), undefined);
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
