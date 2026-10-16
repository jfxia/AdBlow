/**
 * Version bump: one command instead of hand-editing four files.
 *
 * Why this exists: the version lives in package.json, but it is also quoted in both
 * READMEs and in the release checklist, and a hand-run bump has already shipped a
 * README whose test-count badge no longer matched the suite. The references are
 * therefore a literal table (release-core.mjs) that this command verifies against the
 * real files and reports when a rule stops matching.
 *
 * Dry run by default: without `--write` nothing is modified, the plan is printed.
 *
 * Usage:
 *   node tools/release/version-bump.mjs 1.1.0                     # print the plan
 *   node tools/release/version-bump.mjs 1.1.0 --write             # apply it
 *   node tools/release/version-bump.mjs 1.1.0 --write --test-count 782
 *   node tools/release/version-bump.mjs 1.1.0 --notes-from draft.md --write
 *   node tools/release/version-bump.mjs --counts-only --test-count 782 --write
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  RELEASE_NOTES_DIR,
  TEST_COUNT_REF_RULES,
  VERSION_FILES,
  findTestCountRefs,
  findVersionResidue,
  notesCandidates,
  planVersionBump,
  resolveNotesPath,
  rewriteTestCounts,
} from './release-core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const p = (rel) => `${root}${rel}`;

const USAGE = `Usage: node tools/release/version-bump.mjs [<new-version>] [options]

  <new-version>        the version to move to, x.y.z

Options:
  --write              apply the changes (default: print the plan, change nothing)
  --test-count <n>     also sync the test-count references (badges and README lines)
  --counts-only        sync the test-count references only, without touching the version
                       (for a commit that adds tests; needs --test-count)
  --notes-from <path>  seed ${RELEASE_NOTES_DIR}/<version>.md from <path>
  --help               show this text

Exit codes: 0 ok, 1 a check failed, 2 usage error.`;

/** Minimal argv reader: `--flag` booleans and `--key value` pairs. */
function parseArgs(argv) {
  const opts = {
    version: null, write: false, testCount: null, notesFrom: null, countsOnly: false, help: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--counts-only') opts.countsOnly = true;
    else if (arg === '--test-count') opts.testCount = argv[++i] ?? null;
    else if (arg === '--notes-from') opts.notesFrom = argv[++i] ?? null;
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    else rest.push(arg);
  }
  opts.version = rest[0] ?? null;
  if (rest.length > 1) throw new Error(`unexpected extra argument: ${rest[1]}`);
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`[!!] ${e.message}\n\n${USAGE}`);
  process.exit(2);
}

if (opts.help || (!opts.version && !opts.countsOnly)) {
  console.log(USAGE);
  process.exit(opts.help ? 0 : 2);
}
if (opts.countsOnly && opts.testCount === null) {
  console.error(`[!!] --counts-only needs --test-count <n>; there is nothing else to do\n\n${USAGE}`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));
const from = pkg.version;
const to = opts.version ?? from;

console.log(`AdBlow ${opts.countsOnly ? 'test-count sync' : 'version bump'}: ${from} -> ${to}`);
console.log(`mode: ${opts.write ? 'WRITE (files will be modified)' : 'DRY RUN (nothing is modified; pass --write to apply)'}\n`);

/** Current content of every file the bump may touch. */
const files = {};
for (const file of VERSION_FILES) {
  if (existsSync(p(file))) files[file] = readFileSync(p(file), 'utf8');
}

const plan = opts.countsOnly ? { ok: true, problems: [], edits: [] } : planVersionBump({ files, from, to });
let failed = plan.problems.length > 0;

