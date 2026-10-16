/**
 * Pure logic behind the release tooling: version references, tags, the three-way
 * version check, workspace gates, filter-list snapshot freshness, release-note
 * lookup, attachment selection and credential parsing.
 *
 * Nothing here touches the file system, the network or a child process, so every
 * rule below is unit-testable without a repository, a git remote or credentials.
 * The command line wrappers (version-bump.mjs, github-release.mjs) own the I/O.
 *
 * Message style: every problem string is meant to be printed as-is and to say what
 * failed AND how to fix it, because a release gate that only says "check failed"
 * costs more time than it saves.
 */

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
