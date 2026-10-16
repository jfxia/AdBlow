/**
 * GitHub release for AdBlow: create (or reuse) the release and attach the store
 * package plus a snapshot of the filter lists the package was built from.
 *
 * Why a repository tool instead of a one-off script: the release used to be assembled
 * by hand -- the store package, a snapshot zip named after the fetch date, the notes
 * pasted from a scratch file -- and every one of those steps had a way to go wrong
 * silently (wrong manifest version inside the zip, a snapshot older than the lists it
 * claims to contain, an attachment uploaded twice).
 *
 * Dry run by default: without `--publish` every check runs and the requests that WOULD
 * be sent are printed; no write request is ever made.
 *
 * Usage:
 *   node tools/release/github-release.mjs                          # dry run, current version
 *   node tools/release/github-release.mjs --version 1.0.1 --tag v1.0.1
 *   node tools/release/github-release.mjs --rehearse --offline      # checks without git/network
 *   node tools/release/github-release.mjs --publish                 # create the release
 *
 * Exit codes: 0 checks passed (or the release was published), 1 a check failed, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_REPO,
  DEFAULT_SNAPSHOT_MAX_AGE_DAYS,
  checkNotes,
  checkSnapshotFreshness,
  checkVersionTriple,
  checkWorkspace,
  describeToken,
  expectedTag,
  isSemver,
  parseCredentialOutput,
  planAttachments,
  repoFromRemoteUrl,
  resolveNotesPath,
  selectUploads,
} from './release-core.mjs';
import { createZip, readZipText } from './zip.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const p = (rel) => `${root}${rel}`;

const USAGE = `Usage: node tools/release/github-release.mjs [options]

Options:
  --version <x.y.z>   version to release (default: package.json)
  --tag <tag>         release tag, must match the version (default: v<version>)
  --notes <path>      release notes file (default: docs/release-notes/<version>.md)
  --zip <path>        store package (default: release/adblow-<version>-edge.zip)
  --snapshot <path>   filter-list snapshot zip (default: release/adblow-filter-lists-<date>.zip)
  --repo <owner/name> target repository (default: derived from git remote origin)
  --max-snapshot-age <days>  days a filter-list snapshot may be old (default: ${DEFAULT_SNAPSHOT_MAX_AGE_DAYS})
  --publish           actually create the release and upload the attachments
  --dry-run           the default; stated explicitly for readability
  --rehearse          dry run only: skip the "clean and pushed working tree" gate
                      (rejected together with --publish)
  --offline           make no network request at all (skips git ls-remote, the
                      GitHub API reads and the credential check; rejected with --publish)
  --help              show this text

Checks performed before anything is written:
  1 package.json version == requested version == tag == manifest.json INSIDE the zip
  2 the release notes file exists, is non-empty and names the version
  3 the filter-list snapshot is not older than --max-snapshot-age
  4 the working tree is clean and HEAD is on the remote
  5 credentials are available (GH_TOKEN, else git credential fill)
  6 the attachment plan, and which assets the release already has

Exit codes: 0 checks passed (or the release was published), 1 a check failed, 2 usage error.`;

/* ------------------------------------------------------------------ arguments */

