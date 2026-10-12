import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIORITY, compileFilters, type DnrListRule } from '../../src/engine/filterList/compile.ts';
import { validateRulesets } from '../../src/engine/filterList/validate.ts';
import { parseList } from '../../src/engine/filterList/parse.ts';
import { SUBRESOURCE_TYPES, learnedDomainRules } from '../../src/engine/learnedRules.ts';

/**
 * 集成过滤列表**之后**，自学习的安全闸门有没有被绕过。
 *
 * 项目原有的自学习安全测试（learnedRules / learned-selector-safety / domain-learning）
 * 都是在"没有列表"的前提下测的。集成 21,146 条列表规则之后，
 * 需要在**集成层**重新证明四件事：
 *
 *   1. 自学习规则仍然绝不拦 image / media / main_frame
 *   2. 列表里"允许拦图片"这件事不会传染给自学习规则
 *   3. 列表例外（优先级 3）能推翻自学习拦截（优先级 2）——
 *      自学习会学错，必须留这条退路
 *   4. 唯一允许拦主文档的来源仍是列表里**显式写的 `$document`**
 */

/** 一份贴近真实写法的列表片段：含拦图片、含例外、含 important、含 $document。 */
const LIST_TEXT = [
  '||ads.example.com^$image,script',
  '||ads.example.com^',
  '||tracker.example.com^$xmlhttprequest,image',
  '@@||ads.example.com^$script',
  '@@||important.example.com^$important',
  '||fullpage-ad.example.com^$document',
].join('\n');

/**
 * 编译后的条件可能用 `requestDomains`（域名打包）或 `urlFilter`，
 * 断言要把两者都覆盖到 —— 早期版本的测试只认 urlFilter，于是断言全部落空。
 */
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
    // 结构性保证：允许集合本身就不含这两个类型
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
    // 而自学习侧永远不会有这种规则
    assert.ok(!learned.some((r) => (r.condition.resourceTypes ?? []).includes('main_frame')));
  });
});
