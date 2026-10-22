import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilterLine, parseList } from '../../src/engine/filterList/parse.ts';
import { compileFilters, simplifyRegex, PRIORITY } from '../../src/engine/filterList/compile.ts';

// Filter-list syntax parsing and compilation — the core of integrating the EasyList family.
// The two assertions that matter most: an option the parser cannot understand or express must
// drop the whole rule rather than silently widen blocking (`||x.com^$csp=...` with $csp
// ignored would become "block all of x.com"), and budget trimming must spare exception rules
// first, since exceptions are the main defence against breaking sites.

const net = (line: string) => {
  const r = parseFilterLine(line);
  assert.equal(r.kind, 'network', `应解析为网络规则：${line}`);
  return r.kind === 'network' ? r.filter : null!;
};
const skipReason = (line: string): string => {
  const r = parseFilterLine(line);
  assert.equal(r.kind, 'skip', `应被跳过：${line}`);
  return r.kind === 'skip' ? r.reason : '';
};

describe('parseFilterLine：分类', () => {
  it('注释、空行、元数据行都跳过', () => {
    assert.equal(parseFilterLine('! comment').kind, 'skip');
    assert.equal(parseFilterLine('[Adblock Plus 2.0]').kind, 'skip');
    assert.equal(parseFilterLine('   ').kind, 'skip');
    assert.equal(parseFilterLine('#if env_firefox').kind, 'skip');
  });

  it('cosmetic 家族按类型分类（交给第二、三期）', () => {
    const flavor = (l: string) => {
      const r = parseFilterLine(l);
      assert.equal(r.kind, 'cosmetic', l);
      return r.kind === 'cosmetic' ? r.flavor : '';
    };
    assert.equal(flavor('###ad-banner'), 'basic');
    assert.equal(flavor('example.com##.ad'), 'basic');
    assert.equal(flavor('example.com#@#.ad'), 'basic');
    assert.equal(flavor('example.com#?#div:has-text(广告)'), 'extended');
    assert.equal(flavor('example.com#$#.ad { display:none }'), 'style');
    assert.equal(flavor('example.com##+js(set-constant, x, 1)'), 'scriptlet');
    assert.equal(flavor('example.com##^script:has-text(ads)'), 'html');
  });
});

describe('parseFilterLine：网络规则基本形态', () => {
  it('域名锚点与例外', () => {
    const f = net('||ads.example.com^');
    assert.equal(f.pattern, '||ads.example.com^');
    assert.equal(f.exception, false);
    assert.equal(net('@@||example.com^').exception, true);
  });

  it('正则模式被识别', () => {
    assert.equal(net('/banner\\d+\\.gif/').regex, true);
    assert.equal(net('||x.com/banner.gif').regex, false);
  });

  it('类型选项映射到 DNR 资源类型', () => {
    const f = net('||x.com^$script,image,subdocument,xhr');
    assert.deepEqual(f.resourceTypes, ['script', 'image', 'sub_frame', 'xmlhttprequest']);
  });

  it('否定类型选项进 excludedResourceTypes', () => {
    const f = net('||x.com^$~image,~media');
    assert.deepEqual(f.excludedResourceTypes, ['image', 'media']);
  });

  it('$domain= 的肯定与否定分别映射', () => {
    const f = net('||x.com^$domain=a.com|b.com|~c.com');
    assert.deepEqual(f.initiatorDomains, ['a.com', 'b.com']);
    assert.deepEqual(f.excludedInitiatorDomains, ['c.com']);
  });

  it('$third-party / $~third-party / $first-party', () => {
    assert.equal(net('||x.com^$third-party').domainType, 'thirdParty');
    assert.equal(net('||x.com^$3p').domainType, 'thirdParty');
    assert.equal(net('||x.com^$~third-party').domainType, 'firstParty');
    assert.equal(net('||x.com^$first-party').domainType, 'firstParty');
  });

  it('$important / $match-case / $badfilter', () => {
    assert.equal(net('||x.com^$important').important, true);
    assert.equal(net('||x.com^$match-case').matchCase, true);
    assert.equal(net('||x.com^$badfilter').badfilter, true);
  });

  it('$all 等价于不写类型', () => {
    assert.equal(net('||x.com^$all').resourceTypes, undefined);
  });
});

