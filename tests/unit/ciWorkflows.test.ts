import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Structural checks on the CI wiring, kept at the contract level on purpose.
 *
 * What the YAML does cannot be executed here -- GitHub Actions is the only interpreter -- so
 * these tests are the local stand-in. They therefore assert only what the workflow wiring
 * must guarantee: the triggers, the permissions, who calls whom, and that the required steps
 * exist in an order that matters. They deliberately do NOT assert command lines verbatim:
 * an earlier round pinned the broken `pnpm <script> -- <args>` spelling into a test, and the
 * test then defended the bug against its own fix. Two failures that only a real run exposed
 * are guarded here as negative rules instead: the `runner` context in a job-level `env`
 * block (GitHub rejects the whole file) and the `--` separator (pnpm passes it through to the
 * script, which sees it as an unknown option).
 */

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

const CHECKS_PATH = '.github/workflows/checks.yml';
const CI_PATH = '.github/workflows/ci.yml';
const AUTO_PATH = '.github/workflows/auto-release.yml';

const checksWf = read(CHECKS_PATH);
const ciWf = read(CI_PATH);
const autoWf = read(AUTO_PATH);
const acceptance = read('tools/e2e/acceptance.mjs');

const WORKFLOWS: [string, string][] = [
  [CHECKS_PATH, checksWf],
  [CI_PATH, ciWf],
  [AUTO_PATH, autoWf],
];

