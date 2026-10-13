// Generates the DNR static rulesets at build time: reads filters/*.txt (fetched
// by tools/filters/fetch-lists.mjs, not committed), parses -> compiles -> trims
// to budget -> writes filters/generated/list-N.json plus a manifest patch that
// build.mjs copies into dist/.
// Budget numbers mirror MV3 hard limits (see
// docs/plans/2026-10-11-filter-list-integration.md); check the official docs
// before changing them.
// Run: node tools/build/gen-rulesets.ts [--budget N]
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseList } from '../../src/engine/filterList/parse.ts';
import { compileFilters, type DnrListRule } from '../../src/engine/filterList/compile.ts';
import { validateRulesets } from '../../src/engine/filterList/validate.ts';
import {
  COSMETIC_SHARD_COUNT,
  buildCosmeticIndex,
  parseCosmeticLine,
  shardIndex,
  type CosmeticFilter,
} from '../../src/engine/filterList/cosmetic.ts';
import {
  buildScriptletIndex,
  parseScriptletRule,
  type ScriptletRule,
} from '../../src/engine/filterList/scriptlet.ts';

const ROOT = new URL('../../', import.meta.url);
const p = (rel: string) => fileURLToPath(new URL(rel, ROOT));

const FILTERS_DIR = p('filters/');
const OUT_DIR = p('filters/generated/');

/** Total static-rule budget. MV3 guarantees about 30k; keep headroom. */
const DEFAULT_BUDGET = 24_000;
/** Rules per ruleset (shards allow toggling lists later). */
const RULESET_SIZE = 4_000;
/** Regex budget (DNR caps regexFilter separately and lower). */
const REGEX_BUDGET = 1_000;

// Per-list quota. Measured: the six lists barely overlap (59 of ~120k candidate
// domains appear in more than one), so consensus carries no signal, and ranking
// purely by value follows input order and crowds EasyPrivacy out. Quotas give
// every list a share, favoring ad blocking over tracking.
const LIST_QUOTAS: Record<string, number> = {
  'easylist-china': 7_000,
  easylist: 12_000,
  easyprivacy: 2_500,
  'ublock-badware': 1_500,
  'ublock-filters': 1_000,
  'ublock-privacy': 500,
};
const DEFAULT_QUOTA = 1_000;

const budgetArg = process.argv.indexOf('--budget');
const BUDGET = budgetArg >= 0 ? Number(process.argv[budgetArg + 1]) : DEFAULT_BUDGET;

const metaPath = `${FILTERS_DIR}meta.json`;
if (!existsSync(metaPath)) {
  console.error(
    '缺少 filters/meta.json —— 先运行 `pnpm filters` 抓取过滤列表。\n' +
      '（列表不入版本库：许可证与义务见 docs/plans/2026-10-11-filter-list-integration.md）',
  );
  process.exit(1);
}

const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
  fetchedAt: string;
  lists: { id: string; license: string; licenseUrl: string; url: string }[];
};

const perList: { id: string; network: number; cosmetic: number; skipped: number }[] = [];
const allFilters = [];
const allCosmetic: CosmeticFilter[] = [];
const allScriptlets: ScriptletRule[] = [];
const skipReasons: Record<string, number> = {};
let cosmeticTotal = 0;

for (const entry of meta.lists) {
  const path = `${FILTERS_DIR}${entry.id}.txt`;
  if (!existsSync(path)) {
    console.warn(`  跳过 ${entry.id}：文件不存在`);
    continue;
  }
  const parsed = parseList(readFileSync(path, 'utf8'), entry.id);
  perList.push({
    id: entry.id,
    network: parsed.network.length,
    cosmetic: parsed.cosmetic.length,
    skipped: parsed.skipped.length,
  });
  for (const s of parsed.skipped) {
    const key = s.reason.split(':')[0]!;
    skipReasons[key] = (skipReasons[key] ?? 0) + 1;
  }
  cosmeticTotal += parsed.cosmetic.length;
  allFilters.push(...parsed.network);

  for (const c of parsed.cosmetic) {
    const f = parseCosmeticLine(c.raw);
    if (f) allCosmetic.push(f);
    // Scriptlet rules come through the same cosmetic channel
    const s = parseScriptletRule(c.raw);
    if (s) allScriptlets.push(s);
  }
}

console.log(`读取 ${perList.length} 份列表：`);
for (const l of perList) {
  console.log(
    `  ${l.id.padEnd(16)} 网络=${String(l.network).padStart(6)} ` +
      `cosmetic=${String(l.cosmetic).padStart(6)} 解析丢弃=${String(l.skipped).padStart(5)}`,
  );
}

const { rulesets, report } = compileFilters(allFilters, {
  budget: BUDGET,
  rulesetSize: RULESET_SIZE,
  regexBudget: REGEX_BUDGET,
  allowMainFrame: false,
  listQuotas: LIST_QUOTAS,
  defaultListQuota: DEFAULT_QUOTA,
});

mkdirSync(OUT_DIR, { recursive: true });