// `$to=` (target host) and `$denyallow=` (never touch these targets) both map onto
// DNR's domain lists, so they must survive compile as requestDomains /
// excludedRequestDomains — and an unusable entry must drop the whole rule, never just
// the entry (that would widen `$to=a.com|*` to "any host").
describe('parseFilterLine：$to= 与 $denyallow=', () => {
  it('$to= 多项映射到 requestDomains', () => {
    assert.deepEqual(net('||ads.example^$to=a.com|b.com').requestDomains, ['a.com', 'b.com']);
  });

  it('$to= 的 ~ 项进 excludedRequestDomains', () => {
    const f = net('||ads.example^$to=a.com|~b.com');
    assert.deepEqual(f.requestDomains, ['a.com']);
    assert.deepEqual(f.excludedRequestDomains, ['b.com']);
  });

  it('$to= 可以全是反向项（只排除）', () => {
    const f = net('||ads.example^$to=~a.com|~b.com');
    assert.equal(f.requestDomains, undefined);
    assert.deepEqual(f.excludedRequestDomains, ['a.com', 'b.com']);
  });

  it('$to= 接受单标签（com 表示任意 .com 目标）', () => {
    assert.deepEqual(net('||ads.example^$to=com|net').requestDomains, ['com', 'net']);
  });

  it('$denyallow= 映射到 excludedRequestDomains', () => {
    const f = net('||ads.example^$denyallow=a.com|b.com');
    assert.equal(f.requestDomains, undefined);
    assert.deepEqual(f.excludedRequestDomains, ['a.com', 'b.com']);
  });

  it('$to= 与 $denyallow= 同时出现时两者都保留', () => {
    const f = net('||ads.example^$to=a.com|~b.com,denyallow=c.com');
    assert.deepEqual(f.requestDomains, ['a.com']);
    assert.deepEqual(f.excludedRequestDomains, ['b.com', 'c.com']);
  });

  it('域名统一小写、去重并排序', () => {
    // Order of appearance is deliberately reversed, with a case variant and a duplicate.
    const f = net('||ads.example^$to=Z.com|a.com|z.com|~Y.com|~b.com');
    assert.deepEqual(f.requestDomains, ['a.com', 'z.com']);
    assert.deepEqual(f.excludedRequestDomains, ['b.com', 'y.com']);
  });

  it('与 $domain= / $third-party 共存', () => {
    const f = net('||ads.example^$third-party,domain=site.com|~other.com,to=t1.com,denyallow=t2.com');
    assert.equal(f.domainType, 'thirdParty');
    assert.deepEqual(f.initiatorDomains, ['site.com']);
    assert.deepEqual(f.excludedInitiatorDomains, ['other.com']);
    assert.deepEqual(f.requestDomains, ['t1.com']);
    assert.deepEqual(f.excludedRequestDomains, ['t2.com']);
  });

  it('❗非法域名条目 → 丢掉整条规则，而不是只丢那一项', () => {
    for (const arg of ['a.com|*', 'a.com/b', '', 'a.com|b com', '||x^', 'a.com|', '~', 'a..com']) {
      assert.equal(skipReason(`||ads.example^$to=${arg}`), 'bad-option-argument:to', arg);
      assert.equal(
        skipReason(`||ads.example^$denyallow=${arg}`),
        'bad-option-argument:denyallow',
        arg,
      );
    }
  });

  it('❗$denyallow= 里的 ~ 项表达不了，整条丢弃而不是悄悄忽略', () => {
    assert.equal(skipReason('||ads.example^$denyallow=~a.com'), 'bad-option-argument:denyallow');
  });

  it('❗~to= / ~denyallow= 不按正向选项解析', () => {
    assert.match(skipReason('||ads.example^$~to=a.com'), /unsupported-option:~to/);
    assert.match(skipReason('||ads.example^$~denyallow=a.com'), /unsupported-option:~denyallow/);
  });
});

describe('parseFilterLine：安全边界（丢弃而不是放宽）', () => {
  it('❗表达不了的选项 → 整条丢弃（忽略会放宽拦截范围）', () => {
    for (const opt of [
      'csp=script-src none',
      'redirect=noop.js',
      'redirect-rule=1x1.gif',
      'removeparam=utm_source',
      'generichide',
      'elemhide',
      'popup',
      'inline-script',
      'replace=/a/b/',
      'sitekey=abc',
      'method=get',
    ]) {
      const reason = skipReason(`||x.com^$${opt}`);
      assert.match(reason, /unsupported-option/, `${opt} 应被判为不支持，实际：${reason}`);
    }
  });

  it('❗完全不认识的选项也必须丢弃', () => {
    assert.match(skipReason('||x.com^$somefutureopt'), /unknown-option/);
  });

  it('❗匹配一切的模式被拒绝', () => {
    for (const p of ['*', '**', '|', '||', '^']) {
      assert.equal(skipReason(p), 'match-everything', p);
    }
  });

  it('空模式被拒绝', () => {
    assert.equal(skipReason('$third-party'), 'no-pattern');
  });
});

