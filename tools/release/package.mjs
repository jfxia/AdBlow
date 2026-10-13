/**
 * 发布打包：构建 → 审计 → 生成 zip。
 *
 * ## 为什么自己写 ZIP 而不是调外部工具
 *
 * `Compress-Archive` / `zip` 在目标机器上不一定存在，而且它们无法精确控制
 * "哪些文件进包"。ZIP 的格式足够简单（deflate + CRC32 + 三段结构），
 * 自己写反而更可控，且**零依赖**。
 *
 * ## 为什么必须剔除 `_metadata/`
 *
 * Edge/Chrome 加载解包扩展时会在扩展目录里生成
 * `_metadata/generated_indexed_rulesets/*`（规则集的索引缓存，实测约 6 MB）。
 * 它不是我们的产物，把它打进发布包既臃肿又可能让审核困惑。
 *
 * ## 审计规则：dist 里每个文件都必须是"可达的"
 *
 * 可达 = manifest 声明 / 图标 / 语言包 / 界面引用的资源 / 三类规则数据目录。
 * 其余一律视为构建残留：**打印出来并从包里剔除**，而不是静默打包。
 *
 * 用法：node tools/release/package.mjs [--no-build]
 */
import { deflateRawSync } from 'node:zlib';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
const p = (rel) => fileURLToPath(new URL(rel, root));
const DIST = p('dist');
const RELEASE_DIR = p('release');

// ── 1) 先构建（除非显式跳过）──
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

// ── 2) 收集"可达文件" ──
const reachable = new Set();

const add = (rel) => {
  const clean = rel.replace(/^\.?\//, '');
  if (!clean) return;
  reachable.add(clean);
};

// 入口本身：manifest 不会"声明自己的文件名"，必须显式加入
// （自测时踩到：审计把它当成构建残留删掉了）
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

// 界面 HTML 引用的本地资源
for (const html of ['popup.html', 'options.html']) {
  const body = readFileSync(`${DIST}/${html}`, 'utf8');
  for (const m of body.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^(?:https?:|data:|#|\/)/.test(m[1])) continue;
    add(m[1]);
  }
}

// 目录：语言包、三类规则数据（内容脚本/SW 运行时按需读取）
//
// ⚠️ 这里必须是**纯列举**函数：早先版本让同一个 walk 既列举又标记可达，
// 结果"所有文件都可达"，审计永远发现不了残留（自测时才发现）。
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

// ── 3) 审计：找出不该进包的东西 ──
const allFiles = listFiles(DIST, '');
const excluded = allFiles.filter((f) => !reachable.has(f)).sort();

if (excluded.length) {
  console.log(`\n剔除 ${excluded.length} 个非发布产物（构建/浏览器残留）：`);
  for (const f of excluded.slice(0, 20)) {
    const size = statSync(`${DIST}/${f}`).size;
    console.log(`  ${f}  ${(size / 1024).toFixed(0)} KB`);
  }
  if (excluded.length > 20) console.log(`  … 其余 ${excluded.length - 20} 个`);
  // 直接从 dist 删掉，保证目录本身也干净（下次构建前不必手动清理）
  for (const f of excluded) rmSync(`${DIST}/${f}`, { force: true });
  // 清掉因此变空的目录
  for (const dir of readdirSync(DIST)) {
    const abs = `${DIST}/${dir}`;
    if (statSync(abs).isDirectory() && readdirSync(abs).length === 0) rmSync(abs, { recursive: true });
  }
}

const files = allFiles.filter((f) => reachable.has(f)).sort();

// ── 4) 写 ZIP（deflate + CRC32，格式见 PKWARE APPNOTE）──

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** MS-DOS 时间/日期（ZIP 用）。 */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const now = new Date();
const { time: dosTime, day: dosDate } = dosDateTime(now);

const localParts = [];
const centralParts = [];
let offset = 0;

for (const rel of files) {
  const data = readFileSync(`${DIST}/${rel}`);
  const compressed = deflateRawSync(data, { level: 9 });
  // 压缩后反而更大时按规范退回 store（method 0），避免无谓膨胀
  const useDeflate = compressed.length < data.length;
  const body = useDeflate ? compressed : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const nameBuf = Buffer.from(rel, 'utf8');

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);            // version needed
  local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 文件名
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);            // extra len
  localParts.push(local, nameBuf, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);      // version made by (UNIX-ish)
  central.writeUInt16LE(20, 6);          // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);          // extra
  central.writeUInt16LE(0, 32);          // comment
  central.writeUInt16LE(0, 34);          // disk
  central.writeUInt16LE(0, 36);          // internal attrs
  // external attrs: -rw-r--r--  （`<<` 在 JS 里是 32 位有符号，必须 >>> 0）
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(centralParts);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

const zip = Buffer.concat([...localParts, centralBuf, eocd]);

mkdirSync(RELEASE_DIR, { recursive: true });
const zipName = `adblow-${version}-edge.zip`;
const zipPath = `${RELEASE_DIR}/${zipName}`;
writeFileSync(zipPath, zip);

// ── 5) 报告 ──
const totalRaw = files.reduce((n, f) => n + statSync(`${DIST}/${f}`).size, 0);
console.log(`\n${appName} v${version} 发布包`);
console.log(`  文件数   ${files.length}`);
console.log(`  解包体积 ${(totalRaw / 1024 / 1024).toFixed(2)} MB`);
console.log(`  压缩后   ${(zip.length / 1024 / 1024).toFixed(2)} MB  (${(zip.length / totalRaw * 100).toFixed(0)}%)`);
console.log(`  产物     release/${zipName}`);

// 关键项自检：商店要求 manifest.json 在压缩包根目录、且必需字段齐全
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
