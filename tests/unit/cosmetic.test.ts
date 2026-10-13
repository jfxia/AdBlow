import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COSMETIC_SHARD_COUNT,
  buildCosmeticIndex,
  cosmeticCssFor,
  domainKeysForHost,
  domainsToQuery,
  looksLikeValidSelector,
  parseCosmeticLine,
  selectorsForHost,
  selectorsFromShards,
  shardIndex,
  shardOf,
  shardsForHost,
  splitTopLevel,
} from '../../src/engine/filterList/cosmetic.ts';

// Cosmetic rule parsing and compilation. Scope decision, following uBOL: generic (domain-less)
// cosmetic rules are risky and stay off by default, so domain-specific rules are applied while
// generic ones are only parsed and counted.

const parse = (line: string) => {
  const f = parseCosmeticLine(line);
  assert.ok(f, `应解析成功：${line}`);
  return f!;
};

describe('splitTopLevel：按顶层逗号切分', () => {
  it('普通列表', () => {
    assert.deepEqual(splitTopLevel('.a, .b , .c'), ['.a', '.b', '.c']);
  });

  it('❗不切分括号/方括号/引号里的逗号', () => {
    assert.deepEqual(splitTopLevel('div:has(a, b)'), ['div:has(a, b)']);
    assert.deepEqual(splitTopLevel('[data-x="a,b"]'), ['[data-x="a,b"]']);
    assert.deepEqual(splitTopLevel('.a, div:not(.x, .y), .b'), ['.a', 'div:not(.x, .y)', '.b']);
  });

  it('忽略空片段', () => {
    assert.deepEqual(splitTopLevel('.a,,.b,'), ['.a', '.b']);
  });
});

describe('parseCosmeticLine：语法分类', () => {
  it('域名专用隐藏', () => {
    const f = parse('example.com##.ad-banner');
    assert.deepEqual(f.domains, ['example.com']);
    assert.equal(f.selector, '.ad-banner');
    assert.equal(f.flavor, 'hide');
  });

  it('多域名 + 通用（无域名）', () => {
    assert.deepEqual(parse('a.com,b.com##.ad').domains, ['a.com', 'b.com']);
    assert.deepEqual(parse('##.ad').domains, []);
  });

  it('例外规则 #@#', () => {
    const f = parse('example.com#@#.ad-banner');
    assert.equal(f.flavor, 'unhide');
    assert.equal(f.selector, '.ad-banner');
  });

  it('~ 排除域名被单独记录', () => {
    const f = parse('~sub.example.com##.ad');
    assert.deepEqual(f.domains, []);
    assert.deepEqual(f.excludedDomains, ['sub.example.com']);
  });

  it('程序化 / 样式 / 脚本注入被分类', () => {
    assert.equal(parse('example.com#?#div:has-text(广告)').flavor, 'procedural');
    assert.equal(parse('example.com#$#.ad { display:none }').flavor, 'style');
    assert.equal(parse('example.com##+js(set-constant, x, 1)').flavor, 'scriptlet');
  });

  it('域名大小写归一', () => {
    assert.deepEqual(parse('Example.COM##.ad').domains, ['example.com']);
  });

  it('不是 cosmetic 的返回 null', () => {
    assert.equal(parseCosmeticLine('||ads.example.com^'), null);
    assert.equal(parseCosmeticLine('! 注释'), null);
    assert.equal(parseCosmeticLine(''), null);
  });

  it('选择器为空的返回 null', () => {
    assert.equal(parseCosmeticLine('example.com##'), null);
  });
});

describe('looksLikeValidSelector：粗筛非法选择器', () => {
  it('接受常见形态', () => {
    for (const s of ['.ad', '#banner', 'div.ad', '[data-ad]', 'a[href^="x"]', '*', ':root', ' div.ad']) {
      assert.equal(looksLikeValidSelector(s), true, s);
    }
  });

  it('❗拒绝会毁掉整张样式表的形态', () => {
    for (const s of ['', '   ', '{display:none}', 'div{color:red}', '<script>', 'a>b{']) {
      assert.equal(looksLikeValidSelector(s), false, s);
    }
  });
});

