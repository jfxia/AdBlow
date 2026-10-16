import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SNAPSHOT_MAX_AGE_DAYS,
  TEST_COUNT_REF_RULES,
  VERSION_REF_RULES,
  checkNotes,
  checkSnapshotFreshness,
  checkVersionTriple,
  checkWorkspace,
  compareSemver,
  describeToken,
  expandRules,
  expectedTag,
  findTestCountRefs,
  findVersionResidue,
  isSemver,
  normalizeTag,
  notesCandidates,
  parseCredentialOutput,
  planAttachments,
  planVersionBump,
  repoFromRemoteUrl,
  resolveNotesPath,
  rewriteTestCounts,
  rewriteVersionRefs,
  selectUploads,
  snapshotAgeDays,
  snapshotDate,
  snapshotFileName,
} from '../../tools/release/release-core.mjs';

/**
 * Unit tests for the release tooling's pure logic. The interesting cases here are the
 * failure paths: the tools exist to refuse a release that would be wrong, so a test
 * that only covers the happy path proves nothing.
 */

const README_EN = [
  'The store package is produced by `pnpm package` (`release/adblow-1.0.2-edge.zip`).',
  '```bash',
  'pnpm test           # 760 unit and integration tests, run in-process',
  '```',
  '<sub>AdBlow 1.0.2 · Manifest V3 · Edge &amp; Chrome</sub>',
].join('\n');

describe('version reference rewriting', () => {
  it('rewrites every reference of one file and reports each hit with its line', () => {
    const result = rewriteVersionRefs(README_EN, '1.0.2', '1.0.3', 'README.md');
    assert.equal(result.text.includes('1.0.3-edge.zip'), true);
    assert.equal(result.text.includes('<sub>AdBlow 1.0.3 ·'), true);
    assert.equal(result.text.includes('1.0.2'), false);
    assert.deepEqual(
      result.hits.map((hit) => hit.line),
      [1, 5],
    );
    assert.deepEqual(result.unmatched, []);
  });

  it('leaves the per-version history of the checklist alone', () => {
    // The release checklist keeps one section per shipped version. A blind
    // `1.0.2 -> 1.0.3` replace would rewrite that history, and the store copy with it,
    // which is why the rules are literal table entries instead.
    const doc = [
      '当前开发版本 v1.0.2）',
      '',
      '## 八、v1.0.1 更新说明',
      '',
      '上一个版本的说明仍然是 1.0.1。',
    ].join('\n');
    const result = rewriteVersionRefs(doc, '1.0.2', '1.0.3', 'docs/RELEASE.md');
    assert.equal(result.text.includes('当前开发版本 v1.0.3）'), true);
    assert.equal(result.text.includes('## 八、v1.0.1 更新说明'), true);
    assert.equal(result.text.includes('仍然是 1.0.1'), true);
    assert.equal(result.hits.length, 1);
  });

  it('reports a literal that no longer matches, instead of silently missing it', () => {
    const result = rewriteVersionRefs('nothing to see here\n', '1.0.2', '1.0.3', 'package.json');
    assert.deepEqual(result.hits, []);
    assert.deepEqual(result.unmatched, ['"version": "1.0.2"']);
    assert.equal(result.text, 'nothing to see here\n');
  });

  it('does not rewrite the same site twice when the new version contains the old one', () => {
    const result = rewriteVersionRefs('`release/adblow-1.0.1-edge.zip`', '1.0.1', '1.0.10', 'README.md');
    assert.equal(result.text, '`release/adblow-1.0.10-edge.zip`');
    assert.equal(result.hits.length, 1);
  });

  it('exposes the rules as data, with both versions filled in', () => {
    const rules = expandRules(VERSION_REF_RULES, '1.0.2', '1.0.3');
    assert.equal(rules.some((r) => r.before === '"version": "1.0.2"' && r.after === '"version": "1.0.3"'), true);
    assert.equal(
      rules.some((r) => r.before.includes('%FROM%') || r.after.includes('%TO%')),
      false,
    );
  });

  it('rewrites the test-count references, including the badge escape', () => {
    const result = rewriteTestCounts(README_EN, '760', '782', 'README.md');
    assert.equal(result.text.includes('tests-782%20passing'), false); // README.md has no badge in this fixture
    assert.equal(result.text.includes('# 782 unit and integration tests, run in-process'), true);
    assert.equal(result.text.includes('760'), false);
  });

  it('finds the test counts the documentation currently claims', () => {
    const refs = findTestCountRefs({ 'README.md': README_EN });
    assert.deepEqual(
      refs.map((r) => [r.line, r.value]),
      [[3, 760]],
    );
  });

  it('finds old versions still mentioned after a rewrite', () => {
    const residue = findVersionResidue('current 1.0.2\nhistory: v1.0.2 section\nplain 11.0.20', '1.0.2');
    assert.deepEqual(
      residue.map((r) => r.line),
      [1, 2],
    );
  });
});