function parseArgs(argv) {
  const opts = {
    version: null, tag: null, notes: null, zip: null, snapshot: null, repo: null,
    maxSnapshotAge: DEFAULT_SNAPSHOT_MAX_AGE_DAYS,
    publish: false, rehearse: false, offline: false, help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} expects a value`);
      return v;
    };
    if (arg === '--version') opts.version = value();
    else if (arg === '--tag') opts.tag = value();
    else if (arg === '--notes') opts.notes = value();
    else if (arg === '--zip') opts.zip = value();
    else if (arg === '--snapshot') opts.snapshot = value();
    else if (arg === '--repo') opts.repo = value();
    else if (arg === '--max-snapshot-age') opts.maxSnapshotAge = Number(value());
    else if (arg === '--publish') opts.publish = true;
    else if (arg === '--dry-run') opts.publish = false;
    else if (arg === '--rehearse') opts.rehearse = true;
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`[!!] ${e.message}\n\n${USAGE}`);
  process.exit(2);
}

if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!Number.isFinite(opts.maxSnapshotAge) || opts.maxSnapshotAge < 0) {
  console.error(`[!!] --max-snapshot-age expects a number of days\n\n${USAGE}`);
  process.exit(2);
}
if (opts.publish && opts.rehearse) {
  console.error(
    '[!!] --rehearse only exists for dry runs. Publishing always requires a clean, ' +
      'pushed working tree, so the two flags cannot be combined.\n',
  );
  process.exit(2);
}
if (opts.publish && opts.offline) {
  console.error('[!!] --publish needs the network; --offline cannot be combined with it.\n');
  process.exit(2);
}

/* -------------------------------------------------------------- process helpers */

/**
 * Run git and return its stdout.
 *
 * Capture uses a pipe, which some process sandboxes forbid (EPERM on Windows); that
 * is reported as a failed check rather than swallowed, because an unverified working
 * tree must never be treated as a clean one.
 */
function runGit(argv, { input } = {}) {
  try {
    const out = execFileSync('git', argv, {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    const message = e && e.message ? String(e.message).split(/\r?\n/)[0] : 'unknown error';
    return { ok: false, error: code ? `${code} (${message})` : message };
  }
}

/** `GH_TOKEN`, else the credential helper stored under git:https://github.com. */
function loadToken() {
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, source: 'GH_TOKEN' };
  const r = runGit(['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' });
  if (!r.ok) {
    return {
      token: null,
      error:
        `git credential fill failed: ${r.error}. Set GH_TOKEN for this session ` +
        `(PowerShell: $env:GH_TOKEN = '<token>'), or check the git:https://github.com credential`,
    };
  }
  const { password, username } = parseCredentialOutput(r.out);
  if (!password) {
    return {
      token: null,
      error:
        'git credential fill returned no password for https://github.com — ' +
        'store one with: git credential approve (input: protocol=https, host=github.com)',
    };
  }
  return { token: password, source: `git credential fill (user ${username ?? 'unknown'})` };
}

/* ------------------------------------------------------------------- arguments */

const pkg = JSON.parse(readFileSync(p('package.json'), 'utf8'));
const requestedVersion = opts.version ?? pkg.version;
const tag = opts.tag ?? expectedTag(requestedVersion);
const zipPath = opts.zip ?? `release/adblow-${requestedVersion}-edge.zip`;

const remoteUrl = runGit(['remote', 'get-url', 'origin']);
const repo = opts.repo ?? (remoteUrl.ok ? repoFromRemoteUrl(remoteUrl.out) : null) ?? DEFAULT_REPO;

console.log(`AdBlow GitHub release`);
console.log(`  version     ${requestedVersion}`);
console.log(`  tag         ${tag}`);
console.log(`  repository  ${repo}${opts.repo ? ' (--repo)' : remoteUrl.ok ? ' (git remote origin)' : ' (built-in fallback)'}`);
console.log(`  mode        ${opts.publish ? 'PUBLISH (writes to GitHub)' : 'DRY RUN (no write request is made)'}`);
console.log(`  offline     ${opts.offline ? 'yes — no network request at all' : 'no'}`);
console.log(`  notes       ${opts.notes ?? `${requestedVersion} under docs/release-notes/`}\n`);

const failures = [];
const noteFailures = (report) => {
  for (const problem of report.problems) failures.push(problem);
};

/* -------------------------------------------------- 1 version consistency */
console.log('[1/6] version consistency');

let manifestVersion = null;
let zipMissing = false;
if (existsSync(p(zipPath))) {
  try {
    const manifestText = readZipText(readFileSync(p(zipPath)), 'manifest.json');
    manifestVersion = manifestText ? JSON.parse(manifestText).version ?? null : null;
  } catch (e) {
    console.log(`  [!!] cannot read ${zipPath}: ${e.message}`);
    manifestVersion = null;
  }
} else {
  zipMissing = true;
}

