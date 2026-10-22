import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedFilter } from '../../src/engine/filterList/parse.ts';
import {
  BADWARE_LIST_ID,
  badwareDomainFromPattern,
  createBadwareIndexLoader,
  extractBadwareDomains,
  isBadwareHost,
  normalizeBadwareHost,
  parseBadwareDomainFile,
} from '../../src/engine/badwareDomains.ts';

// The runtime gate for cookie consent: a host on the packaged ublock-badware domain list
// is left alone. Matching must be dot-boundary based, never a raw suffix/includes test.

function filter(pattern: string, overrides: Partial<ParsedFilter> = {}): ParsedFilter {
  return {
    raw: pattern,
    pattern,
    exception: false,
    regex: false,
    badfilter: false,
    important: false,
    matchCase: false,
    ...overrides,
  };
}

const SET = (domains: string[]): Set<string> => new Set(domains);

describe('badware：域名锚点提取', () => {
  it('只接受裸域名锚点（含 ^ / ^| / 无分隔符）', () => {
    assert.equal(badwareDomainFromPattern('||a.com^'), 'a.com');
    assert.equal(badwareDomainFromPattern('||a.com'), 'a.com');
    assert.equal(badwareDomainFromPattern('||a.com^|'), 'a.com');
    assert.equal(badwareDomainFromPattern('||A.COM^'), 'a.com');
  });

  it('路径、正则、通配符与残缺域名不算', () => {
    for (const pattern of [
      '||a.com/ads',
      '/a\\.com^/',
      '||*.a.com^',
      '||allyes.^',
      '||check-tl-^',
      'a.com',
    ]) {
      assert.equal(badwareDomainFromPattern(pattern), null, pattern);
    }
  });

  it('从 ublock-badware 的规则里导出：去重、排序、小写', () => {
    const domains = extractBadwareDomains([
      filter('||b.com^', { source: BADWARE_LIST_ID }),
      filter('||a.com^', { source: BADWARE_LIST_ID }),
      filter('||a.com^|', { source: BADWARE_LIST_ID }),
      filter('||path.com/ads', { source: BADWARE_LIST_ID }),
      filter('||other.com^', { source: 'easylist' }),
    ]);
    assert.deepEqual(domains, ['a.com', 'b.com']);
  });

  it('带 $domain= 作用域的规则不把域名全局标黑', () => {
    const domains = extractBadwareDomains([
      filter('||scoped.com^', { source: BADWARE_LIST_ID, initiatorDomains: ['news.com'] }),
    ]);
    assert.deepEqual(domains, []);
  });

  it('带 $to= / $denyallow= 作用域的规则同样不标黑', () => {
    // Real list lines: `||roblox.com.$all,to=~cloudflare.net` would otherwise add the
    // legitimate roblox.com to the runtime gate once $to= compiles.
    const domains = extractBadwareDomains([
      filter('||roblox.com^', { source: BADWARE_LIST_ID, requestDomains: ['evil.net'] }),
      filter('||bad.com^', { source: BADWARE_LIST_ID, excludedRequestDomains: ['keep.com'] }),
      filter('||plain.com^', { source: BADWARE_LIST_ID }),
    ]);
    assert.deepEqual(domains, ['plain.com']);
  });

  it('例外行从黑名单里扣除；badfilter 忽略', () => {
    const domains = extractBadwareDomains([
      filter('||a.com^', { source: BADWARE_LIST_ID }),
      filter('||a.com^', { source: BADWARE_LIST_ID, exception: true }),
      filter('||b.com^', { source: BADWARE_LIST_ID, badfilter: true }),
      filter('||c.com^', { source: BADWARE_LIST_ID }),
    ]);
    assert.deepEqual(domains, ['c.com']);
  });
});

