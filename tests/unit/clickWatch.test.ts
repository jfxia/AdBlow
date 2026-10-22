import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLICK_WATCH_WINDOW_MS,
  clickWatchKey,
  mergeIncident,
  shouldRecordClickNavigation,
  type PlainClick,
} from '../../src/engine/clickWatch.ts';

/**
 * 观测（只记录、不改行为）：点击普通内容之后，顶层框架跳到了别的站点，就记一笔。
 * 之所以换成"看结果"，是因为按源码形状判断会被混淆/间接调用绕过（the video site 的 popunder SDK 就是）。
 */
const click = (over: Partial<PlainClick> = {}): PlainClick => ({
  host: 'videos.example',
  url: 'https://www.videos.example/dm339',
  at: 1_000_000,
  ...over,
});

describe('shouldRecordClickNavigation', () => {
  it('点击后窗口内跨站跳转 → 记录', () => {
    const r = shouldRecordClickNavigation({
      click: click(),
      toUrl: 'https://ads.example.com/landing',
      now: 1_000_000 + 1200,
    });
    assert.equal(r.record, true);
    assert.equal(r.targetHost, 'ads.example.com');
  });

  it('超过窗口的跳转不记录', () => {
    const r = shouldRecordClickNavigation({
      click: click(),
      toUrl: 'https://ads.example.com/landing',
      now: 1_000_000 + CLICK_WATCH_WINDOW_MS + 1,
    });
    assert.equal(r.record, false);
  });

  it('同站路由变化不记录', () => {
    const r = shouldRecordClickNavigation({
      click: click(),
      toUrl: 'https://www.videos.example/other',
      now: 1_000_000 + 500,
    });
    assert.equal(r.record, false);
  });

  it('同注册域名、不同子域不记录', () => {
    const r = shouldRecordClickNavigation({
      click: click(),
      toUrl: 'https://cn.videos.example/x',
      now: 1_000_000 + 500,
    });
    assert.equal(r.record, false);
  });

  it('没有点击时不记录', () => {
    const r = shouldRecordClickNavigation({
      click: null,
      toUrl: 'https://ads.example.com/landing',
      now: 1_000_000,
    });
    assert.equal(r.record, false);
  });

  it('非 http(s) 目标不记录（扩展页、about:blank 等）', () => {
    const r = shouldRecordClickNavigation({
      click: click(),
      toUrl: 'chrome://settings',
      now: 1_000_000 + 100,
    });
    assert.equal(r.record, false);
  });

  it('点击时间在将来（时钟回拨）不记录', () => {
    const r = shouldRecordClickNavigation({
      click: click({ at: 2_000_000 }),
      toUrl: 'https://ads.example.com/landing',
      now: 1_000_000,
    });
    assert.equal(r.record, false);
  });
});

describe('mergeIncident / clickWatchKey', () => {
  it('首次记录 count=1，并保留首个时间与样本', () => {
    const rec = mergeIncident(null, 'videos.example', 'ads.example.com', 1000);
    assert.deepEqual(rec, {
      host: 'videos.example',
      count: 1,
      firstAt: 1000,
      lastAt: 1000,
      lastTarget: 'ads.example.com',
      lastTargetHost: 'ads.example.com',
    });
  });

  it('重复记录累加，firstAt 不变，lastAt 与样本更新', () => {
    const first = mergeIncident(null, 'videos.example', 'ads.example.com', 1000);
    const second = mergeIncident(first, 'videos.example', 'tracker.example', 5000);
    assert.equal(second.count, 2);
    assert.equal(second.firstAt, 1000);
    assert.equal(second.lastAt, 5000);
    assert.equal(second.lastTargetHost, 'tracker.example');
  });

  it('损坏的记录按首次处理，不抛错', () => {
    const rec = mergeIncident({ count: -3 } as never, 'a.example', 'b.example', 42);
    assert.equal(rec.count, 1);
    assert.equal(rec.lastAt, 42);
  });

  it('存储键带前缀', () => {
    assert.equal(clickWatchKey('videos.example'), 'clickwatch:videos.example');
  });
});
