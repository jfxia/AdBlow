/**
 * One command to refresh the bundled filter lists and produce a release zip.
 *
 * Why this exists: MV3 static rulesets are packaged files and there is no API to
 * replace them remotely (verified in Edge: `getEnabledRulesets` only toggles the
 * packaged sets), so a list refresh always means shipping a new extension
 * version. That makes the refresh a routine to be run on a schedule, and a
 * routine should be one command -- with the list dates printed before and after,
 * so the person running it can see what actually changed.
 *
 * Steps: fetch lists -> compile -> build -> test -> package.
 * The version is NOT bumped automatically: the store ties the version to the
 * uploaded package, and a human should decide whether this is a patch or a
 * minor release (and write the changelog).
 *
 * Usage:
 *   node tools/release/update-lists.mjs            # full run
 *   node tools/release/update-lists.mjs --dry-run  # show current list state only
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');

/** Run a step with output going straight to the terminal (pipes are restricted). */
function step(label, args) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    console.error(`\n[!!] 步骤失败：${label}。已中止，未产出新的发布包。`);
    process.exit(1);
  }
  console.log(`  （用时 ${((Date.now() - started) / 1000).toFixed(0)}s）`);
}

function showListState(title) {
  const metaPath = `${root}/filters/meta.json`;
  const reportPath = `${root}/filters/generated/report.json`;
  console.log(`\n--- ${title} ---`);
  if (!existsSync(metaPath)) {
    console.log('  还没有抓取过过滤列表（filters/meta.json 不存在）');
    return;
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  console.log(`  列表抓取时间：${meta.fetchedAt ?? '未知'}`);
  if (existsSync(reportPath)) {
    const r = JSON.parse(readFileSync(reportPath, 'utf8'));
    console.log(
      `  编译结果：${r.compiled} 条拦截规则 + ${r.exceptions} 条例外，` +
        `分 ${r.rulesetCount} 卷；输入 ${r.input} 条`,
    );
    console.log(
      `  预算：${r.budgetUsed}/${r.budget}${r.budgetTruncated ? '（有截断）' : '（未截断）'}`,
    );
  }
}

const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
console.log(`AdBlow 过滤列表更新 —— 当前版本 ${pkg.version}`);

showListState('更新前');

if (dryRun) {
  console.log('\n（--dry-run：只报告当前状态，未做任何抓取或构建）');
  process.exit(0);
}

step('1/5 抓取过滤列表', ['tools/filters/fetch-lists.mjs']);
step('2/5 编译成规则集 / 隐藏分片 / 脚本注入表', ['tools/build/gen-rulesets.ts']);
showListState('更新后');
step('3/5 构建 dist', ['tools/build/build.mjs']);
step('4/5 跑测试', ['tests/run-all.ts']);
step('5/5 打包', ['tools/release/package.mjs']);

console.log(`
下一步（需要人工决定）：
  1. 版本号：商店按版本区分，pnpm version:bump <新版本> --write 后提交并推送；
  2. 重打包并发布：pnpm package 之后 pnpm release:github --publish
     （dry-run 用 pnpm release:github）；发布说明写在 docs/release-notes/<版本>.md；
  3. 上传商店：把 release/adblow-<版本>-edge.zip 传到 Edge 加载项后台；
  4. 审核通过后，已安装的用户会在数小时内自动更新。

提醒：静态规则集无法远程替换（MV3 限制），所以列表新鲜度 = 发版频率。
`);
