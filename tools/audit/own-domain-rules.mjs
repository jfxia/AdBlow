/**
 * A 层检查的命令行：读 dist 下的规则集，列出会拦掉站点自有脚本的规则，与受审基线比较。
 *
 * 用法：
 *   node tools/audit/own-domain-rules.mjs            打印表格，有新条目则退出码 1
 *   node tools/audit/own-domain-rules.mjs --write    把当前结果写成基线（人工过目后再提交）
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CANARY_SITES, findingKey, inspectRuleSet, newFindings } from '../../src/engine/filterList/ownDomainRisk.ts';

const DIR = 'dist/rulesets';
const BASELINE = 'tools/audit/own-domain-baseline.json';

if (!existsSync(DIR)) {
  console.log('  [!!] 缺少 dist/rulesets，先运行 node _probe/check.mjs 或 pnpm build');
  process.exit(2);
}

const findings = [];
for (const file of readdirSync(DIR).filter((f) => f.startsWith('list-') && f.endsWith('.json'))) {
  const rules = JSON.parse(readFileSync(`${DIR}/${file}`, 'utf8'));
  findings.push(...inspectRuleSet(rules, file));
}
findings.sort((a, b) => a.site.localeCompare(b.site) || a.ruleId - b.ruleId);

console.log(`  检查对象：${CANARY_SITES.map((s) => s.name).join(', ')}`);
console.log(`  命中 ${findings.length} 条规则：`);
for (const finding of findings) {
  console.log(`    [${finding.site}] ${finding.ruleSet} id=${finding.ruleId} types=${finding.types}`);
  console.log(`        ${finding.match}`);
}

if (process.argv.includes('--write')) {
  writeFileSync(BASELINE, JSON.stringify(findings.map(findingKey), undefined, 2) + '\n', 'utf8');
  console.log(`  [ok] 已写入基线 ${BASELINE}（${findings.length} 条）`);
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.log('  [!!] 没有基线，先用 --write 生成并人工过目');
  process.exit(2);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const fresh = newFindings(findings, baseline);
if (fresh.length === 0) {
  console.log('  [ok] 与受审基线一致，没有新条目');
  process.exit(0);
}
console.log(`  [!!] 有 ${fresh.length} 条新命中，需要人工判断是否该拦：`);
for (const finding of fresh) {
  console.log(`    [${finding.site}] ${finding.ruleSet} id=${finding.ruleId} types=${finding.types} ${finding.match}`);
}
console.log('  如果确认可以拦，重新生成基线：node tools/audit/own-domain-rules.mjs --write');
process.exit(1);