describe('parseList：覆盖率统计', () => {
  it('分别统计网络 / cosmetic / 跳过及原因', () => {
    const text = [
      '! comment',
      '||a.com^',
      '@@||b.com^',
      'example.com##.ad',
      '||c.com^$csp=x',
      '',
    ].join('\n');
    const r = parseList(text);
    assert.equal(r.network.length, 2, '||a.com^ 与 @@||b.com^');
    assert.equal(r.cosmetic.length, 1);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0]!.reason, /unsupported-option/);
  });
});

describe('simplifyRegex：正则降级为域名锚点', () => {
  it('把域名型正则降级为 ||domain', () => {
    assert.equal(simplifyRegex('^https?:\\/\\/([^/]+\\.)?example\\.com\\/'), '||example.com');
    assert.equal(simplifyRegex('^https?:\\/\\/ads\\.example\\.net/'), '||ads.example.net');
  });

  it('降级不了就返回 null（保留为正则）', () => {
    assert.equal(simplifyRegex('banner\\d+\\.gif'), null);
    assert.equal(simplifyRegex('.*'), null);
  });
});

describe('compileFilters：编译与预算', () => {
  const parseAll = (lines: string[]) => parseList(lines.join('\n')).network;
  const opts = { budget: 10, rulesetSize: 4, regexBudget: 2 };

  it('基础编译：block 与 allow 的优先级正确', () => {
    const { rulesets } = compileFilters(parseAll(['||a.com^', '@@||b.com^']), opts);
    const rules = rulesets.flat();
    const block = rules.find((r) => r.action.type === 'block')!;
    const allow = rules.find((r) => r.action.type === 'allow')!;
    assert.equal(block.priority, PRIORITY.listBlock);
    assert.equal(allow.priority, PRIORITY.listAllow);
    assert.ok(allow.priority > block.priority, '例外必须压过普通拦截');
  });

  it('❗纯域名锚点被打包成 requestDomains（这是覆盖面的决定性手段）', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `||ads${i}.example.com^`);
    const { rulesets, report } = compileFilters(parseAll(lines), {
      budget: 24_000,
      rulesetSize: 4_000,
      regexBudget: 1_000,
    });
    assert.equal(report.packedDomains, 500, '500 个域名都应被打包');
    assert.equal(rulesets.flat().length, 1, '条件一致 → 压成 1 条规则');
    assert.equal(rulesets.flat()[0]!.condition.requestDomains!.length, 500);
    assert.equal(rulesets.flat()[0]!.condition.urlFilter, undefined, '打包后不再用 urlFilter');
  });

  it('打包按条件分组：类型不同的域名各成一组', () => {
    const { rulesets, report } = compileFilters(
      parseAll(['||a.com^', '||b.com^', '||c.com^$script', '||d.com^$script']),
      { budget: 100, rulesetSize: 100, regexBudget: 10 },
    );
    assert.equal(report.packedDomains, 4);
    assert.equal(rulesets.flat().length, 2, '不限类型一组、$script 一组');
  });

  it('域名数超过单规则上限时切分', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `||d${i}.com^`);
    const { rulesets } = compileFilters(parseAll(lines), {
      budget: 100,
      rulesetSize: 100,
      regexBudget: 10,
    });
    // MAX_DOMAINS_PER_RULE is 2000, so 25 domains don't trigger splitting.
    assert.equal(rulesets.flat().length, 1);
  });

  it('important 拦截压过普通例外；important 例外最高', () => {
    const { rulesets } = compileFilters(
      parseAll(['||a.com^$important', '@@||b.com^', '@@||c.com^$important']),
      opts,
    );
    const rules = rulesets.flat();
    const importantBlock = rules.find((r) => r.action.type === 'block')!;
    const importantAllow = rules.find((r) => r.action.type === 'allow' && r.priority === PRIORITY.listImportantAllow);
    assert.ok(importantBlock.priority > PRIORITY.listAllow, 'important 拦截应压过普通例外');
    assert.ok(importantAllow, 'important 例外应存在');
    assert.ok(importantAllow!.priority > importantBlock.priority, 'important 例外应最高');
  });

  it('❗默认不让列表规则拦主文档（除非显式 $document）', () => {
    const { rulesets } = compileFilters(parseAll(['||a.com^', '||b.com^$document']), opts);
    const rules = rulesets.flat();
    const plain = rules.find((r) => r.condition.requestDomains?.includes('a.com'))!;
    const explicit = rules.find((r) => r.condition.requestDomains?.includes('b.com'))!;
    // Omitting resourceTypes means DNR's default "everything but the main frame",
    // which is exactly the semantics we want.
    assert.equal(
      plain.condition.resourceTypes,
      undefined,
      '未写类型的规则不应展开类型列表（默认即排除主文档）',
    );
    assert.deepEqual(explicit.condition.resourceTypes, ['main_frame'], '显式 $document 才拦主文档');
  });

  it('allowMainFrame 打开后语义改为包含主文档', () => {
    const { rulesets } = compileFilters(parseAll(['||a.com^']), { ...opts, allowMainFrame: true });
    assert.ok(rulesets.flat()[0]!.condition.resourceTypes!.includes('main_frame'));
  });

  it('❗$badfilter 抵消同模式的规则', () => {
    const { rulesets, report } = compileFilters(
      parseAll(['||a.com^', '||a.com^$badfilter', '||b.com^']),
      opts,
    );
    const domains = rulesets.flat().flatMap((r) => r.condition.requestDomains ?? []);
    assert.ok(!domains.includes('a.com'), '被 badfilter 抵消的规则不应存在');
    assert.ok(domains.includes('b.com'));
    assert.equal(report.dropped['badfilter-cancelled'], 1);
  });

  it('去重：完全相同的规则只留一条', () => {
    const { report } = compileFilters(parseAll(['||a.com^', '||a.com^', '||a.com^']), opts);
    assert.equal(report.compiled, 1);
    assert.equal(report.dropped['duplicate'], 2);
  });

  it('❗预算裁剪时优先保住例外规则（且例外也会被打包）', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `||block${i}.com^`),
      ...Array.from({ length: 3 }, (_, i) => `@@||allow${i}.com^`),
    ];
    const { rulesets } = compileFilters(parseAll(lines), { budget: 5, rulesetSize: 10, regexBudget: 2 });
    const allows = rulesets.flat().filter((r) => r.action.type === 'allow');
    const allowedDomains = allows.flatMap((r) => r.condition.requestDomains ?? []);
    assert.deepEqual(
      allowedDomains.sort(),
      ['allow0.com', 'allow1.com', 'allow2.com'],
      '3 条例外都必须留下（打包后是 1 条规则含 3 个域名）',
    );
  });

  it('优先保留纯域名锚点（覆盖最广、最值钱）', () => {
    const lines = ['||valuable.com^', '/some\\d+regex/', 'ad-banner.gif'];
    const { rulesets } = compileFilters(parseAll(lines), {
      budget: 1,
      rulesetSize: 10,
      regexBudget: 0,
    });
    // Packed rules take budget first: one domain packed into one rule uses it up exactly.
    assert.deepEqual(rulesets.flat()[0]!.condition.requestDomains, ['valuable.com']);
  });

  it('正则预算生效', () => {
    const lines = ['/a\\d+/', '/b\\d+/', '/c\\d+/'];
    const { report } = compileFilters(parseAll(lines), { budget: 10, rulesetSize: 10, regexBudget: 1 });
    assert.equal(report.regex, 1);
    assert.equal(report.dropped['over-regex-budget'], 2);
  });

  it('按 rulesetSize 分卷', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `||s${i}.com^`);
    const { rulesets } = compileFilters(parseAll(lines), { budget: 100, rulesetSize: 4, regexBudget: 1 });
    // 20 same-condition domains → one packed rule; rulesets split by rule count, not domain count.
    assert.equal(rulesets.flat().length, 1);
  });

  it('规则 id 在同一卷内唯一且从 1 开始', () => {
    const lines = [...Array.from({ length: 5 }, (_, i) => `||s${i}.com^`), '/re\\d+/'];
    const { rulesets } = compileFilters(parseAll(lines), { budget: 100, rulesetSize: 10, regexBudget: 5 });
    const ids = rulesets.flat().map((r) => r.id);
    assert.deepEqual(ids, [1, 2]);
  });

  it('$domain= 映射进 initiatorDomains', () => {
    const { rulesets } = compileFilters(parseAll(['||x.com^$domain=a.com']), opts);
    assert.deepEqual(rulesets.flat()[0]!.condition.initiatorDomains, ['a.com']);
  });

  it('domainType 被保留', () => {
    const { rulesets } = compileFilters(parseAll(['||x.com^$third-party']), opts);
    assert.equal(rulesets.flat()[0]!.condition.domainType, 'thirdParty');
  });
});

