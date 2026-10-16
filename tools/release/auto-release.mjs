/**
 * Automatic release judgement: do the freshly fetched filter lists actually differ from
 * the state the repository last released?
 *
 * Why this exists: MV3 static rulesets cannot be replaced remotely, so list freshness
 * equals release frequency -- which makes a scheduled release worth having. The failure
 * mode to avoid is the opposite one: a scheduled job that bumps the version on every run
 * and publishes identical packages weekly. The judgement therefore compares a fingerprint
 * of the six lists plus the compiled counts against `tools/release/baseline.json`, a file
 * under version control, and releases only when that fingerprint really moved. See the
 * block comment in release-core.mjs for why no timestamp can enter the comparison.
 *
 * Dry run by default: without `--write` this command only judges and prints; the verdict
 * is also available as JSON for CI (`--decision-file`, the one report written in either
 * mode, and it should point outside the working tree).
 *
 * The steps that follow a "release" verdict in CI (package, commit, push, publish) are
 * deliberately NOT part of this command: `pnpm release:github` refuses to publish unless
 * HEAD is already on the remote, so the commit has to happen between the two.
 *
 * Usage:
 *   node tools/release/auto-release.mjs                          # judge, write nothing
 *   node tools/release/auto-release.mjs --write                  # apply the verdict
 *   node tools/release/auto-release.mjs --write --decision-file "$RUNNER_TEMP/auto.json"
 *   node tools/release/auto-release.mjs --baseline /tmp/base.json   # compare elsewhere
 *
 * Exit codes: 0 judged (including "release"), 1 a check failed, 2 usage error.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The configured sources, so a fetch that silently dropped a list cannot be judged as a
// change: the fetcher reports failures but still writes meta.json with the lists it did
// get, and the ruleset compiler only warns about a list whose file is absent. Importing
// the table keeps one source of truth for "which lists there are"; the module has no
// side effects on import (its main() is behind a direct-invocation guard).
import { LIST_SOURCES } from '../filters/fetch-lists.mjs';
import {
  BASELINE_PATH,
  FINGERPRINT_COUNT_FIELDS,
  FINGERPRINT_SCHEMA,
  VERSION_FILES,
  buildAutoReleaseNotes,
  buildFingerprint,
  decideAutoRelease,
  decisionReport,
  describeFingerprintChange,
  hashListText,
  nextPatchVersion,
  normalizeListText,
  planVersionBump,
  shortHash,
  snapshotDate,
} from './release-core.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const USAGE = `Usage: node tools/release/auto-release.mjs [options]

Judges whether the fetched filter lists differ from the committed baseline. The verdict
is one of: no-change, release, baseline-init, error.

Options:
  --write                 apply the verdict: (re)write the baseline, and for a release
                          also bump the patch version and write the release notes
                          (default: judge only, write nothing)
  --decision-file <path>  write the verdict as JSON to <path> (also in dry-run mode;
                          meant for CI, so the path should live outside the repository)
  --baseline <path>       baseline file (default: ${BASELINE_PATH})
  --root <dir>            repository root (default: the checkout this file lives in)
  --filters-dir <dir>     directory holding the lists and meta.json (default: <root>/filters)
  --report <path>         compile report (default: <filters-dir>/generated/report.json)
  --help                  show this text

What "changed" means: a sha256 of the rule body of each list -- comments, blank lines and
#if/#include directives are dropped, exactly as the compiler drops them -- plus the
compiled counts of ${FINGERPRINT_COUNT_FIELDS.join(', ')}.
Neither filters/meta.json (fetchedAt) nor the timestamps in the report take part, so a
plain refetch is not a change.

Exit codes: 0 judged (including "release"), 1 a check failed, 2 usage error.`;

/** Minimal argv reader: `--flag` booleans and `--key value` pairs. */
export function parseArgs(argv) {
  const opts = {
    write: false,
    decisionFile: null,
    baseline: null,
    root: null,
    filtersDir: null,
    report: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} expects a value`);
      return v;
    };
    if (arg === '--write') opts.write = true;
    else if (arg === '--decision-file') opts.decisionFile = value();
    else if (arg === '--baseline') opts.baseline = value();
    else if (arg === '--root') opts.root = value();
    else if (arg === '--filters-dir') opts.filtersDir = value();
    else if (arg === '--report') opts.report = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

/**
 * Judge one set of fetched lists and, with `--write`, apply the verdict.
 *
 * Exported (with an injectable `io`) so the error paths can be tested in-process: the
 * test sandbox forbids the pipes a spawned child would need.
 *
 * @param {string[]} argv arguments after the script name
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [io]
 * @returns {number} the process exit code
 */
export function runAutoRelease(argv, io = {}) {
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
  const p = (rel) => join(root, rel);
  const filtersDir = opts.filtersDir ? resolve(opts.filtersDir) : p('filters');
  const reportPath = opts.report ? resolve(opts.report) : join(filtersDir, 'generated', 'report.json');
  const baselinePath = opts.baseline
    ? (isAbsolute(opts.baseline) ? opts.baseline : join(root, opts.baseline))
    : p(BASELINE_PATH);
  const recordedAt = new Date().toISOString();
  const problems = [];

  log('AdBlow automatic release judgement');
  log(`  root        ${root}`);
  log(`  mode        ${opts.write ? 'WRITE (repository files are modified)' : 'DRY RUN (nothing is written)'}`);
  log(`  baseline    ${baselinePath}`);
  log(`  notes       docs/release-notes/<version>.md\n`);

  /* ----------------------------------------------------------------- 1 filter lists */
  log('[1/5] filter lists (sha256 of the rule body; comments, blank lines and directives ignored)');
  const listNames = existsSync(filtersDir)
    ? readdirSync(filtersDir).filter((f) => f.endsWith('.txt')).sort()
    : [];
  const lists = [];
  for (const name of listNames) {
    const read = readText(join(filtersDir, name));
    if (read.error) {
      problems.push(`${read.error} — fetch the lists: pnpm filters --force`);
      continue;
    }
    const list = { name: name.slice(0, -'.txt'.length), text: read.text };
    lists.push(list);
    const body = normalizeListText(list.text);
    const ruleLines = body === '' ? 0 : body.split('\n').length;
    log(
      `  [${ruleLines > 0 ? 'ok' : '!!'}] ${list.name.padEnd(18)} ${String(ruleLines).padStart(6)} rules  ` +
        shortHash(hashListText(list.text)),
    );
  }
  if (lists.length === 0) log(`  [!!] no *.txt under ${filtersDir} — fetch the lists: pnpm filters --force`);
  // A fetch that lost a list must not be judged as "the list was removed, release":
  // the fingerprints would differ and a release missing one list would be published.
  for (const source of LIST_SOURCES) {
    if (listNames.includes(`${source.id}.txt`)) continue;
    log(`  [!!] ${source.id.padEnd(18)} not fetched`);
    problems.push(
      `the configured list ${source.id} was not fetched (no ${source.id}.txt in ${filtersDir}) — ` +
        'the fetch did not complete: re-run pnpm filters --force',
    );
  }

  /* --------------------------------------------------------- 2 lists metadata + report */
  const metaRead = readJson(join(filtersDir, 'meta.json'));
  let meta = null;
  if (metaRead.error) {
    problems.push(`${metaRead.error} — fetch the lists: pnpm filters --force`);
  } else {
    meta = metaRead.value;
    const fetchedAt = meta && typeof meta === 'object' ? meta.fetchedAt : null;
    if (!fetchedAt || Number.isNaN(Date.parse(String(fetchedAt)))) {
      problems.push(
        `filters/meta.json has no usable fetchedAt (${JSON.stringify(fetchedAt ?? null)}) — ` +
          'refresh the lists: pnpm filters --force',
      );
    }
  }

  log('\n[2/5] compiled counts (the only report fields that take part in the fingerprint)');
  const reportRead = readJson(reportPath);
  const report = reportRead.error ? null : reportRead.value;
  if (reportRead.error) {
    problems.push(`${reportRead.error} — compile the rulesets: pnpm rulesets`);
    log(`  [!!] ${reportPath} could not be read`);
  } else {
    log(`  [ok] ${FINGERPRINT_COUNT_FIELDS.map((f) => `${f} ${report[f]}`).join('  ')}`);
    log(`  [--] generatedAt ${report.generatedAt ?? '(none)'} is NOT part of the fingerprint`);
  }

  const built = buildFingerprint({ lists, report });
  for (const problem of built.problems) {
    // An unreadable report was already reported once above; its seven missing fields would
    // bury that one useful line under seven duplicates.
    if (report === null && problem.includes('has no numeric')) continue;
    problems.push(problem);
  }

  /* -------------------------------------------------------------------- 3 baseline */
  log('\n[3/5] baseline');
  let baseline = null;
  const baselineExists = existsSync(baselinePath);
  if (baselineExists) {
    const read = readJson(baselinePath);
    if (read.error) {
      problems.push(`${read.error} — delete the file and re-run to establish a new baseline`);
    } else {
      baseline = read.value;
      log(`  [ok] ${baselinePath} (recorded ${baseline?.recordedAt ?? 'unknown'})`);
    }
  } else {
    log(`  [--] ${baselinePath} does not exist yet`);
  }
  if (meta?.fetchedAt) {
    log(`  [--] filters/meta.json fetchedAt ${meta.fetchedAt} is NOT part of the fingerprint (it moves on every fetch)`);
  }

  const pkgRead = readJson(p('package.json'));
  if (pkgRead.error) problems.push(`${pkgRead.error} — --root must point at the AdBlow checkout`);
  const currentVersion = String((pkgRead.value && pkgRead.value.version) ?? '');

  /* -------------------------------------------------------------------- 4 verdict */
  log('\n[4/5] verdict');
  if (problems.length > 0) {
    log('  [!!] cannot judge: the inputs above are incomplete');
    for (const problem of problems) log(`  [!!] ${problem}`);
    log('\nNothing was written.');
    return 1;
  }

  const decision = decideAutoRelease({ baseline, current: built.fingerprint });
  const nextVersion = decision.decision === 'release' ? nextPatchVersion(currentVersion) : null;

  if (decision.decision === 'no-change') {
    log(`  [ok] no change: ${decision.reason}`);
  } else if (decision.decision === 'release') {
    log(`  [new] release: ${decision.reason}`);
    for (const change of decision.changes) log(`        - ${describeFingerprintChange(change)}`);
    if (!nextVersion) {
      log(`  [!!] package.json version ${JSON.stringify(currentVersion)} is not x.y.z — cannot derive the next patch version`);
      return 1;
    }
    log(`        - version ${currentVersion} -> ${nextVersion}`);
  } else if (decision.decision === 'baseline-init') {
    log(`  [--] baseline only: ${decision.reason}`);
  } else {
    log(`  [!!] ${decision.reason}`);
    for (const problem of decision.problems) log(`  [!!] ${problem}`);
  }

  /* ---------------------------------------------------------------------- 5 apply */
  log('\n[5/5] apply');
  const wrote = [];
  let exitCode = 0;

  if (decision.decision === 'error') {
    log('  [!!] nothing was written.');
    exitCode = 1;
  } else if (decision.decision === 'no-change') {
    log('  [--] nothing to do: no file is written and nothing is published');
  } else if (!opts.write) {
    log('  [--] dry run: nothing written. Planned changes:');
    if (decision.decision === 'release') {
      log(`        bump ${currentVersion} -> ${nextVersion} in ${VERSION_FILES.join(', ')}`);
      log(`        write docs/release-notes/${nextVersion}.md${existsSync(p(`docs/release-notes/${nextVersion}.md`)) ? ' (already present, kept)' : ''}`);
      log(`        write ${baselinePath}`);
      log('        then: pnpm package && git commit && git push && pnpm release:github --publish');
    } else {
      log(`        write ${baselinePath}`);
      log('        then: git commit && git push (nothing is released)');
    }
    log('  Re-run with --write to apply.');
  } else {
    exitCode = applyVerdict({ p, decision, currentVersion, nextVersion, baselinePath, built, meta, recordedAt, log });
  }

  const verdictReport = decisionReport({
    decision,
    currentVersion,
    nextVersion,
    baselinePath,
    wrote,
    recordedAt,
  });

  if (opts.decisionFile) {
    const target = isAbsolute(opts.decisionFile) ? opts.decisionFile : resolve(opts.decisionFile);
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(verdictReport, null, 2)}\n`, 'utf8');
      log(`  [ok] wrote the decision report ${target}`);
    } catch (e) {
      fail(`[!!] cannot write the decision report ${target}: ${e.message}`);
      return 1;
    }
  }

  log(`\ndecision: ${decision.decision}${nextVersion ? ` (next version ${nextVersion})` : ''}`);
  return exitCode;

  /**
   * `--write`: rewrite the baseline and, for a release, bump the version and write the
   * release notes. Refuses to touch anything when the version references do not all
   * match, because a half-rewritten bump is exactly what the tooling exists to prevent.
   */
  function applyVerdict(input) {
    const {
      p: path, decision: verdict, currentVersion: from, nextVersion: to,
      baselinePath: baselineFile, built: fingerprintResult, meta: listsMeta, recordedAt: stamp, log: say,
    } = input;
    let code = 0;

    if (verdict.decision === 'release') {
      const files = {};
      for (const rel of VERSION_FILES) {
        const read = readText(path(rel));
        if (!read.error) files[rel] = read.text;
      }
      const plan = planVersionBump({ files, from, to });
      for (const problem of plan.problems) {
        say(`  [!!] ${problem}`);
        code = 1;
      }
      for (const edit of plan.edits) {
        for (const missed of edit.unmatched) {
          say(`  [!!] ${edit.file}: expected literal not found: ${oneLine(missed)}`);
          say('       fix the document, or update VERSION_REF_RULES in tools/release/release-core.mjs');
          code = 1;
        }
      }
      if (code === 0) {
        for (const edit of plan.edits) {
          if (edit.text === files[edit.file]) continue;
          writeFileSync(path(edit.file), edit.text, 'utf8');
          wrote.push(edit.file);
          say(`  [ok] wrote ${edit.file}`);
        }
        const notesRel = `docs/release-notes/${to}.md`;
        if (existsSync(path(notesRel))) {
          say(`  [--] kept the existing ${notesRel}`);
        } else {
          const notes = buildAutoReleaseNotes({
            version: to,
            fingerprint: fingerprintResult.fingerprint,
            changes: verdict.changes,
            fetchedAt: listsMeta?.fetchedAt ?? null,
            date: snapshotDate(listsMeta?.fetchedAt),
          });
          mkdirSync(dirname(path(notesRel)), { recursive: true });
          writeFileSync(path(notesRel), notes, 'utf8');
          wrote.push(notesRel);
          say(`  [ok] wrote ${notesRel} (generated: a release cannot be published without notes)`);
        }
      }
    }

    if (code !== 0) {
      say('  [!!] refusing to write anything: fix the problems above first');
      return code;
    }

    const record = {
      schema: FINGERPRINT_SCHEMA,
      recordedAt: stamp,
      // Informational only: neither field takes part in the comparison, so a stale
      // baseline is never excused by them.
      packageVersion: to ?? from,
      digest: fingerprintResult.fingerprint.digest,
      lists: fingerprintResult.fingerprint.lists,
      counts: fingerprintResult.fingerprint.counts,
    };
    mkdirSync(dirname(baselineFile), { recursive: true });
    writeFileSync(baselineFile, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    wrote.push(baselineFile);
    say(`  [ok] wrote ${baselineFile}`);
    return 0;
  }
}

/** Read a file as UTF-8 text; `{ error }` instead of a throw, so a check can report it. */
function readText(path) {
  try {
    return { text: readFileSync(path, 'utf8') };
  } catch (e) {
    return { error: `cannot read ${path}: ${e.code ?? e.message}` };
  }
}

/** Read and parse JSON; `{ error }` when the file is absent or not JSON. */
function readJson(path) {
  const read = readText(path);
  if (read.error) return { error: read.error };
  try {
    return { value: JSON.parse(read.text) };
  } catch (e) {
    return { error: `${path} is not valid JSON: ${e.message}` };
  }
}

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').slice(0, 96);
}

// Only when run directly: a test imports this module to reach `runAutoRelease`, and an
// unconditional `main()` would run a real judgement as a side effect of importing.
// Compare via pathToFileURL: on Windows a plain string comparison mismatches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAutoRelease(process.argv.slice(2));
}