const triple = checkVersionTriple({
  packageVersion: pkg.version,
  requestedVersion,
  tag,
  manifestVersion,
  manifestSource: zipPath,
});
let versionProblems = triple.problems;
if (zipMissing) {
  versionProblems = versionProblems.filter((m) => !m.startsWith('manifest.json could not be read'));
  versionProblems.unshift(`the store package does not exist: ${zipPath} — build it: pnpm package`);
}
noteFailures({ problems: versionProblems });

console.log(`  [${isSemver(pkg.version) ? 'ok' : '!!'}] package.json version ${pkg.version}`);
if (!zipMissing && manifestVersion !== null) {
  console.log(`  [ok] manifest.json inside ${zipPath} -> ${manifestVersion} (read from the archive, not the build log)`);
} else if (!zipMissing) {
  console.log(`  [!!] ${zipPath} contains no manifest.json`);
}
for (const problem of versionProblems) console.log(`  [!!] ${problem}`);

/* ------------------------------------------------------------- 2 release notes */
console.log('\n[2/6] release notes');
const notes = resolveNotesPath(requestedVersion, {
  explicit: opts.notes,
  exists: (rel) => existsSync(p(rel)),
});
const notesText = notes.found ? readFileSync(p(notes.path), 'utf8') : null;
const notesReport = checkNotes({ text: notesText, version: requestedVersion, path: notes.path });
noteFailures(notesReport);
if (notesReport.ok) {
  console.log(`  [ok] ${notes.path} (${notesText.trim().length} bytes)`);
} else if (!notes.found && !notes.explicit) {
  console.log(`  [!!] not found; looked for: ${notes.candidates.join(', ')}`);
}
for (const problem of notesReport.problems) console.log(`  [!!] ${problem}`);

/* ---------------------------------------------------------- 3 list snapshot */
console.log('\n[3/6] filter-list snapshot');
const metaRel = 'filters/meta.json';
let meta = null;
if (existsSync(p(metaRel))) {
  try {
    meta = JSON.parse(readFileSync(p(metaRel), 'utf8'));
  } catch (e) {
    console.log(`  [!!] ${metaRel} is not valid JSON: ${e.message}`);
  }
}
const snapReport = checkSnapshotFreshness(meta, { maxAgeDays: opts.maxSnapshotAge });
noteFailures(snapReport);

let listFiles = [];
if (existsSync(p('filters'))) {
  listFiles = readdirSync(p('filters')).filter((f) => f.endsWith('.txt')).sort();
}
if (listFiles.length === 0) {
  const problem = 'no filter list under filters/ — fetch them first: pnpm filters';
  failures.push(problem);
  console.log(`  [!!] ${problem}`);
}
if (snapReport.ageDays !== null && snapReport.ageDays >= 0) {
  console.log(
    `  [${snapReport.ok ? 'ok' : '!!'}] ${metaRel} fetchedAt ${meta?.fetchedAt} ` +
      `(${snapReport.ageDays} days old, limit ${opts.maxSnapshotAge})`,
  );
}
if (listFiles.length > 0) {
  console.log(`  [ok] ${listFiles.length} lists + meta.json would go into the snapshot`);
}
const snapshotPath = opts.snapshot ?? `release/${snapReport.fileName ?? `adblow-filter-lists-${requestedVersion}.zip`}`;
console.log(`  [${snapReport.ok ? 'ok' : '!!'}] snapshot ${snapshotPath}`);
for (const problem of snapReport.problems) console.log(`  [!!] ${problem}`);

/* ----------------------------------------------------------- 4 git workspace */
console.log('\n[4/6] git workspace');
const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
const head = runGit(['rev-parse', 'HEAD']);
const upstream = runGit(['rev-parse', '@{upstream}']);
const status = runGit(['status', '--porcelain']);
const branchName = branch.ok ? branch.out.trim() : 'master';

