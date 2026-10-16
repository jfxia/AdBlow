/**
 * 自学习规则安全阀：限额、衰减与淘汰策略的纯函数测试。
 *
 * 这些数字是"病态站点的安全阀"，不是实测阈值，所以测试锁的是
 * 行为（谁被保留、谁被删、为什么）与记录形状，而不是"调参调出来的值"。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEANUP_LOG_KEY,
  CLEANUP_REASONS,
  DAY_MS,
  DECAY_INTERVAL_DAYS,
  DEFAULT_LIMITS,
  DOMAIN_TTL_DAYS,
  LEARNED_CLEANUP_MAX_RECORDS,
  MAX_DOMAINS_PER_SITE,
  MAX_GLOBAL_DOMAINS,
  MAX_OBSERVING_PER_SITE,
  MAX_PROMOTED_PER_SITE,
  OBSERVING_TTL_DAYS,
  PROMOTED_TTL_DAYS,
  aggregateGlobalDomains,
  appendCleanupLog,
  decayHits,
  effectiveDomainHits,
  effectiveSelectorHits,
  pruneDomainEntries,
  pruneSelectorEntries,
  rankGlobalDomainEvictions,
  readCleanupLog,
  resolveLimits,
  resolveNow,
  type DomainLike,
  type RuleLimits,
  type SelectorLike,
} from '../../src/content/ruleLimits.ts';
import { memoryStore } from '../../src/content/storage.ts';

/** Fixed clock so TTL/decay assertions never depend on wall time. */
const NOW = 1_800_000_000_000;
const INTERVAL = DECAY_INTERVAL_DAYS * DAY_MS;

const sel = (
  selector: string,
  hits: number,
  promoted: boolean,
  lastHitAt: number = NOW,
): SelectorLike => ({ selector, hits, promoted, lastHitAt });

const dom = (host: string, hits: number, promoted: boolean, lastSeenAt: number = NOW): DomainLike => ({
  host,
  hits,
  promoted,
  lastSeenAt,
});

const limits = (over: Partial<RuleLimits> = {}): RuleLimits => resolveLimits(over);

describe('安全阀常量（安全阀而非实测 p99）', () => {
  it('锁定文档化的上限与过期天数', () => {
    assert.equal(MAX_PROMOTED_PER_SITE, 40);
    assert.equal(MAX_OBSERVING_PER_SITE, 200);
    assert.equal(MAX_DOMAINS_PER_SITE, 50);
    assert.equal(MAX_GLOBAL_DOMAINS, 2000);
    assert.equal(DECAY_INTERVAL_DAYS, 30);
    assert.equal(OBSERVING_TTL_DAYS, 30);
    assert.equal(PROMOTED_TTL_DAYS, 90);
    assert.equal(DOMAIN_TTL_DAYS, 90);
  });

  it('DEFAULT_LIMITS 把天数换算成毫秒', () => {
    assert.equal(DEFAULT_LIMITS.decayIntervalMs, 30 * DAY_MS);
    assert.equal(DEFAULT_LIMITS.observingTtlMs, 30 * DAY_MS);
    assert.equal(DEFAULT_LIMITS.promotedTtlMs, 90 * DAY_MS);
    assert.equal(DEFAULT_LIMITS.domainTtlMs, 90 * DAY_MS);
    assert.equal(DEFAULT_LIMITS.maxPromotedPerSite, MAX_PROMOTED_PER_SITE);
    assert.equal(DEFAULT_LIMITS.maxObservingPerSite, MAX_OBSERVING_PER_SITE);
    assert.equal(DEFAULT_LIMITS.maxDomainsPerSite, MAX_DOMAINS_PER_SITE);
    assert.equal(DEFAULT_LIMITS.maxGlobalDomains, MAX_GLOBAL_DOMAINS);
  });

  it('resolveLimits 只覆盖传入的字段', () => {
    const merged = resolveLimits({ maxPromotedPerSite: 2 });
    assert.equal(merged.maxPromotedPerSite, 2);
    assert.equal(merged.maxObservingPerSite, MAX_OBSERVING_PER_SITE);
    assert.equal(merged.promotedTtlMs, DEFAULT_LIMITS.promotedTtlMs);
  });

  it('resolveNow 注入优先，非有限值回退系统时钟', () => {
    assert.equal(resolveNow(NOW), NOW);
    assert.ok(Math.abs(resolveNow() - Date.now()) < 60_000);
    assert.ok(Math.abs(resolveNow(Number.NaN) - Date.now()) < 60_000);
  });
});

