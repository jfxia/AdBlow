import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIORITY, compileFilters, type DnrListRule } from '../../src/engine/filterList/compile.ts';
import { validateRulesets } from '../../src/engine/filterList/validate.ts';
import { parseList } from '../../src/engine/filterList/parse.ts';
import { SUBRESOURCE_TYPES, learnedDomainRules } from '../../src/engine/learnedRules.ts';

// Integration-layer re-proof of the learned-rule safety gate once the lists are in.
// The other learning tests (learnedRules / learned-selector-safety / domain-learning)
// all run without lists; on top of 21,146 list rules this asserts that learned rules
// still never block image/media/main_frame, that "lists may block images" does not leak
// into them, that list exceptions (priority 3) still outrank learned blocks (priority 2),
// and that explicit $document stays the only main-frame block.

/** A realistic list snippet: blocks images, has exceptions, important, and $document. */
const LIST_TEXT = [
  '||ads.example.com^$image,script',
  '||ads.example.com^',
  '||tracker.example.com^$xmlhttprequest,image',
  '@@||ads.example.com^$script',
  '@@||important.example.com^$important',
  '||fullpage-ad.example.com^$document',
].join('\n');

/** Compiled conditions may use `requestDomains` or `urlFilter`; cover both — an earlier
 * version read only urlFilter, so its assertions silently matched nothing. */
function domainsOf(r: DnrListRule): string[] {
  if (r.condition.requestDomains?.length) return r.condition.requestDomains;
  const m = /\|\|([^|^$]+)/.exec(r.condition.urlFilter ?? '');
  return m ? [m[1]!] : [];
}

const listRules = (() => {
  const parsed = parseList(LIST_TEXT, 'test-list');
  return compileFilters(parsed.network, { budget: 1000, rulesetSize: 200, regexBudget: 100 })
    .rulesets.flat();
})();
const learned = learnedDomainRules([
  'ads.example.com',
  'tracker.example.com',
]) as unknown as DnrListRule[];

describe('集成列表后：自学习安全闸门不被绕过', () => {
  it('前提：列表规则确实会拦 image（否则这组测试没有意义）', () => {
    const blocksImage = listRules.some(
      (r) =>
        r.action.type === 'block' &&
        domainsOf(r).includes('ads.example.com') &&
        (r.condition.resourceTypes === undefined ||
          r.condition.resourceTypes.includes('image')),
    );
    assert.ok(blocksImage, '列表应存在会拦 image 的规则 —— 集成层的对照条件');
  });

  it('❗自学习规则绝不拦 image / media', () => {
    for (const r of learned) {
      const types = r.condition.resourceTypes ?? [];
      assert.ok(!types.includes('image'), `${r.condition.urlFilter} 不得拦图片`);
      assert.ok(!types.includes('media'), `${r.condition.urlFilter} 不得拦音视频`);
    }
    // Structural guarantee: the allowed set itself excludes these two types.
    assert.ok(!SUBRESOURCE_TYPES.includes('image'));
    assert.ok(!SUBRESOURCE_TYPES.includes('media'));
  });

  it('❗自学习规则绝不拦 main_frame', () => {
    for (const r of learned) {
      assert.ok(!(r.condition.resourceTypes ?? []).includes('main_frame'));
    }
  });

  it('❗列表"允许拦图片"不传染给自学习规则：同域名下两者类型集合不同', () => {
    const listForDomain = listRules.filter(
      (r) => r.action.type === 'block' && domainsOf(r).includes('ads.example.com'),
    );
    const learnedForDomain = learned.filter((r) => domainsOf(r).includes('ads.example.com'));
    assert.ok(listForDomain.length > 0, '列表侧应有该域名的规则');
    assert.ok(learnedForDomain.length > 0, '自学习侧应有该域名的规则');

    for (const r of learnedForDomain) {
      const types = r.condition.resourceTypes ?? [];
      assert.ok(types.length > 0, '自学习规则必须显式列出类型，不能"不写类型"');
      assert.ok(!types.includes('image'), '自学习侧不得因为同域名有列表规则而获得 image');
      assert.ok(!types.includes('media'));
    }
  });

  it('❗列表例外（优先级 3）能推翻自学习拦截（优先级 2）', () => {
    const allow = listRules.find(
      (r) => r.action.type === 'allow' && domainsOf(r).includes('ads.example.com'),
    );
    assert.ok(allow, '列表里应有 @@ 例外');
    assert.equal(allow!.priority, PRIORITY.listAllow);

    const learnedBlock = learned.find((r) => domainsOf(r).includes('ads.example.com'))!;
    assert.equal(learnedBlock.priority, 2);
    assert.ok(
      allow!.priority > learnedBlock.priority,
      `例外必须压过自学习（allow ${allow!.priority} vs learned ${learnedBlock.priority}）`,
    );
    assert.ok(
      PRIORITY.listImportantAllow > allow!.priority,
      'important 例外还应更高一层',
    );
  });

  it('❗合并后整体仍通过 DNR 约束自检（含主文档纪律）', () => {
    const problems = validateRulesets([[...listRules, ...learned]]);
    assert.deepEqual(problems.map((p) => p.problem), []);
  });

  it('显式 $document 是列表既定的例外（唯一允许拦主文档的来源）', () => {
    const docRule = listRules.find((r) => domainsOf(r).includes('fullpage-ad.example.com'));
    assert.ok(docRule, '应存在显式 $document 规则');
    assert.deepEqual(docRule!.condition.resourceTypes, ['main_frame']);
    // Learned rules never contain such a rule.
    assert.ok(!learned.some((r) => (r.condition.resourceTypes ?? []).includes('main_frame')));
  });
});
