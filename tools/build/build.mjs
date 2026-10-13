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
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));

/**
 * 输出目录，可用环境变量 `ADBLOW_DIST` 覆盖。
 *
 * 为什么需要：`dist/` 会被**正在加载该扩展的浏览器**占用（Windows 下
 * 目录删除会 EPERM）。此时 `ADBLOW_DIST=dist-release pnpm build` 就能在别处
 * 出一份干净产物，而不必关掉浏览器（也不必去杀进程 —— 实测杀掉会被守护进程
 * 立刻重启，而且可能是用户自己的浏览器）。
 */
const DIST = process.env.ADBLOW_DIST ? p(process.env.ADBLOW_DIST) : p('dist');

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
  // 脚本注入（第三期）：引擎单独一个文件，随 manifest 声明为 <all_urls>；
  // 规则表由构建期生成（scriptlets/bundle-N.js），只在那批域名上注入。
  { name: 'scriptlets-engine', format: 'iife', from: 'src/inject/scriptletsGlobal.ts' },
  { name: 'popup', format: 'iife', from: 'src/ui/popup.ts' },
  { name: 'options', format: 'iife', from: 'src/ui/options.ts' },
];

/** 需要原样拷贝进 dist/ 的静态资源。 */
const ASSETS = [
  { from: 'public/manifest.json', to: 'manifest.json' },
  { from: 'public/cosmetic.css', to: 'cosmetic.css' },
  { from: 'src/ui/popup.html', to: 'popup.html' },
  { from: 'src/ui/options.html', to: 'options.html' },
  { from: 'src/ui/ui.css', to: 'ui.css' },
];

/** 需要整目录拷贝的静态资源（图标、语言包）。 */
const ASSET_DIRS = [
  { from: 'public/icons', to: 'icons' },
  { from: 'public/_locales', to: '_locales' },
];

/** 递归拷贝目录（保持相对结构）。 */
function copyDir(fromAbs, toAbs, report, label) {
  let count = 0;
  let bytes = 0;
  const walk = (src, dst) => {
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(src)) {
      const s = `${src}/${entry}`;
      const d = `${dst}/${entry}`;
      if (statSync(s).isDirectory()) {
        walk(s, d);
        continue;
      }
      copyFileSync(s, d);
      count += 1;
      bytes += statSync(d).size;
    }
  };
  walk(fromAbs, toAbs);
  report.push([`${label}/ (${count} 个文件)`, bytes, 'copy']);
  return count;
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const report = [];