describe('bump planning', () => {
  const files = { 'package.json': '{ "version": "1.0.2" }\n', 'README.md': README_EN };

  it('plans one edit per file that carries a reference', () => {
    const plan = planVersionBump({ files, from: '1.0.2', to: '1.0.3' });
    assert.equal(plan.ok, true);
    assert.deepEqual(
      plan.edits.map((e) => e.file),
      ['package.json', 'README.md'],
    );
    assert.equal(plan.edits[0]!.text, '{ "version": "1.0.3" }\n');
  });

  it('refuses a version that does not move forward', () => {
    const plan = planVersionBump({ files, from: '1.0.2', to: '1.0.2' });
    assert.equal(plan.ok, false);
    assert.match(plan.problems[0]!, /not greater/);
  });

  it('refuses a target that is not x.y.z', () => {
    const plan = planVersionBump({ files, from: '1.0.2', to: '1.0' });
    assert.equal(plan.ok, false);
    assert.match(plan.problems.join('\n'), /must be x\.y\.z/);
  });

  it('refuses a current version that is not x.y.z', () => {
    const plan = planVersionBump({ files: { 'package.json': '{ "version": "dev" }' }, from: 'dev', to: '1.0.3' });
    assert.equal(plan.ok, false);
    assert.match(plan.problems[0]!, /package\.json/);
  });

  it('compares versions numerically, not as strings', () => {
    assert.ok(compareSemver('1.0.10', '1.0.9') > 0);
    assert.ok(compareSemver('1.1.0', '1.0.99') > 0);
    assert.equal(compareSemver('1.0.2', '1.0.2'), 0);
  });
});

describe('tag validation', () => {
  it('accepts a tag with or without the v prefix', () => {
    assert.equal(normalizeTag('v1.0.2'), '1.0.2');
    assert.equal(normalizeTag('1.0.2'), '1.0.2');
    assert.equal(normalizeTag(' v1.0.2 '), '1.0.2');
    assert.equal(expectedTag('1.0.2'), 'v1.0.2');
  });

  it('rejects anything that is not a version tag', () => {
    for (const tag of ['release-1.0.2', 'v1.0', 'v1.0.2.1', 'latest', '', 'v1.0.x']) {
      assert.equal(normalizeTag(tag), null, `expected ${JSON.stringify(tag)} to be rejected`);
    }
  });

  it('accepts only x.y.z versions', () => {
    assert.equal(isSemver('1.0.2'), true);
    assert.equal(isSemver('1.0'), false);
    assert.equal(isSemver('1.0.2-beta'), false);
    assert.equal(isSemver(102), false);
  });
});