describe('buildCosmeticIndex：按域名建索引', () => {
  const index = buildCosmeticIndex(
    [
      parse('example.com##.ad-a'),
      parse('example.com##.ad-b'),
      parse('example.com#@#.ad-b'),
      parse('sub.example.com##.ad-c'),
      parse('##.generic-ad'),
      parse('##.generic-ad2'),
      parse('other.com#?#div:has-text(x)'),
      parse('x.com#$#.y { color: red }'),
      parse('y.com##+js(set-constant, a, 1)'),
      parse('~excluded.com##.ad-d'),
      parse('bad.com##{display:none}'),
    ].filter(Boolean) as ReturnType<typeof parse>[],
  );

  it('域名专用规则进了索引', () => {
    assert.deepEqual([...index.hideByDomain.get('example.com')!].sort(), ['.ad-a', '.ad-b']);
    assert.deepEqual([...index.unhideByDomain.get('example.com')!], ['.ad-b']);
    assert.deepEqual([...index.hideByDomain.get('sub.example.com')!], ['.ad-c']);
  });

  it('通用规则单独存放（默认不注入）', () => {
    assert.deepEqual([...index.genericHide].sort(), ['.generic-ad', '.generic-ad2']);
  });

  it('❗~ 排除型规则被跳过而不是误当成正向规则', () => {
    assert.equal(index.stats.skippedExcluded, 1);
    assert.equal(index.hideByDomain.get('excluded.com'), undefined);
  });

  it('❗非法选择器被丢弃（一条非法选择器会毁掉整张样式表）', () => {
    assert.equal(index.stats.invalidSelectors, 1);
    assert.equal(index.hideByDomain.get('bad.com'), undefined);
  });

  it('程序化/样式/脚本注入只计数不产出', () => {
    assert.deepEqual(index.stats.deferred, { procedural: 1, style: 1, scriptlet: 1 });
  });

  it('统计数字对得上', () => {
    assert.equal(index.stats.parsed, 11);
    assert.equal(index.stats.generic, 2);
  });
});

describe('selectorsForHost：沿主机名逐级向上查（ABP 语义）', () => {
  const index = buildCosmeticIndex([
    parse('example.com##.root-ad'),
    parse('sub.example.com##.sub-ad'),
    parse('deep.sub.example.com##.deep-ad'),
    parse('other.com##.other-ad'),
  ]);

  it('父域规则对子域生效', () => {
    assert.deepEqual(selectorsForHost(index, 'sub.example.com').sort(), ['.root-ad', '.sub-ad']);
  });

  it('三级子域拿到全部祖先规则', () => {
    assert.deepEqual(selectorsForHost(index, 'deep.sub.example.com').sort(), [
      '.deep-ad',
      '.root-ad',
      '.sub-ad',
    ]);
  });

  it('无关域名拿不到', () => {
    assert.deepEqual(selectorsForHost(index, 'unrelated.com'), []);
  });

  it('❗例外会扣掉同胞规则', () => {
    const withUnhide = buildCosmeticIndex([
      parse('example.com##.a'),
      parse('example.com##.b'),
      parse('sub.example.com#@#.a'),
    ]);
    assert.deepEqual(selectorsForHost(withUnhide, 'sub.example.com'), ['.b']);
    assert.deepEqual(selectorsForHost(withUnhide, 'example.com').sort(), ['.a', '.b']);
  });

  it('大小写不敏感', () => {
    assert.deepEqual(selectorsForHost(index, 'SUB.Example.COM').sort(), ['.root-ad', '.sub-ad']);
  });

  it('无匹配时返回空数组', () => {
    const empty = buildCosmeticIndex([]);
    assert.deepEqual(selectorsForHost(empty, 'a.com'), []);
  });
});

describe('cosmeticCssFor', () => {
  it('生成 display:none !important', () => {
    assert.equal(cosmeticCssFor(['.a', '.b']), '.a,.b{display:none!important;}');
  });

  it('空列表产出空字符串', () => {
    assert.equal(cosmeticCssFor([]), '');
  });
});

