import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASELINE_PATH,
  FINGERPRINT_COUNT_FIELDS,
  FINGERPRINT_SCHEMA,
  buildAutoReleaseNotes,
  buildFingerprint,
  decideAutoRelease,
  digestOf,
  diffFingerprints,
  hashListText,
  nextPatchVersion,
  normalizeListText,
  projectCounts,
} from '../../tools/release/release-core.mjs';
import { parseArgs, runAutoRelease } from '../../tools/release/auto-release.mjs';

/**
 * The automatic release exists to publish a patch version when -- and only when -- the
 * filter lists really changed. So the tests that matter are the ones that prove the
 * *negative*: upstream header churn, a new timestamp, an untouched list and a missing
 * baseline must all fail to produce a release, while one changed rule and one changed
 * compiled count must produce one. The CLI paths are covered in-process (a spawned child
 * would need pipes, which the sandbox forbids) against a fixture checkout in a temp dir.
 */

/** A list whose header is rewritten by upstream on every publication. */
function listBody(version: string, modified: string, extra: string[] = []): string {
  return [
    '[Adblock Plus 2.0]',
    `! Version: ${version}`,
    '! Title: EasyList',
    `! Last modified: ${modified}`,
    '! Expires: 4 days (update frequency)',
    `! Checksum: ${version}-checksum`,
    '',
    '||ads.example^',
    '||tracker.example^$third-party',
    'example.com##.ad-banner',
    'example.com#@#.ad-banner',
    ...extra,
  ].join('\n');
}

const REPORT = {
  generatedAt: '2026-10-16T04:03:14.465Z',
  listFetchedAt: '2026-10-16T04:03:13.544Z',
  rulesetSize: 4000,
  regexBudget: 1000,
  input: 128023,
  compiled: 20913,
  exceptions: 2365,
  packedDomains: 106595,
  packedRules: 114,
  rulesetCount: 6,
  budget: 24000,
  budgetTruncated: 0,
};

function fingerprintOf(lists: { name: string; text: string }[], report: unknown = REPORT) {
  const built = buildFingerprint({ lists, report });
  assert.deepEqual(built.problems, [], `fixture is unusable: ${built.problems.join('; ')}`);
  assert.ok(built.fingerprint);
  return built.fingerprint;
}

describe('filter list normalization', () => {
  it('drops exactly what the compiler drops: comments, blank lines and directives', () => {
    const text = [
      '[Adblock Plus 2.0]',
      '! Version: 202610160341',
      '',
      '!#include filters-general.txt',
      '#if env_chromium',
      '||ads.example^',
      'example.com##.ad-banner',
      '   ',
      '#@#.ad-banner',
    ].join('\r\n');
    assert.equal(
      normalizeListText(text),
      ['||ads.example^', 'example.com##.ad-banner', '#@#.ad-banner'].join('\n'),
    );
  });

  it('gives the same hash for a list whose body did not change, whatever the header says', () => {
    // This is the property that keeps a scheduled job from releasing every week: EasyList
    // rewrites Version / Last modified / Checksum on each publication, and none of those
    // lines is a rule.
    const before = listBody('202610160341', '16 Oct 2026 03:41 UTC');
    const after = listBody('202701010900', '01 Jan 2027 09:00 UTC');
    assert.notEqual(before, after);
    assert.equal(hashListText(after), hashListText(before));
  });

  it('changes the hash as soon as one rule changes', () => {
    const before = listBody('202610160341', '16 Oct 2026 03:41 UTC');
    const after = listBody('202610160341', '16 Oct 2026 03:41 UTC', ['||new-ad.example^']);
    assert.notEqual(hashListText(after), hashListText(before));
  });
});