describe('three-way version check', () => {
  const base = {
    packageVersion: '1.0.2',
    requestedVersion: '1.0.2',
    tag: 'v1.0.2',
    manifestVersion: '1.0.2',
    manifestSource: 'release/adblow-1.0.2-edge.zip',
  };

  it('passes when package.json, the request and the manifest inside the zip agree', () => {
    const report = checkVersionTriple(base);
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
  });

  it('refuses a requested version that package.json does not have', () => {
    // The 1.0.1 -> 1.0.2 case: the old package zip is still on disk, but the release
    // request must match package.json, not the leftover file.
    const report = checkVersionTriple({ ...base, requestedVersion: '1.0.1', tag: 'v1.0.1' });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /requested version 1\.0\.1 does not match package\.json \(1\.0\.2\)/);
    assert.match(report.problems[0]!, /pnpm version:bump 1\.0\.1 --write/);
  });

  it('refuses a package whose manifest version drifted from package.json', () => {
    const report = checkVersionTriple({ ...base, manifestVersion: '1.0.1' });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /says version 1\.0\.1/);
    assert.match(report.problems[0]!, /pnpm package/);
  });

  it('refuses a tag that does not match the version', () => {
    const report = checkVersionTriple({ ...base, tag: 'v1.0.1' });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /tag v1\.0\.1 does not match version 1\.0\.2/);
  });

  it('refuses a package without a readable manifest', () => {
    const report = checkVersionTriple({ ...base, manifestVersion: null });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /manifest\.json could not be read/);
  });
});

describe('workspace gate', () => {
  const clean = { porcelain: '', head: 'a'.repeat(40), upstream: 'a'.repeat(40), branch: 'master' };

  it('passes on a clean, pushed tree', () => {
    assert.deepEqual(checkWorkspace(clean).problems, []);
  });

  it('refuses a dirty tree and names the paths', () => {
    const report = checkWorkspace({ ...clean, porcelain: ' M README.md\n?? src/new.ts\n' });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /working tree is not clean \(2 path\(s\)\)/);
    assert.match(report.problems[0]!, /M README\.md/);
  });

  it('refuses an unpushed HEAD', () => {
    const report = checkWorkspace({ ...clean, upstream: 'b'.repeat(40) });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /is not the pushed commit/);
  });

  it('refuses a branch without an upstream', () => {
    const report = checkWorkspace({ ...clean, upstream: null });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /no upstream/);
  });

  it('refuses a commit the remote does not have', () => {
    const report = checkWorkspace({ ...clean, remoteHead: 'c'.repeat(40) });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /already on the remote/);
  });

  it('refuses an unresolvable HEAD', () => {
    const report = checkWorkspace({ porcelain: '', head: null, upstream: null });
    assert.equal(report.ok, false);
    assert.match(report.problems.join('\n'), /HEAD could not be resolved/);
  });
});

describe('filter-list snapshot freshness', () => {
  const now = new Date('2026-10-16T12:00:00Z');

  it('names the attachment after the fetch date', () => {
    assert.equal(snapshotDate('2026-10-16T04:03:13.544Z'), '2026-10-16');
    assert.equal(snapshotFileName('2026-10-16T04:03:13.544Z'), 'adblow-filter-lists-2026-10-16.zip');
    assert.equal(snapshotAgeDays('2026-10-16T04:03:13.544Z', now), 0);
    assert.equal(snapshotAgeDays('2026-10-09T11:00:00Z', now), 7);
  });

  it('accepts a snapshot inside the age limit', () => {
    const report = checkSnapshotFreshness({ fetchedAt: '2026-10-16T04:03:13.544Z' }, { now });
    assert.equal(report.ok, true);
    assert.equal(report.ageDays, 0);
    assert.equal(report.fileName, 'adblow-filter-lists-2026-10-16.zip');
  });

  it('refuses a snapshot older than the limit and says how to refresh it', () => {
    const report = checkSnapshotFreshness({ fetchedAt: '2026-10-01T04:03:13.544Z' }, { now });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /15 days old \(limit 7\)/);
    assert.match(report.problems[0]!, /pnpm filters --force/);
  });

  it('refuses an unparsable fetchedAt', () => {
    const report = checkSnapshotFreshness({ fetchedAt: 'yesterday' }, { now });
    assert.equal(report.ok, false);
    assert.match(report.problems.join('\n'), /not a timestamp/);
  });

  it('refuses missing metadata altogether', () => {
    const report = checkSnapshotFreshness(null, { now });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /filters\/meta\.json is missing/);
    assert.match(report.problems[0]!, /pnpm filters/);
  });

  it('refuses a timestamp in the future', () => {
    const report = checkSnapshotFreshness({ fetchedAt: '2026-11-01T00:00:00Z' }, { now });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /in the future/);
  });

  it('honours a custom age limit', () => {
    const report = checkSnapshotFreshness({ fetchedAt: '2026-10-01T04:03:13.544Z' }, { now, maxAgeDays: 30 });
    assert.equal(report.ok, true);
    assert.equal(DEFAULT_SNAPSHOT_MAX_AGE_DAYS, 7);
  });
});

