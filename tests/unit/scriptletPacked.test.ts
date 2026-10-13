import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntry,
  decodePacked,
  selectPacked,
} from '../../src/inject/scriptletsGlobal.ts';

// The compact scriptlet data table (third-phase rework). Why it was reworked: declaring one
// match pattern per domain bundle produced 2,503 patterns and froze extension load for 2.4s
// (3093ms full / 3114ms for 2500 patterns / 801ms for <all_urls> / 496ms without the extension).
// Switching to <all_urls> plus an inline table is why this codec needs regression coverage.
// Lookup is exercised through the pure `selectPacked`; `runPacked` really executes scripts.

type Entry = { canonical: string; args: string[] };

/** Build-time/runtime codec, kept in sync with tools/build/gen-rulesets.ts. */
function pack(names: string[], table: Record<string, Entry[]>) {
  const idx = new Map(names.map((n, i) => [n, i]));
  const entries = Object.keys(table)
    .sort()
    .map((domain) => {
      const body = table[domain]!
        .map((inv) => [idx.get(inv.canonical), ...inv.args].join('\u0001'))
        .join('\u0002');
      return `\u0004${domain}\u0003${body}`;
    });
  return { namesJoined: names.join('\u0001'), data: entries.join('') };
}

const NAMES = ['set-constant', 'abort-on-property-read', 'remove-cookie'];

describe('紧凑数据表：编解码往返', () => {
  it('decodeEntry 还原单个调用', () => {
    assert.deepEqual(decodeEntry(['set-constant', 'aopr'], '0\u0001x\u0001false'), [
      { canonical: 'set-constant', args: ['x', 'false'] },
    ]);
  });

  it('decodeEntry 还原多个调用', () => {
    assert.deepEqual(decodeEntry(['set-constant', 'aopr'], '0\u0001x\u0001false\u00021\u0001y'), [
      { canonical: 'set-constant', args: ['x', 'false'] },
      { canonical: 'aopr', args: ['y'] },
    ]);
  });

  it('参数里的分隔符被构建期清理（不会破坏编码）', () => {
    // The build replaces control characters with spaces; this checks plain args survive the codec.
    const { namesJoined, data } = pack(NAMES, {
      'a.com': [{ canonical: 'remove-cookie', args: ['/sc_id|statsig/'] }],
    });
    const map = decodePacked(namesJoined, data);
    assert.deepEqual(map.get('a.com'), [
      { canonical: 'remove-cookie', args: ['/sc_id|statsig/'] },
    ]);
  });

  it('全量解码与原始表一致', () => {
    const table = {
      'example.com': [{ canonical: 'set-constant', args: ['adsEnabled', 'false'] }],
      'news.example.com': [{ canonical: 'abort-on-property-read', args: ['adblock'] }],
      'a.com': [{ canonical: 'remove-cookie', args: ['/tracker/'] }],
    };
    const { namesJoined, data } = pack(NAMES, table);
    const map = decodePacked(namesJoined, data);
    assert.equal(map.size, 3);
    for (const [d, v] of Object.entries(table)) assert.deepEqual(map.get(d), v);
  });

  it('空数据返回空表（列表未生成时不能抛）', () => {
    assert.equal(decodePacked('', '').size, 0);
    assert.deepEqual(decodeEntry([], ''), []);
    assert.deepEqual(selectPacked('', '', 'a.com'), []);
  });
});

describe('❗惰性查表：边界字符必须防止子串误命中', () => {
  const table = {
    'a.com': [{ canonical: 'remove-cookie', args: ['/aOnly/'] }],
    'b.a.com': [{ canonical: 'set-constant', args: ['bOnly', 'false'] }],
  };
  const { namesJoined, data } = pack(NAMES, table);

  it('❗子域会继承父域规则（ABP 语义），两者都命中', () => {
    // b.a.com is a subdomain of a.com, so both rules apply (ordered by domainKeysForHost).
    assert.deepEqual(selectPacked(namesJoined, data, 'b.a.com'), [
      ...table['b.a.com'],
      ...table['a.com'],
    ]);
  });

  it('① 主机名本身的条目命中，而不是别人的子串', () => {
    // `a.com` is a suffix of `b.a.com`: boundary characters must let each match its own rules.
    assert.deepEqual(selectPacked(namesJoined, data, 'a.com'), table['a.com']);
  });

  it('② 父域规则沿主机名逐级向上命中（ABP 语义）', () => {
    const selected = selectPacked(namesJoined, data, 'x.a.com');
    assert.deepEqual(selected, table['a.com'], '应继承父域 a.com 的规则');
    // And it must not pick up b.a.com's rules: a different domain, not an ancestor of x.a.com.
    assert.ok(
      !selected.some((i) => i.args.includes('bOnly')),
      'b.a.com 的规则不得泄漏到 x.a.com',
    );
  });

  it('③ 全都不匹配时返回空数组（<all_urls> 会注入到所有站点）', () => {
    assert.deepEqual(selectPacked(namesJoined, data, 'unrelated.net'), []);
    assert.deepEqual(selectPacked(namesJoined, data, 'a.com.evil.test'), []);
  });

  it('④ 数据表里没有该域名时不抛异常', () => {
    assert.doesNotThrow(() => selectPacked(namesJoined, data, 'nowhere.test'));
  });

  it('⑤ 通配 TLD 键（`amazon.*`）也能命中 —— 这是返工后收回来的 341 个域名', () => {
    const wild = pack(NAMES, { 'amazon.*': [{ canonical: 'set-constant', args: ['x', 'false'] }] });
    assert.deepEqual(selectPacked(wild.namesJoined, wild.data, 'www.amazon.com'), [
      { canonical: 'set-constant', args: ['x', 'false'] },
    ]);
    assert.deepEqual(selectPacked(wild.namesJoined, wild.data, 'amazon.co.jp'), [
      { canonical: 'set-constant', args: ['x', 'false'] },
    ]);
    assert.deepEqual(selectPacked(wild.namesJoined, wild.data, 'notamazon.com'), []);
  });
});