/** One top-level job of a workflow, from `  <id>:` to the next top-level key. */
function jobBlock(text: string, jobId: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  assert.ok(start > -1, `no job named ${jobId}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^ {2}\S/.test(line) && !/^ {2}#/.test(line)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** A workflow body without whole-line comments, so a step check only sees real steps. */
const withoutComments = (text: string) =>
  text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

/** The effective (comment-free) body of every job-level `env:` block. */
function jobLevelEnvBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^ {4}env:\s*$/.test(lines[i]!)) continue;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && /^ {6,}\S/.test(lines[j]!); j += 1) {
      // Comments are skipped: the explanation of this very pitfall names the runner context.
      if (/^\s*#/.test(lines[j]!)) continue;
      body.push(lines[j]!);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('the reusable checks workflow', () => {
  it('is callable and nothing else: it has no trigger of its own', () => {
    assert.match(checksWf, /^on:\n {2}workflow_call:\s*$/m);
    assert.equal(/^ {2}(push|pull_request|schedule|workflow_dispatch):/m.test(checksWf), false);
    // Reusable workflows can only narrow what the caller granted.
    assert.match(checksWf, /permissions:\n {2}contents: read/);
  });

  it('builds, tests, packages and audits the package on Linux', () => {
    const build = withoutComments(jobBlock(checksWf, 'build'));
    assert.match(build, /runs-on: ubuntu-latest/);
    const steps = [
      'pnpm install --frozen-lockfile',
      'pnpm typecheck',
      'node tests/run-all.ts',
      'pnpm filters --force',
      'pnpm rulesets',
      'pnpm build',
      'pnpm package',
      'tools/release/verify-package.mjs',
    ];
    let previous = -1;
    for (const step of steps) {
      const at = build.indexOf(step);
      assert.ok(at > -1, `the build job never runs: ${step}`);
      assert.ok(at > previous, `the build job runs ${step} out of order`);
      previous = at;
    }
  });

  it('audits the package with its own tool and hands the extension to the next job', () => {
    const build = jobBlock(checksWf, 'build');
    // The audit runs the checked-in tool and does not reuse package.mjs's own audit.
    assert.match(build, /node tools\/release\/verify-package\.mjs/);
    assert.match(build, /uses: actions\/upload-artifact@v4/);
    assert.match(build, /name: adblow-dist/);
  });

  it('runs the 24-category acceptance suite in a real Edge on Windows, after the build', () => {
    const job = jobBlock(checksWf, 'acceptance');
    assert.match(job, /needs: build/);
    assert.match(job, /runs-on: windows-latest/);
    assert.match(job, /tools\/e2e\/acceptance\.mjs/);
    // Reviewers expect the strongest suite to be a gate, so the pass count is required and
    // the suite must be told where the browser is rather than hard-coding one path.
    assert.match(job, /--min-pass \d+/);
    assert.match(job, /ADBLOW_BROWSER:/);
    assert.match(acceptance, /process\.env\.ADBLOW_BROWSER/);
    const timeout = /timeout-minutes:\s*(\d+)/.exec(job);
    assert.ok(timeout, 'the acceptance job has no timeout');
    assert.ok(Number(timeout[1]) >= 20, `the acceptance job times out after ${timeout[1]} minutes`);
  });

  it('collects the browser logs when the acceptance suite fails', () => {
    const job = jobBlock(checksWf, 'acceptance');
    assert.match(job, /uses: actions\/upload-artifact@v4/);
    assert.match(job, /if: failure\(\)/);
    assert.match(job, /_probe\/e2e\/\*\.log/);
    assert.match(job, /if-no-files-found: ignore/);
  });
});

describe('the push and pull-request workflow', () => {
  it('runs on every push and pull request', () => {
    assert.match(ciWf, /^on:\n {2}push:\s*\n {2}pull_request:\s*$/m);
  });

  it('only calls the shared definition instead of defining steps of its own', () => {
    assert.match(ciWf, /uses: \.\/\.github\/workflows\/checks\.yml/);
    assert.equal(/\brun:/.test(ciWf), false, 'ci.yml must not define a single step');
    assert.match(ciWf, /permissions:\n {2}contents: read/);
  });

  it('cancels a superseded run of the same ref', () => {
    assert.match(ciWf, /concurrency:[\s\S]{0,400}?group: ci-[\s\S]{0,400}?cancel-in-progress: true/);
  });
});

describe('the release workflow', () => {
  const releaseJob = withoutComments(jobBlock(autoWf, 'auto-release'));

  it('calls the same gate, and only starts the release after it passed', () => {
    assert.match(jobBlock(autoWf, 'checks'), /uses: \.\/\.github\/workflows\/checks\.yml/);
    assert.match(releaseJob, /needs: checks/);
    // The install, typecheck and test steps moved into the shared workflow.
    assert.equal(/run: pnpm typecheck/.test(autoWf), false);
    assert.equal(/run: node tests\/run-all\.ts/.test(autoWf), false);
  });

  it('still fetches the lists itself, because the fingerprint is computed from that fetch', () => {
    assert.match(releaseJob, /pnpm filters --force/);
    assert.match(releaseJob, /pnpm rulesets/);
  });

  it('keeps the order the publish tool depends on', () => {
    const steps = [
      'pnpm filters --force',
      'pnpm rulesets',
      'pnpm release:auto',
      'pnpm package',
      'git push origin',
      'pnpm release:github --publish',
    ];
    let previous = -1;
    for (const step of steps) {
      const at = releaseJob.indexOf(step);
      assert.ok(at > -1, `the release job never runs: ${step}`);
      assert.ok(at > previous, `the release job runs ${step} out of order`);
      previous = at;
    }
  });

  it('keeps the schedule, the report-only default and the serialised concurrency', () => {
    assert.match(autoWf, /schedule:/);
    assert.match(autoWf, /- cron: '\S+ \S+ \* \* \d'/);
    assert.match(autoWf, /workflow_dispatch:/);
    assert.match(autoWf, /publish:[\s\S]{0,200}?default: false/);
    assert.match(autoWf, /permissions:\n {2}contents: write/);
    assert.match(autoWf, /concurrency:[\s\S]{0,400}?group: \S+[\s\S]{0,400}?cancel-in-progress: false/);
  });
});

describe('the workflow pitfalls that a local run cannot catch', () => {
  it('never puts the runner context in a job-level env block', () => {
    // GitHub rejects the entire file with "Unrecognized named-value: 'runner'"; the runner
    // context exists only inside steps. `github.workspace` is the job-level substitute.
    for (const [path, text] of WORKFLOWS) {
      for (const block of jobLevelEnvBlocks(text)) {
        assert.equal(
          /runner\./.test(block),
          false,
          `${path} uses the runner context in a job-level env block:\n${block}`,
        );
      }
    }
    assert.match(autoWf, /github\.workspace/);
  });

  it('never passes the -- separator to a pnpm script', () => {
    // pnpm forwards `--` verbatim, so the script receives it and fails on an unknown
    // option. npm would swallow it, which is why the mistake reads as harmless.
    for (const [path, text] of WORKFLOWS) {
      assert.equal(
        /\bpnpm\s+\S+\s+--\s/.test(text),
        false,
        `${path} passes the -- separator to pnpm`,
      );
    }
  });

  it('uses no credential other than the built-in token', () => {
    for (const [path, text] of WORKFLOWS) {
      const secrets = [...text.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
      assert.deepEqual(secrets, path === AUTO_PATH ? ['GITHUB_TOKEN'] : [], `${path} references another secret`);
    }
    // The release is the only job that talks back to GitHub, and it uses the token the run
    // already has: nothing to configure, nothing to expire.
    assert.match(autoWf, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  });
});
