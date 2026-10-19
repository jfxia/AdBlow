import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countSites,
  groupBySite,
  isWholeSite,
  pickKey,
  siteKey,
  togglePick,
  type PickMap,
  type PickRef,
} from '../../src/ui/bulkSelection.ts';

const sel = (host: string, rule: string): PickRef => ({ kind: 'selector', host, rule });
const dom = (host: string, rule: string): PickRef => ({ kind: 'domain', host, rule });

describe('pickKey / siteKey', () => {
  it('同一条规则得到同一个键', () => {
    assert.equal(pickKey(sel('a.example', '.ad')), pickKey(sel('a.example', '.ad')));
  });

  it('不同种类、不同站点、不同规则互不相撞', () => {
    const keys = new Set([
      pickKey(sel('a.example', '.ad')),
      pickKey(dom('a.example', '.ad')),
      pickKey(sel('b.example', '.ad')),
      pickKey(sel('a.example', '.ad2')),
    ]);
    assert.equal(keys.size, 4);
  });

  it('站点键只区分种类与站点，与规则无关', () => {
    assert.equal(siteKey(sel('a.example', '.x')), siteKey(sel('a.example', '#y')));
    assert.notEqual(siteKey(sel('a.example', '.x')), siteKey(dom('a.example', '.x')));
  });
});

describe('togglePick', () => {
  it('默认按当前状态取反，并返回新状态', () => {
    const picked: PickMap = new Map();
    assert.equal(togglePick(picked, sel('a.example', '.ad')), true);
    assert.equal(picked.size, 1);
    assert.equal(togglePick(picked, sel('a.example', '.ad')), false);
    assert.equal(picked.size, 0);
  });

  it('显式指定状态时幂等（站点级全选/取消会用到）', () => {
    const picked: PickMap = new Map();
    togglePick(picked, sel('a.example', '.ad'), true);
    togglePick(picked, sel('a.example', '.ad'), true);
    assert.equal(picked.size, 1);
    togglePick(picked, sel('a.example', '.ad'), false);
    togglePick(picked, sel('a.example', '.ad'), false);
    assert.equal(picked.size, 0);
  });
});

describe('groupBySite / countSites / isWholeSite', () => {
  it('按"种类 + 站点"分组', () => {
    const picked: PickMap = new Map();
    for (const ref of [sel('a.example', '.x'), sel('a.example', '.y'), dom('a.example', 'ads.example')]) {
      togglePick(picked, ref, true);
    }
    const groups = groupBySite(picked);
    assert.equal(groups.size, 2, '同一站点的隐藏规则与域名规则属于两个分区');
    assert.equal(groups.get('selector|a.example')?.length, 2);
    assert.equal(groups.get('domain|a.example')?.length, 1);
  });

  it('站点数按去重后的分区计', () => {
    const picked: PickMap = new Map();
    for (const ref of [sel('a.example', '.x'), sel('b.example', '.y'), sel('a.example', '.z')]) {
      togglePick(picked, ref, true);
    }
    assert.equal(countSites(picked), 2);
  });

  it('整分区被选中才算 whole site（决定用一次 clearSite 还是逐条删除）', () => {
    const picked: PickMap = new Map();
    const keys = [pickKey(sel('a.example', '.x')), pickKey(sel('a.example', '.y'))];
    togglePick(picked, sel('a.example', '.x'), true);
    assert.equal(isWholeSite(picked, keys), false);
    togglePick(picked, sel('a.example', '.y'), true);
    assert.equal(isWholeSite(picked, keys), true);
  });

  it('空分区不算 whole site（避免把空分区当作"全删"处理）', () => {
    assert.equal(isWholeSite(new Map(), []), false);
  });

  it('删掉其中一条后不再算 whole site', () => {
    const picked: PickMap = new Map();
    const keys = [pickKey(sel('a.example', '.x')), pickKey(sel('a.example', '.y'))];
    togglePick(picked, sel('a.example', '.x'), true);
    togglePick(picked, sel('a.example', '.y'), true);
    togglePick(picked, sel('a.example', '.x'), false);
    assert.equal(isWholeSite(picked, keys), false);
  });
});