describe('badware：清单文件解析', () => {
  it('读取 domains 数组，小写并去重', () => {
    const parsed = parseBadwareDomainFile({
      generatedFrom: BADWARE_LIST_ID,
      domains: ['A.com', 'a.com', 'www.b.com'],
    });
    assert.deepEqual([...parsed!].sort(), ['a.com', 'www.b.com']);
  });

  it('空数组是有效清单（放行，不是读不到）', () => {
    const parsed = parseBadwareDomainFile({ generatedFrom: BADWARE_LIST_ID, domains: [] });
    assert.ok(parsed);
    assert.equal(parsed?.size, 0);
  });

  it('文件缺失 / 形状不对 / domains 不是数组 → null', () => {
    assert.equal(parseBadwareDomainFile(null), null);
    assert.equal(parseBadwareDomainFile(undefined), null);
    assert.equal(parseBadwareDomainFile([]), null);
    assert.equal(parseBadwareDomainFile({}), null);
    assert.equal(parseBadwareDomainFile({ domains: 'a.com' }), null);
    assert.equal(parseBadwareDomainFile({ domains: ['a.com', 42, null] })?.size, 1);
  });
});

describe('badware：主机名后缀匹配', () => {
  const domains = SET(['a.com', 'b.net']);

  it('精确匹配', () => {
    assert.equal(isBadwareHost('a.com', domains), true);
  });

  it('子域匹配（任意层级）', () => {
    assert.equal(isBadwareHost('www.a.com', domains), true);
    assert.equal(isBadwareHost('x.y.a.com', domains), true);
  });

  it('大小写不敏感', () => {
    assert.equal(isBadwareHost('WWW.A.COM', domains), true);
    assert.equal(isBadwareHost('X.Y.A.COM', domains), true);
  });

  it('去掉前导 www. 后再比一次', () => {
    assert.equal(isBadwareHost('www.b.net', domains), true);
  });

  it('nota.com 不命中 a.com（不能用 includes / 裸 endsWith）', () => {
    assert.equal(isBadwareHost('nota.com', domains), false);
    assert.equal(isBadwareHost('a.com.evil', domains), false);
    assert.equal(isBadwareHost('ba.com', domains), false);
  });

  it('空清单 / 空主机不命中', () => {
    assert.equal(isBadwareHost('a.com', new Set()), false);
    assert.equal(isBadwareHost('', domains), false);
    assert.equal(isBadwareHost('   ', domains), false);
  });

  it('主机名归一化：大小写、尾点、端口', () => {
    assert.equal(normalizeBadwareHost(' WWW.A.COM:443 '), 'www.a.com');
    assert.equal(normalizeBadwareHost('a.com.'), 'a.com');
    assert.equal(isBadwareHost('a.com:8080', domains), true);
  });
});

describe('badware：清单加载只读一次并缓存', () => {
  it('并发调用共享同一次读取，成功日志只记一次', async () => {
    let loads = 0;
    let loadedLogs = 0;
    const loader = createBadwareIndexLoader({
      loadFile: async () => {
        loads += 1;
        return { generatedFrom: BADWARE_LIST_ID, domains: ['a.com'] };
      },
      onLoaded: () => {
        loadedLogs += 1;
      },
    });

    const [first, second] = await Promise.all([loader.load(), loader.load()]);
    assert.equal(loads, 1);
    assert.equal(loadedLogs, 1);
    assert.equal(first.available, true);
    assert.equal(second.domains.has('a.com'), true);
  });

  it('读取失败返回 available=false，并缓存失败、只记一条日志', async () => {
    let loads = 0;
    let unavailableLogs = 0;
    const loader = createBadwareIndexLoader({
      loadFile: async () => {
        loads += 1;
        throw new Error('missing file');
      },
      onUnavailable: () => {
        unavailableLogs += 1;
      },
    });

    const first = await loader.load();
    const second = await loader.load();
    assert.equal(loads, 1);
    assert.equal(unavailableLogs, 1);
    assert.deepEqual(first, { domains: new Set(), available: false });
    assert.equal(second.available, false);
  });

  it('JSON 形状不对（没有 domains 数组）同样视为读不到', async () => {
    let unavailableLogs = 0;
    const loader = createBadwareIndexLoader({
      loadFile: async () => ({ generatedFrom: BADWARE_LIST_ID }),
      onUnavailable: () => {
        unavailableLogs += 1;
      },
    });
    const index = await loader.load();
    assert.equal(index.available, false);
    assert.equal(unavailableLogs, 1);
  });
});