describe('命中计数衰减（每 30 天未命中减半）', () => {
  it('未满 30 天不减半', () => {
    assert.equal(decayHits(8, NOW, NOW + INTERVAL - 1, INTERVAL), 8);
  });

  it('满 30 天减半', () => {
    assert.equal(decayHits(8, NOW, NOW + INTERVAL, INTERVAL), 4);
  });

  it('多个 30 天周期连续减半', () => {
    assert.equal(decayHits(8, NOW, NOW + 2 * INTERVAL, INTERVAL), 2);
    assert.equal(decayHits(8, NOW, NOW + 3 * INTERVAL, INTERVAL), 1);
    assert.equal(decayHits(100, NOW, NOW + 6 * INTERVAL, INTERVAL), 1);
  });

  it('长期静默归零而不是溢出', () => {
    assert.equal(decayHits(1_000_000, NOW, NOW + 400 * INTERVAL, INTERVAL), 0);
  });

  it('缺少命中时间（旧数据）不衰减', () => {
    assert.equal(decayHits(7, undefined, NOW + 400 * INTERVAL, INTERVAL), 7);
    assert.equal(decayHits(7, Number.NaN, NOW + 400 * INTERVAL, INTERVAL), 7);
  });

  it('同一时点重复读取结果一致（衰减是派生的，不会反复减半）', () => {
    const first = decayHits(8, NOW, NOW + INTERVAL, INTERVAL);
    const second = decayHits(8, NOW, NOW + INTERVAL, INTERVAL);
    assert.equal(first, second);
    assert.equal(first, 4);
  });

  it('effectiveXxxHits 使用条目自身的时间锚点', () => {
    assert.equal(effectiveSelectorHits(sel('.a', 8, true, NOW), NOW + INTERVAL, DEFAULT_LIMITS), 4);
    assert.equal(effectiveDomainHits(dom('a.cc', 8, true, NOW), NOW + INTERVAL, DEFAULT_LIMITS), 4);
    // 旧条目没有锚点 → 视为刚命中，不减半
    assert.equal(
      effectiveSelectorHits({ selector: '.a', hits: 8, promoted: false }, NOW + 100 * INTERVAL, DEFAULT_LIMITS),
      8,
    );
  });
});

