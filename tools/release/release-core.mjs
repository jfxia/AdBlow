/**
 * Pure logic behind the release tooling: version references, tags, the three-way
 * version check, workspace gates, filter-list snapshot freshness, release-note
 * lookup, attachment selection, credential parsing, and the fingerprint that decides
 * whether a scheduled run has anything to release at all.
 *
 * Nothing here touches the file system, the network or a child process (`node:crypto`
 * is used for hashing, which is a pure function of its input), so every rule below is
 * unit-testable without a repository, a git remote or credentials. The command line
 * wrappers (version-bump.mjs, github-release.mjs, auto-release.mjs) own the I/O.
 *
 * Message style: every problem string is meant to be printed as-is and to say what
 * failed AND how to fix it, because a release gate that only says "check failed"
 * costs more time than it saves.
 */

import { createHash } from 'node:crypto';

/** Directory holding one release-notes file per version (version-controlled). */
export const RELEASE_NOTES_DIR = 'docs/release-notes';

/** A snapshot older than this is refused: the attachment cannot be corrected in place. */
export const DEFAULT_SNAPSHOT_MAX_AGE_DAYS = 7;

/** Files whose version references are rewritten by a bump, in this order. */
export const VERSION_FILES = ['package.json', 'README.md', 'README.zh-CN.md', 'docs/RELEASE.md'];

/** Fallback repository when `git remote get-url origin` is unavailable. */
export const DEFAULT_REPO = 'jfxia/AdBlow';

const GITHUB_HOST = 'github.com';

/**
 * Literal version references to rewrite, `%FROM%` / `%TO%` being the placeholder pair.
 *
 * Deliberately a literal table rather than a global `1.0.1 -> 1.0.2` replace: the
 * release checklist ends with per-version history sections (`## 八、v1.0.1 更新说明`)
 * that must keep their own version. A blind replace would rewrite history, and the
 * store listing text with it.
 *
 * Every rule is expanded for both versions and verified against the real files by
 * `pnpm version:bump`, which reports any rule that no longer matches. That is what
 * keeps this table honest when the documentation is restructured: a silent miss is
 * exactly the failure this tooling exists to remove.
 */
export const VERSION_REF_RULES = [
  { file: 'package.json', before: '"version": "%FROM%"', after: '"version": "%TO%"' },
  {
    file: 'README.md',
    before: 'release/adblow-%FROM%-edge.zip',
    after: 'release/adblow-%TO%-edge.zip',
  },
  {
    file: 'README.md',
    before: '<sub>AdBlow %FROM% · Manifest V3 · Edge &amp; Chrome</sub>',
    after: '<sub>AdBlow %TO% · Manifest V3 · Edge &amp; Chrome</sub>',
  },
  {
    file: 'README.zh-CN.md',
    before: 'release/adblow-%FROM%-edge.zip',
    after: 'release/adblow-%TO%-edge.zip',
  },
  {
    file: 'README.zh-CN.md',
    before: '<sub>AdBlow %FROM% · Manifest V3 · Edge 与 Chrome</sub>',
    after: '<sub>AdBlow %TO% · Manifest V3 · Edge 与 Chrome</sub>',
  },
  {
    file: 'docs/RELEASE.md',
    before: 'release/adblow-%FROM%-edge.zip',
    after: 'release/adblow-%TO%-edge.zip',
  },
  {
    file: 'docs/RELEASE.md',
    before: '当前开发版本 v%FROM%）',
    after: '当前开发版本 v%TO%）',
  },
  { file: 'docs/RELEASE.md', before: '`x.y.z`（%FROM%）', after: '`x.y.z`（%TO%）' },
];

/**
 * Test-count references to rewrite with `--test-count <n>`.
 *
 * Exists because a hand-run bump once updated the version but left `tests-760`
 * badges and "# 760 unit and integration tests" lines behind, so the published
 * README described a test suite that no longer matched. Same literal-table
 * approach and the same unmatched-rule report as the version rules.
 */