let workspace;
let remoteHead = null;
if (opts.rehearse) {
  workspace = { ok: true, problems: [], skipped: true };
} else if (!status.ok || !head.ok) {
  const detail = (!status.ok && status.error) || (!head.ok && head.error) || 'unknown error';
  workspace = {
    ok: false,
    problems: [
      `cannot run git (${detail}) — the working tree cannot be verified, and a release must ` +
        'point at a clean, pushed commit. Run this from a normal terminal, or use --rehearse ' +
        'for a dry run that skips this gate.',
    ],
  };
} else {
  if (!opts.offline) {
    const lsRemote = runGit(['ls-remote', 'origin', `refs/heads/${branchName}`]);
    if (lsRemote.ok) {
      const line = lsRemote.out.trim().split(/\r?\n/).filter(Boolean)[0] ?? '';
      remoteHead = line.split(/\s+/)[0] || null;
      if (!remoteHead) console.log(`  [--] origin/${branchName} not found on the remote yet`);
    } else {
      console.log(`  [--] remote check skipped, git ls-remote failed: ${lsRemote.error}`);
    }
  }
  workspace = checkWorkspace({
    porcelain: status.out,
    head: head.out.trim(),
    upstream: upstream.ok ? upstream.out.trim() : null,
    remoteHead,
    branch: branchName,
  });
}

if (opts.rehearse) {
  console.log('  [--] SKIPPED (--rehearse): the working tree was NOT verified — rehearsal only, never for a real release');
} else if (workspace.ok) {
  console.log(`  [ok] git status --porcelain is empty`);
  console.log(
    `  [ok] HEAD ${head.out.trim().slice(0, 8)} == upstream ${upstream.out.trim().slice(0, 8)}` +
      (remoteHead ? ` == origin/${branchName}` : ' (remote not checked)'),
  );
} else {
  noteFailures(workspace);
  console.log(`  [!!] the release gate refused the working tree`);
  for (const problem of workspace.problems) console.log(`  [!!] ${problem}`);
}

/* ------------------------------------------------------------ 5 credentials */
console.log('\n[5/6] credentials');
let token = null;
let tokenSource = null;
if (opts.offline) {
  console.log('  [--] not checked (--offline): no request will be made, so no credential is needed');
} else {
  const cred = loadToken();
  if (cred.token) {
    token = cred.token;
    tokenSource = cred.source;
    console.log(`  [ok] token from ${tokenSource} — value never printed (${describeToken(token)})`);
  } else {
    failures.push(cred.error);
    console.log(`  [!!] no credential: ${cred.error}`);
  }
}

/* ------------------------------------------------------------ 6 attachments */
console.log('\n[6/6] attachments');
const planned = planAttachments({ packagePath: zipPath, snapshotPath });

if (existsSync(p(zipPath))) {
  console.log(`  [ok] ${zipPath} (${formatSize(statSync(p(zipPath)).size)})`);
} else {
  console.log(`  [!!] ${zipPath} is missing`);
}
console.log(
  `  [${existsSync(p(snapshotPath)) ? 'ok' : '--'}] ${snapshotPath} ` +
    `(${existsSync(p(snapshotPath)) ? formatSize(statSync(p(snapshotPath)).size) : `will be built from ${listFiles.length} lists + meta.json`})`,
);

let existing = null;
let remoteStateError = null;
if (token && !opts.offline) {
  try {
    const res = await api(`/repos/${repo}/releases/tags/${tag}`, 'GET', token);
    if (res.status === 200) existing = await res.json();
    else if (res.status === 404) existing = null;
    else remoteStateError = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`;
  } catch (e) {
    remoteStateError = e.message;
  }
}

const existingNames = (existing?.assets ?? []).map((a) => a.name);
const { uploads, skipped } = selectUploads(planned, existingNames);
if (existing) {
  console.log(`  [ok] release ${tag} already exists (id ${existing.id}) — reusing it, ${skipped.length} asset(s) present`);
} else if (remoteStateError) {
  console.log(`  [--] release state unknown (${remoteStateError}); assuming it does not exist`);
} else if (token) {
  console.log(`  [--] release ${tag} does not exist yet — it would be created`);
} else {
  console.log(`  [--] release state not checked`);
}
for (const asset of uploads) console.log(`  [--] would upload ${asset.name} (${asset.role})`);
for (const asset of skipped) console.log(`  [ok] already present, skipped: ${asset.name}`);

/* --------------------------------------------------------------- the outcome */
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed — nothing was sent. Fix the items marked [!!] above.`);
  process.exitCode = 1;
} else if (!opts.publish) {
  printPlan();
} else {
  await publishRelease();
}