// Build-time self-check: fail hard on invalid rules. 119 rules carrying both
// resourceTypes and excludedResourceTypes once made the whole extension fail to
// load, with no signal on the Node side.
const problems = validateRulesets(rulesets);
if (problems.length) {
  console.error(`\n规则集自检失败：${problems.length} 个问题（前 10 条）`);
  for (const p of problems.slice(0, 10)) {
    console.error(`  卷 ${p.ruleset} 规则 ${p.ruleId}: ${p.problem}`);
  }
  process.exit(1);
}
console.log('\n规则集自检通过（DNR 约束全部满足）');

const resources: { id: string; enabled: boolean; path: string }[] = [];
rulesets.forEach((rules: DnrListRule[], i: number) => {
  const id = `adblow_list_${i + 1}`;
  const file = `list-${i + 1}.json`;
  writeFileSync(`${OUT_DIR}${file}`, JSON.stringify(rules), 'utf8');
  resources.push({ id, enabled: true, path: `rulesets/${file}` });
});

writeFileSync(
  `${OUT_DIR}manifest-patch.json`,
  JSON.stringify({ declarative_net_request: { rule_resources: resources } }, null, 2),
  'utf8',
);

const fullReport = {
  generatedAt: new Date().toISOString(),
  listFetchedAt: meta.fetchedAt,
  rulesetSize: RULESET_SIZE,
  regexBudget: REGEX_BUDGET,
  cosmeticFiltersAvailable: cosmeticTotal,
  perList,
  parseDropReasons: skipReasons,
  // report already holds budget / budgetUsed / budgetTruncated; spread last to
  // override same-named keys
  ...report,
};
writeFileSync(`${OUT_DIR}report.json`, JSON.stringify(fullReport, null, 2), 'utf8');

console.log('\n编译结果：');
console.log(`  输入网络规则        ${report.input}`);
console.log(`  badfilter 抵消后    ${report.afterBadfilter}`);
console.log(`  去重后              ${report.deduped}`);
console.log(`  ✦ 域名打包          ${report.packedDomains} 个域名 → ${report.packedRules} 条规则`);
console.log(`  ✦ 逐条规则          ${report.compiled - report.packedRules} 条（路径/正则/带作用域）`);
console.log(`  ✦ 合计              ${report.compiled} 条  （含正则 ${report.regex}）`);
console.log(`  分卷                ${report.rulesetCount} 卷 × ≤${RULESET_SIZE}`);
console.log(`  预算                ${report.budgetUsed}/${report.budget}`);
console.log('\n列表里本来有多少（判断我们丢掉了什么）：');
console.log(`  纯域名锚点可用      ${report.available.domainAnchors}  → 打包进 ${report.packedRules} 条规则`);
console.log(`  例外可用            ${report.available.exceptions}`);
console.log(`  正则可用            ${report.available.regex}  → 保留 ${report.regex}`);
console.log(`  其余（路径等）可用   ${report.available.blocks}`);
console.log(`  按域名归并掉        ${report.collapsedDomains}`);
console.log('\n多列表共识（预算有限时的排序依据）：');
console.log(`  只被 1 份列表提到   ${report.consensus.single}`);
console.log(`  被多份列表提到      ${report.consensus.multi}  （最多 ${report.consensus.maxLists} 份）`);
console.log('\n每份列表实际保留（配额生效的验证）：');
for (const [id, n] of Object.entries(report.keptByList).sort((a, b) => b[1] - a[1])) {
  const quota = LIST_QUOTAS[id] ?? DEFAULT_QUOTA;
  console.log(`  ${id.padEnd(16)} ${String(n).padStart(6)} / 配额 ${quota}`);
}
console.log('\n丢弃原因：');
for (const [reason, n] of Object.entries(report.dropped).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(7)}  ${reason}`);
}
console.log(`\n未支持的语法（解析阶段）：`);
for (const [reason, n] of Object.entries(skipReasons).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(7)}  ${reason}`);
}
// cosmetic: shard by domain

const cosmeticIndex = buildCosmeticIndex(allCosmetic);
const shards = shardIndex(cosmeticIndex, COSMETIC_SHARD_COUNT);

let shardFiles = 0;
let shardBytes = 0;
let maxShardBytes = 0;
for (let i = 0; i < shards.length; i += 1) {
  const shard = shards[i]!;
  if (Object.keys(shard.hide).length === 0 && Object.keys(shard.unhide).length === 0) continue;
  const json = JSON.stringify(shard);
  writeFileSync(`${OUT_DIR}cosmetic-${i}.json`, json, 'utf8');
  shardFiles += 1;
  shardBytes += json.length;
  if (json.length > maxShardBytes) maxShardBytes = json.length;
}

const cosmeticMeta = {
  shardCount: COSMETIC_SHARD_COUNT,
  shardFiles,
  shardBytes,
  maxShardBytes,
  ...cosmeticIndex.stats,
  domainCount: cosmeticIndex.hideByDomain.size,
  unhideDomainCount: cosmeticIndex.unhideByDomain.size,
  /** Generic rules are not injected by default (same call as uBOL); count only */
  genericNotInjected: cosmeticIndex.genericHide.size,
};
writeFileSync(
  `${OUT_DIR}cosmetic-meta.json`,
  JSON.stringify(cosmeticMeta, null, 2),
  'utf8',
);

