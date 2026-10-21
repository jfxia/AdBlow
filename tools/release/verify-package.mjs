/**
 * Independent unpack audit of the release package.
 *
 * Why a second audit exists at all: `tools/release/package.mjs` decides what goes into the
 * zip by scanning the build directory, and each time that decision was wrong the build log
 * looked perfect. The loss that hurt was `list-info.json` -- the file the rule manager
 * reads through `chrome.runtime.getURL(...)` to report which filter-list revision the
 * installed extension carries. A manifest/HTML scan cannot see such a resource, the audit
 * had deleted it, and only opening the produced zip revealed that the packaged extension
 * had lost the file while the development build still showed it.
 *
 * This tool therefore imports no decision logic from package.mjs and never looks at dist/:
 * it opens the archive that would be uploaded and reads the files back out of it through
 * the reader in ./zip.mjs (the same container implementation, read in the opposite
 * direction). It asserts at least:
 *   - `manifest.json` sits at the archive root, parses, and its `version` equals
 *     package.json's;
 *   - every file the manifest declares exists inside the archive;
 *   - the mandatory manifest fields are present;
 *   - `_locales/` exists and carries the default locale's catalog;
 *   - `icons/` exists and every declared icon is a real, non-empty file;
 *   - `list-info.json` exists, parses, and names the bundled lists;
 *   - `badware-domains.json` exists, parses, and carries a `domains` array (it is read by
 *     the worker through `chrome.runtime.getURL`, so a manifest scan never sees it).
 * Beyond the required set it also fails on the known browser leftovers (`_metadata/`) and on
 * an archive whose file name states a different version than the manifest inside it, which
 * is what a stale or renamed artifact looks like.
 *
 * Usage:
 *   node tools/release/verify-package.mjs                 # release/adblow-<version>-edge.zip
 *   node tools/release/verify-package.mjs --zip /tmp/other.zip
 *   node tools/release/verify-package.mjs --root /tmp/checkout
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 usage error.
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listZipEntries, readZipText } from './zip.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const USAGE = `Usage: node tools/release/verify-package.mjs [options]

Unpacks the release archive and asserts that the files the extension needs are really in it.
Nothing is read from dist/: the archive is the artifact that gets uploaded, so the archive is
what is checked.

Options:
  --zip <path>    archive to audit (default: <root>/release/adblow-<version>-edge.zip)
  --root <dir>    repository root supplying package.json (default: the checkout this file lives in)
  --help          show this text

Exit codes: 0 every check passed, 1 a check failed, 2 usage error.`;

/** Minimal argv reader: `--flag` booleans and `--key value` pairs. */
export function parseArgs(argv) {
  const opts = { zip: null, root: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} expects a value`);
      return v;
    };
    if (arg === '--zip') opts.zip = value();
    else if (arg === '--root') opts.root = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

/** The fields the store requires before it accepts an upload. */
const REQUIRED_MANIFEST_FIELDS = [
  'manifest_version',
  'name',
  'version',
  'description',
  'icons',
  'default_locale',
];

/**
 * Archive-relative paths the manifest declares.
 *
 * Written out here instead of importing package.mjs: this is the second opinion, so it must
 * not share the code whose reachability decision is being verified.
 *
 * @param {Record<string, any>} manifest
 * @returns {string[]} sorted, de-duplicated, `./`-stripped archive paths
 */
export function declaredFiles(manifest) {
  const out = ['manifest.json'];
  const push = (value) => {
    if (typeof value === 'string' && value) out.push(value.replace(/^\.?\//, ''));
  };

  push(manifest?.background?.service_worker);
  push(manifest?.action?.default_popup);
  push(manifest?.options_page);
  for (const v of Object.values(manifest?.icons ?? {})) push(v);
  for (const v of Object.values(manifest?.action?.default_icon ?? {})) push(v);
  for (const cs of manifest?.content_scripts ?? []) {
    for (const v of cs?.js ?? []) push(v);
    for (const v of cs?.css ?? []) push(v);
  }
  for (const r of manifest?.declarative_net_request?.rule_resources ?? []) push(r?.path);

  return [...new Set(out)].sort();
}

/**
 * Audit one archive in memory.
 *
 * Kept free of disk access and of `process`, so a unit test can hand it a zip built by
 * `createZip` and assert on the resulting check list.
 *
 * @param {Buffer} buf the archive
 * @param {{ packageVersion?: string, zipName?: string | null }} [context]
 *   `packageVersion` is the version the archive must carry; `zipName` is the file name, used
 *   only to catch an artifact whose name claims another version.
 * @returns {{ checks: { name: string, ok: boolean, detail: string }[], problems: string[],
 *   manifest: Record<string, any> | null, entryCount: number }}
 */
export function auditPackage(buf, context = {}) {
  const { packageVersion = null, zipName = null } = context;
  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const checks = [];
  const add = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    return Boolean(ok);
  };
  const finish = (manifest) => ({
    checks,
    problems: checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
    manifest,
    entryCount,
  });

  let entries;
  let entryCount = 0;
  try {
    entries = listZipEntries(buf);
    entryCount = entries.length;
  } catch (e) {
    add('archive is readable', false, e.message);
    return finish(null);
  }
  add('archive is readable', true, `${entryCount} entries`);
  add('archive has entries', entryCount > 0, `${entryCount} entries`);

  const names = new Set(entries.map((e) => e.name));
  const sizeOf = new Map(entries.map((e) => [e.name, e.uncompressedSize]));

  const unsafe = entries.filter((e) => e.name.startsWith('/') || e.name.split('/').includes('..'));
  add(
    'entry paths are relative',
    unsafe.length === 0,
    unsafe.length ? `${unsafe.length} unsafe entries: ${unsafe.slice(0, 3).map((e) => e.name).join(', ')}` : 'no absolute or .. path',
  );

  const leftovers = entries.filter((e) => e.name === '_metadata' || e.name.startsWith('_metadata/'));
  add(
    'no browser leftovers',
    leftovers.length === 0,
    leftovers.length ? `${leftovers.length} _metadata/ entries` : 'no _metadata/ entry',
  );

  // --- locale and icon directories do not depend on the manifest being readable
  const locales = [...names].filter((n) => n.startsWith('_locales/')).sort();
  add('_locales/ is in the archive', locales.length > 0, locales.length ? `${locales.length} files` : '_locales/ is missing');

  const icons = [...names].filter((n) => n.startsWith('icons/')).sort();
  add('icons/ is in the archive', icons.length > 0, icons.length ? `${icons.length} files` : 'icons/ is missing');

  const listInfoText = names.has('list-info.json') ? readZipText(buf, 'list-info.json') : null;
  add('list-info.json is in the archive', listInfoText !== null, listInfoText === null ? 'list-info.json is missing from the archive root' : 'found');
  if (listInfoText !== null) {
    let info = null;
    try {
      info = JSON.parse(listInfoText);
    } catch (e) {
      add('list-info.json is valid JSON', false, e.message);
    }
    if (info) {
      const lists = Array.isArray(info.lists) ? info.lists : null;
      add(
        'list-info.json names the bundled lists',
        lists !== null && lists.length > 0,
        lists === null
          ? 'no `lists` array'
          : `${lists.length} lists, built ${info.builtAt ?? '(no builtAt)'}`,
      );
    }
  }

  /**
   * The worker reads this through `chrome.runtime.getURL`, so the manifest and HTML scans
   * cannot see it. Its absence would silently turn the badware gate into "no list" (which
   * allows banner handling), i.e. a feature regression that no build log shows.
   */
  const badwareText = names.has('badware-domains.json')
    ? readZipText(buf, 'badware-domains.json')
    : null;
  add(
    'badware-domains.json is in the archive',
    badwareText !== null,
    badwareText === null ? 'badware-domains.json is missing from the archive root' : 'found',
  );
  if (badwareText !== null) {
    let badware = null;
    try {
      badware = JSON.parse(badwareText);
    } catch (e) {
      add('badware-domains.json is valid JSON', false, e.message);
    }
    if (badware) {
      const domains = badware.domains;
      add(
        'badware-domains.json has a domains array',
        Array.isArray(domains),
        Array.isArray(domains) ? `${domains.length} domains` : 'no `domains` array',
      );
    }
  }

  // --- the manifest decides everything below
  const manifestText = names.has('manifest.json') ? readZipText(buf, 'manifest.json') : null;
  if (!add('manifest.json is at the archive root', manifestText !== null, manifestText === null ? 'manifest.json is missing from the archive root' : 'found')) {
    return finish(null);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (e) {
    add('manifest.json is valid JSON', false, e.message);
    return finish(null);
  }
  add('manifest.json is valid JSON', true, `${Object.keys(manifest).length} fields`);

  const missingFields = REQUIRED_MANIFEST_FIELDS.filter((f) => manifest[f] === undefined);
  add(
    'manifest declares the required fields',
    missingFields.length === 0,
    missingFields.length ? `missing: ${missingFields.join(', ')}` : REQUIRED_MANIFEST_FIELDS.join(', '),
  );

  add(
    'manifest version matches package.json',
    typeof packageVersion === 'string' && manifest.version === packageVersion,
    `manifest ${JSON.stringify(manifest.version)} vs package.json ${JSON.stringify(packageVersion)}`,
  );

  const declared = declaredFiles(manifest);
  const absent = declared.filter((f) => !names.has(f));
  add(
    'every file the manifest declares is in the archive',
    absent.length === 0,
    absent.length ? `${absent.length} missing: ${absent.slice(0, 5).join(', ')}` : `${declared.length} files`,
  );

  const catalog = `_locales/${manifest.default_locale}/messages.json`;
  add(
    'the default locale catalog is in the archive',
    names.has(catalog),
    names.has(catalog) ? catalog : `${catalog} is missing`,
  );

  const declaredIcons = [...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})]
    .filter((v) => typeof v === 'string' && v);
  const emptyIcons = declaredIcons.filter((f) => (sizeOf.get(f.replace(/^\.?\//, '')) ?? 0) === 0);
  add(
    'declared icons are non-empty files',
    declaredIcons.length > 0 && emptyIcons.length === 0,
    declaredIcons.length === 0
      ? 'the manifest declares no icon'
      : emptyIcons.length
        ? `empty or absent: ${emptyIcons.join(', ')}`
        : `${declaredIcons.length} icons`,
  );

  if (zipName !== null) {
    const named = /^adblow-(\d+\.\d+\.\d+)-edge\.zip$/.exec(zipName);
    add(
      'the file name version matches the manifest version',
      named === null || named[1] === manifest.version,
      named === null
        ? `the file name carries no version (${zipName})`
        : named[1] === manifest.version
          ? `both ${named[1]}`
          : `the file name says ${named[1]}, the manifest says ${manifest.version}`,
    );
  }

  return finish(manifest);
}

/**
 * Audit the archive on disk and print one line per check.
 *
 * Exported with an injectable `io` so the CLI paths (missing archive, usage error, a failed
 * check) can be tested in-process: the test sandbox forbids the pipes a child process needs.
 *
 * @param {string[]} argv arguments after the script name
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [io]
 * @returns {number} the process exit code
 */
export function runVerifyPackage(argv, io = {}) {
  const log = io.log ?? ((line) => console.log(line));
  const fail = io.error ?? ((line) => console.error(line));

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    fail(`[!!] ${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }

  const root = resolve(opts.root ?? REPO_ROOT);
  const pkgPath = join(root, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    fail(`[!!] cannot read ${pkgPath}: ${e.message}`);
    return 1;
  }
  const packageVersion = pkg?.version;
  if (typeof packageVersion !== 'string' || packageVersion === '') {
    fail(`[!!] ${pkgPath} has no version`);
    return 1;
  }

  const zipPath = opts.zip
    ? (isAbsolute(opts.zip) ? opts.zip : resolve(opts.zip))
    : join(root, 'release', `adblow-${packageVersion}-edge.zip`);

  log('AdBlow release package audit (unpack and read back)');
  log(`  root        ${root}`);
  log(`  version     ${packageVersion}`);
  log(`  archive     ${zipPath}\n`);

  if (!existsSync(zipPath)) {
    fail(`[!!] the archive does not exist: ${zipPath}`);
    fail('     build it first: pnpm package');
    return 1;
  }

  const result = auditPackage(readFileSync(zipPath), { packageVersion, zipName: basename(zipPath) });
  const width = Math.max(...result.checks.map((c) => c.name.length));
  for (const check of result.checks) {
    log(`  [${check.ok ? 'ok' : '!!'}] ${check.name.padEnd(width)}  ${check.detail}`);
  }

  if (result.problems.length > 0) {
    fail(`\n[!!] ${result.problems.length} of ${result.checks.length} checks failed:`);
    for (const problem of result.problems) fail(`     ${problem}`);
    return 1;
  }

  log(
    `\n[ok] ${result.checks.length} checks passed: ${result.entryCount} entries, the manifest version, ` +
      'every declared file, _locales, the icons, list-info.json and badware-domains.json are in the archive',
  );
  return 0;
}

// Only when run directly: a test imports this module, and an unconditional main() would
// audit a real archive as a side effect of importing. Compare via pathToFileURL, because on
// Windows a plain string comparison mismatches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runVerifyPackage(process.argv.slice(2));
}