/** The requests `--publish` would send, printed instead of sent. */
function printPlan() {
  console.log(`\nDRY RUN — no write request was made. The following requests would be sent to ${repo}:`);
  if (!existing) {
    console.log(`  POST https://api.github.com/repos/${repo}/releases`);
    console.log(`       tag_name ${tag}, target_commitish ${branchName}, name AdBlow ${requestedVersion}`);
    console.log(`       body: ${notesText.trim().length} bytes from ${notes.path}`);
  }
  if (uploads.length === 0) {
    console.log('  (all attachments are already present — nothing to upload)');
  } else if (existing) {
    for (const asset of uploads) {
      console.log(`  POST https://uploads.github.com/repos/${repo}/releases/${existing.id}/assets?name=${asset.name}`);
    }
  } else {
    for (const asset of uploads) {
      console.log(`  POST https://uploads.github.com/repos/${repo}/releases/<created id>/assets?name=${asset.name}`);
    }
  }
  console.log('\nRe-run with --publish to perform these requests.');
}

/**
 * Create (or reuse) the release and upload the attachments it does not have yet.
 *
 * Why `process.exitCode` instead of `process.exit()`: on Windows, exiting while undici
 * is still closing a keep-alive socket trips a libuv assertion
 * (`async.c ... UV_HANDLE_CLOSING`, exit code 0xC0000409), which would turn a clean
 * "nothing to do" exit into a crash the moment the GitHub API has been contacted.
 */
async function publishRelease() {
  console.log(`\nPUBLISHING to ${repo} ...`);

  // the snapshot is derived from the lists in filters/, so build it right before uploading
  const snapshotInputs = [
    ...listFiles.map((f) => ({ name: f, data: readFileSync(p(`filters/${f}`)) })),
    { name: 'meta.json', data: readFileSync(p(metaRel)) },
  ];
  const snapshotBytes = createZip(snapshotInputs);
  writeFileSync(p(snapshotPath), snapshotBytes);
  console.log(`  [ok] built ${snapshotPath} (${formatSize(snapshotBytes.length)})`);

  let release = existing;
  if (!release) {
    const created = await api(`/repos/${repo}/releases`, 'POST', token, {
      tag_name: tag,
      name: `AdBlow ${requestedVersion}`,
      body: notesText.trimEnd(),
      target_commitish: branchName,
      draft: false,
      prerelease: false,
    });
    if (created.status !== 201) {
      console.error(`  [!!] creating the release failed: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`);
      process.exitCode = 1;
      return;
    }
    release = await created.json();
    console.log(`  [ok] created release ${tag} (id ${release.id})`);
  } else {
    console.log(`  [ok] reusing release ${tag} (id ${release.id})`);
  }

  for (const asset of uploads) {
    const bytes = readFileSync(p(asset.path));
    const res = await fetch(
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/zip',
          'content-length': String(bytes.length),
          'user-agent': 'adblow-release-tool',
        },
        body: bytes,
      },
    );
    if (res.status !== 201) {
      console.error(`  [!!] uploading ${asset.name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`  [ok] uploaded ${asset.name} (${formatSize(bytes.length)})`);
  }

  console.log(`\nRelease page: ${release.html_url}`);
}

/** GitHub REST helper; in dry-run mode only GET is ever used. */
async function api(path, method, bearer, body) {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'adblow-release-tool',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