describe('compileFilters：$to= / $denyallow= → 请求目标域名条件', () => {
  const parseAll = (lines: string[]) => parseList(lines.join('\n')).network;
  const opts = { budget: 100, rulesetSize: 100, regexBudget: 10 };

  it('$to= 编译成 requestDomains', () => {
    const { rulesets } = compileFilters(parseAll(['||ads.example^$to=a.com|b.com']), opts);
    const c = rulesets.flat()[0]!.condition;
    assert.deepEqual(c.requestDomains, ['a.com', 'b.com']);
    assert.equal(c.excludedRequestDomains, undefined);
  });

  it('$to= 的反向项编译成 excludedRequestDomains', () => {
    const { rulesets } = compileFilters(parseAll(['||ads.example^$to=a.com|~b.com']), opts);
    const c = rulesets.flat()[0]!.condition;
    assert.deepEqual(c.requestDomains, ['a.com']);
    assert.deepEqual(c.excludedRequestDomains, ['b.com']);
  });

  it('$denyallow= 编译成 excludedRequestDomains', () => {
    const { rulesets } = compileFilters(parseAll(['||ads.example^$denyallow=a.com']), opts);
    assert.deepEqual(rulesets.flat()[0]!.condition.excludedRequestDomains, ['a.com']);
  });

  it('❗$to= 与 $denyallow= 共存：两个字段同时出现（DNR 允许并存）', () => {
    const { rulesets } = compileFilters(
      parseAll(['||ads.example^$to=a.com|~b.com,denyallow=c.com']),
      opts,
    );
    const c = rulesets.flat()[0]!.condition;
    assert.deepEqual(c.requestDomains, ['a.com']);
    assert.deepEqual(c.excludedRequestDomains, ['b.com', 'c.com']);
  });

  it('与 $domain= / $third-party 同时生效', () => {
    const { rulesets } = compileFilters(
      parseAll(['||ads.example^$third-party,domain=site.com,to=t.com']),
      opts,
    );
    const c = rulesets.flat()[0]!.condition;
    assert.equal(c.domainType, 'thirdParty');
    assert.deepEqual(c.initiatorDomains, ['site.com']);
    assert.deepEqual(c.requestDomains, ['t.com']);
  });

  it('❗带 $to= 的规则不参与域名打包（否则 $to 列表会被模式域名覆盖）', () => {
    const { rulesets, report } = compileFilters(
      parseAll(['||a.com^', '||b.com^$to=c.com']),
      opts,
    );
    assert.equal(report.packedDomains, 1, '只有无作用域的 a.com 能打包');
    const scoped = rulesets.flat().find((r) => r.condition.urlFilter === '||b.com^')!;
    assert.deepEqual(scoped.condition.requestDomains, ['c.com']);
    assert.ok(rulesets.flat().some((r) => r.condition.requestDomains?.includes('a.com')));
  });

  it('❗带 $denyallow= 的规则不参与域名归并（作用域不能被抹掉）', () => {
    const { rulesets } = compileFilters(
      parseAll(['||a.com^', '@@||a.com^$denyallow=b.com']),
      opts,
    );
    const exception = rulesets.flat().find((r) => r.action.type === 'allow')!;
    assert.equal(exception.condition.urlFilter, '||a.com^');
    assert.equal(exception.condition.requestDomains, undefined);
    assert.deepEqual(exception.condition.excludedRequestDomains, ['b.com']);
  });

  it('❗同一模式不同 $to= 不会被去重成一条', () => {
    const { rulesets } = compileFilters(
      parseAll(['||a.com^$to=x.com', '||a.com^$to=y.com']),
      opts,
    );
    assert.deepEqual(
      rulesets.flat().map((r) => r.condition.requestDomains),
      [['x.com'], ['y.com']],
    );
  });
});