export const TEST_COUNT_REF_RULES = [
  { file: 'README.md', before: 'tests-%FROM%%20passing', after: 'tests-%TO%%20passing' },
  {
    file: 'README.md',
    before: '# %FROM% unit and integration tests, run in-process',
    after: '# %TO% unit and integration tests, run in-process',
  },
  {
    file: 'README.md',
    before: '%FROM% unit and integration tests (jsdom)',
    after: '%TO% unit and integration tests (jsdom)',
  },
  { file: 'README.md', before: '# %FROM% tests, 0 failures', after: '# %TO% tests, 0 failures' },
  { file: 'README.zh-CN.md', before: 'tests-%FROM%%20passing', after: 'tests-%TO%%20passing' },
  {
    file: 'README.zh-CN.md',
    before: '# %FROM% 项单元与集成测试，单进程内执行',
    after: '# %TO% 项单元与集成测试，单进程内执行',
  },
  {
    file: 'README.zh-CN.md',
    before: '%FROM% 项单元与集成测试（jsdom）',
    after: '%TO% 项单元与集成测试（jsdom）',
  },
  { file: 'README.zh-CN.md', before: '# %FROM% 项测试，0 失败', after: '# %TO% 项测试，0 失败' },
  { file: 'docs/RELEASE.md', before: '%FROM% 项测试通过', after: '%TO% 项测试通过' },
];

/** `1.2.3`, the only version shape the manifest and the store accept here. */
export function isSemver(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

/** Numeric semver comparison; returns <0, 0 or >0. Non-semver input sorts last. */
export function compareSemver(a, b) {
  if (!isSemver(a) || !isSemver(b)) return isSemver(a) ? 1 : isSemver(b) ? -1 : 0;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/** The version a tag must carry, e.g. `v1.0.2`. */
export function expectedTag(version) {
  return `v${version}`;
}

/**
 * Strip the optional `v` from a tag.
 *
 * @param {string} tag
 * @returns {string | null} the version, or null when the tag is not a version tag
 */
export function normalizeTag(tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim());
  return m ? m[1] : null;
}

/**
 * Replace every occurrence of every literal in `rules`.
 *
 * @param {string} text
 * @param {{ file: string, before: string, after: string }[]} rules already expanded
 * @returns {{ text: string, hits: { file: string, line: number, before: string, after: string }[],
 *   unmatched: string[] }} `unmatched` lists the rules that matched nothing
 */
export function applyRules(text, rules) {
  let out = text;
  const hits = [];
  const unmatched = [];

  for (const rule of rules) {
    if (!rule.before) continue;
    let searchFrom = 0;
    let found = 0;
    for (;;) {
      const at = out.indexOf(rule.before, searchFrom);
      if (at < 0) break;
      hits.push({
        file: rule.file,
        line: lineAt(out, at),
        before: rule.before,
        after: rule.after,
      });
      out = out.slice(0, at) + rule.after + out.slice(at + rule.before.length);
      // skip past the replacement: a new version such as 1.0.10 contains 1.0.1
      searchFrom = at + rule.after.length;
      found += 1;
      if (rule.after === rule.before) break; // nothing to replace; avoid looping forever
    }
    if (found === 0) unmatched.push(rule.before);
  }

  return { text: out, hits, unmatched };
}

/** Substitute `%FROM%` / `%TO%` in a rule table. */
export function expandRules(rules, from, to) {
  const fill = (tpl) => String(tpl).split('%FROM%').join(from).split('%TO%').join(to);
  return rules.map((rule) => ({ file: rule.file, before: fill(rule.before), after: fill(rule.after) }));
}

/**
 * Rewrite the version references of one file.
 *
 * @param {string} text current file content
 * @param {string} from current version
 * @param {string} to new version
 * @param {string} file repository-relative path, selects the applicable rules
 * @returns {{ text: string, hits: { file: string, line: number, before: string, after: string }[],
 *   unmatched: string[] }}
 */
export function rewriteVersionRefs(text, from, to, file) {
  return applyRules(text, expandRules(VERSION_REF_RULES, from, to).filter((r) => r.file === file));
}

/** Same as `rewriteVersionRefs`, for the test-count references. */
export function rewriteTestCounts(text, from, to, file) {
  return applyRules(
    text,
    expandRules(TEST_COUNT_REF_RULES, from, to).filter((r) => r.file === file),
  );
}

/**
 * Find the test counts currently written in the documentation.
 *
 * @param {Record<string, string>} files repository-relative path -> content
 * @returns {{ file: string, line: number, value: number, match: string }[]}
 */
export function findTestCountRefs(files) {
  const out = [];
  for (const [file, text] of Object.entries(files)) {
    for (const rule of TEST_COUNT_REF_RULES.filter((r) => r.file === file)) {
      const parts = rule.before.split('%FROM%').map(escapeRegExp);
      const re = new RegExp(parts.join('(\\d+)'), 'g');
      for (const m of String(text).matchAll(re)) {
        out.push({ file, line: lineAt(text, m.index), value: Number(m[1]), match: m[0] });
      }
    }
  }
  return out;
}

/**
 * Plan a version bump over a set of files.
 *
 * @param {{ files: Record<string, string>, from: string, to: string }} input
 * @returns {{ ok: boolean, problems: string[],
 *   edits: { file: string, text: string, hits: object[], unmatched: string[] }[] }}
 */
export function planVersionBump({ files, from, to }) {
  const problems = [];
  if (!isSemver(from)) problems.push(`the current version in package.json is not x.y.z: ${JSON.stringify(from)}`);
  if (!isSemver(to)) problems.push(`the new version must be x.y.z, got ${JSON.stringify(to)}`);
  if (isSemver(from) && isSemver(to) && compareSemver(to, from) <= 0) {
    problems.push(`the new version ${to} is not greater than the current version ${from}`);
  }

  const edits = [];
  for (const file of VERSION_FILES) {
    const text = files[file];
    if (typeof text !== 'string') continue;
    if (!expandRules(VERSION_REF_RULES, from, to).some((r) => r.file === file)) continue;
    edits.push({ file, ...rewriteVersionRefs(text, from, to, file) });
  }

  return { ok: problems.length === 0, problems, edits };
}

/**
 * Lines that still mention the old version after a rewrite.
 *
 * Expected hits are the per-version history sections; anything else is a reference
 * the tooling does not know about yet.
 */
export function findVersionResidue(text, version) {
  const out = [];
  const re = new RegExp(`(^|[^0-9.])${escapeRegExp(version)}([^0-9.]|$)`, 'g');
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) out.push({ line: i + 1, text: line.trim() });
    });
  return out;
}