console.log('\ncosmetic（第二期）：');
console.log(`  解析                ${cosmeticIndex.stats.parsed} 条`);
console.log(`  域名专用隐藏        ${cosmeticIndex.stats.domainSpecific} 条 → ${cosmeticIndex.hideByDomain.size} 个域名`);
console.log(`  例外 #@#            ${cosmeticIndex.hideByDomain.size ? cosmeticIndex.unhideByDomain.size : 0} 个域名`);
console.log(`  通用选择器          ${cosmeticIndex.genericHide.size} 条（**默认不注入**，与 uBOL 取舍一致）`);
console.log(
  `  暂缓（第三期）      程序化 ${cosmeticIndex.stats.deferred['procedural'] ?? 0}｜` +
    `样式 ${cosmeticIndex.stats.deferred['style'] ?? 0}｜脚本注入 ${cosmeticIndex.stats.deferred['scriptlet'] ?? 0}`,
);
console.log(`  跳过 ~ 排除型       ${cosmeticIndex.stats.skippedExcluded} 条（正向索引表达不了，不误用）`);
console.log(`  丢弃非法选择器      ${cosmeticIndex.stats.invalidSelectors} 条（一条非法会毁掉整张样式表）`);
console.log(
  `  分片                ${shardFiles}/${COSMETIC_SHARD_COUNT} 片，合计 ${(shardBytes / 1024).toFixed(0)} KB，` +
    `单片最大 ${(maxShardBytes / 1024).toFixed(1)} KB`,
);

// Scriptlet injection. Delivery was reworked after measurement: per-domain match
// patterns (uBOL's approach) cost 2.4s at ~2,500 patterns, and the cost tracks
// pattern count rather than entry count. So: one `<all_urls>` content script plus
// a compact inlined data table -- inlined because fetching the data across worlds
// would lose the `document_start` head start over page scripts.
// Bonus: wildcard-TLD domains (`ticketmaster.*`), previously skipped as
// unexpressible match patterns, are now included (the runtime lookup supports
// wildcard keys).

const scriptletIndex = buildScriptletIndex(allScriptlets);
const usedNames = [
  ...new Set([...scriptletIndex.byDomain.values()].flatMap((list) => list.map((i) => i.canonical))),
].sort();
const nameIndex = new Map(usedNames.map((n, i) => [n, i]));

/** Control characters would break the separators; replace them at build time. */
const clean = (s: string): string => s.replace(/[\u0000-\u001f]/g, ' ');

const entries: string[] = [];
for (const domain of [...scriptletIndex.byDomain.keys()].sort()) {
  const list = scriptletIndex.byDomain.get(domain)!;
  const body = list
    .map((inv) => [nameIndex.get(inv.canonical), ...inv.args.map(clean)].join('\u0001'))
    .join('\u0002');
  entries.push(`${domain}\u0003${body}`);
}

const namesJoined = usedNames.join('\u0001');
// Prefixing every entry with `\u0004` lets the runtime pin one down with
// `indexOf('\u0004domain\u0003')`, and stops `a.com` matching inside `b.a.com`.
const packedData = entries.map((e) => `\u0004${e}`).join('');
const dataFile = 'scriptlet-data.js';
const dataSource =
  `// AdBlow 生成的脚本注入数据表（${entries.length} 个域名，${usedNames.length} 个规范名）\n` +
  `// 格式见 src/inject/scriptletsGlobal.ts 的 runPacked/decodeEntry 注释\n` +
  `(function(){var n=${JSON.stringify(namesJoined)};var d=${JSON.stringify(packedData)};` +
  `var e=window.__adblowScriptlets;if(e)e.runPacked(n,d,location.hostname);})();\n`;
writeFileSync(`${OUT_DIR}${dataFile}`, dataSource, 'utf8');

writeFileSync(
  `${OUT_DIR}scriptlet-manifest.json`,
  JSON.stringify(
    {
      file: dataFile,
      bytes: dataSource.length,
      entries: entries.length,
      names: usedNames,
      stats: scriptletIndex.stats,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('\n脚本注入（第三期）：');
console.log(`  解析                ${scriptletIndex.stats.parsed} 条`);
console.log(
  `  ✦ 支持并已生成      ${scriptletIndex.stats.supported} 条 → ${entries.length} 个域名，` +
    `${usedNames.length} 个规范名`,
);
console.log(`  名字未支持          ${scriptletIndex.stats.unsupportedName} 条`);
console.log(`  ~ 排除型跳过        ${scriptletIndex.stats.skippedExcluded} 条`);
console.log(
  `  数据表              ${(dataSource.length / 1024).toFixed(0)} KB（紧凑编码，原 JSON 形式约 422 KB）`,
);
console.log('  未支持的名字（按条数，决定下一步做什么）：');
for (const [name, n] of Object.entries(scriptletIndex.stats.unsupportedByCanonical)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)) {
  console.log(`    ${String(n).padStart(5)}  ${name}`);
}