console.log(`[1/5] version references`);
if (opts.countsOnly) {
  console.log(`  [--] skipped (--counts-only): the version stays ${from}`);
} else if (plan.problems.length) {
  for (const problem of plan.problems) console.log(`  [!!] ${problem}`);
} else {
  for (const edit of plan.edits) {
    if (edit.hits.length === 0) console.log(`  [--] ${edit.file}: no reference to ${from}`);
    for (const hit of edit.hits) {
      console.log(`  [ok] ${edit.file}:${hit.line}  ${oneLine(hit.before)} -> ${oneLine(hit.after)}`);
    }
    // A rule that no longer matches means the documentation moved on and the table
    // is out of date: exactly the silent miss this tool is meant to remove.
    for (const missed of edit.unmatched) {
      console.log(`  [!!] ${edit.file}: expected literal not found: ${oneLine(missed)}`);
      console.log(`       fix the document, or update VERSION_REF_RULES in tools/release/release-core.mjs`);
      failed = true;
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n[2/5] test-count references`);
const docFiles = ['README.md', 'README.zh-CN.md', 'docs/RELEASE.md'];
const current = findTestCountRefs(Object.fromEntries(docFiles.map((f) => [f, files[f] ?? ''])));
for (const ref of current) {
  console.log(`  [--] ${ref.file}:${ref.line}  ${ref.value}  (${ref.match})`);
}
if (current.length === 0) console.log(`  [--] no test-count reference found`);

/** Planned test-count rewrites, keyed by file. */
const countEdits = [];
if (opts.testCount !== null) {
  const fromCounts = new Set(current.map((r) => String(r.value)));
  if (!/^\d+$/.test(String(opts.testCount))) {
    console.log(`  [!!] --test-count expects an integer, got ${JSON.stringify(opts.testCount)}`);
    failed = true;
  } else if (current.length === 0) {
    console.log(`  [!!] --test-count was given but no test-count reference matched any rule`);
    failed = true;
  } else if (fromCounts.size > 1) {
    console.log(`  [!!] the documentation disagrees with itself (counts ${[...fromCounts].join(', ')});`);
    console.log(`       fix the documents first, then re-run the bump`);
    failed = true;
  } else {
    const source = [...fromCounts][0];
    for (const file of docFiles) {
      if (typeof files[file] !== 'string') continue;
      if (!TEST_COUNT_REF_RULES.some((r) => r.file === file)) continue;
      const edited = rewriteTestCounts(files[file], source, String(opts.testCount), file);
      countEdits.push({ file, ...edited });
      for (const hit of edited.hits) {
        console.log(`  [ok] ${file}:${hit.line}  ${oneLine(hit.before)} -> ${oneLine(hit.after)}`);
      }
      for (const missed of edited.unmatched) {
        console.log(`  [!!] ${file}: expected test-count literal not found: ${oneLine(missed)}`);
        console.log(`       fix the document, or update TEST_COUNT_REF_RULES in tools/release/release-core.mjs`);
        failed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\n[3/5] release notes`);
if (opts.countsOnly) {
  console.log(`  [--] skipped (--counts-only): the release notes for ${from} are already in place`);
}
const notes = resolveNotesPath(to, { exists: (rel) => existsSync(p(rel)) });
if (!opts.countsOnly) {
  if (notes.found) {
    const text = readFileSync(p(notes.path), 'utf8');
    console.log(`  [ok] ${notes.path} (${text.length} bytes, version-controlled)`);
  } else {
    console.log(`  [--] not written yet: ${notesCandidates(to).join(' or ')}`);
    console.log(`       the GitHub release body is read from that file; publish refuses without it`);
  }
}
let notesSource = null;
if (opts.notesFrom) {
  if (!existsSync(p(opts.notesFrom))) {
    console.log(`  [!!] --notes-from ${opts.notesFrom} does not exist`);
    failed = true;
  } else {
    notesSource = readFileSync(p(opts.notesFrom), 'utf8');
    console.log(`  [ok] seeding ${notes.path} from ${opts.notesFrom} (${notesSource.length} bytes)`);
  }
}

// ---------------------------------------------------------------------------
console.log(`\n[4/5] remaining mentions of ${from} after the rewrite (history sections are expected)`);
let residueCount = 0;
for (const edit of plan.edits) {
  for (const line of findVersionResidue(edit.text, from)) {
    residueCount += 1;
    console.log(`  [--] ${edit.file}:${line.line}  ${line.text.slice(0, 96)}`);
  }
}
if (opts.countsOnly) console.log(`  [--] skipped (--counts-only): no version reference was rewritten`);
else if (residueCount === 0) console.log(`  [ok] none`);

// ---------------------------------------------------------------------------
console.log(`\n[5/5] apply`);
if (!opts.write) {
  console.log(`  [--] dry run: nothing written. Re-run with --write to apply.`);
} else if (failed) {
  console.log(`  [!!] checks failed; refusing to write. Fix the problems above first.`);
} else {
  for (const edit of plan.edits) {
    if (edit.text !== files[edit.file]) {
      writeFileSync(p(edit.file), edit.text, 'utf8');
      console.log(`  [ok] wrote ${edit.file}`);
    }
  }
  for (const edit of countEdits) {
    if (edit.text !== files[edit.file]) {
      writeFileSync(p(edit.file), edit.text, 'utf8');
      console.log(`  [ok] wrote ${edit.file} (test counts)`);
    }
  }
  if (notesSource !== null) {
    writeFileSync(p(notes.path), notesSource, 'utf8');
    console.log(`  [ok] wrote ${notes.path}`);
  }
}

if (opts.countsOnly) {
  console.log(`
next step: commit the synchronised test counts.
  git add -A && git commit && git push`);
} else {
  console.log(`
next steps (a release must point at a pushed commit):
  ${notes.found || notesSource !== null ? 'notes ready' : `write ${notesCandidates(to)[0]}`}
  git add -A && git commit && git push
  pnpm package                    # build + audit + zip -> release/adblow-${to}-edge.zip
  pnpm release:github             # dry run: all checks, no write requests
  pnpm release:github --publish`);
}

process.exit(failed ? 1 : 0);

function oneLine(value) {
  return String(value).replace(/\s+/g, ' ').slice(0, 96);
}