for (const entry of ENTRIES) {
  const bundle = await rollup({
    input: p(entry.from),
    plugins: [nodeResolve(), adblowTs],
    onwarn: (warning) => {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return;
      // 入口有 export 但 IIFE 没给 output.name 时的提示。
      // 我们**有意不加 name**：加了会在页面全局作用域塞一个变量，
      // 而 scriptlets-engine 是 MAIN world 脚本，那属于污染与指纹面。
      // 它需要暴露的东西由文件自己挂到 window.__adblowScriptlets 上。
      if (warning.code === 'MISSING_NAME_OPTION_FOR_IIFE_EXPORT') return;
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

for (const dir of ASSET_DIRS) {
  const from = p(dir.from);
  if (!existsSync(from)) throw new Error(`缺少静态资源目录 ${dir.from}`);
  copyDir(from, `${DIST}/${dir.to}`, report, dir.to);
}

/**
 * 版本号单一来源：package.json。
 *
 * 之前 manifest 里的版本是手写的，很容易与 package.json 漂移
 * （发布时改了这里忘了那里 → 商店里显示旧版本）。现在构建期注入，
 * 并强制校验是 x.y.z 形式 —— 商店只接受这种格式。
 */
const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.error(`package.json 的 version 必须是 x.y.z 形式，实际：${pkg.version}`);
  process.exit(1);
}
{
  const manifestPath = `${DIST}/manifest.json`;
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');
  console.log(`版本号：${pkg.version}（注入自 package.json）`);
}

/**
 * 语言包自检：manifest 与界面里用到的每个 `__MSG_key__` / data-i18n key
 * 都必须在默认语言包里存在，且**五种语言键集一致**。
 *
 * 为什么必须校验：缺 key 时商店页面会直接显示 `__MSG_extDesc__` 这种原始
 * 占位符，而这是**提交后才会发现**的问题（本地加载看不出）。
 */
{
  const localesDir = `${DIST}/_locales`;
  const defaultLocale = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8')).default_locale;
  const locales = readdirSync(localesDir);
  if (!locales.includes(defaultLocale)) {
    console.error(`默认语言 ${defaultLocale} 在 _locales 里不存在`);
    process.exit(1);
  }
  const catalogs = new Map();
  for (const loc of locales) {
    catalogs.set(loc, JSON.parse(readFileSync(`${localesDir}/${loc}/messages.json`, 'utf8')));
  }

  const manifestRaw = readFileSync('public/manifest.json', 'utf8') + readFileSync('src/ui/popup.html', 'utf8') + readFileSync('src/ui/options.html', 'utf8');
  const used = new Set([...manifestRaw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]));
  // 界面里 data-i18n / data-i18n-* 用到的 key
  for (const m of [...readFileSync('src/ui/popup.html', 'utf8').matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)]) used.add(m[1]);
  for (const m of [...readFileSync('src/ui/options.html', 'utf8').matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)]) used.add(m[1]);
  // JS 里 t('key') 调用的 key
  for (const file of ['src/ui/popup.ts', 'src/ui/options.ts']) {
    for (const m of [...readFileSync(file, 'utf8').matchAll(/\bt\('([A-Za-z0-9_]+)'/g)]) used.add(m[1]);
  }

  const base = catalogs.get(defaultLocale);
  const problems = [];
  for (const key of used) if (!(key in base)) problems.push(`${defaultLocale} 缺少 ${key}`);
  for (const [loc, cat] of catalogs) {
    for (const key of used) if (!(key in cat)) problems.push(`${loc} 缺少 ${key}`);
    for (const key of Object.keys(cat)) if (!(key in base)) problems.push(`${loc} 多出 ${key}`);
  }
  if (problems.length) {
    console.error(`语言包校验失败：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `语言包：${locales.length} 种（${locales.sort().join(', ')}），默认 ${defaultLocale}，` +
      `界面共用 ${used.size} 个 key，全部一致`,
  );
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

  /**
   * 脚本注入（第三期）：**两个** content_scripts 条目 —— 引擎 + 数据表，
   * 都是 `<all_urls>`。
   *
   * ⚠️ 这里经过一次实测驱动的返工。最初按 uBOL 的做法为每个域名组声明
   * 匹配域名，实测 2,500 个 match pattern 会让浏览器**加载扩展时卡死 2.4 秒**
   * （完整 dist 3093ms vs 单条目 <all_urls> 801ms vs 无扩展 496ms；
   * 且代价是按 pattern 数而非条目数 —— 合并成 1 个条目同样是 3114ms）。
   *
   * 改成 `<all_urls>` 后由脚本自查 `location.hostname`。数据内联在文件里，
   * 因此仍然在 document_start、页面脚本之前执行完，时序保证没有损失。
   */
  const scriptletManifestPath = p('filters/generated/scriptlet-manifest.json');
  if (existsSync(scriptletManifestPath)) {
    const sm = JSON.parse(readFileSync(scriptletManifestPath, 'utf8'));
    mkdirSync(`${DIST}/scriptlets`, { recursive: true });
    copyFileSync(`${p('filters/generated')}/${sm.file}`, `${DIST}/scriptlets/${sm.file}`);

    const scriptletScripts = [
      {
        matches: ['<all_urls>'],
        js: ['scriptlets-engine.js'],
        run_at: 'document_start',
        all_frames: true,
        world: 'MAIN',
      },
      {
        matches: ['<all_urls>'],
        js: [`scriptlets/${sm.file}`],
        run_at: 'document_start',
        all_frames: true,
        world: 'MAIN',
      },
    ];
    m.content_scripts = [...(m.content_scripts ?? []), ...scriptletScripts];
    report.push([`scriptlets/ (data table)`, sm.bytes, 'ruleset']);
    console.log(
      `脚本注入：引擎 1 个 + 数据表 1 个（${(sm.bytes / 1024).toFixed(0)} KB，` +
        `${sm.entries} 个域名）、manifest 新增 ${scriptletScripts.length} 个条目（均为 <all_urls>，共 2 个 pattern）`,
    );
  }

  writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');

  for (const [name, size] of rulesetFiles) report.push([name, size, 'ruleset']);
  console.log(
    `过滤列表规则集：${resources.length} 卷、合计 ${(bytes / 1024 / 1024).toFixed(2)} MB ` +
      `（已注入 manifest）`,
  );

  // cosmetic 分片（第二期）：由 SW 读取后经消息回给内容脚本，
  // 因此**不需要** web_accessible_resources（少一个指纹面）。
  const cosmeticDir = p('filters/generated');
  const cosmeticFiles = existsSync(cosmeticDir)
    ? readdirSync(cosmeticDir).filter((f) => /^cosmetic-\d+\.json$/.test(f))
    : [];
  if (cosmeticFiles.length) {
    mkdirSync(`${DIST}/cosmetic`, { recursive: true });
    let cb = 0;
    for (const f of cosmeticFiles) {
      copyFileSync(`${cosmeticDir}/${f}`, `${DIST}/cosmetic/shard-${f.replace(/\D+/g, '')}.json`);
      cb += statSync(`${cosmeticDir}/${f}`).size;
    }
    report.push([`cosmetic/ (${cosmeticFiles.length} shards)`, cb, 'copy']);
    console.log(`cosmetic 分片：${cosmeticFiles.length} 片、合计 ${(cb / 1024).toFixed(0)} KB`);
  }
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
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.declarative_net_request?.rule_resources ?? []).map((r) => r.path),
].filter(Boolean);

const missing = declared.filter((f) => !existsSync(`${DIST}/${f}`));
if (missing.length) {
  console.error(`manifest 声明了不存在的文件：${missing.join(', ')}`);
  process.exit(1);
}

// 自检：两个界面的 HTML 里引用的本地资源也必须存在
// （manifest 不会声明 ui.css —— 它是被 HTML 引用的，最容易漏拷）
{
  const htmlRefs = new Set();
  for (const file of ['popup.html', 'options.html']) {
    const html = readFileSync(`${DIST}/${file}`, 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = m[1];
      if (/^(?:https?:|data:|#|\/)/.test(ref)) continue;
      htmlRefs.add(ref);
    }
  }
  const missingRefs = [...htmlRefs].filter((f) => !existsSync(`${DIST}/${f}`));
  if (missingRefs.length) {
    console.error(`界面 HTML 引用了不存在的资源：${missingRefs.join(', ')}`);
    process.exit(1);
  }
  console.log(`界面引用的 ${htmlRefs.size} 个本地资源全部存在`);
}

console.log('dist/ 构建完成：');
for (const [name, size, kind] of report) {
  console.log(`  ${name.padEnd(18)} ${String(size).padStart(7)} B   ${kind}`);
}
console.log(`  manifest 声明的 ${declared.length} 个文件全部存在`);