/**
 * Three-way version consistency: package.json, the requested release, and the
 * manifest INSIDE the package.
 *
 * @param {{ packageVersion: string, requestedVersion: string, tag: string,
 *   manifestVersion: string | null, manifestSource: string }} input
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkVersionTriple(input) {
  const { packageVersion, requestedVersion, tag, manifestVersion, manifestSource } = input;
  const problems = [];

  if (!isSemver(packageVersion)) {
    problems.push(`package.json version is not x.y.z: ${JSON.stringify(packageVersion)}`);
  }
  if (!isSemver(requestedVersion)) {
    problems.push(`the requested version is not x.y.z: ${JSON.stringify(requestedVersion)}`);
  }
  const tagVersion = normalizeTag(tag);
  if (!tagVersion) {
    problems.push(`tag ${JSON.stringify(tag)} is not a version tag such as v1.2.3`);
  }

  if (isSemver(packageVersion) && isSemver(requestedVersion) && requestedVersion !== packageVersion) {
    problems.push(
      `requested version ${requestedVersion} does not match package.json (${packageVersion}) — ` +
        `bump first: pnpm version:bump ${requestedVersion} --write, then commit and push`,
    );
  }
  if (tagVersion && isSemver(requestedVersion) && tagVersion !== requestedVersion) {
    problems.push(
      `tag ${tag} does not match version ${requestedVersion} (expected ${expectedTag(requestedVersion)})`,
    );
  }
  if (manifestVersion === null || manifestVersion === undefined) {
    problems.push(`manifest.json could not be read from ${manifestSource} — the package is not a valid extension zip`);
  } else {
    // Compare against the version being released, which the checks above already tied
    // to package.json, so a drift shows up once and on the right side.
    const target = isSemver(requestedVersion) ? requestedVersion : packageVersion;
    if (isSemver(target) && manifestVersion !== target) {
      problems.push(
        `the manifest inside ${manifestSource} says version ${manifestVersion}, but this release is ` +
          `${target} — rebuild the package: pnpm package`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Gate the release on a clean, pushed working tree.
 *
 * @param {{ porcelain?: string, head?: string | null, upstream?: string | null,
 *   remoteHead?: string | null, branch?: string | null }} input
 *   `remoteHead` is the remote commit after `git ls-remote`, or null when it was not checked
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkWorkspace(input) {
  const { porcelain = '', head = null, upstream = null, remoteHead = null, branch = null } = input;
  const problems = [];

  const dirty = String(porcelain).split(/\r?\n/).filter((line) => line.trim() !== '');
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 10).map((line) => `      ${line}`);
    if (dirty.length > shown.length) shown.push(`      … and ${dirty.length - shown.length} more`);
    problems.push(
      `the working tree is not clean (${dirty.length} path(s)) — commit and push before releasing:\n${shown.join('\n')}`,
    );
  }

  if (!head) {
    problems.push('git HEAD could not be resolved — run this from a git working tree');
  }
  if (!upstream) {
    problems.push(
      `the current branch (${branch ?? 'unknown'}) has no upstream — publish it first: git push -u origin ${branch ?? 'master'}`,
    );
  } else if (head && upstream && head !== upstream) {
    problems.push(
      `HEAD ${shortSha(head)} is not the pushed commit (upstream is ${shortSha(upstream)}) — git push`,
    );
  }
  if (remoteHead && head && remoteHead !== head) {
    problems.push(
      `origin/${branch ?? 'HEAD'} is at ${shortSha(remoteHead)}, not ${shortSha(head)} — ` +
        'the release must point at a commit that is already on the remote: git push',
    );
  }

  return { ok: problems.length === 0, problems };
}

/** `YYYY-MM-DD` from an ISO timestamp, or null when it is not one. */
export function snapshotDate(fetchedAt) {
  const m = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
    String(fetchedAt ?? '').trim(),
  );
  return m ? m[1] : null;
}