describe('分片投递：生成端与运行端必须一致', () => {
  it('shardOf 是确定性的且随域名变化', () => {
    assert.equal(shardOf('example.com'), shardOf('example.com'));
    assert.equal(shardOf('EXAMPLE.COM'), shardOf('example.com'), '大小写不影响分片');
    const set = new Set(['a.com', 'b.com', 'c.com', 'd.com'].map((d) => shardOf(d)));
    assert.ok(set.size > 1, '不同域名应散落到不同分片');
  });

  it('domainsToQuery 逐级向上', () => {
    assert.deepEqual(domainsToQuery('a.b.example.com'), [
      'a.b.example.com',
      'b.example.com',
      'example.com',
      'com',
    ]);
    assert.deepEqual(domainsToQuery('example.com'), ['example.com', 'com']);
  });

  it('❗分片数可控（运行端只取需要的几片，代价是每页几次本地文件读）', () => {
    const shards = shardsForHost('a.b.example.com');
    // Each suffix level adds at most one wildcard form, so the bound is ~2x the suffix count.
    assert.ok(shards.length >= 1 && shards.length <= 8, `实际取 ${shards.length} 片`);
    assert.deepEqual(shards, [...shards].sort((a, b) => a - b), '应升序');
    assert.equal(new Set(shards).size, shards.length, '应去重');
  });

  it('❗索引切分后，运行端能取回同样的选择器（端到端一致性）', () => {
    const index = buildCosmeticIndex([
      parse('example.com##.root-ad'),
      parse('sub.example.com##.sub-ad'),
      parse('sub.example.com#@#.root-ad'),
      parse('other.com##.other-ad'),
    ]);
    const shards = shardIndex(index);

    // Runtime side: pick the shards for the host, then parse them.
    const loaded = shardsForHost('sub.example.com').map((i) => shards[i]!);
    assert.deepEqual(selectorsFromShards(loaded, 'sub.example.com'), ['.sub-ad']);

    // other.com's rules live in other shards and must be unaffected.
    const loadedOther = shardsForHost('other.com').map((i) => shards[i]!);
    assert.deepEqual(selectorsFromShards(loadedOther, 'other.com'), ['.other-ad']);
  });

  it('分片数组里有 null（取不到的文件）时安全跳过', () => {
    assert.deepEqual(selectorsFromShards([null, null], 'example.com'), []);
  });

  it('❗通配 TLD 键（`amazon.*`）也能命中 —— 实测 250 个这种键', () => {
    const wild = buildCosmeticIndex([parse('amazon.*##.wild-ad'), parse('example.com##.plain-ad')]);
    // ABP semantics: amazon.* applies to any TLD.
    assert.deepEqual(selectorsForHost(wild, 'www.amazon.com'), ['.wild-ad']);
    assert.deepEqual(selectorsForHost(wild, 'www.amazon.co.jp'), ['.wild-ad']);
    assert.deepEqual(selectorsForHost(wild, 'amazon.de'), ['.wild-ad']);
    assert.deepEqual(selectorsForHost(wild, 'notamazon.com'), []);

    // The shard path must agree.
    const shards = shardIndex(wild);
    const loaded = shardsForHost('www.amazon.co.uk').map((i) => shards[i]!);
    assert.deepEqual(selectorsFromShards(loaded, 'www.amazon.co.uk'), ['.wild-ad']);
  });

  it('domainKeysForHost 同时给出字面后缀与通配形式', () => {
    const keys = domainKeysForHost('a.example.com');
    assert.ok(keys.includes('a.example.com'));
    assert.ok(keys.includes('example.com'));
    assert.ok(keys.includes('example.*'), '应包含通配 TLD 形式');
  });

  it('分片数量与 COSMETIC_SHARD_COUNT 一致', () => {
    assert.equal(shardIndex(buildCosmeticIndex([])).length, COSMETIC_SHARD_COUNT);
  });
});
