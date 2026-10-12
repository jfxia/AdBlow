/**
 * 构建脚本：用 Rollup 的 JS API 打包扩展，并组装 dist/。
 *
 * 为什么不用 `rollup -c`：让配置加载与产物组装都在一个已实测可行的进程内完成，
 * 少一层不确定性。本沙箱禁止子进程管道，Vite 就是在配置加载阶段挂掉的。
 *
 * 为什么自研 TS 转换插件而不用 @rollup/plugin-typescript：
 * 后者按 tsconfig 的 include 过滤文件，被跳过的文件会让 rollup 把 TS 当 JS
 * 解析并报 `Expected '{', got ':'`。自研插件用 transpileModule，不经 tsc 的
 * emit 校验，因而也允许 `.ts` 后缀导入（Node ESM 需要显式扩展名）。
 *
 * 用法：node tools/build/build.mjs
 */
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import ts from 'typescript';
import { copyFileSync, mkdirSync, readFileSync, statSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));

const DIST = p('dist');

/** 自研 TS 转换插件。 */
const adblowTs = {
  name: 'adblow-ts',
  transform(code, id) {
    if (!id.endsWith('.ts')) return null;
    const out = ts.transpileModule(code, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        sourceMap: false,
      },
      fileName: id,
    });
    return { code: out.outputText, map: null };
  },
};

/**
 * 入口清单。
 *
 * - background：MV3 service worker 支持 ESM，用 es。
 * - content / inject / popup / options：MV3 内容脚本**不支持静态 ESM 导入**，
 *   所以打成单个自包含 IIFE（HTML 用普通 <script src> 引用）。
 *   这正是用 Rollup 而不是 tsc 的原因。
 */
const ENTRIES = [
  { name: 'background', format: 'es', from: 'src/background/index.ts' },
  { name: 'content', format: 'iife', from: 'src/content/index.ts' },
  { name: 'inject', format: 'iife', from: 'src/inject/index.ts' },
  { name: 'popup', format: 'iife', from: 'src/ui/popup.ts' },
  { name: 'options', format: 'iife', from: 'src/ui/options.ts' },
];

/** 需要原样拷贝进 dist/ 的静态资源。 */
const ASSETS = [
  { from: 'public/manifest.json', to: 'manifest.json' },
  { from: 'public/cosmetic.css', to: 'cosmetic.css' },
  { from: 'src/ui/popup.html', to: 'popup.html' },
  { from: 'src/ui/options.html', to: 'options.html' },
];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const report = [];

for (const entry of ENTRIES) {
  const bundle = await rollup({
    input: p(entry.from),
    plugins: [nodeResolve(), adblowTs],
    onwarn: (warning) => {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      console.warn(`[rollup] ${warning.code}: ${warning.message}`);
    },
  });

  await bundle.write({
    file: `${DIST}/${entry.name}.js`,
    format: entry.format,
    generatedCode: 'es2015',
  });
  await bundle.close();

  report.push([`${entry.name}.js`, statSync(`${DIST}/${entry.name}.js`).size, entry.format]);
}

// 组装静态资源
for (const asset of ASSETS) {
  const from = p(asset.from);
  if (!existsSync(from)) throw new Error(`缺少静态资源 ${asset.from}`);
  copyFileSync(from, `${DIST}/${asset.to}`);
  report.push([asset.to, statSync(`${DIST}/${asset.to}`).size, 'copy']);
}

/**
 * 注入过滤列表生成的静态规则集。
 *
 * 列表与生成的规则集都**不进版本库**（许可证原因，见
 * docs/plans/2026-10-11-filter-list-integration.md），因此这里缺失时不报错，
 * 只提示先跑 `pnpm filters && node tools/build/gen-rulesets.ts`。
 */
const rulesetPatch = p('filters/generated/manifest-patch.json');
const rulesetFiles = [];
if (existsSync(rulesetPatch)) {
  const patch = JSON.parse(readFileSync(rulesetPatch, 'utf8'));
  const resources = patch.declarative_net_request?.rule_resources ?? [];
  mkdirSync(`${DIST}/rulesets`, { recursive: true });
  let bytes = 0;
  for (const r of resources) {
    const from = p(`filters/generated/${r.path.replace('rulesets/', '')}`);
    if (!existsSync(from)) throw new Error(`规则集文件缺失：${from}`);
    copyFileSync(from, `${DIST}/${r.path}`);
    const size = statSync(from).size;
    bytes += size;
    rulesetFiles.push([r.path, size]);
  }

  const manifestPath = `${DIST}/manifest.json`;
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.declarative_net_request = { rule_resources: resources };
  writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');

  for (const [name, size] of rulesetFiles) report.push([name, size, 'ruleset']);
  console.log(
    `过滤列表规则集：${resources.length} 卷、合计 ${(bytes / 1024 / 1024).toFixed(2)} MB ` +
      `（已注入 manifest）`,
  );
} else {
  console.log(
    '未找到过滤列表规则集 —— 跳过注入。若要启用：pnpm filters && node tools/build/gen-rulesets.ts',
  );
}

// 自检：manifest 里声明的每个文件都必须真实存在
const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'));
const declared = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  manifest.action?.default_popup,
  manifest.options_page,
  ...(manifest.declarative_net_request?.rule_resources ?? []).map((r) => r.path),
].filter(Boolean);

const missing = declared.filter((f) => !existsSync(`${DIST}/${f}`));
if (missing.length) {
  console.error(`manifest 声明了不存在的文件：${missing.join(', ')}`);
  process.exit(1);
}

console.log('dist/ 构建完成：');
for (const [name, size, kind] of report) {
  console.log(`  ${name.padEnd(18)} ${String(size).padStart(7)} B   ${kind}`);
}
console.log(`  manifest 声明的 ${declared.length} 个文件全部存在`);