/** Whole days since `fetchedAt`; null when the timestamp is unusable. */
export function snapshotAgeDays(fetchedAt, now = new Date()) {
  const t = Date.parse(String(fetchedAt ?? ''));
  if (Number.isNaN(t)) return null;
  return Math.floor((now.getTime() - t) / 86_400_000);
}

/** Attachment name of the filter-list snapshot, derived from the fetch date. */
export function snapshotFileName(fetchedAt) {
  const date = snapshotDate(fetchedAt);
  return date ? `adblow-filter-lists-${date}.zip` : null;
}

/**
 * Refuse a stale filter-list snapshot.
 *
 * @param {unknown} meta parsed filters/meta.json, or null when the file is absent
 * @param {{ now?: Date, maxAgeDays?: number }} [options]
 * @returns {{ ok: boolean, ageDays: number | null, date: string | null,
 *   fileName: string | null, problems: string[] }}
 */
export function checkSnapshotFreshness(meta, options = {}) {
  const { now = new Date(), maxAgeDays = DEFAULT_SNAPSHOT_MAX_AGE_DAYS } = options;
  const problems = [];
  const fetchedAt = meta && typeof meta === 'object' ? meta.fetchedAt : null;

  if (!fetchedAt) {
    problems.push('filters/meta.json is missing or has no fetchedAt — fetch the lists: pnpm filters');
    return { ok: false, ageDays: null, date: null, fileName: null, problems };
  }

  const ageDays = snapshotAgeDays(fetchedAt, now);
  const date = snapshotDate(fetchedAt);
  const fileName = snapshotFileName(fetchedAt);

  if (ageDays === null) {
    problems.push(`filters/meta.json fetchedAt is not a timestamp: ${JSON.stringify(fetchedAt)} — refresh: pnpm filters --force`);
  } else if (ageDays > maxAgeDays) {
    problems.push(
      `the filter-list snapshot is ${ageDays} days old (limit ${maxAgeDays}) — refresh it: pnpm filters --force`,
    );
  } else if (ageDays < 0) {
    problems.push(
      `filters/meta.json fetchedAt is in the future (${fetchedAt}); the clock is wrong or the file was edited`,
    );
  }
  if (!date) {
    problems.push(`the fetch date cannot be derived from ${JSON.stringify(fetchedAt)} — refresh: pnpm filters --force`);
  }

  return { ok: problems.length === 0, ageDays, date, fileName, problems };
}

/** Candidate release-notes paths for a version, most specific first. */
export function notesCandidates(version) {
  return [`${RELEASE_NOTES_DIR}/${version}.md`, `${RELEASE_NOTES_DIR}/v${version}.md`];
}

/**
 * Locate the version-controlled release notes.
 *
 * @param {string} version
 * @param {{ explicit?: string | null, exists: (path: string) => boolean }} options
 * @returns {{ path: string, found: boolean, candidates: string[], explicit: boolean }}
 */