describe('选择器淘汰策略', () => {
  it('远低于上限时什么都不删，顺序与计数器不变', () => {
    const entries = [sel('.a', 1, false), sel('.b', 5, true), sel('.c', 2, false)];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);
    assert.deepEqual(kept, entries);
    assert.deepEqual(removals, []);
  });

  it('已晋级超限时按命中次数保留前 40', () => {
    const entries = Array.from({ length: 45 }, (_, i) => sel(`.s${i}`, i + 1, true));
    const { kept, removals } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);
    assert.equal(kept.length, MAX_PROMOTED_PER_SITE);
    assert.deepEqual(removals, [{ reason: 'selector-promoted-overflow', removed: 5 }]);
    assert.ok(
      kept.every((e) => e.hits > 5),
      '保留的必须是最强的 40 条',
    );
  });

  it('未超限时不因年龄删除已晋级规则（只在超限时才按年龄清）', () => {
    const entries = [sel('.ancient', 5, true, NOW - 400 * DAY_MS), sel('.new', 9, true)];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);
    assert.deepEqual(kept.map((e) => e.selector), ['.ancient', '.new']);
    assert.deepEqual(removals, []);
  });

  it('超限时先清 90 天未命中的已晋级条目', () => {
    const entries = [
      sel('.stale', 99, true, NOW - 90 * DAY_MS),
      sel('.live-a', 4, true),
      sel('.live-b', 3, true),
    ];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, limits({ maxPromotedPerSite: 2 }));
    assert.deepEqual(
      kept.map((e) => e.selector).sort(),
      ['.live-a', '.live-b'],
    );
    assert.deepEqual(removals, [{ reason: 'selector-promoted-expired', removed: 1 }]);
  });

  it('超限且都在 90 天内时淘汰命中最少的', () => {
    const entries = [sel('.weak', 1, true), sel('.mid', 5, true), sel('.strong', 9, true)];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, limits({ maxPromotedPerSite: 2 }));
    assert.deepEqual(
      kept.map((e) => e.selector).sort(),
      ['.mid', '.strong'],
    );
    assert.deepEqual(removals, [{ reason: 'selector-promoted-overflow', removed: 1 }]);
  });

  it('命中和时间都相同时按名字定序（结果确定，不依赖存储顺序）', () => {
    const entries = [sel('.z', 5, true), sel('.a', 5, true)];
    const forward = pruneSelectorEntries(entries, NOW, limits({ maxPromotedPerSite: 1 }));
    const backward = pruneSelectorEntries([...entries].reverse(), NOW, limits({ maxPromotedPerSite: 1 }));
    assert.deepEqual(forward.kept.map((e) => e.selector), ['.a']);
    assert.deepEqual(backward.kept.map((e) => e.selector), ['.a']);
  });

  it('更久未命中的条目在命中数相同时先被淘汰', () => {
    const entries = [sel('.older', 5, true, NOW - 5 * DAY_MS), sel('.newer', 5, true, NOW)];
    const { kept } = pruneSelectorEntries(entries, NOW, limits({ maxPromotedPerSite: 1 }));
    assert.deepEqual(kept.map((e) => e.selector), ['.newer']);
  });

  it('衰减后的计数决定淘汰顺序', () => {
    // B 存储里是 8 次，但已静默 60 天 → 有效 2 次；A 是 3 次且刚命中。
    const entries = [sel('.a', 3, true, NOW), sel('.b', 8, true, NOW - 60 * DAY_MS)];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, limits({ maxPromotedPerSite: 1 }));
    assert.deepEqual(kept.map((e) => e.selector), ['.a']);
    assert.deepEqual(removals, [{ reason: 'selector-promoted-overflow', removed: 1 }]);
  });

  it('观察中 30 天未命中即清（未超限也清）', () => {
    const entries = [sel('.stale', 2, false, NOW - 30 * DAY_MS), sel('.fresh', 1, false, NOW - 29 * DAY_MS)];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);
    assert.deepEqual(kept.map((e) => e.selector), ['.fresh']);
    assert.deepEqual(removals, [{ reason: 'selector-observing-expired', removed: 1 }]);
  });

  it('观察中超限时按命中保留 200 条', () => {
    const entries = [
      sel('.weak', 1, false),
      sel('.mid', 2, false),
      sel('.strong', 3, false),
    ];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, limits({ maxObservingPerSite: 2 }));
    assert.deepEqual(
      kept.map((e) => e.selector).sort(),
      ['.mid', '.strong'],
    );
    assert.deepEqual(removals, [{ reason: 'selector-observing-overflow', removed: 1 }]);
  });

  it('观察中与已晋级各自计数，互不挤占名额', () => {
    const entries = [
      sel('.o1', 1, false),
      sel('.o2', 1, false),
      sel('.p1', 9, true),
      sel('.p2', 9, true),
    ];
    const { kept, removals } = pruneSelectorEntries(
      entries,
      NOW,
      limits({ maxObservingPerSite: 2, maxPromotedPerSite: 2 }),
    );
    assert.equal(kept.length, 4);
    assert.deepEqual(removals, []);
  });

  it('同时触发多种清理时按固定顺序记录原因', () => {
    const entries = [
      sel('.stale-obs', 1, false, NOW - 60 * DAY_MS),
      sel('.stale-prom', 100, true, NOW - 200 * DAY_MS),
      sel('.weak-prom', 1, true),
      sel('.strong-prom', 50, true),
    ];
    const { removals } = pruneSelectorEntries(
      entries,
      NOW,
      limits({ maxPromotedPerSite: 1 }),
    );
    assert.deepEqual(removals, [
      { reason: 'selector-observing-expired', removed: 1 },
      { reason: 'selector-promoted-expired', removed: 1 },
      { reason: 'selector-promoted-overflow', removed: 1 },
    ]);
    assert.deepEqual(
      removals.map((r) => r.reason),
      CLEANUP_REASONS.filter((r) => removals.some((x) => x.reason === r)),
      '原因顺序必须固定，日志形状才稳定',
    );
  });
});

