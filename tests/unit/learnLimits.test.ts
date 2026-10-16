/**
 * 自学习安全阀：经过真实存储路径（写入 recordHit/recordDomains，读取
 * allEntries/allDomainEntries/... ）的行为测试。
 *
 * 重点有三处：
 *   1. 条目数远低于上限时，写入/读取结果与加限额前完全一致（也不产生清理记录）；
 *   2. 已有超限数据在首次读取时就被裁剪（不能只在写入时管）；
 *   3. 衰减是派生的：存储里保留原始计数，读取按 30 天周期计算有效计数。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLEANUP_LOG_KEY, DAY_MS, readCleanupLog, type RuleLimits } from '../../src/content/ruleLimits.ts';
import { allEntries, forgetSelector, learnedKey, listAllSites, promotedSelectors, recordHit } from '../../src/content/learn.ts';
import {
  allDomainEntries,
  allPromotedDomainScopes,
  allPromotedDomains,
  domainsKey,
  promotedDomainsFor,
  recordDomains,
} from '../../src/content/domainLearn.ts';
import { memoryStore } from '../../src/content/storage.ts';

const NOW = 1_800_000_000_000;
const limits = (over: Partial<RuleLimits>): Partial<RuleLimits> => over;

type RawSelectorMap = Record<
  string,
  { selector: string; hits: number; promoted: boolean; lastHitAt?: number }
>;
type RawDomainMap = Record<
  string,
  { host: string; hits: number; promoted: boolean; lastSeenAt: number }
>;

const rawSelectors = async (store: ReturnType<typeof memoryStore>, host: string): Promise<RawSelectorMap> =>
  ((await store.get<RawSelectorMap>(learnedKey(host))) ?? {}) as RawSelectorMap;

const rawDomains = async (store: ReturnType<typeof memoryStore>, pageHost: string): Promise<RawDomainMap> =>
  ((await store.get<RawDomainMap>(domainsKey(pageHost))) ?? {}) as RawDomainMap;

describe('选择器安全阀：小数据（远低于上限）行为不变', () => {
  it('写入与读取结果与加限额前一致，且没有清理记录', async () => {
    const store = memoryStore();
    for (let i = 0; i < 4; i++) await recordHit(store, 'a.cc', '.ad', { now: NOW });
    await recordHit(store, 'a.cc', '.weak', { now: NOW });
    await recordHit(store, 'b.cc', '.other', { now: NOW });

    const entries = await allEntries(store, 'a.cc', { now: NOW });
    assert.deepEqual(
      entries.map((e) => [e.selector, e.hits, e.promoted]),
      [
        ['.ad', 4, true],
        ['.weak', 1, false],
      ],
    );
    assert.deepEqual(await promotedSelectors(store, 'a.cc', { now: NOW }), ['.ad']);
    assert.deepEqual(
      (await listAllSites(store, { now: NOW })).map((s) => s.host),
      ['a.cc', 'b.cc'],
    );

    // 存储里保留原始计数与命中时间；清理记录键根本不存在。
    const raw = await rawSelectors(store, 'a.cc');
    assert.equal(raw['.ad']!.hits, 4);
    assert.equal(raw['.ad']!.lastHitAt, NOW);
    assert.equal(await store.get(CLEANUP_LOG_KEY), undefined);
  });

  it('旧数据没有命中时间时不会被误判为过期，也不会被减半', async () => {
    const store = memoryStore({
      [learnedKey('a.cc')]: {
        '.legacy-promoted': { selector: '.legacy-promoted', hits: 9, promoted: true },
        '.legacy-observing': { selector: '.legacy-observing', hits: 1, promoted: false },
      },
    });

    const entries = await allEntries(store, 'a.cc', { now: NOW });
    assert.deepEqual(entries.map((e) => [e.selector, e.hits]), [
      ['.legacy-promoted', 9],
      ['.legacy-observing', 1],
    ]);
    assert.equal(await store.get(CLEANUP_LOG_KEY), undefined, '升级后不该把旧数据当过期清掉');
  });

  it('撤销与整站清除的既有语义不变', async () => {
    const store = memoryStore();
    for (let i = 0; i < 3; i++) await recordHit(store, 'a.cc', '.ad', { now: NOW });
    await forgetSelector(store, 'a.cc', '.ad');
    assert.deepEqual(await allEntries(store, 'a.cc', { now: NOW }), []);
    assert.equal(await store.get(CLEANUP_LOG_KEY), undefined);
  });
});

describe('选择器安全阀：写入路径生效', () => {
  it('recordHit 超限时淘汰最弱的已晋级条目并记录原因', async () => {
    const store = memoryStore({
      [learnedKey('a.cc')]: {
        '.strong': { selector: '.strong', hits: 9, promoted: true, lastHitAt: NOW },
        '.weak': { selector: '.weak', hits: 1, promoted: true, lastHitAt: NOW },
      },
    });
    const lim = limits({ maxPromotedPerSite: 1 });

    const entry = await recordHit(store, 'a.cc', '.strong', { now: NOW, limits: lim });
    assert.equal(entry.hits, 10);
    assert.equal(entry.promoted, true);

    const entries = await allEntries(store, 'a.cc', { now: NOW, limits: lim });
    assert.deepEqual(
      entries.map((e) => [e.selector, e.hits]),
      [['.strong', 10]],
    );
    assert.equal('.weak' in (await rawSelectors(store, 'a.cc')), false, '超限写入必须落盘淘汰');

    const log = await readCleanupLog(store);
    assert.deepEqual(
      log.map((r) => [r.at, r.reason, r.removed]),
      [[NOW, 'selector-promoted-overflow', 1]],
    );
  });

  it('recordHit 写入时清掉 30 天未命中的观察中条目', async () => {
    const store = memoryStore({
      [learnedKey('a.cc')]: {
        '.stale': { selector: '.stale', hits: 2, promoted: false, lastHitAt: NOW - 40 * DAY_MS },
      },
    });
    await recordHit(store, 'a.cc', '.fresh', { now: NOW });

    const entries = await allEntries(store, 'a.cc', { now: NOW });
    assert.deepEqual(entries.map((e) => e.selector), ['.fresh']);
    assert.deepEqual(
      (await readCleanupLog(store)).map((r) => [r.reason, r.removed]),
      [['selector-observing-expired', 1]],
    );
  });
});

describe('选择器安全阀：读取路径裁剪已有超限数据', () => {
  it('首次读取就按命中次数裁剪，并把记录写进存储', async () => {
    const seeded: RawSelectorMap = {};
    for (let i = 0; i < 45; i++) {
      seeded[`.s${i}`] = { selector: `.s${i}`, hits: i + 1, promoted: true, lastHitAt: NOW - DAY_MS };
    }
    const store = memoryStore({ [learnedKey('a.cc')]: seeded });

    // 读取（不是写入）触发裁剪：条目数 45 → 40。
    const entries = await allEntries(store, 'a.cc', { now: NOW });
    assert.equal(entries.length, 40);
    assert.equal(entries[0]!.selector, '.s44');
    assert.ok(!entries.some((e) => e.selector === '.s0'));

    const raw = await rawSelectors(store, 'a.cc');
    assert.equal(Object.keys(raw).length, 40, '裁剪必须落盘');
    assert.deepEqual(
      (await readCleanupLog(store)).map((r) => [r.reason, r.removed]),
      [['selector-promoted-overflow', 5]],
    );

    // 幂等：再读一次不产生新的清理记录。
    await allEntries(store, 'a.cc', { now: NOW });
    assert.equal((await readCleanupLog(store)).length, 1);
  });

  it('promotedSelectors 读取路径同样裁剪（内容脚本入口）', async () => {
    const seeded: RawSelectorMap = {};
    for (let i = 0; i < 4; i++) {
      seeded[`.p${i}`] = { selector: `.p${i}`, hits: i + 1, promoted: true, lastHitAt: NOW };
    }
    const store = memoryStore({ [learnedKey('a.cc')]: seeded });

    const promoted = await promotedSelectors(store, 'a.cc', {
      now: NOW,
      limits: limits({ maxPromotedPerSite: 2 }),
    });
    assert.deepEqual(promoted, ['.p2', '.p3']);
    assert.equal(Object.keys(await rawSelectors(store, 'a.cc')).length, 2);
  });

  it('整站条目全部过期时站点键被删除，不再出现在列表里', async () => {
    const store = memoryStore({
      [learnedKey('dead.cc')]: {
        '.x': { selector: '.x', hits: 1, promoted: false, lastHitAt: NOW - 400 * DAY_MS },
      },
      [learnedKey('live.cc')]: {
        '.y': { selector: '.y', hits: 1, promoted: false, lastHitAt: NOW },
      },
    });

    const sites = await listAllSites(store, { now: NOW });
    assert.deepEqual(sites.map((s) => [s.host, s.entries.length]), [
      ['dead.cc', 0],
      ['live.cc', 1],
    ]);
    assert.ok(!(await store.keys()).includes(learnedKey('dead.cc')), '空键应被删除');
    assert.deepEqual(
      (await listAllSites(store, { now: NOW })).map((s) => s.host),
      ['live.cc'],
    );
  });
});

describe('命中计数衰减（30 天减半，可多次）', () => {
  it('读取时按静默时长减半，存储里保留原始计数', async () => {
    const store = memoryStore({
      [learnedKey('a.cc')]: {
        '.x': { selector: '.x', hits: 8, promoted: true, lastHitAt: NOW },
      },
    });

    const at = async (offsetDays: number): Promise<number> =>
      (await allEntries(store, 'a.cc', { now: NOW + offsetDays * DAY_MS }))[0]!.hits;

    assert.equal(await at(29), 8, '未满 30 天不减半');
    assert.equal(await at(30), 4);
    assert.equal(await at(60), 2);
    assert.equal(await at(90), 1);
    assert.equal((await rawSelectors(store, 'a.cc'))['.x']!.hits, 8, '存储里仍是原始计数');
  });

  it('新命中把衰减烘进存储并把锚点前移，避免重复减半', async () => {
    const store = memoryStore({
      [learnedKey('a.cc')]: {
        '.x': { selector: '.x', hits: 8, promoted: true, lastHitAt: NOW },
      },
    });

    const entry = await recordHit(store, 'a.cc', '.x', { now: NOW + 30 * DAY_MS });
    assert.equal(entry.hits, 5, '8 在 30 天后减半为 4，再加本次命中');

    const raw = (await rawSelectors(store, 'a.cc'))['.x']!;
    assert.equal(raw.hits, 5);
    assert.equal(raw.lastHitAt, NOW + 30 * DAY_MS);
    assert.equal(
      (await allEntries(store, 'a.cc', { now: NOW + 30 * DAY_MS }))[0]!.hits,
      5,
      '锚点已前移，同一天再读仍是 5',
    );
  });

  it('衰减后的计数参与淘汰排序：曾经很吵、现在安静的规则下沉', async () => {
    const seeded: RawSelectorMap = {
      '.loud-then-quiet': { selector: '.loud-then-quiet', hits: 16, promoted: true, lastHitAt: NOW - 60 * DAY_MS },
      '.steady': { selector: '.steady', hits: 9, promoted: true, lastHitAt: NOW },
    };
    const store = memoryStore({ [learnedKey('a.cc')]: seeded });

    // 16 次命中但静默 60 天 → 有效 4 次，低于 .steady 的 9 次（且未到 90 天，不会按年龄清）。
    const kept = await promotedSelectors(store, 'a.cc', {
      now: NOW,
      limits: limits({ maxPromotedPerSite: 1 }),
    });
    assert.deepEqual(kept, ['.steady']);
  });
});

describe('域名安全阀：小数据行为不变', () => {
  it('未超限时记录、晋级、读取与作用域聚合照旧，无清理记录', async () => {
    const store = memoryStore();
    for (let i = 0; i < 3; i++) {
      await recordDomains(store, 'a.cc', ['ads.example.com'], `https://a.cc/${i}`, { now: NOW });
    }

    assert.deepEqual(await promotedDomainsFor(store, 'a.cc', { now: NOW }), ['ads.example.com']);

    const sites = await allDomainEntries(store, { now: NOW });
    assert.equal(sites.length, 1);
    assert.deepEqual(
      sites[0]!.entries.map((e) => [e.host, e.hits, e.promoted, e.samplePage]),
      [['ads.example.com', 3, true, 'https://a.cc/0']],
    );
    assert.deepEqual(await allPromotedDomains(store, { now: NOW }), ['ads.example.com']);
    assert.deepEqual(
      await allPromotedDomainScopes(store, { now: NOW }),
      new Map([['ads.example.com', ['a.cc']]]),
    );
    assert.equal(await store.get(CLEANUP_LOG_KEY), undefined);
  });

  it('空域名列表仍然不写存储', async () => {
    const store = memoryStore();
    await recordDomains(store, 'a.cc', [], 'https://a.cc/', { now: NOW });
    assert.deepEqual(await store.keys(), []);
  });
});

describe('域名安全阀：写入与读取路径', () => {
  it('recordDomains 超站点上限时按命中淘汰并记录', async () => {
    const store = memoryStore();
    const lim = limits({ maxDomainsPerSite: 2 });

    await recordDomains(store, 'a.cc', ['weak.cc'], 'https://a.cc/', { now: NOW, limits: lim });
    for (let i = 0; i < 5; i++) {
      await recordDomains(store, 'a.cc', ['strong.cc'], 'https://a.cc/', { now: NOW, limits: lim });
    }
    for (let i = 0; i < 3; i++) {
      await recordDomains(store, 'a.cc', ['mid.cc'], 'https://a.cc/', { now: NOW, limits: lim });
    }

    const raw = await rawDomains(store, 'a.cc');
    assert.deepEqual(Object.keys(raw).sort(), ['mid.cc', 'strong.cc']);
    assert.deepEqual(
      (await readCleanupLog(store)).map((r) => [r.reason, r.removed]),
      [['domain-overflow', 1]],
    );
  });

  it('未晋级的站点域名 90 天未命中被清；已晋级域名未超限时保留', async () => {
    const store = memoryStore({
      [domainsKey('a.cc')]: {
        'observed.cc': { host: 'observed.cc', hits: 1, promoted: false, lastSeenAt: NOW - 120 * DAY_MS, samplePage: 'https://a.cc/' },
        'known.cc': { host: 'known.cc', hits: 9, promoted: true, lastSeenAt: NOW - 400 * DAY_MS, samplePage: 'https://a.cc/' },
      },
    });

    const sites = await allDomainEntries(store, { now: NOW });
    assert.deepEqual(sites[0]!.entries.map((e) => e.host), ['known.cc']);
    assert.deepEqual(
      (await readCleanupLog(store)).map((r) => [r.reason, r.removed]),
      [['domain-expired', 1]],
    );
  });

  it('读取路径裁剪已有超限的站点域名（首次读取即生效）', async () => {
    const seeded: RawDomainMap = {};
    for (let i = 0; i < 5; i++) {
      seeded[`d${i}.cc`] = {
        host: `d${i}.cc`,
        hits: i + 1,
        promoted: true,
        lastSeenAt: NOW - DAY_MS,
      };
    }
    const store = memoryStore({ [domainsKey('a.cc')]: seeded });

    const promoted = await promotedDomainsFor(store, 'a.cc', {
      now: NOW,
      limits: limits({ maxDomainsPerSite: 3 }),
    });
    assert.deepEqual(promoted, ['d2.cc', 'd3.cc', 'd4.cc']);
    assert.equal(Object.keys(await rawDomains(store, 'a.cc')).length, 3);
    assert.deepEqual(
      (await readCleanupLog(store)).map((r) => [r.reason, r.removed]),
      [['domain-overflow', 2]],
    );
  });

  it('域名计数同样按 30 天衰减（只在读取时派生）', async () => {
    const store = memoryStore({
      [domainsKey('a.cc')]: {
        'ads.cc': { host: 'ads.cc', hits: 8, promoted: true, lastSeenAt: NOW, samplePage: 'https://a.cc/' },
      },
    });

    const entries = (await allDomainEntries(store, { now: NOW + 60 * DAY_MS }))[0]!.entries;
    assert.deepEqual(entries.map((e) => [e.host, e.hits]), [['ads.cc', 2]]);
    assert.equal((await rawDomains(store, 'a.cc'))['ads.cc']!.hits, 8);
  });
});

describe('全局域名上限（跨站点，2,000）', () => {
  it('超限时按「命中最少 + 最久未用」跨站点淘汰，并从所有站点删除', async () => {
    const store = memoryStore();

    // weak.cc：3 次命中但已 10 天没用；mid.cc：3 次命中、2 天前；hot.cc：9 次命中、刚刚。
    for (let i = 0; i < 3; i++) {
      await recordDomains(store, 'a.cc', ['weak.cc'], 'https://a.cc/', { now: NOW - 10 * DAY_MS });
      await recordDomains(store, 'a.cc', ['mid.cc'], 'https://a.cc/', { now: NOW - 2 * DAY_MS });
      await recordDomains(store, 'b.cc', ['hot.cc'], 'https://b.cc/', { now: NOW });
    }

    const all = await allPromotedDomains(store, { now: NOW, limits: limits({ maxGlobalDomains: 2 }) });
    assert.deepEqual(all, ['hot.cc', 'mid.cc']);

    assert.equal('weak.cc' in (await rawDomains(store, 'a.cc')), false, '淘汰的域名必须从所有站点删除');
    assert.deepEqual(
      (await readCleanupLog(store)).map((r) => [r.reason, r.removed]),
      [['domain-global-overflow', 1]],
    );

    // 幂等：再读一次不再淘汰、不再记日志。
    await allPromotedDomains(store, { now: NOW, limits: limits({ maxGlobalDomains: 2 }) });
    assert.equal((await readCleanupLog(store)).length, 1);
  });

  it('全局未超限时一个域名都不动', async () => {
    const store = memoryStore();
    for (let i = 0; i < 3; i++) {
      await recordDomains(store, 'a.cc', ['x.cc', 'y.cc'], 'https://a.cc/', { now: NOW });
    }
    assert.deepEqual(await allPromotedDomains(store, { now: NOW }), ['x.cc', 'y.cc']);
    assert.equal(await store.get(CLEANUP_LOG_KEY), undefined);
  });
});