describe('the fingerprint', () => {
  it('hashes the lists and records only the allow-listed compiled counts', () => {
    const built = buildFingerprint({ lists: [{ name: 'easylist', text: listBody('1', 'x') }], report: REPORT });
    assert.deepEqual(built.problems, []);
    const print = built.fingerprint!;
    assert.equal(print.schema, FINGERPRINT_SCHEMA);
    assert.deepEqual(Object.keys(print.lists), ['easylist']);
    assert.equal(print.lists.easylist!.length, 64);
    assert.deepEqual(Object.keys(print.counts), [...FINGERPRINT_COUNT_FIELDS].sort() as string[]);
    assert.equal(print.digest.length, 64);
  });

  it('contains no field that is a timestamp, a date or a version', () => {
    // The guard on the guard: if a future field named `generatedAt` were added to the
    // allow-list, every run would look like a change again.
    const suspicious = FINGERPRINT_COUNT_FIELDS.filter((f) => /at$|time|date|version/i.test(f));
    assert.deepEqual(suspicious, []);
  });

  it('does not change when only the fetch timestamps change', () => {
    const lists = [{ name: 'easylist', text: listBody('1', 'x') }];
    const first = fingerprintOf(lists, REPORT);
    const refetched = fingerprintOf(lists, {
      ...REPORT,
      generatedAt: '2026-11-01T00:00:00.000Z',
      listFetchedAt: '2026-11-01T00:00:00.000Z',
      // a future report may carry more metadata; only the allow-list may matter
      somethingNew: 'whatever',
    });
    assert.equal(refetched.digest, first.digest);
  });

  it('does not depend on the order of the lists or of the counts', () => {
    const a = { schema: FINGERPRINT_SCHEMA, lists: { one: 'aa', two: 'bb' }, counts: { compiled: 1, input: 2 } };
    const b = { schema: FINGERPRINT_SCHEMA, lists: { two: 'bb', one: 'aa' }, counts: { input: 2, compiled: 1 } };
    assert.equal(digestOf(a), digestOf(b));
  });

  it('reports the report fields it is missing instead of inventing them', () => {
    const { counts, missing } = projectCounts({ compiled: 5 });
    assert.deepEqual(counts, { compiled: 5 });
    assert.equal(missing.includes('input'), true);
    const built = buildFingerprint({ lists: [{ name: 'easylist', text: listBody('1', 'x') }], report: { compiled: 5 } });
    assert.equal(built.fingerprint, null);
    assert.match(built.problems.join('\n'), /has no numeric input/);
    assert.match(built.problems.join('\n'), /pnpm rulesets/);
  });

  it('refuses a list that carries no rule at all', () => {
    const built = buildFingerprint({ lists: [{ name: 'easylist', text: '! Version: 1\n! Title: x\n' }], report: REPORT });
    assert.equal(built.fingerprint, null);
    assert.match(built.problems.join('\n'), /no rule line at all/);
  });

  it('refuses an empty set of lists', () => {
    const built = buildFingerprint({ lists: [], report: REPORT });
    assert.equal(built.fingerprint, null);
    assert.match(built.problems.join('\n'), /no filter list was read/);
  });
});