describe('站点广告域名淘汰策略', () => {
  it('未超限时保留，且已晋级域名不因年龄单独删除', () => {
    const entries = [dom('ancient.cc', 5, true, NOW - 400 * DAY_MS), dom('new.cc', 9, true)];
    const { kept, removals } = pruneDomainEntries(entries, NOW, DEFAULT_LIMITS);
    assert.deepEqual(kept.map((e) => e.host), ['ancient.cc', 'new.cc']);
    assert.deepEqual(removals, []);
  });

  it('未晋级的域名 90 天未命中被清', () => {
    const entries = [dom('stale.cc', 2, false, NOW - 90 * DAY_MS), dom('fresh.cc', 1, false, NOW - 89 * DAY_MS)];
    const { kept, removals } = pruneDomainEntries(entries, NOW, DEFAULT_LIMITS);
    assert.deepEqual(kept.map((e) => e.host), ['fresh.cc']);
    assert.deepEqual(removals, [{ reason: 'domain-expired', removed: 1 }]);
  });

  it('超过站点上限时按命中次数保留 50 条', () => {
    const entries = Array.from({ length: 53 }, (_, i) => dom(`d${i}.cc`, i + 1, true));
    const { kept, removals } = pruneDomainEntries(entries, NOW, DEFAULT_LIMITS);
    assert.equal(kept.length, MAX_DOMAINS_PER_SITE);
    assert.deepEqual(removals, [{ reason: 'domain-overflow', removed: 3 }]);
    assert.ok(kept.every((e) => e.hits > 3));
  });

  it('超过站点上限时先清 90 天未见过的已晋级域名', () => {
    const entries = [
      dom('stale.cc', 99, true, NOW - 90 * DAY_MS),
      dom('live-a.cc', 4, true),
      dom('live-b.cc', 3, true),
    ];
    const { kept, removals } = pruneDomainEntries(entries, NOW, limits({ maxDomainsPerSite: 2 }));
    assert.deepEqual(kept.map((e) => e.host), ['live-a.cc', 'live-b.cc']);
    assert.deepEqual(removals, [{ reason: 'domain-expired', removed: 1 }]);
  });

  it('衰减后的计数决定域名淘汰顺序', () => {
    const entries = [dom('active.cc', 3, true, NOW), dom('quiet.cc', 8, true, NOW - 60 * DAY_MS)];
    const { kept } = pruneDomainEntries(entries, NOW, limits({ maxDomainsPerSite: 1 }));
    assert.deepEqual(kept.map((e) => e.host), ['active.cc']);
  });
});

describe('全局域名池淘汰策略', () => {
  it('汇总同一域名在各站点的命中与最近使用时间', () => {
    const sites = [
      { entries: [dom('shared.cc', 3, true, NOW - 5 * DAY_MS)] },
      { entries: [dom('shared.cc', 4, true, NOW), dom('only.cc', 1, false, NOW - 9 * DAY_MS)] },
    ];
    const agg = aggregateGlobalDomains(sites, NOW, DEFAULT_LIMITS);
    assert.deepEqual(
      agg.slice().sort((a, b) => (a.host < b.host ? -1 : 1)),
      [
        { host: 'only.cc', hits: 1, lastSeenAt: NOW - 9 * DAY_MS },
        { host: 'shared.cc', hits: 7, lastSeenAt: NOW },
      ],
    );
  });

  it('全局未超限时不淘汰', () => {
    const candidates = [
      { host: 'a.cc', hits: 1, lastSeenAt: NOW },
      { host: 'b.cc', hits: 9, lastSeenAt: NOW },
    ];
    assert.deepEqual(rankGlobalDomainEvictions(candidates, 2), []);
    assert.deepEqual(rankGlobalDomainEvictions(candidates, 5), []);
  });

  it('全局超限时按「命中最少 + 最久未用」淘汰', () => {
    const candidates = [
      { host: 'fewest.cc', hits: 1, lastSeenAt: NOW },
      { host: 'older.cc', hits: 5, lastSeenAt: NOW - 30 * DAY_MS },
      { host: 'newer.cc', hits: 5, lastSeenAt: NOW },
      { host: 'strong.cc', hits: 40, lastSeenAt: NOW - 60 * DAY_MS },
    ];
    assert.deepEqual(rankGlobalDomainEvictions(candidates, 2), ['fewest.cc', 'older.cc']);
    assert.deepEqual(rankGlobalDomainEvictions(candidates, 3), ['fewest.cc']);
  });

  it('完全相同的历史按域名定序（结果确定）', () => {
    const candidates = [
      { host: 'b.cc', hits: 2, lastSeenAt: NOW },
      { host: 'a.cc', hits: 2, lastSeenAt: NOW },
    ];
    assert.deepEqual(rankGlobalDomainEvictions(candidates, 1), ['a.cc']);
  });
});

