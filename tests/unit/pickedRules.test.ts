/**
 * 手动拾取规则的存储与豁免。
 *
 * 硬要求：`picked: true` 的条目绝不能被子学习的上限裁剪、30/90 天过期或命中衰减
 * 删掉。用户手动加的规则静默消失会被当成 bug，所以这里同时锁纯函数（prune）与
 * 真实存储路径（addPickedSelector → allEntries/promotedSelectors）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_MS,
  DEFAULT_LIMITS,
  effectiveSelectorHits,
  pruneSelectorEntries,
  readCleanupLog,
  resolveLimits,
  type SelectorLike,
} from '../../src/content/ruleLimits.ts';
import {
  addPickedSelector,
  allEntries,
  clearSite,
  forgetSelector,
  learnedKey,
  listAllSites,
  promotedSelectors,
  recordHit,
} from '../../src/content/learn.ts';
import { selectorsFrom } from '../../src/content/engine.ts';
import { memoryStore } from '../../src/content/storage.ts';

const NOW = 1_800_000_000_000;

const auto = (selector: string, hits: number, lastHitAt: number = NOW): SelectorLike => ({
  selector,
  hits,
  promoted: true,
  lastHitAt,
});

const picked = (selector: string, hits = 1, lastHitAt: number = NOW): SelectorLike => ({
  selector,
  hits,
  promoted: true,
  picked: true,
  lastHitAt,
});

type RawSelectorMap = Record<
  string,
  { selector: string; hits: number; promoted: boolean; lastHitAt?: number; picked?: boolean }
>;

const rawSelectors = async (
  store: ReturnType<typeof memoryStore>,
  host: string,
): Promise<RawSelectorMap> => ((await store.get<RawSelectorMap>(learnedKey(host))) ?? {}) as RawSelectorMap;

describe('手动拾取规则：pruneSelectorEntries 永不删除', () => {
  it('❗超过每站 40 条上限时，手动规则全部保留', () => {
    const entries = Array.from({ length: 45 }, (_, i) => picked(`.manual-${i}`));
    const { kept, removals } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);

    assert.equal(kept.length, 45);
    assert.deepEqual(removals, []);
  });

  it('❗自动规则超限时只裁自动规则，手动规则不占名额', () => {
    const entries = [
      ...Array.from({ length: 45 }, (_, i) => auto(`.auto-${i}`, i + 1)),
      ...Array.from({ length: 3 }, (_, i) => picked(`.manual-${i}`)),
    ];
    const { kept } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);

    const keptSelectors = kept.map((e) => e.selector);
    assert.equal(keptSelectors.filter((s) => s.startsWith('.auto-')).length, 40);
    assert.deepEqual(
      keptSelectors.filter((s) => s.startsWith('.manual-')).sort(),
      ['.manual-0', '.manual-1', '.manual-2'],
    );
  });

  it('❗400 天未命中的手动规则不被过期清理', () => {
    const entries = [
      picked('.manual-ancient', 1, NOW - 400 * DAY_MS),
      auto('.auto-a', 9),
      auto('.auto-b', 5),
    ];
    const { kept, removals } = pruneSelectorEntries(
      entries,
      NOW,
      resolveLimits({ maxPromotedPerSite: 1 }),
    );

    assert.ok(kept.some((e) => e.selector === '.manual-ancient'));
    assert.deepEqual(
      kept.map((e) => e.selector).sort(),
      ['.auto-a', '.manual-ancient'],
    );
    assert.deepEqual(removals, [{ reason: 'selector-promoted-overflow', removed: 1 }]);
  });

  it('手动规则即使带 promoted=false 也按手动规则处理（不被观察期 TTL 清掉）', () => {
    const entries: SelectorLike[] = [
      { selector: '.manual', hits: 1, promoted: false, picked: true, lastHitAt: NOW - 400 * DAY_MS },
    ];
    const { kept, removals } = pruneSelectorEntries(entries, NOW, DEFAULT_LIMITS);
    assert.deepEqual(kept.map((e) => e.selector), ['.manual']);
    assert.deepEqual(removals, []);
  });

  it('手动规则的命中计数不衰减', () => {
    const entry = picked('.manual', 7, NOW - 400 * DAY_MS);
    assert.equal(effectiveSelectorHits(entry, NOW, DEFAULT_LIMITS), 7);
    // 对照：同样的自动规则早被衰减到 0
    assert.equal(effectiveSelectorHits(auto('.auto', 7, NOW - 400 * DAY_MS), NOW, DEFAULT_LIMITS), 0);
  });
});

describe('手动拾取规则：存储路径', () => {
  it('写入 learned:<host>，形状为 picked/promoted 且带站点范围', async () => {
    const store = memoryStore();
    const entry = await addPickedSelector(store, 'a.cc', '.ad-slot', { now: NOW });

    assert.deepEqual(entry, {
      selector: '.ad-slot',
      hits: 1,
      promoted: true,
      picked: true,
      lastHitAt: NOW,
    });
    assert.deepEqual(await rawSelectors(store, 'a.cc'), { '.ad-slot': entry });
    assert.equal(await store.get(learnedKey('b.cc')), undefined, '不得写成全局规则');
    assert.deepEqual(await promotedSelectors(store, 'a.cc', { now: NOW }), ['.ad-slot']);
    assert.deepEqual(await promotedSelectors(store, 'b.cc', { now: NOW }), []);
  });

  it('❗连续拾取超过上限仍全部保留（写入路径每次都会 prune）', async () => {
    const store = memoryStore();
    const limits = { maxPromotedPerSite: 1 };
    for (let i = 0; i < 45; i++) {
      await addPickedSelector(store, 'a.cc', `.manual-${i}`, { now: NOW, limits });
    }

    const entries = await allEntries(store, 'a.cc', { now: NOW, limits });
    assert.equal(entries.length, 45);
    assert.equal(entries.every((e) => e.picked === true), true);
    assert.deepEqual(await readCleanupLog(store), [], '不该有任何手动规则被清理');
  });

  it('❗读取路径按 400 天后 + 极小上限裁剪时，手动规则仍在', async () => {
    const store = memoryStore();
    await addPickedSelector(store, 'a.cc', '.manual', { now: NOW });
    const later = NOW + 400 * DAY_MS;

    const entries = await allEntries(store, 'a.cc', {
      now: later,
      limits: { maxPromotedPerSite: 1, observingTtlMs: 1, promotedTtlMs: 1 },
    });
    assert.deepEqual(entries.map((e) => [e.selector, e.picked, e.hits]), [['.manual', true, 1]]);
    assert.deepEqual(
      (await rawSelectors(store, 'a.cc'))['.manual']?.picked,
      true,
      '存储里也必须原样保留',
    );
  });

  it('对已存在的自学习条目再次拾取，保留命中次数并加上手动标记', async () => {
    const store = memoryStore();
    await recordHit(store, 'a.cc', '.ad-slot', { now: NOW });
    await recordHit(store, 'a.cc', '.ad-slot', { now: NOW });
    const entry = await addPickedSelector(store, 'a.cc', '.ad-slot', { now: NOW });

    assert.equal(entry.hits, 2);
    assert.equal(entry.picked, true);
    assert.equal(entry.promoted, true);
  });

  it('后续自学习命中不会丢掉手动标记', async () => {
    const store = memoryStore();
    await addPickedSelector(store, 'a.cc', '.manual', { now: NOW });
    for (let i = 0; i < 5; i++) await recordHit(store, 'a.cc', '.manual', { now: NOW + i });

    const entries = await allEntries(store, 'a.cc', { now: NOW + 10 });
    assert.equal(entries[0]!.picked, true);
    assert.equal(entries[0]!.hits, 6);
  });

  it('手动规则仍可撤销：单条删除与整站清空', async () => {
    const store = memoryStore();
    await addPickedSelector(store, 'a.cc', '.one', { now: NOW });
    await addPickedSelector(store, 'a.cc', '.two', { now: NOW });

    await forgetSelector(store, 'a.cc', '.one');
    assert.deepEqual(await promotedSelectors(store, 'a.cc', { now: NOW }), ['.two']);

    await clearSite(store, 'a.cc');
    assert.deepEqual(await promotedSelectors(store, 'a.cc', { now: NOW }), []);
  });

  it('规则管理页枚举时能区分手动规则', async () => {
    const store = memoryStore();
    await addPickedSelector(store, 'a.cc', '.manual', { now: NOW });
    for (let i = 0; i < 3; i++) await recordHit(store, 'a.cc', '.learned', { now: NOW });

    const sites = await listAllSites(store, { now: NOW });
    const entry = sites.find((s) => s.host === 'a.cc')?.entries.find((e) => e.selector === '.manual');
    assert.ok(entry);
    assert.equal(entry!.picked, true);
    assert.equal(entry!.promoted, true);
  });
});

describe('手动规则不混入自学习集合', () => {
  it('selectorsFrom 把手动规则放进 picked，而不是 learned/curated', () => {
    const set = selectorsFrom([], [], undefined, ['.manual']);
    assert.deepEqual(set.curated, []);
    assert.deepEqual(set.learned, []);
    assert.deepEqual(set.picked, ['.manual']);
  });
});
