// Release packaging: build -> audit -> zip.
// Why a hand-written ZIP: external `zip` / `Compress-Archive` may be absent and
// cannot control which files go in; deflate + CRC32 + three sections is simple enough to write.
// The writer now lives in tools/release/zip.mjs, shared with the filter-list snapshot
// that tools/release/github-release.mjs attaches to each GitHub release.
// Why `_metadata/` must go: loading the unpacked extension creates
// `_metadata/generated_indexed_rulesets/*` (~6 MB ruleset index cache), not our artifact.
// Audit: a dist file is reachable when the manifest declares it, it is an
// icon/locale/UI resource, or it is rule data; anything else is build leftover.
// Run: node tools/release/package.mjs [--no-build]
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createZip } from './zip.mjs';

const root = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));
// share the build script's output-dir override, so packaging works while a
// browser is holding dist/ open
const DIST = process.env.ADBLOW_DIST ? p(process.env.ADBLOW_DIST) : p('dist');
const RELEASE_DIR = p('release');

// 1) build first, unless explicitly skipped
if (!process.argv.includes('--no-build')) {
  console.log('构建 dist …');
  execFileSync(process.execPath, [p('tools/build/build.mjs')], { stdio: 'inherit' });
}

if (!existsSync(`${DIST}/manifest.json`)) {
  console.error('dist/manifest.json 不存在 —— 先运行构建。');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(`${DIST}/manifest.json`, 'utf8'));
const version = manifest.version;
const appName = 'AdBlow';

// 2) collect the reachable files
const reachable = new Set();

const add = (rel) => {
  const clean = rel.replace(/^\.?\//, '');
  if (!clean) return;
  reachable.add(clean);
};

// the manifest itself: it never declares its own filename, so add it explicitly
// (self-testing once had the audit delete it as a build leftover)
add('manifest.json');

for (const f of [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_page,
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ...(manifest.declarative_net_request?.rule_resources ?? []).map((r) => r.path),
]) {
  if (f) add(f);
}

// local resources referenced by the UI HTML
for (const html of ['popup.html', 'options.html']) {
  const body = readFileSync(`${DIST}/${html}`, 'utf8');
  for (const m of body.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(?:https?:|data:|#|\/)/.test(m[1])) continue;
    add(m[1]);
  }
}

/**
 * Resources the JavaScript reads at runtime through `chrome.runtime.getURL(...)`.
 *
 * These are invisible to a manifest/HTML scan, so the audit used to delete them as
 * leftovers. That is exactly what happened to `list-info.json` (the bundled filter
 * list revision shown by the rule manager): the dev build showed it, the packaged
 * build silently did not. Scan the built scripts instead of hard-coding filenames,
 * so any future getURL resource is covered automatically.
 */
for (const js of readdirSync(DIST).filter((f) => f.endsWith('.js'))) {
  const body = readFileSync(`${DIST}/${js}`, 'utf8');
  for (const m of body.matchAll(/getURL\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
}

// directories: locales plus the three rule-data sets (read on demand by the
// content script / SW). listFiles must stay a pure listing: an earlier version had
// one walk both list and mark reachable, so everything looked reachable and the
// audit could never spot leftovers.
const listFiles = (dir, base = '') => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = `${dir}/${entry}`;
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
};

for (const dir of ['_locales', 'icons', 'rulesets', 'cosmetic', 'scriptlets']) {
  if (existsSync(`${DIST}/${dir}`)) for (const f of listFiles(`${DIST}/${dir}`, dir)) add(f);
}

// 3) audit: find what should not be in the package
const allFiles = listFiles(DIST, '');
const excluded = allFiles.filter((f) => !reachable.has(f)).sort();

if (excluded.length) {
  console.log(`\n剔除 ${excluded.length} 个非发布产物（构建/浏览器残留）：`);
  for (const f of excluded.slice(0, 20)) {
    const size = statSync(`${DIST}/${f}`).size;
    console.log(`  ${f}  ${(size / 1024).toFixed(0)} KB`);
  }
  if (excluded.length > 20) console.log(`  … 其余 ${excluded.length - 20} 个`);
  // delete them from dist too, so the directory stays clean for the next build
  for (const f of excluded) rmSync(`${DIST}/${f}`, { force: true });
  // remove directories that became empty
  for (const dir of readdirSync(DIST)) {
    const abs = `${DIST}/${dir}`;
    if (statSync(abs).isDirectory() && readdirSync(abs).length === 0) rmSync(abs, { recursive: true });
  }
}

const files = allFiles.filter((f) => reachable.has(f)).sort();

// 4) write the ZIP (deflate + CRC32, implemented in ./zip.mjs)
const zip = createZip(files.map((rel) => ({ name: rel, data: readFileSync(`${DIST}/${rel}`) })));

mkdirSync(RELEASE_DIR, { recursive: true });
const zipName = `adblow-${version}-edge.zip`;
const zipPath = `${RELEASE_DIR}/${zipName}`;
writeFileSync(zipPath, zip);

const totalRaw = files.reduce((n, f) => n + statSync(`${DIST}/${f}`).size, 0);
console.log(`\n${appName} v${version} 发布包`);
console.log(`  文件数   ${files.length}`);
console.log(`  解包体积 ${(totalRaw / 1024 / 1024).toFixed(2)} MB`);
console.log(`  压缩后   ${(zip.length / 1024 / 1024).toFixed(2)} MB  (${(zip.length / totalRaw * 100).toFixed(0)}%)`);
console.log(`  产物     release/${zipName}`);

// key self-check: the store requires manifest.json at the archive root, with all
// required fields present
const requiredAtRoot = ['manifest.json', 'background.js', 'content.js'];
for (const f of requiredAtRoot) {
  if (!files.includes(f)) {
    console.error(`发布包缺少必需文件：${f}`);
    process.exit(1);
  }
}
for (const field of ['manifest_version', 'name', 'version', 'description', 'icons', 'default_locale']) {
  if (manifest[field] === undefined) {
    console.error(`manifest 缺少必需字段：${field}`);
    process.exit(1);
  }
}
console.log('  自检     根目录含 manifest.json；name/version/description/icons/default_locale 齐全');