describe('清理记录（供后续 UI 读取，不写界面）', () => {
  it('键名与记录形状固定', async () => {
    const store = memoryStore();
    assert.equal(CLEANUP_LOG_KEY, 'learnedCleanupLog');

    const written = await appendCleanupLog(store, NOW, [
      { reason: 'selector-observing-expired', removed: 3 },
    ]);
    assert.deepEqual(written, [{ at: NOW, reason: 'selector-observing-expired', removed: 3 }]);
    assert.deepEqual(await store.get('learnedCleanupLog'), [
      { at: NOW, reason: 'selector-observing-expired', removed: 3 },
    ]);
    assert.deepEqual(await readCleanupLog(store), [
      { at: NOW, reason: 'selector-observing-expired', removed: 3 },
    ]);
  });

  it('什么都没删就不写存储', async () => {
    const store = memoryStore();
    assert.equal(await appendCleanupLog(store, NOW, [{ reason: 'domain-overflow', removed: 0 }]), null);
    assert.equal(await appendCleanupLog(store, NOW, []), null);
    assert.deepEqual(await store.keys(), []);
  });

  it('多次清理按时间追加，只保留最近 20 条', async () => {
    const store = memoryStore();
    for (let i = 0; i < LEARNED_CLEANUP_MAX_RECORDS + 5; i++) {
      await appendCleanupLog(store, NOW + i, [{ reason: 'domain-overflow', removed: i + 1 }]);
    }
    const log = await readCleanupLog(store);
    assert.equal(log.length, LEARNED_CLEANUP_MAX_RECORDS);
    assert.deepEqual(log[0], { at: NOW + 5, reason: 'domain-overflow', removed: 6 });
    assert.deepEqual(log.at(-1), {
      at: NOW + LEARNED_CLEANUP_MAX_RECORDS + 4,
      reason: 'domain-overflow',
      removed: LEARNED_CLEANUP_MAX_RECORDS + 5,
    });
  });

  it('缺失或损坏的日志被当作空，不抛异常', async () => {
    assert.deepEqual(await readCleanupLog(memoryStore()), []);
    assert.deepEqual(await readCleanupLog(memoryStore({ learnedCleanupLog: 'oops' })), []);
    assert.deepEqual(
      await readCleanupLog(
        memoryStore({
          learnedCleanupLog: [
            { at: NOW, reason: 'not-a-reason', removed: 1 },
            { at: 'nope', reason: 'domain-overflow', removed: 1 },
            { at: NOW, reason: 'domain-overflow', removed: 2 },
          ],
        }),
      ),
      [{ at: NOW, reason: 'domain-overflow', removed: 2 }],
    );
  });

  it('原因必须是固定集合之一', () => {
    assert.deepEqual(CLEANUP_REASONS, [
      'selector-observing-expired',
      'selector-observing-overflow',
      'selector-promoted-expired',
      'selector-promoted-overflow',
      'domain-expired',
      'domain-overflow',
      'domain-global-overflow',
    ]);
  });
});