describe('the automatic-release verdict', () => {
  const lists = [{ name: 'easylist', text: listBody('1', 'x') }];
  const baseline = fingerprintOf(lists);

  it('releases nothing when the lists and the counts are unchanged', () => {
    const verdict = decideAutoRelease({ baseline, current: fingerprintOf(lists) });
    assert.equal(verdict.decision, 'no-change');
    assert.deepEqual(verdict.changes, []);
    assert.deepEqual(verdict.problems, []);
  });

  it('releases when one rule of one list changed', () => {
    const changed = fingerprintOf([{ name: 'easylist', text: listBody('1', 'x', ['||brand-new.example^']) }]);
    const verdict = decideAutoRelease({ baseline, current: changed });
    assert.equal(verdict.decision, 'release');
    assert.deepEqual(
      verdict.changes.map((c) => [c.kind, c.key]),
      [['list-changed', 'easylist']],
    );
  });

  it('releases when only a compiled count moved', () => {
    const verdict = decideAutoRelease({
      baseline,
      current: fingerprintOf(lists, { ...REPORT, compiled: REPORT.compiled + 1 }),
    });
    assert.equal(verdict.decision, 'release');
    assert.deepEqual(
      verdict.changes.map((c) => [c.kind, c.key, c.from, c.to]),
      [['count-changed', 'compiled', 20913, 20914]],
    );
  });

  it('does not release when only the timestamps moved', () => {
    const verdict = decideAutoRelease({
      baseline,
      current: fingerprintOf(lists, {
        ...REPORT,
        generatedAt: '2027-02-02T02:02:02.000Z',
        listFetchedAt: '2027-02-02T02:02:02.000Z',
      }),
    });
    assert.equal(verdict.decision, 'no-change');
  });

  it('records a baseline and stops when there is none yet', () => {
    // The first run of a freshly configured schedule: writing the baseline is the whole
    // job. Releasing here would ship the rules that are already in the repository.
    const verdict = decideAutoRelease({ baseline: null, current: baseline });
    assert.equal(verdict.decision, 'baseline-init');
    assert.match(verdict.reason, /no baseline/);
    assert.deepEqual(verdict.changes, []);
  });

  it('rewrites the baseline without releasing when its schema is older', () => {
    const verdict = decideAutoRelease({ baseline: { ...baseline, schema: 0 }, current: baseline });
    assert.equal(verdict.decision, 'baseline-init');
    assert.match(verdict.reason, /schema 0/);
  });

  it('refuses a baseline that was edited by hand instead of trusting it', () => {
    const tampered = { ...baseline, lists: { ...baseline.lists, easylist: 'f'.repeat(64) } };
    const verdict = decideAutoRelease({ baseline: tampered, current: baseline });
    assert.equal(verdict.decision, 'error');
    assert.match(verdict.problems.join('\n'), /does not match its own lists\/counts/);
  });

  it('refuses a baseline that is not an object', () => {
    for (const bad of [[], 'schema: 1', 42]) {
      const verdict = decideAutoRelease({ baseline: bad, current: baseline });
      assert.equal(verdict.decision, 'error', `accepted ${JSON.stringify(bad)}`);
    }
  });

  it('reports an error when there is no current fingerprint to compare', () => {
    const verdict = decideAutoRelease({ baseline, current: null });
    assert.equal(verdict.decision, 'error');
  });

  it('refuses to release when a list of the baseline was not fetched at all', () => {
    const twoLists = fingerprintOf([
      { name: 'easylist', text: listBody('1', 'x') },
      { name: 'easyprivacy', text: listBody('1', 'x') },
    ]);
    const verdict = decideAutoRelease({ baseline: twoLists, current: baseline });
    assert.equal(verdict.decision, 'error');
    assert.match(verdict.problems.join('\n'), /easyprivacy is in the baseline/);
    assert.match(verdict.problems.join('\n'), /pnpm filters --force/);
  });

  it('names added and removed lists as changes', () => {
    const twoLists = fingerprintOf([
      { name: 'easylist', text: listBody('1', 'x') },
      { name: 'easyprivacy', text: listBody('1', 'x') },
    ]);
    const changes = diffFingerprints(baseline, twoLists);
    assert.deepEqual(
      changes.map((c) => [c.kind, c.key]),
      [['list-added', 'easyprivacy']],
    );
    assert.deepEqual(
      diffFingerprints(twoLists, baseline).map((c) => [c.kind, c.key]),
      [['list-removed', 'easyprivacy']],
    );
  });
});

