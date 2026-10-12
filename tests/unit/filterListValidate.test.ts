import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REGEX_RULES,
  isValidRequestDomain,
  normalizeUrlFilter,
  urlFilterProblem,
  validateRuleset,
  validateRulesets,
} from '../../src/engine/filterList/validate.ts';
import type { DnrListRule } from '../../src/engine/filterList/compile.ts';

/**
 * DNR 约束自检 —— 这个文件的存在理由是一次真实事故：
 *
 * 浏览器**只要发现一条规则非法，就拒绝加载整个扩展**，而 Node 侧毫无迹象。
 * 实测踩到两次（119 条规则同时带 resourceTypes 与 excludedResourceTypes；
 * `||*` 开头的 urlFilter），都只有开浏览器才暴露。
 *
 * 所以校验器必须比浏览器更早知道问题 —— 它现在是构建期的一道硬门。
 */

const rule = (over: Partial<DnrListRule> = {}): DnrListRule => ({
  id: 1,
  priority: 1,
  action: { type: 'block' },
  condition: { urlFilter: '||ads.example.com^' },
  ...over,
});

describe('isValidRequestDomain', () => {
  it('接受正常域名与 IPv4', () => {
    for (const d of ['example.com', 'ads.example.com', 'a-b.co.uk', '0.0.0.1', '255.255.255.255']) {
      assert.equal(isValidRequestDomain(d), true, d);
    }
  });

  it('❗拒绝上游列表里的残缺域名（实测会产出非法规则 → 扩展装不上）', () => {
    for (const d of [
      'allyes.', // ||allyes.$third-party
      'check-tl-', // ||check-tl-$all
      'valid-check-tl-', // ||valid-check-tl-$all
      'adservice.google.', // 尾部点
      '142.91.159.', // 截断的 IP
      '.example.com',
      'no-tld',
      '256.1.1.1',
      '',
    ]) {
      assert.equal(isValidRequestDomain(d), false, d);
    }
  });
});

describe('urlFilterProblem', () => {
  it('接受合法模式', () => {
    for (const p of ['||ads.example.com^', '|https://', 'swf|', '/ads/*.gif', '^ad^', 'ad-banner']) {
      assert.equal(urlFilterProblem(p), null, p);
    }
  });

  it('❗拒绝 ||* 开头（官方明确禁止）', () => {
    assert.match(urlFilterProblem('||*xav.*/guang/*.gif')!, /\|\|\*/);
  });

  it('拒绝空、非 ASCII、空白、只有锚点、中段 |', () => {
    assert.ok(urlFilterProblem(''));
    assert.ok(urlFilterProblem('||广告.com^'));
    assert.ok(urlFilterProblem('||a b.com^'));
    assert.ok(urlFilterProblem('||'));
    assert.ok(urlFilterProblem('|'));
    assert.ok(urlFilterProblem('a|b'));
  });

  it('两端有 | 是合法的（左锚点与右锚点）', () => {
    assert.equal(urlFilterProblem('|https://example.com|'), null);
    assert.equal(urlFilterProblem('||example.com^|'), null);
  });
});

describe('normalizeUrlFilter', () => {
  it('按官方建议把 ||* 规范化成 * 开头', () => {
    assert.deepEqual(normalizeUrlFilter('||*xav.*/guang/*.gif'), {
      value: '*xav.*/guang/*.gif',
      changed: true,
    });
  });

  it('其它模式原样保留', () => {
    assert.deepEqual(normalizeUrlFilter('||ads.example.com^'), {
      value: '||ads.example.com^',
      changed: false,
    });
  });
});

describe('validateRuleset', () => {
  it('合法规则集没有问题', () => {
    assert.deepEqual(validateRuleset([rule()], 1), []);
  });

  it('❗resourceTypes 与 excludedResourceTypes 互斥（曾导致整个扩展装不上）', () => {
    const problems = validateRuleset(
      [
        rule({
          condition: {
            urlFilter: '||a.com^',
            resourceTypes: ['script'],
            excludedResourceTypes: ['image'],
          },
        }),
      ],
      1,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.problem, /不能同时存在/);
  });

  it('❗urlFilter 语法非法会被抓出来', () => {
    const problems = validateRuleset([rule({ condition: { urlFilter: '||*x' } })], 1);
    assert.ok(problems.some((p) => /\|\|\*/.test(p.problem)));
  });

  it('id 必须唯一且 ≥1', () => {
    assert.ok(validateRuleset([rule({ id: 0 })], 1).some((p) => /非法 id/.test(p.problem)));
    assert.ok(
      validateRuleset([rule({ id: 1 }), rule({ id: 1 })], 1).some((p) => /id 重复/.test(p.problem)),
    );
  });

  it('priority 必须 ≥1', () => {
    assert.ok(validateRuleset([rule({ priority: 0 })], 1).some((p) => /priority/.test(p.problem)));
  });

  it('必须有匹配条件，否则会匹配一切', () => {
    const problems = validateRuleset([rule({ condition: {} })], 1);
    assert.ok(problems.some((p) => /匹配条件/.test(p.problem)));
  });

  it('requestDomains 里的非法域名会被抓出来', () => {
    const problems = validateRuleset(
      [rule({ condition: { requestDomains: ['allyes.', 'ok.com'] } })],
      1,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.problem, /allyes\./);
  });

  it('空数组会被抓出来', () => {
    assert.ok(
      validateRuleset([rule({ condition: { requestDomains: [] } })], 1).some((p) =>
        /空数组/.test(p.problem),
      ),
    );
    assert.ok(
      validateRuleset([rule({ condition: { urlFilter: '||a^', resourceTypes: [] } })], 1).some((p) =>
        /空数组/.test(p.problem),
      ),
    );
  });

  it('❗只报"意外拦主文档"，不报显式 $document', () => {
    // 显式 main_frame 是编译器既定允许的
    assert.deepEqual(
      validateRuleset([rule({ condition: { urlFilter: '||a^', resourceTypes: ['main_frame'] } })], 1),
      [],
    );
    // 两个类型字段都不写 = DNR 默认排除主文档，也不该报
    assert.deepEqual(validateRuleset([rule({ condition: { urlFilter: '||a^' } })], 1), []);
    // 写了 excludedResourceTypes 却没排除 main_frame = 意外拦主文档，要报
    assert.ok(
      validateRuleset(
        [rule({ condition: { urlFilter: '||a^', excludedResourceTypes: ['image'] } })],
        1,
      ).some((p) => /主文档/.test(p.problem)),
    );
    // 正确排除了就不报
    assert.deepEqual(
      validateRuleset(
        [rule({ condition: { urlFilter: '||a^', excludedResourceTypes: ['image', 'main_frame'] } })],
        1,
      ),
      [],
    );
  });

  it('正则条数超上限会被抓出来', () => {
    const many = Array.from({ length: MAX_REGEX_RULES + 1 }, (_, i) =>
      rule({ id: i + 1, condition: { regexFilter: `/ad${i}/` } }),
    );
    assert.ok(validateRuleset(many, 1).some((p) => /正则规则/.test(p.problem)));
  });

  it('validateRulesets 汇总多卷并带上卷号', () => {
    const problems = validateRulesets([[rule({ id: 0 })], [rule({ condition: {} })]]);
    assert.equal(problems.length, 2);
    assert.deepEqual(problems.map((p) => p.ruleset), [1, 2]);
  });
});
