import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeEntry,
  decodePacked,
  selectPacked,
} from '../../src/inject/scriptletsGlobal.ts';

/**
 * 脚本注入的**紧凑数据表**（第三期返工）。
 *
 * 返工原因（实测）：最初按域名给每个 bundle 声明 match pattern，
 * 2,503 个 pattern 让浏览器**加载扩展时卡死 2.4 秒**
 * （完整 3093ms / 单条目 2500 pattern 3114ms / `<all_urls>` 801ms / 无扩展 496ms）。
 * 改成 `<all_urls>` + 内联紧凑数据表，于是必须有这套编解码的回归。
 *
 * 查表逻辑用纯函数 `selectPacked` 测（`runPacked` 会真的执行脚本，依赖 window）。
 */

type Entry = { canonical: string; args: string[] };

/** 构建期与运行期共用的编码（与 tools/build/gen-rulesets.ts 保持一致）。 */
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
    // 构建期会把控制字符替换成空格，这里验证编解码对普通参数是安全的
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
    // b.a.com 是 a.com 的子域 → 两条规则都要生效（顺序按 domainKeysForHost）
    assert.deepEqual(selectPacked(namesJoined, data, 'b.a.com'), [
      ...table['b.a.com'],
      ...table['a.com'],
    ]);
  });

  it('① 主机名本身的条目命中，而不是别人的子串', () => {
    // `a.com` 是 `b.a.com` 的后缀，边界字符必须让两者各自命中自己的规则
    assert.deepEqual(selectPacked(namesJoined, data, 'a.com'), table['a.com']);
  });

  it('② 父域规则沿主机名逐级向上命中（ABP 语义）', () => {
    const selected = selectPacked(namesJoined, data, 'x.a.com');
    // x.a.com 应拿到 a.com 的规则
    assert.deepEqual(selected, table['a.com'], '应继承父域 a.com 的规则');
    // 且**不得**拿到 b.a.com 的规则（那是另一个域名，不是 x.a.com 的祖先）
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
