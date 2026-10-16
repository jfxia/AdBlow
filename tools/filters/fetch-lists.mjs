// Fetches the filter lists at build time. The lists are NOT committed (filters/ is
// in .gitignore) for two practical reasons -- not because the licences forbid it:
// the EasyList family is GPLv3 / CC BY-SA 3.0, so redistributing it is allowed as long
// as the terms travel with it (this repository is GPL-3.0, see the licence section of
// the README). What committing would cost is freshness and repository size: the six
// lists are ~10 MB of text that upstream rewrites daily, and a clone would carry every
// stale revision. Fetching at build time is what upstream expects and what other
// blockers do. See docs/plans/2026-10-11-filter-list-integration.md, "License".
// Only lists without a paid allowlist are included -- no Acceptable Ads list.
// Run: node tools/filters/fetch-lists.mjs [--force]
import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../../filters/', import.meta.url));

/** List sources. Order sets the trimming priority (small, specific first). */
export const LIST_SOURCES = [
  {
    id: 'easylist-china',
    url: 'https://easylist-downloads.adblockplus.org/easylistchina.txt',
    license: 'GPL-3.0 / CC BY-SA 3.0（与 EasyList 同源）',
    licenseUrl: 'https://easylist.to/pages/licence.html',
    note: '中文站点广告规则，与用户实际浏览的站点生态最相关',
  },
  {
    id: 'easylist',
    url: 'https://easylist.to/easylist/easylist.txt',
    license: 'GPL-3.0 / CC BY-SA 3.0',
    licenseUrl: 'https://easylist.to/pages/licence.html',
    note: '主列表',
  },
  {
    id: 'easyprivacy',
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    license: 'GPL-3.0 / CC BY-SA 3.0',
    licenseUrl: 'https://easylist.to/pages/licence.html',
    note: '追踪与隐私',
  },
  {
    id: 'ublock-filters',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt',
    license: 'GPL-3.0',
    licenseUrl: 'https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE',
    note: 'uBlock Origin 自带列表（含较多反拦截对策）',
  },
  {
    id: 'ublock-privacy',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt',
    license: 'GPL-3.0',
    licenseUrl: 'https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE',
    note: 'uBlock 隐私列表',
  },
  {
    id: 'ublock-badware',
    url: 'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
    license: 'GPL-3.0',
    licenseUrl: 'https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE',
    note: '恶意与误导性内容',
  },
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0';

// Paid-allowlist denylist (hard requirement: only lists without a paid allowlist
// may be sources). EasyList itself has none, but "Acceptable Ads" is a separate
// subscription (exceptionrules.txt) that lets paying advertisers through -- the
// usual way a "free adblocker" goes bad.
// Enforced in code rather than promised in docs: adding such a source to
// LIST_SOURCES makes the fetch fail.
const FORBIDDEN_SOURCE_PATTERNS = [
  'exceptionrules', // Acceptable Ads rules file
  'acceptableads', // official domain
  'acceptable-ads',
  '/aa.txt',
  'allowlist',
  'whitelist',
];

/** Header markers that betray a paid-allowlist lineage. */
const FORBIDDEN_HEADER_MARKERS = ['acceptable ads', 'acceptableads', 'exceptionrules'];

/**
 * Alternative URLs for a list source, tried in order after the primary one.
 *
 * Why this exists: two of the upstream hosts (raw.githubusercontent.com, easylist.to) are
 * unreachable from some networks -- commonly blocked, and slow where they are not. Without a
 * fallback, `pnpm filters` fails there and nobody can build from source, which is exactly the
 * complaint that led to this code. The mirrors below were verified reachable and of matching
 * size: jsDelivr serves GitHub repository contents, and adblockplus.org publishes the EasyList
 * files directly.
 *
 * Derived from the URL rather than listed per source, so a newly added source gets fallbacks
 * for free and there is no second place to keep in sync.
 */
export function mirrorUrls(url) {
  const out = [];

  const gh = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url);
  if (gh) {
    const [, owner, repo, branch, path] = gh;
    out.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`);
  }

  const easylist = /^https:\/\/easylist\.to\/easylist\/([^/]+)$/.exec(url);
  if (easylist) {
    const file = easylist[1];
    out.push(`https://easylist-downloads.adblockplus.org/${file}`);
    out.push(`https://cdn.jsdelivr.net/gh/easylist/easylist@gh-pages/${file}`);
  }

  // The China list lives in its own GitHub repository, which jsDelivr mirrors.
  if (url === 'https://easylist-downloads.adblockplus.org/easylistchina.txt') {
    out.push('https://cdn.jsdelivr.net/gh/easylist/easylistchina@master/easylistchina.txt');
  }

  return out;
}

