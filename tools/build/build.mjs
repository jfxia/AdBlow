// Builds the extension with Rollup's JS API and assembles dist/.
// Run: node tools/build/build.mjs
// Why not `rollup -c`: then config loading and output assembly stay in one
// process; this sandbox forbids piped child-process stdio and Vite dies there.
// Why a hand-rolled TS transform: @rollup/plugin-typescript filters files by
// tsconfig `include`, and skipped files make Rollup parse TS as JS
// (`Expected '{', got ':'`). transpileModule bypasses tsc's emit checks and so
// also allows `.ts`-suffixed imports (Node ESM needs them).
import { rollup } from 'rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import ts from 'typescript';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));

// Output dir, overridable via ADBLOW_DIST. A browser loading the extension holds
// dist/ open, so rmSync fails with EPERM on Windows; killing that browser is not
// an option -- it is restarted by a daemon and may be the user's own.
const DIST = process.env.ADBLOW_DIST ? p(process.env.ADBLOW_DIST) : p('dist');

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

// Entry list. background is `es` (MV3 service workers support ESM);
// content/inject/popup/options cannot use static ESM imports, so each becomes a
// self-contained IIFE loaded by a plain <script src> -- hence Rollup, not tsc.
const ENTRIES = [
  { name: 'background', format: 'es', from: 'src/background/index.ts' },
  { name: 'content', format: 'iife', from: 'src/content/index.ts' },
  { name: 'inject', format: 'iife', from: 'src/inject/index.ts' },
  // Scriptlet engine: its own file, declared <all_urls>. Its rule table
  // (scriptlets/bundle-N.js) is generated at build time and gates itself to the
  // listed domains.
  { name: 'scriptlets-engine', format: 'iife', from: 'src/inject/scriptletsGlobal.ts' },
  { name: 'popup', format: 'iife', from: 'src/ui/popup.ts' },
  { name: 'options', format: 'iife', from: 'src/ui/options.ts' },
];

const ASSETS = [
  { from: 'public/manifest.json', to: 'manifest.json' },
  { from: 'public/cosmetic.css', to: 'cosmetic.css' },
  { from: 'src/ui/popup.html', to: 'popup.html' },
  { from: 'src/ui/options.html', to: 'options.html' },
  { from: 'src/ui/ui.css', to: 'ui.css' },
];

const ASSET_DIRS = [
  { from: 'public/icons', to: 'icons' },
  { from: 'public/_locales', to: '_locales' },
];

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
      // MISSING_NAME_OPTION_FOR_IIFE_EXPORT is deliberate: output.name would add
      // a page-global variable, and scriptlets-engine runs in the MAIN world, so
      // that is pollution and fingerprint surface.
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

// Version comes from package.json alone: the manifest version used to be
// hand-written and drifted on releases, showing a stale version in the store.
// Validated as x.y.z -- the only format the store accepts.
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

// Locale self-check: every `__MSG_key__` / data-i18n key must exist in the
// default catalog and all five locales must agree. A missing key renders the raw
// placeholder (`__MSG_extDesc__`) on the store page -- only found after posting.
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
  // keys used by data-i18n / data-i18n-* in the UI
  for (const m of [...readFileSync('src/ui/popup.html', 'utf8').matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)]) used.add(m[1]);
  for (const m of [...readFileSync('src/ui/options.html', 'utf8').matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)]) used.add(m[1]);
  // keys passed to t('key') in JS
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

  /**
   * `description` 是**给译者的注释**（不会显示给用户）。两条约束：
   *   1. 用英文 —— 翻译平台按英文注释工作
   *   2. 各语言**完全一致** —— 它是说明，不是需要逐语言翻译的文案
   * 曾经把它逐语言翻译了一遍（同一句注释写 5 份），还写过"产品名不翻译"这类
   * 零信息量的句子；这条校验防止再漂回去。
   */
  const descSeen = new Map();
  for (const [loc, cat] of catalogs) {
    for (const [key, entry] of Object.entries(cat)) {
      const desc = entry.description;
      if (typeof desc !== 'string' || !desc) continue;
      if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(desc)) {
        problems.push(`${loc} 的 ${key}.description 不是英文：${desc.slice(0, 40)}`);
      }
      const first = descSeen.get(key);
      if (!first) descSeen.set(key, { desc, loc });
      else if (first.desc !== desc) {
        problems.push(`${key}.description 在各语言间不一致（${first.loc} vs ${loc}）`);
      }
    }
  }
  if (problems.length) {
    console.error(`语言包校验失败：\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(
    `语言包：${locales.length} 种（${locales.sort().join(', ')}），默认 ${defaultLocale}，` +
      `界面共用 ${used.size} 个 key，全部一致；${descSeen.size} 条译者注释均为英文且各语言一致`,
  );
}

// Inject the static rulesets generated from filter lists. Neither the lists nor
// the generated rulesets are committed (licensing; see
// docs/plans/2026-10-11-filter-list-integration.md), so a missing patch only
// hints at `pnpm filters && node tools/build/gen-rulesets.ts`.
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

  // Two content_scripts entries (engine + data table), both `<all_urls>`.
  // Warning: per-domain match patterns are very expensive -- ~2,500 of them
  // froze extension load for 2.4s, and the cost scales with pattern count, not
  // entry count (one merged entry took just as long). With <all_urls> the script
  // checks location.hostname itself, and inlined data still runs at
  // document_start ahead of page scripts, so ordering is not weakened.
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

  /**
   * Publish which filter-list revision this build carries.
   *
   * Static rulesets are packaged files and MV3 has no API to replace them
   * remotely, so refreshing lists means shipping a new extension version.
   * Without this file neither users nor we can tell how old the bundled data is,
   * and "is my list stale?" is the first question when an ad slips through or a
   * page breaks. The rule manager reads it.
   */
  {
    const meta = existsSync(p('filters/meta.json'))
      ? JSON.parse(readFileSync(p('filters/meta.json'), 'utf8'))
      : {};
    const stats = existsSync(p('filters/generated/report.json'))
      ? JSON.parse(readFileSync(p('filters/generated/report.json'), 'utf8'))
      : {};
    const scriptletCount = existsSync(scriptletManifestPath)
      ? JSON.parse(readFileSync(scriptletManifestPath, 'utf8')).entries
      : null;
    const listInfo = {
      builtAt: new Date().toISOString(),
      listsFetchedAt: meta.fetchedAt ?? null,
      lists: (stats.perList ?? []).map((l) => l.id),
      networkRules: stats.compiled ?? null,
      exceptions: stats.exceptions ?? null,
      cosmeticAvailable: stats.cosmeticFiltersAvailable ?? null,
      scriptletDomains: scriptletCount,
    };
    writeFileSync(`${DIST}/list-info.json`, JSON.stringify(listInfo, null, 2), 'utf8');
    report.push(['list-info.json', statSync(`${DIST}/list-info.json`).size, 'copy']);
    console.log(
      `规则数据来源：${listInfo.lists.length} 份列表，抓取于 ${listInfo.listsFetchedAt ?? '未知'}` +
        `（网络规则 ${listInfo.networkRules ?? '?'} 条 + 例外 ${listInfo.exceptions ?? '?'} 条）`,
    );
  }

  // Cosmetic shards are read by the SW and messaged to content scripts, so
  // web_accessible_resources is not needed (one less fingerprint surface).
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

// Self-check: every file declared in the manifest must exist
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

// Self-check: local resources referenced by the UI HTML must exist too -- ui.css
// comes from HTML rather than the manifest, so it is the easiest to forget
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