export function resolveNotesPath(version, options) {
  const { explicit = null, exists } = options;
  if (explicit) {
    return { path: explicit, found: exists(explicit), candidates: [explicit], explicit: true };
  }
  const candidates = notesCandidates(version);
  const hit = candidates.find((c) => exists(c));
  return { path: hit ?? candidates[0], found: Boolean(hit), candidates, explicit: false };
}

/**
 * Validate the release-notes body that will become the GitHub release text.
 *
 * @param {{ text: string | null, version: string, path: string }} input
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkNotes({ text, version, path }) {
  const problems = [];
  if (text === null || text === undefined) {
    problems.push(
      `release notes not found: ${path} — write the notes for ${version} under ${RELEASE_NOTES_DIR}/ ` +
        `(one file per version, e.g. ${notesCandidates(version)[0]})`,
    );
    return { ok: false, problems };
  }
  const body = String(text).trim();
  if (body === '') {
    problems.push(`release notes are empty: ${path}`);
    return { ok: false, problems };
  }
  if (!body.includes(version)) {
    problems.push(`release notes ${path} never mention version ${version} — the release body would name the wrong version`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The two attachments of an AdBlow release: the store package and the snapshot of
 * the filter lists the package was built from.
 *
 * @param {{ packagePath: string, snapshotPath: string }} input
 * @returns {{ role: string, path: string, name: string }[]}
 */
export function planAttachments({ packagePath, snapshotPath }) {
  return [
    { role: 'store-package', path: packagePath, name: basename(packagePath) },
    { role: 'filter-lists-snapshot', path: snapshotPath, name: basename(snapshotPath) },
  ];
}

/**
 * Idempotency: upload only the attachments the release does not already have.
 *
 * @param {{ role: string, path: string, name: string }[]} planned
 * @param {string[]} existingNames asset names already on the release
 */
export function selectUploads(planned, existingNames = []) {
  const have = new Set(existingNames);
  return {
    uploads: planned.filter((a) => !have.has(a.name)),
    skipped: planned.filter((a) => have.has(a.name)),
  };
}

/**
 * Parse `git credential fill` output. Only the two fields of interest are returned;
 * callers must never print the password.
 *
 * @param {string} text
 * @returns {{ username: string | null, password: string | null }}
 */
export function parseCredentialOutput(text) {
  const out = { username: null, password: null };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([A-Za-z_]+)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'username') out.username = m[2];
    else if (m[1] === 'password') out.password = m[2];
  }
  return out;
}

/** Safe description of a token: length only, never the value. */
export function describeToken(token) {
  return token ? `length ${String(token).length}` : '(none)';
}

