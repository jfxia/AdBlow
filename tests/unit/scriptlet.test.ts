import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCRIPTLET_ALIASES,
  SUPPORTED_SCRIPTLETS,
  buildScriptletIndex,
  parseScriptletArgs,
  parseScriptletRule,
} from '../../src/engine/filterList/scriptlet.ts';

/**
 * 脚本注入规则的解析与编译（第三期）。
 *
 * 取舍依据是实测频率：2,807 条规则、50 个脚本名，**前 5 名覆盖 61%、前 10 名 81%**。
 * 所以"实现常用子集"是有据可依的，不是偷懒。
 */

const parse = (line: string) => {
  const r = parseScriptletRule(line);
  assert.ok(r, `应解析成功：${line}`);
  return r!;
};

describe('parseScriptletArgs：参数切分', () => {
  it('普通逗号分隔', () => {
    assert.deepEqual(parseScriptletArgs('aopr, adsEnabled'), ['aopr', 'adsEnabled']);
    assert.deepEqual(parseScriptletArgs('set, x, false'), ['set', 'x', 'false']);
  });

  it('❗支持转义逗号（uBO 语法）', () => {
    assert.deepEqual(parseScriptletArgs('set, x, a\\,b'), ['set', 'x', 'a,b']);
  });

  it('保留空参数（有些脚本用逗号占位）', () => {
    const args = parseScriptletArgs('set-cookie, GPC, 1, , reload, 1');
    assert.equal(args[0], 'set-cookie');
    assert.equal(args.length, 6);
  });

  it('去掉首尾空白', () => {
    assert.deepEqual(parseScriptletArgs(' aopr ,  x '), ['aopr', 'x']);
  });
});

describe('parseScriptletRule：语法与别名', () => {
  it('解析域名、别名与参数', () => {
    const r = parse('example.com##+js(aopr, adsEnabled)');
    assert.deepEqual(r.domains, ['example.com']);
    assert.equal(r.name, 'aopr');
    assert.equal(r.canonical, 'abort-on-property-read');
    assert.deepEqual(r.args, ['adsEnabled']);
  });

  it('多域名', () => {
    assert.deepEqual(parse('a.com,b.com##+js(set, x, false)').domains, ['a.com', 'b.com']);
  });

  it('~ 排除域名被单独记录', () => {
    const r = parse('~sub.example.com##+js(aopr, x)');
    assert.deepEqual(r.domains, []);
    assert.deepEqual(r.excludedDomains, ['sub.example.com']);
  });

  it('通配 TLD 域名', () => {
    assert.deepEqual(parse('ticketmaster.*##+js(aopr, x)').domains, ['ticketmaster.*']);
  });

  it('未知名字 canonical 为 null', () => {
    assert.equal(parse('a.com##+js(some-unknown-thing, x)').canonical, null);
  });

  it('#@#+js(...) 例外返回 null（本期不处理例外）', () => {
    assert.equal(parseScriptletRule('a.com#@#+js(aopr, x)'), null);
  });

  it('不是脚本注入的返回 null', () => {
    assert.equal(parseScriptletRule('a.com##.ad'), null);
    assert.equal(parseScriptletRule('||ads.example.com^'), null);
    assert.equal(parseScriptletRule('! 注释'), null);
  });

  it('括号不闭合时返回 null（不抛异常）', () => {
    assert.equal(parseScriptletRule('a.com##+js(aopr, x'), null);
  });
});

describe('别名表与支持子集的一致性', () => {
  it('每个支持的名字都必须能被某个别名解析到（否则永远用不上）', () => {
    const reachable = new Set(Object.values(SCRIPTLET_ALIASES));
    const unreachable = [...SUPPORTED_SCRIPTLETS].filter((c) => !reachable.has(c));
    // `set-local-storage-item` / `remove-cookie` 等以规范名直接出现，也算可达
    const selfNamed = unreachable.filter((c) => !SCRIPTLET_ALIASES[c]);
    assert.deepEqual(
      selfNamed,
      [],
      `这些支持的名字没有别名也没有同名映射，属于死代码：${selfNamed.join(', ')}`,
    );
  });

  it('高频名字都在支持列表里（实测前 7 名的可支持项）', () => {
    // aopr 636 / set 327 / nostif 195 / aopw 184 / nowoif 178
    for (const alias of ['aopr', 'set', 'nostif', 'aopw', 'nowoif']) {
      assert.ok(
        SUPPORTED_SCRIPTLETS.has(SCRIPTLET_ALIASES[alias]!),
        `${alias} 是高频脚本，应在支持列表里`,
      );
    }
  });
});

describe('buildScriptletIndex：域名索引与统计', () => {
  const rules = [
    parse('a.com##+js(aopr, x)'),
    parse('a.com##+js(set, y, false)'),
    parse('b.com##+js(nostif, /ad/)'),
    parse('c.com##+js(acs, document.createElement, admiral)'), // 未支持
    parse('d.com##+js(totally-unknown, x)'), // 未知
    parse('~e.com##+js(aopr, x)'), // 排除型
    parse('##+js(aopr, x)'), // 无域名限定 → 不做
  ];
  const index = buildScriptletIndex(rules);

  it('域名 → 调用序列', () => {
    assert.equal(index.byDomain.get('a.com')!.length, 2);
    assert.deepEqual(index.byDomain.get('a.com')![0], {
      canonical: 'abort-on-property-read',
      args: ['x'],
    });
    assert.equal(index.byDomain.get('b.com')!.length, 1);
  });

  it('❗未支持的名字被统计出来（决定下一步做什么）', () => {
    assert.equal(index.stats.unsupportedName, 1);
    assert.deepEqual(index.stats.unsupportedByCanonical, { 'abort-current-script': 1 });
  });

  it('未知名字单独计数', () => {
    assert.ok(index.stats.unknownName >= 1);
  });

  it('~ 排除型跳过而不是误用', () => {
    assert.equal(index.stats.skippedExcluded, 1);
    assert.equal(index.byDomain.get('e.com'), undefined);
  });

  it('覆盖域名数正确', () => {
    assert.equal(index.stats.domains, 2, 'a.com 与 b.com');
  });
});