/** Validate the source config; returns problems (empty means pass). */
export function checkNoPaidWhitelist(sources = LIST_SOURCES) {
  const problems = [];
  for (const s of sources) {
    // Mirrors count too: a fallback URL must not smuggle in a paid-allowlist list.
    const haystack = [s.id, s.url, ...mirrorUrls(s.url)].join(' ').toLowerCase();
    for (const bad of FORBIDDEN_SOURCE_PATTERNS) {
      if (haystack.includes(bad)) {
        problems.push(`来源 ${s.id} 命中付费白名单特征 "${bad}"：${s.url}`);
      }
    }
  }
  return problems;
}

// Check the fetched bodies for traces of the paid-allowlist system. URLs alone
// are not enough -- upstream could merge AA into a main list (controversial in
// the past) and this finds it locally. Comment lines only, so ordinary words in
// the body are never flagged.
export function scanTextForPaidWhitelist(text) {
  const findings = [];
  const lines = text.split(/\r?\n/, 400); // the header is enough
  for (const raw of lines) {
    const line = raw.trim().toLowerCase();
    if (!line.startsWith('!') && !line.startsWith('[')) continue;
    for (const marker of FORBIDDEN_HEADER_MARKERS) {
      if (line.includes(marker)) {
        findings.push(raw.trim().slice(0, 140));
        break;
      }
    }
  }
  return findings;
}

/** Composition stats of one list (coverage report + budget planning). */
export function summarizeList(text) {
  const lines = text.split(/\r?\n/);
  let comments = 0;
  let empty = 0;
  let network = 0;
  let cosmetic = 0;
  let exceptions = 0;
  let extended = 0;
  let scriptlets = 0;
  let html = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      empty += 1;
      continue;
    }
    if (line.startsWith('!') || line.startsWith('[')) {
      comments += 1;
      continue;
    }
    if (line.includes('##+js(') || line.includes('#@#+js(')) {
      scriptlets += 1;
      continue;
    }
    if (line.includes('##^') || line.includes('#@#^')) {
      html += 1;
      continue;
    }
    if (line.includes('#?#')) {
      extended += 1;
      continue;
    }
    if (line.includes('##') || line.includes('#@#') || line.includes('#$#')) {
      cosmetic += 1;
      continue;
    }
    if (line.startsWith('@@')) exceptions += 1;
    network += 1;
  }

  return { total: lines.length, comments, empty, network, exceptions, cosmetic, extended, scriptlets, html };
}

async function fetchOne(source, force) {
  const path = `${OUT_DIR}${source.id}.txt`;
  if (!force && existsSync(path) && statSync(path).size > 1024) {
    const text = readFileSync(path, 'utf8');
    return {
      ...source,
      bytes: text.length,
      cached: true,
      stats: summarizeList(text),
      paidWhitelistFindings: scanTextForPaidWhitelist(text),
    };
  }

  // Primary URL first, then the mirrors; the first one that returns a plausible body wins.
  const candidates = [source.url, ...mirrorUrls(source.url)];
  let text = null;
  let used = null;
  let lastError = '未知';
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, { headers: { 'user-agent': UA } });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const body = await res.text();
      if (body.length < 1024) {
        lastError = `内容过短（${body.length} B）`;
        continue;
      }
      text = body;
      used = candidate;
      break;
    } catch (e) {
      lastError = String(e.message).slice(0, 80);
    }
  }
  if (text === null) {
    throw new Error(
      `${source.id}: 原站与 ${candidates.length - 1} 个镜像全部失败（最后一个错误：${lastError}）。` +
        `可在能访问的机器上执行 pnpm filters 后，把 filters/ 目录复制过来。`,
    );
  }

  writeFileSync(path, text, 'utf8');
  return {
    ...source,
    url: used,
    viaMirror: used !== source.url,
    bytes: text.length,
    cached: false,
    stats: summarizeList(text),
    paidWhitelistFindings: scanTextForPaidWhitelist(text),
  };
}