/** `owner/name` from a GitHub remote URL (https or ssh); null for anything else. */
export function repoFromRemoteUrl(url) {
  const m = new RegExp(`${escapeRegExp(GITHUB_HOST)}[/:]([^/]+)/([^/]+?)(?:\\.git)?$`).exec(
    String(url ?? '').trim(),
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortSha(sha) {
  return String(sha).slice(0, 8);
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

function basename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

/* ---------------------------------------------------------------------------------
 * Automatic release: is there anything new to release?
 *
 * MV3 static rulesets cannot be replaced remotely, so the freshness of the filter
 * lists equals the release frequency. That makes a scheduled release useful -- and a
 * scheduled release that bumps the version on every run useless, because it would
 * publish identical packages weekly and train everyone to ignore the version number.
 *
 * The decision therefore rests on a fingerprint of the fetched lists plus the compiled
 * counts, compared against a baseline file that is under version control:
 *
 *   fingerprint = { schema, lists: { <list id>: sha256(rule body) }, counts, digest }
 *
 * Two properties matter, and both are deliberate:
 *
 * 1. NO TIMESTAMP IS PART OF THE FINGERPRINT. `filters/meta.json` (fetchedAt) and the
 *    `generatedAt` / `listFetchedAt` fields of `filters/generated/report.json` change
 *    on every fetch, so including any of them would make every scheduled run look like
 *    a change. The counts are read from an explicit allow-list of fields instead of
 *    hashing the whole report, so a future timestamp field cannot leak in either.
 *
 * 2. THE LIST HASH COVERS THE RULE BODY ONLY. Upstream rewrites the header of every
 *    EasyList-family file on each publication (`! Version:`, `! Last modified:`,
 *    `! Checksum:`, `! Commit:`), and those lines are not rules. `normalizeListText`
 *    drops exactly the lines the compiler drops (`src/engine/filterList/parse.ts`:
 *    `!`/`[` comments and `#if|#endif|#include|@include` directives), so header churn
 *    alone cannot trigger a release while a single changed rule can.
 * ------------------------------------------------------------------------------ */

/** Repository-relative path of the fingerprint baseline (version-controlled). */
export const BASELINE_PATH = 'tools/release/baseline.json';

/** Shape version of the baseline file; a change means "re-baseline, release nothing". */
export const FINGERPRINT_SCHEMA = 1;

/**
 * `filters/generated/report.json` fields that make up the fingerprint, in report order.
 *
 * An allow-list, not the whole object: every timestamp in that file changes per run, and
 * so does anything the compiler may start reporting later. `budget` is included because a
 * budget change alters which rules survive truncation.
 */
export const FINGERPRINT_COUNT_FIELDS = [
  'input',
  'compiled',
  'exceptions',
  'packedDomains',
  'packedRules',
  'rulesetCount',
  'budget',
];

/** The four verdicts of the automatic-release judgement. */
export const AUTO_RELEASE_DECISIONS = ['no-change', 'release', 'baseline-init', 'error'];

/** sha256 of a string, hex encoded. */
export function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/**
 * Reduce a filter list to the lines that can affect the compiled ruleset.
 *
 * Mirrors the classifier in `src/engine/filterList/parse.ts`: blank lines, `!`/`[`
 * comments and `#if`/`#endif`/`#include`/`@include` directives are skipped there, so
 * they are skipped here too -- anything else (network, cosmetic, scriptlet, HTML) is
 * kept verbatim, only trimmed.
 *
 * @param {string} text
 * @returns {string} the rule body, one trimmed rule per line
 */
export function normalizeListText(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('!') || line.startsWith('[')) continue;
    if (/^#(if|endif|include|@include)/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

/** Hash of the rule body of one list (see `normalizeListText`). */
export function hashListText(text) {
  return hashText(normalizeListText(text));
}

/** First 12 hex characters of a hash: enough to compare by eye in a log line. */
export function shortHash(hash) {
  return String(hash ?? '').slice(0, 12);
}

/** A record with its keys sorted, so a digest never depends on insertion order. */
export function sortedRecord(input) {
  const out = {};
  for (const key of Object.keys(input ?? {}).sort()) out[key] = input[key];
  return out;
}

/** The digest of a fingerprint's content: `{ schema, lists, counts }` and nothing else. */
export function digestOf({ schema, lists, counts }) {
  return hashText(JSON.stringify({ schema, lists: sortedRecord(lists), counts: sortedRecord(counts) }));
}

/**
 * Read the fingerprint counts out of a compile report.
 *
 * @param {unknown} report parsed `filters/generated/report.json`
 * @returns {{ counts: Record<string, number>, missing: string[] }}
 */
export function projectCounts(report) {
  const counts = {};
  const missing = [];
  for (const field of FINGERPRINT_COUNT_FIELDS) {
    const value = report && typeof report === 'object' ? report[field] : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) counts[field] = value;
    else missing.push(field);
  }
  return { counts, missing };
}

/**
 * Build the fingerprint of the lists that were just fetched and compiled.
 *
 * @param {{ lists: { name: string, text: string }[], report: unknown, schema?: number }} input
 * @returns {{ fingerprint: null | { schema: number, lists: Record<string, string>,
 *   counts: Record<string, number>, digest: string }, problems: string[] }}
 *   `fingerprint` is null when the inputs are unusable; the problems say what to fix
 */
export function buildFingerprint({ lists, report, schema = FINGERPRINT_SCHEMA }) {
  const problems = [];
  const hashed = {};

  if (!Array.isArray(lists) || lists.length === 0) {
    problems.push('no filter list was read — fetch them first: pnpm filters --force');
  }
  for (const item of lists ?? []) {
    const name = String(item?.name ?? '').trim();
    if (!name) {
      problems.push('a filter list has no name');
      continue;
    }
    const body = normalizeListText(item?.text);
    if (body === '') {
      problems.push(
        `the filter list ${name} has no rule line at all (comments only) — ` +
          'the download is truncated or the file is not a filter list',
      );
      continue;
    }
    hashed[name] = hashText(body);
  }

  const { counts, missing } = projectCounts(report);
  for (const field of missing) {
    problems.push(
      `filters/generated/report.json has no numeric ${field} — recompile the rulesets: pnpm rulesets`,
    );
  }

  if (problems.length > 0) return { fingerprint: null, problems };
  return {
    fingerprint: {
      schema,
      lists: sortedRecord(hashed),
      counts: sortedRecord(counts),
      digest: digestOf({ schema, lists: hashed, counts }),
    },
    problems,
  };
}

/**
 * Per-field difference between two fingerprints, so the log can name what moved.
 *
 * @param {{ lists?: Record<string, string>, counts?: Record<string, number> }} from
 * @param {{ lists?: Record<string, string>, counts?: Record<string, number> }} to
 * @returns {{ kind: string, key: string, from: string | number | null,
 *   to: string | number | null }[]}
 */
export function diffFingerprints(from, to) {
  const changes = [];
  const compare = (group, kind) => {
    const a = sortedRecord((from ?? {})[group]);
    const b = sortedRecord((to ?? {})[group]);
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(key in a)) changes.push({ kind: `${kind}-added`, key, from: null, to: b[key] });
      else if (!(key in b)) changes.push({ kind: `${kind}-removed`, key, from: a[key], to: null });
      else if (a[key] !== b[key]) changes.push({ kind: `${kind}-changed`, key, from: a[key], to: b[key] });
    }
  };
  compare('lists', 'list');
  compare('counts', 'count');
  return changes;
}

/**
 * The judgement: release, do nothing, or (re)write the baseline first.
 *
 * `baseline-init` is the "record, do not release" verdict. It covers the first run in a
 * repository (no baseline yet) and a fingerprint shape change. Both are deliberately
 * non-releasing: a run that cannot compare against a known-good state must never be the
 * run that publishes a version, or the very first configuration would ship a release for
 * rules that were already in the repository.
 *
 * @param {{ baseline: unknown, current: object | null }} input
 *   `baseline` is the parsed baseline file, or null when the file does not exist
 * @returns {{ decision: string, reason: string, problems: string[], changes: object[] }}
 */
export function decideAutoRelease({ baseline, current }) {
  const empty = { problems: [], changes: [] };

  if (!current) {
    return {
      decision: 'error',
      reason: 'the fingerprint of the current lists could not be built',
      problems: ['the current fingerprint is missing — fix the problems reported above'],
      changes: [],
    };
  }
  if (baseline === null || baseline === undefined) {
    return {
      ...empty,
      decision: 'baseline-init',
      reason: 'there is no baseline in the repository yet: this run records one and releases nothing',
    };
  }
  if (typeof baseline !== 'object' || Array.isArray(baseline)) {
    return {
      decision: 'error',
      reason: 'the baseline file is not a JSON object',
      problems: [
        'the baseline is not a JSON object — delete it and re-run to establish a new one',
      ],
      changes: [],
    };
  }
  if (baseline.schema !== current.schema) {
    return {
      ...empty,
      decision: 'baseline-init',
      reason:
        `the baseline carries schema ${JSON.stringify(baseline.schema)} and this tool writes ` +
        `schema ${current.schema}: the baseline is rewritten and nothing is released this run`,
    };
  }

  // A baseline whose digest does not describe its own content cannot be trusted to say
  // "unchanged": it was edited by hand, or written by something else.
  const recomputed = digestOf({
    schema: baseline.schema,
    lists: baseline.lists ?? {},
    counts: baseline.counts ?? {},
  });
  if (baseline.digest !== recomputed) {
    return {
      decision: 'error',
      reason: 'the baseline digest does not match the baseline content',
      problems: [
        'the digest in the baseline does not match its own lists/counts — the file was edited ' +
          'by hand; delete it and re-run to establish a new baseline',
      ],
      changes: [],
    };
  }

  const changes = diffFingerprints(baseline, current);
  // A list the baseline knows but this run did not fetch is an incomplete fetch, not a
  // release: publishing from it would ship a package whose ruleset silently lost a list.
  const missing = changes.filter((change) => change.kind === 'list-removed').map((change) => change.key);
  if (missing.length > 0) {
    return {
      decision: 'error',
      reason: `${missing.length} list(s) of the baseline were not fetched`,
      problems: [
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} in the baseline but missing from ` +
          'this fingerprint — an incomplete fetch must not become a release: re-run ' +
          'pnpm filters --force. If a source was removed deliberately, delete the baseline and ' +
          're-run to record the new set of lists',
      ],
      changes,
    };
  }
  if (changes.length > 0) {
    return {
      decision: 'release',
      reason: `${changes.length} fingerprint change(s) against the baseline`,
      problems: [],
      changes,
    };
  }
  if (baseline.digest !== current.digest) {
    return {
      decision: 'error',
      reason: 'every fingerprint field matches, yet the digests differ',
      problems: [
        'every field of the baseline matches the current fingerprint but the digests differ — ' +
          'the baseline was written by a different version of this tool; delete it and re-run',
      ],
      changes: [],
    };
  }

  return {
    ...empty,
    decision: 'no-change',
    reason: 'the filter lists and the compiled counts match the baseline',
  };
}

/** The next patch version, or null when the input is not `x.y.z`. */
export function nextPatchVersion(version) {
  if (!isSemver(version)) return null;
  const [major, minor, patch] = String(version).split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

/** One line describing a fingerprint change, for the log and the release notes. */
export function describeFingerprintChange(change) {
  const { kind, key, from, to } = change ?? {};
  if (kind === 'list-changed') return `${key}: rule body changed (${shortHash(from)} -> ${shortHash(to)})`;
  if (kind === 'list-added') return `${key}: new list added (${shortHash(to)})`;
  if (kind === 'list-removed') return `${key}: list removed (was ${shortHash(from)})`;
  if (kind === 'count-added') return `${key}: ${from} -> ${to}`;
  if (kind === 'count-removed') return `${key}: ${from} -> ${to}`;
  if (kind === 'count-changed') return `${key}: ${from} -> ${to}`;
  return `${kind} ${key}`;
}

/**
 * The release notes an automatic release publishes.
 *
 * Generated rather than left empty because `pnpm release:github` refuses to publish
 * without `docs/release-notes/<version>.md`, and a scheduled run has nobody to write one.
 * The file is only written when it does not exist, so a hand-written note always wins.
 * The text is third person ("the store package ... is attached"), matching the style the
 * documentation guard enforces on every Markdown file in the repository.
 *
 * @param {{ version: string, fingerprint: object | null, changes?: object[],
 *   fetchedAt?: string | null, date?: string | null }} input
 * @returns {string}
 */
export function buildAutoReleaseNotes({ version, fingerprint, changes = [], fetchedAt = null, date = null }) {
  const counts = fingerprint?.counts ?? {};
  const lines = [];
  lines.push(`### 本版更新（v${version}）`);
  lines.push('');
  lines.push(
    '- **定时任务自动发布的补丁版本**：过滤列表已刷新，规则集随之重建；除列表数据与版本号外没有代码改动。',
  );
  if (fetchedAt) lines.push(`- 过滤列表抓取时间：${fetchedAt}${date ? `（${date}）` : ''}`);
  if (typeof counts.input === 'number') {
    lines.push(
      `- 编译结果：输入 ${counts.input} 条 → 拦截 ${counts.compiled} 条 + 例外 ${counts.exceptions} 条，` +
        `分 ${counts.rulesetCount} 卷；域名锚点 ${counts.packedDomains} 个、合并规则 ${counts.packedRules} 条。`,
    );
  }
  if (changes.length > 0) {
    lines.push('');
    lines.push('与上一版相比：');
    lines.push('');
    for (const change of changes) lines.push(`- ${describeFingerprintChange(change)}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('The store package and a filter-list snapshot are attached to this release. If the upstream list');
  lines.push('hosts are unreachable, extract the snapshot into `filters/` and run `pnpm rulesets && pnpm build`.');
  return `${lines.join('\n')}\n`;
}

/**
 * The JSON report the CI job reads to decide what to do next (`--decision-file`).
 *
 * @param {{ decision: object, currentVersion: string, nextVersion: string | null,
 *   baselinePath: string, wrote: string[], recordedAt: string }} input
 * @returns {object}
 */
export function decisionReport({
  decision,
  currentVersion,
  nextVersion = null,
  baselinePath,
  wrote = [],
  recordedAt,
}) {
  const release = decision.decision === 'release';
  return {
    decision: decision.decision,
    reason: decision.reason,
    currentVersion,
    nextVersion,
    baseline: baselinePath,
    changes: decision.changes ?? [],
    problems: decision.problems ?? [],
    wrote,
    recordedAt,
    commitMessage: release
      ? `chore(release): auto-release v${nextVersion} (filter lists refreshed)`
      : 'chore(release): record the filter-list fingerprint baseline',
  };
}
