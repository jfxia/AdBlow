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
import { copyFileSync, mkdirSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));

const DIST = p('dist');
const PUBLIC_DIR = p('public');

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
 * - content / inject：MV3 内容脚本**不支持静态 ESM 导入**，必须打成
 *   单个自包含 IIFE。这正是用 Rollup 而不是 tsc 的原因。
 */
const ENTRIES = [
  { name: 'background', format: 'es' },
  { name: 'content', format: 'iife' },
  { name: 'inject', format: 'iife' },
];

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const report = [];

for (const entry of ENTRIES) {
  const bundle = await rollup({
    input: p(`src/${entry.name}/index.ts`),
    plugins: [nodeResolve(), adblowTs],
    onwarn: (warning) => {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      console.warn(`[rollup] ${warning.code}: ${warning.message}`);
    },
  });

  await bundle.write({
    file: `${DIST}/${entry.name}.js`,
    format: entry.format,
    // content / inject 用 IIFE，需要确保没有顶层 await（Rollup 会直接报错）
    generatedCode: 'es2015',
  });
  await bundle.close();

  report.push([`${entry.name}.js`, statSync(`${DIST}/${entry.name}.js`).size, entry.format]);
}

// 组装静态资源
for (const file of ['manifest.json', 'cosmetic.css']) {
  const from = `${PUBLIC_DIR}/${file}`;
  if (!existsSync(from)) throw new Error(`缺少 public/${file}`);
  copyFileSync(from, `${DIST}/${file}`);
  report.push([file, statSync(`${DIST}/${file}`).size, 'copy']);
}

// 自检：manifest 里声明的每个文件都必须真实存在
const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'));
const declared = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  manifest.action?.default_popup,
  manifest.options_page,
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