async function main() {
  const force = process.argv.includes('--force');
  mkdirSync(OUT_DIR, { recursive: true });

  // validate the source config first (hard requirement: no paid allowlist)
  const sourceProblems = checkNoPaidWhitelist();
  if (sourceProblems.length) {
    console.error('❌ 来源配置包含付费白名单列表，已中止：');
    for (const p of sourceProblems) console.error(`   ${p}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const source of LIST_SOURCES) {
    try {
      const r = await fetchOne(source, force);
      results.push(r);
      const s = r.stats;
      console.log(
        `${r.cached ? '缓存' : r.viaMirror ? '下载(镜像)' : '下载'} ${r.id.padEnd(16)} ` +
          `${String(Math.round(r.bytes / 1024)).padStart(5)} KB  ` +
          `网络=${String(s.network).padStart(6)} 例外=${String(s.exceptions).padStart(5)} ` +
          `cosmetic=${String(s.cosmetic).padStart(5)} 扩展=${String(s.extended).padStart(4)} ` +
          `脚本=${String(s.scriptlets).padStart(5)} HTML=${String(s.html).padStart(4)}`,
      );
    } catch (e) {
      console.log(`失败 ${source.id}: ${e.message}`);
    }
  }

  const meta = {
    fetchedAt: new Date().toISOString(),
    note: '构建期下载，不入版本库。许可证与义务见 docs/plans/2026-10-11-filter-list-integration.md',
    // Paid-allowlist results, kept in meta so every fetch stays auditable: no
    // paid sources in the config, no Acceptable Ads traces in the bodies.
    noPaidWhitelist: {
      sourceConfigChecked: true,
      forbiddenPatterns: FORBIDDEN_SOURCE_PATTERNS,
      findings: results.flatMap((r) =>
        (r.paidWhitelistFindings ?? []).map((line) => ({ list: r.id, line })),
      ),
    },
    lists: results.map((r) => ({
      id: r.id,
      url: r.url,
      license: r.license,
      licenseUrl: r.licenseUrl,
      note: r.note,
      bytes: r.bytes,
      stats: r.stats,
    })),
  };
  writeFileSync(`${OUT_DIR}meta.json`, JSON.stringify(meta, null, 2), 'utf8');

  const sum = (k) => results.reduce((n, r) => n + (r.stats[k] ?? 0), 0);
  console.log(
    `\n合计：网络规则 ${sum('network')}（含例外 ${sum('exceptions')}）｜` +
      `cosmetic ${sum('cosmetic')}｜扩展选择器 ${sum('extended')}｜脚本注入 ${sum('scriptlets')}｜HTML 过滤 ${sum('html')}`,
  );

  const findings = meta.noPaidWhitelist.findings;
  if (findings.length) {
    console.error(`\n❌ 列表正文出现付费白名单体系痕迹（${findings.length} 处）：`);
    for (const f of findings.slice(0, 5)) console.error(`   [${f.list}] ${f.line}`);
    console.error('   请人工确认后再继续 —— 目标要求来源只限无付费白名单者。');
    process.exitCode = 1;
  } else {
    console.log(
      `付费白名单检查：来源配置 ${LIST_SOURCES.length} 份均通过；` +
        `正文未出现 Acceptable Ads / exceptionrules 痕迹 ✓`,
    );
  }
  console.log(`已写入 filters/meta.json（${results.length} 份列表）`);
}

// only when run directly; on Windows compare via pathToFileURL, plain string
// comparison mismatches
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