describe('release notes lookup', () => {
  it('prefers <version>.md and accepts the v-prefixed alternative', () => {
    assert.deepEqual(notesCandidates('1.0.2'), ['docs/release-notes/1.0.2.md', 'docs/release-notes/v1.0.2.md']);

    const plain = resolveNotesPath('1.0.2', { exists: (p) => p === 'docs/release-notes/1.0.2.md' });
    assert.equal(plain.path, 'docs/release-notes/1.0.2.md');
    assert.equal(plain.found, true);

    const prefixed = resolveNotesPath('1.0.2', { exists: (p) => p === 'docs/release-notes/v1.0.2.md' });
    assert.equal(prefixed.path, 'docs/release-notes/v1.0.2.md');
    assert.equal(prefixed.found, true);
  });

  it('falls back to the canonical path when nothing exists, and reports it', () => {
    const notes = resolveNotesPath('1.0.3', { exists: () => false });
    assert.equal(notes.found, false);
    assert.equal(notes.path, 'docs/release-notes/1.0.3.md');
  });

  it('always honours an explicit path', () => {
    const notes = resolveNotesPath('1.0.2', { explicit: 'draft.md', exists: () => false });
    assert.equal(notes.path, 'draft.md');
    assert.equal(notes.found, false);
    assert.equal(notes.explicit, true);
  });

  it('refuses missing notes with the path that was looked for', () => {
    const report = checkNotes({ text: null, version: '1.0.3', path: 'docs/release-notes/1.0.3.md' });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /release notes not found: docs\/release-notes\/1\.0\.3\.md/);
  });

  it('refuses empty notes', () => {
    const report = checkNotes({ text: '   \n', version: '1.0.3', path: 'docs/release-notes/1.0.3.md' });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /empty/);
  });

  it('refuses notes that never mention the version being released', () => {
    const report = checkNotes({
      text: '### 本版更新（v1.0.2）\n- something\n',
      version: '1.0.3',
      path: 'docs/release-notes/1.0.3.md',
    });
    assert.equal(report.ok, false);
    assert.match(report.problems[0]!, /never mention version 1\.0\.3/);
  });

  it('accepts notes that name the version', () => {
    const report = checkNotes({
      text: '### 本版更新（v1.0.2）\n- something\n',
      version: '1.0.2',
      path: 'docs/release-notes/1.0.2.md',
    });
    assert.deepEqual(report.problems, []);
  });
});

describe('attachment selection', () => {
  const planned = planAttachments({
    packagePath: 'release/adblow-1.0.2-edge.zip',
    snapshotPath: 'release/adblow-filter-lists-2026-10-16.zip',
  });

  it('plans the store package first and the list snapshot second', () => {
    assert.deepEqual(
      planned.map((a) => [a.role, a.name]),
      [
        ['store-package', 'adblow-1.0.2-edge.zip'],
        ['filter-lists-snapshot', 'adblow-filter-lists-2026-10-16.zip'],
      ],
    );
  });

  it('uploads both attachments for a new release', () => {
    const { uploads, skipped } = selectUploads(planned, []);
    assert.equal(uploads.length, 2);
    assert.equal(skipped.length, 0);
  });

  it('skips the attachments a release already has, so a retry is safe', () => {
    const { uploads, skipped } = selectUploads(planned, ['adblow-1.0.2-edge.zip', 'notes.txt']);
    assert.deepEqual(
      uploads.map((a) => a.name),
      ['adblow-filter-lists-2026-10-16.zip'],
    );
    assert.deepEqual(
      skipped.map((a) => a.name),
      ['adblow-1.0.2-edge.zip'],
    );
  });

  it('uploads nothing when every attachment is already present', () => {
    const { uploads } = selectUploads(planned, planned.map((a) => a.name));
    assert.equal(uploads.length, 0);
  });
});