describe('the next patch version', () => {
  it('increments the patch component', () => {
    assert.equal(nextPatchVersion('1.0.2'), '1.0.3');
    assert.equal(nextPatchVersion('1.9.9'), '1.9.10');
    assert.equal(nextPatchVersion('9.9.99'), '9.9.100');
  });

  it('returns null for anything that is not x.y.z', () => {
    for (const bad of ['v1.0.2', '1.0', '1.0.2.3', 'dev', '', null]) {
      assert.equal(nextPatchVersion(bad as string), null, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('the generated release notes', () => {
  const notes = buildAutoReleaseNotes({
    version: '1.0.3',
    fingerprint: fingerprintOf([{ name: 'easylist', text: listBody('1', 'x') }]),
    changes: [{ kind: 'list-changed', key: 'easylist', from: 'a'.repeat(64), to: 'b'.repeat(64) }],
    fetchedAt: '2026-10-16T04:03:13.544Z',
    date: '2026-10-16',
  });

  it('names the version, so the release gate accepts it as the release body', () => {
    assert.match(notes, /v1\.0\.3/);
    assert.match(notes, /2026-10-16/);
    assert.match(notes, /easylist/);
    assert.equal(notes.trim().length > 100, true);
  });

  it('is written in the third person, like every other document in the repository', () => {
    // The same rule tests/unit/repo-hygiene.test.ts enforces on every Markdown file; the
    // generated file has to satisfy it or the next run fails on the repository's own gate.
    assert.equal(/\b(you|your|yours|yourself|you're|you'll)\b|[你您]/i.test(notes), false);
  });

  it('carries no placeholder that a version bump would try to rewrite', () => {
    assert.equal(notes.includes('%FROM%') || notes.includes('%TO%'), false);
  });
});

/* ------------------------------------------------------------------ the CLI paths */

const ROOT_FILES: Record<string, string> = {
  'package.json': `${JSON.stringify({ name: 'adblow', version: '1.0.2' }, null, 2)}\n`,
  'README.md': [
    '# AdBlow',
    'release/adblow-1.0.2-edge.zip',
    '<sub>AdBlow 1.0.2 · Manifest V3 · Edge &amp; Chrome</sub>',
    '',
  ].join('\n'),
  'README.zh-CN.md': [
    '# AdBlow',
    'release/adblow-1.0.2-edge.zip',
    '<sub>AdBlow 1.0.2 · Manifest V3 · Edge 与 Chrome</sub>',
    '',
  ].join('\n'),
  'docs/RELEASE.md': ['# 发布清单', 'release/adblow-1.0.2-edge.zip', '（当前开发版本 v1.0.2）', '`x.y.z`（1.0.2）', ''].join(
    '\n',
  ),
};

/** The lists the repository is configured to fetch. */
const LIST_IDS = [
  'easylist-china',
  'easylist',
  'easyprivacy',
  'ublock-filters',
  'ublock-privacy',
  'ublock-badware',
];

/** A throwaway checkout that satisfies every version-reference rule. */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adblow-auto-release-'));
  for (const [rel, text] of Object.entries(ROOT_FILES)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text, 'utf8');
  }
  mkdirSync(join(dir, 'filters', 'generated'), { recursive: true });
  for (const id of LIST_IDS) writeFileSync(join(dir, 'filters', `${id}.txt`), listBody('1', 'x'), 'utf8');
  writeFileSync(
    join(dir, 'filters', 'meta.json'),
    `${JSON.stringify(
      { fetchedAt: '2026-10-16T04:03:13.544Z', lists: LIST_IDS.map((id) => ({ id })) },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(join(dir, 'filters', 'generated', 'report.json'), `${JSON.stringify(REPORT, null, 2)}\n`, 'utf8');
  return dir;
}

/** Run the CLI against a fixture and return its exit code, output and verdict report. */
function runFixture(dir: string, args: string[] = []) {
  const decisionPath = join(dir, 'decision.json');
  const lines: string[] = [];
  const errors: string[] = [];
  const code = runAutoRelease(
    ['--root', dir, '--decision-file', decisionPath, ...args],
    { log: (line) => lines.push(line), error: (line) => errors.push(line) },
  );
  const report = existsSync(decisionPath)
    ? (JSON.parse(readFileSync(decisionPath, 'utf8')) as Record<string, unknown>)
    : null;
  return { code, out: lines.join('\n'), errors: errors.join('\n'), report, decisionPath };
}

const readFixture = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

describe('the auto-release command line', () => {
  it('rejects an unknown option and a missing value', () => {
    assert.throws(() => parseArgs(['--publish']), /unknown option: --publish/);
    assert.throws(() => parseArgs(['--decision-file']), /expects a value/);
    assert.deepEqual(parseArgs(['--write', '--baseline', 'x.json']), {
      write: true,
      decisionFile: null,
      baseline: 'x.json',
      root: null,
      filtersDir: null,
      report: null,
      help: false,
    });
  });

  it('prints the usage and succeeds on --help, without reading a checkout', () => {
    const lines: string[] = [];
    const code = runAutoRelease(['--help'], { log: (line) => lines.push(line), error: () => {} });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Usage: node tools\/release\/auto-release\.mjs/);
    assert.match(lines.join('\n'), /--decision-file/);
  });

  it('returns the usage exit code for a usage error, without touching the checkout', () => {
    const dir = makeFixture();
    try {
      const result = runFixture(dir, ['--publish']);
      assert.equal(result.code, 2);
      assert.match(result.errors, /unknown option/);
      assert.equal(result.report, null);
      assert.equal(existsSync(join(dir, BASELINE_PATH)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the baseline and releases nothing on a checkout that has no baseline', () => {
    const dir = makeFixture();
    try {
      const first = runFixture(dir, ['--write']);
      assert.equal(first.code, 0);
      assert.equal(first.report?.decision, 'baseline-init');
      assert.equal(first.report?.nextVersion, null);
      const baseline = JSON.parse(readFixture(dir, BASELINE_PATH)) as { digest: string };
      assert.equal(baseline.digest.length, 64);
      // nothing else was touched: no version bump, no notes
      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.2');
      assert.equal(existsSync(join(dir, 'docs', 'release-notes', '1.0.3.md')), false);

      // second run: the baseline is in place and matches, so there is nothing to do
      const second = runFixture(dir, ['--write']);
      assert.equal(second.report?.decision, 'no-change');
      assert.match(second.out, /nothing to do: no file is written/);
      assert.equal(JSON.parse(readFixture(dir, BASELINE_PATH)).digest, baseline.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bumps the patch version, writes the notes and moves the baseline when a rule changed', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      const before = JSON.parse(readFixture(dir, BASELINE_PATH)) as { digest: string };
      writeFileSync(join(dir, 'filters', 'easylist.txt'), listBody('2', 'y', ['||brand-new.example^']), 'utf8');

      const result = runFixture(dir, ['--write']);
      assert.equal(result.code, 0);
      assert.equal(result.report?.decision, 'release');
      assert.equal(result.report?.nextVersion, '1.0.3');
      assert.match(String(result.report?.commitMessage), /auto-release v1\.0\.3/);

      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.3');
      assert.match(readFixture(dir, 'README.md'), /adblow-1\.0\.3-edge\.zip/);
      assert.match(readFixture(dir, 'README.zh-CN.md'), /adblow-1\.0\.3-edge\.zip/);
      assert.match(readFixture(dir, 'docs/RELEASE.md'), /当前开发版本 v1\.0\.3）/);

      const notes = readFixture(dir, 'docs/release-notes/1.0.3.md');
      assert.match(notes, /v1\.0\.3/);
      assert.match(notes, /easylist/);
      assert.notEqual((JSON.parse(readFixture(dir, BASELINE_PATH)) as { digest: string }).digest, before.digest);

      // and the next run is quiet again: the baseline now describes what was released
      assert.equal(runFixture(dir, ['--write']).report?.decision, 'no-change');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps release notes that were written by hand', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      // the notes are read from that file as the release body: an automatic run must not
      // overwrite a note somebody wrote for this exact version
      const handWritten = '### 本版更新（v1.0.3）\n\n- 手写说明。\n';
      mkdirSync(join(dir, 'docs', 'release-notes'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'release-notes', '1.0.3.md'), handWritten, 'utf8');
      writeFileSync(join(dir, 'filters', 'easylist.txt'), listBody('2', 'y', ['||brand-new.example^']), 'utf8');

      const result = runFixture(dir, ['--write']);
      assert.equal(result.report?.decision, 'release');
      assert.match(result.out, /kept the existing docs\/release-notes\/1\.0\.3\.md/);
      assert.equal(readFixture(dir, 'docs/release-notes/1.0.3.md'), handWritten);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('judges without writing anything when --write is absent', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      writeFileSync(join(dir, 'filters', 'easylist.txt'), listBody('2', 'y', ['||brand-new.example^']), 'utf8');
      const baselineBefore = readFixture(dir, BASELINE_PATH);

      const dryRun = runFixture(dir);
      assert.equal(dryRun.code, 0);
      assert.equal(dryRun.report?.decision, 'release');
      assert.deepEqual(dryRun.report?.wrote, []);
      assert.match(dryRun.out, /dry run: nothing written/);
      assert.match(dryRun.out, /bump 1\.0\.2 -> 1\.0\.3/);
      // the verdict is written, the repository is not
      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.2');
      assert.equal(existsSync(join(dir, 'docs', 'release-notes', '1.0.3.md')), false);
      assert.equal(readFixture(dir, BASELINE_PATH), baselineBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when the rulesets were never compiled', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      const baselineBefore = readFixture(dir, BASELINE_PATH);
      rmSync(join(dir, 'filters', 'generated', 'report.json'));
      const result = runFixture(dir, ['--write']);
      assert.equal(result.code, 1);
      assert.match(result.out, /cannot judge/);
      assert.match(result.out, /pnpm rulesets/);
      assert.equal(readFixture(dir, BASELINE_PATH), baselineBefore);
      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly when a configured list was not fetched', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      // The fetcher reports a failed list, still writes meta.json without it, and the
      // ruleset compiler only warns -- so without this check the run would look like
      // "a list was removed" and publish a package that lost it.
      rmSync(join(dir, 'filters', 'easyprivacy.txt'));
      const result = runFixture(dir, ['--write']);
      assert.equal(result.code, 1);
      assert.match(result.out, /easyprivacy/);
      assert.match(result.out, /the fetch did not complete/);
      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails loudly on a baseline it cannot parse, instead of treating it as absent', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      writeFileSync(join(dir, BASELINE_PATH), '{ "schema": 1,', 'utf8');
      writeFileSync(join(dir, 'filters', 'easylist.txt'), listBody('2', 'y'), 'utf8');
      const result = runFixture(dir, ['--write']);
      assert.equal(result.code, 1);
      assert.match(result.out, /is not valid JSON/);
      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to half-apply a bump whose version references do not match', () => {
    const dir = makeFixture();
    try {
      runFixture(dir, ['--write']);
      // a document the reference table no longer matches: the bump must not happen at all
      writeFileSync(join(dir, 'docs', 'RELEASE.md'), '# 发布清单\n', 'utf8');
      writeFileSync(join(dir, 'filters', 'easylist.txt'), listBody('2', 'y', ['||brand-new.example^']), 'utf8');
      const baselineBefore = readFixture(dir, BASELINE_PATH);

      const result = runFixture(dir, ['--write']);
      assert.equal(result.code, 1);
      assert.match(result.out, /expected literal not found/);
      assert.match(result.out, /refusing to write anything/);
      assert.equal(JSON.parse(readFixture(dir, 'package.json')).version, '1.0.2');
      assert.equal(readFixture(dir, BASELINE_PATH), baselineBefore);
      assert.equal(existsSync(join(dir, 'docs', 'release-notes', '1.0.3.md')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* --------------------------------------------------------- the workflow is wiring */

describe('the auto-release workflow', () => {
  const root = new URL('../../', import.meta.url);
  const workflow = readFileSync(new URL('.github/workflows/auto-release.yml', root), 'utf8');
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    engines?: { node?: string };
    scripts?: Record<string, string>;
  };

  it('is wired to the checked-in script', () => {
    assert.equal(pkg.scripts?.['release:auto'], 'node tools/release/auto-release.mjs');
  });

  it('checks out enough history and pins a Node major the package accepts', () => {
    assert.match(workflow, /fetch-depth: 0/);
    const pinned = /node-version: '(\d+)'/.exec(workflow);
    assert.ok(pinned, 'the workflow does not pin a Node major');
    const range = /^>=(\d+)/.exec(pkg.engines?.node ?? '');
    assert.ok(range, 'package.json does not state an engines.node minimum');
    assert.ok(Number(pinned[1]) >= Number(range[1]), `Node ${pinned[1]} is below engines ${pkg.engines?.node}`);
  });

  it('reuses the shared gate instead of defining its own', () => {
    // The typecheck and test steps used to be inline here, which meant the release judged
    // the tree with a private copy of the gate. They now live in the reusable checks.yml --
    // the file ci.yml also calls -- so a release and a pull request cannot drift into two
    // standards, and the release job waits for that job.
    // `pnpm install` stays: this job runs pnpm scripts of its own (filters, rulesets,
    // package, release:github) and needs node_modules for them.
    assert.match(workflow, /uses: \.\/\.github\/workflows\/checks\.yml/);
    assert.match(workflow, /needs: checks/);
    assert.equal(/run: pnpm typecheck/.test(workflow), false);
    assert.equal(/run: node tests\/run-all\.ts/.test(workflow), false);
  });

  it('guards every writing step on both the verdict and the publish input', () => {
    const lines = workflow.split(/\r?\n/);
    const guarded = (name: string) => {
      const at = lines.findIndex((line) => line.includes(`name: ${name}`));
      assert.ok(at > -1, `no step named ${name}`);
      const condition = lines.slice(at, at + 3).find((line) => line.trim().startsWith('if:')) ?? '';
      assert.match(condition, /env\.AUTO_PUBLISH == 'true'/, `${name} is not guarded by the publish input`);
      return condition;
    };
    assert.match(guarded('Commit and push the version, the notes and the baseline'), /decision == 'release'/);
    assert.match(guarded('Publish the GitHub release'), /decision == 'release'/);
    assert.match(guarded('Package the extension'), /decision == 'release'/);

    // Exactly one of the two judge steps may write: a manual run without the publish input
    // has to leave the checkout untouched.
    const judgeSteps = workflow
      .split(/\n\s+- name: /)
      .filter((step) => /run: pnpm release:auto/.test(step));
    assert.equal(judgeSteps.length, 2, 'expected a report-only judge and a writing judge');
    assert.equal(judgeSteps.filter((step) => step.includes('--write')).length, 1, 'exactly one judge may write');
  });
});