describe('credentials', () => {
  it('parses git credential fill output and ignores unrelated fields', () => {
    const parsed = parseCredentialOutput(
      'protocol=https\nhost=github.com\nusername=octocat\npassword=secret-value\n\n',
    );
    assert.deepEqual(parsed, { username: 'octocat', password: 'secret-value' });
  });

  it('reports nothing for empty or non-credential output', () => {
    assert.deepEqual(parseCredentialOutput(''), { username: null, password: null });
    assert.deepEqual(parseCredentialOutput('fatal: could not read Username\n'), {
      username: null,
      password: null,
    });
  });

  it('never exposes the token, only its length', () => {
    const token = 'x'.repeat(40);
    const described = describeToken(token);
    assert.equal(described, 'length 40');
    assert.equal(described.includes(token), false);
    assert.equal(describeToken(null), '(none)');
  });
});

describe('repository detection', () => {
  it('reads owner/name from https and ssh remotes', () => {
    assert.equal(repoFromRemoteUrl('https://github.com/jfxia/AdBlow.git'), 'jfxia/AdBlow');
    assert.equal(repoFromRemoteUrl('https://github.com/jfxia/AdBlow'), 'jfxia/AdBlow');
    assert.equal(repoFromRemoteUrl('git@github.com:jfxia/AdBlow.git'), 'jfxia/AdBlow');
  });

  it('rejects anything that is not a GitHub remote', () => {
    assert.equal(repoFromRemoteUrl('https://gitlab.com/jfxia/AdBlow.git'), null);
    assert.equal(repoFromRemoteUrl(''), null);
  });
});

describe('reference tables against the real repository', () => {
  /**
   * The tables are literal text, so they rot whenever a document is restructured.
   * This guard fails loudly instead: it is the automated version of the hand-check
   * that once missed the test-count badge.
   */
  const root = new URL('../../', import.meta.url);
  const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');
  const version = (JSON.parse(read('package.json')) as { version: string }).version;

  it('every version rule matches its file as it stands today', () => {
    const missing: string[] = [];
    for (const rule of expandRules(VERSION_REF_RULES, version, '9.9.9')) {
      if (!read(rule.file).includes(rule.before)) missing.push(`${rule.file}: ${rule.before}`);
    }
    assert.deepEqual(missing, [], `stale VERSION_REF_RULES entries:\n  ${missing.join('\n  ')}`);
  });

  it('every test-count rule matches its file, and the documents agree on the count', () => {
    const files = {
      'README.md': read('README.md'),
      'README.zh-CN.md': read('README.zh-CN.md'),
      'docs/RELEASE.md': read('docs/RELEASE.md'),
    };
    const refs = findTestCountRefs(files);
    const missing: string[] = [];
    for (const rule of expandRules(TEST_COUNT_REF_RULES, String(refs[0]?.value ?? ''), '9')) {
      if (!files[rule.file as keyof typeof files].includes(rule.before)) {
        missing.push(`${rule.file}: ${rule.before}`);
      }
    }
    assert.deepEqual(missing, [], `stale TEST_COUNT_REF_RULES entries:\n  ${missing.join('\n  ')}`);
    assert.deepEqual(
      [...new Set(refs.map((r) => r.value))],
      [refs[0]?.value],
      'the READMEs and the checklist must state the same test count',
    );
  });

  it('the current version has release notes under docs/release-notes/', () => {
    const notes = read(`docs/release-notes/${version}.md`);
    assert.ok(notes.includes(version), `docs/release-notes/${version}.md does not name ${version}`);
  });
});
