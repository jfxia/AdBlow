import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip } from '../../tools/release/zip.mjs';
import {
  auditPackage,
  declaredFiles,
  parseArgs,
  runVerifyPackage,
} from '../../tools/release/verify-package.mjs';

/**
 * The unpack audit exists because the packaging audit can be wrong in a way the build log
 * never shows: it once removed `list-info.json` -- read by the rule manager, invisible to a
 * manifest/HTML scan -- from the shipped zip while the development build still showed it.
 * So the tests below break one thing at a time in an otherwise complete archive and require
 * the audit to notice, which is the only property that makes a second audit worth having.
 */

const VERSION = '1.0.2';

type Entry = { name: string; data: Buffer | string };

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: 'AdBlow',
    version: VERSION,
    description: 'ad blocker',
    default_locale: 'en',
    icons: { 16: 'icons/icon-16.png', 128: 'icons/icon-128.png' },
    action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon-16.png' } },
    options_page: 'options.html',
    background: { service_worker: 'background.js' },
    content_scripts: [{ js: ['content.js'], css: ['cosmetic.css'] }],
    declarative_net_request: {
      rule_resources: [{ id: 'list-1', enabled: true, path: 'rulesets/list-1.json' }],
    },
    ...overrides,
  };
}

/** PNG magic bytes plus filler, so a "real file" is distinguishable from an empty one. */
function png(length = 16): Buffer {
  const out = Buffer.alloc(length, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(out);
  return out;
}

/**
 * A package that passes every check, so each test can break exactly one thing.
 *
 * `remove` deletes an entry, `replace` swaps an entry's content, `extra` adds a foreign one.
 */
function makePackage(
  opts: {
    remove?: string[];
    replace?: Record<string, string>;
    extra?: Entry[];
    manifestOverrides?: Record<string, unknown>;
  } = {},
): Entry[] {
  const base: Entry[] = [
    { name: 'manifest.json', data: JSON.stringify(manifest(opts.manifestOverrides)) },
    { name: 'background.js', data: 'console.log(1)\n' },
    { name: 'content.js', data: 'console.log(1)\n' },
    { name: 'cosmetic.css', data: 'a{display:none}\n' },
    { name: 'popup.html', data: '<html><body></body></html>' },
    { name: 'popup.js', data: 'void 0\n' },
    { name: 'options.html', data: '<html><body></body></html>' },
    { name: 'options.js', data: 'void 0\n' },
    { name: 'rulesets/list-1.json', data: '[]\n' },
    { name: 'icons/icon-16.png', data: png() },
    { name: 'icons/icon-128.png', data: png(32) },
    { name: '_locales/en/messages.json', data: '{"extName":{"message":"AdBlow"}}' },
    {
      name: 'list-info.json',
      data: JSON.stringify({
        builtAt: '2026-10-16T08:56:40.016Z',
        listsFetchedAt: '2026-10-16T04:03:13.544Z',
        lists: ['easylist', 'easyprivacy'],
      }),
    },
    {
      name: 'badware-domains.json',
      data: JSON.stringify({ generatedFrom: 'ublock-badware', domains: ['a.com'] }),
    },
    {
      name: 'popup-domains.json',
      data: JSON.stringify({ generatedFrom: 'popup-rules', domains: ['ads.example'] }),
    },
  ];

  return [...base, ...(opts.extra ?? [])]
    .filter((e) => !(opts.remove ?? []).includes(e.name))
    .map((e) => (opts.replace && e.name in opts.replace ? { name: e.name, data: opts.replace[e.name]! } : e));
}

/** Audit a package built in memory, under its real file name. */
function audit(entries: Entry[] = makePackage(), zipName: string | null = `adblow-${VERSION}-edge.zip`) {
  return auditPackage(createZip(entries), { packageVersion: VERSION, zipName });
}

const problemsOf = (entries: Entry[], zipName: string | null = `adblow-${VERSION}-edge.zip`) =>
  audit(entries, zipName).problems.join('\n');

describe('the package audit accepts a complete archive', () => {
  it('reports no problem when every file the extension loads is inside the zip', () => {
    const result = audit();
    assert.deepEqual(result.problems, []);
    assert.ok(result.checks.length >= 10, 'the audit should run more than a handful of checks');
    assert.equal(result.checks.every((c) => c.ok), true);
    assert.equal(result.entryCount, makePackage().length);
    assert.equal(result.manifest?.version, VERSION);
  });

  it('passes on the real release archive when one is on disk', (t) => {
    // The strongest form of this test: not a fixture but the zip that would be uploaded.
    // release/ is gitignored build output, so the test skips when it is absent.
    const root = new URL('../../', import.meta.url);
    const version = (JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { version: string })
      .version;
    const name = `adblow-${version}-edge.zip`;
    let buf: Buffer;
    try {
      buf = readFileSync(new URL(`release/${name}`, root));
    } catch {
      t.skip('release/ has no archive for the current version (run pnpm package)');
      return;
    }
    const result = auditPackage(buf, { packageVersion: version, zipName: name });
    assert.deepEqual(result.problems, []);
  });
});

describe('the package audit rejects a broken archive', () => {
  it('rejects a manifest version that differs from package.json', () => {
    const problems = problemsOf(makePackage({ manifestOverrides: { version: '1.0.1' } }));
    assert.match(problems, /manifest version matches package\.json/);
  });

  it('rejects a package that lost a file the manifest declares', () => {
    const problems = problemsOf(makePackage({ remove: ['content.js'] }));
    assert.match(problems, /every file the manifest declares is in the archive/);
    assert.match(problems, /content\.js/);
  });

  it('rejects a package without the locale catalogs', () => {
    const problems = problemsOf(makePackage({ remove: ['_locales/en/messages.json'] }));
    assert.match(problems, /_locales\/ is in the archive/);
    assert.match(problems, /default locale catalog is in the archive/);
  });

  it('rejects a package whose default locale has no catalog of its own', () => {
    const problems = problemsOf(
      makePackage({
        remove: ['_locales/en/messages.json'],
        extra: [{ name: '_locales/zh_CN/messages.json', data: '{}' }],
      }),
    );
    assert.match(problems, /default locale catalog is in the archive/);
  });

  it('rejects a package without icons', () => {
    const problems = problemsOf(
      makePackage({
        remove: ['icons/icon-16.png', 'icons/icon-128.png'],
        manifestOverrides: { icons: undefined },
      }),
    );
    assert.match(problems, /icons\/ is in the archive/);
    assert.match(problems, /icon/);
  });

  it('rejects an icon that is present but empty', () => {
    const problems = problemsOf(
      makePackage({
        remove: ['icons/icon-16.png'],
        manifestOverrides: { icons: { 16: 'icons/icon-16.png' }, action: { default_icon: {} } },
        extra: [{ name: 'icons/icon-16.png', data: '' }],
      }),
    );
    assert.match(problems, /declared icons are non-empty files/);
  });

  it('rejects a package that lost list-info.json (the file the build log never missed)', () => {
    const problems = problemsOf(makePackage({ remove: ['list-info.json'] }));
    assert.match(problems, /list-info\.json is in the archive/);
  });

  it('rejects a package that lost badware-domains.json (read via chrome.runtime.getURL)', () => {
    const problems = problemsOf(makePackage({ remove: ['badware-domains.json'] }));
    assert.match(problems, /badware-domains\.json is in the archive/);
  });

  it('rejects a badware-domains.json without a domains array', () => {
    const problems = problemsOf(
      makePackage({ replace: { 'badware-domains.json': JSON.stringify({ generatedFrom: 'x' }) } }),
    );
    assert.match(problems, /badware-domains\.json has a domains array/);
  });

  it('rejects a package that lost popup-domains.json (read via chrome.runtime.getURL)', () => {
    const problems = problemsOf(makePackage({ remove: ['popup-domains.json'] }));
    assert.match(problems, /popup-domains\.json is in the archive/);
  });

  it('rejects a popup-domains.json without a domains array', () => {
    const problems = problemsOf(
      makePackage({ replace: { 'popup-domains.json': JSON.stringify({ generatedFrom: 'x' }) } }),
    );
    assert.match(problems, /popup-domains\.json has a domains array/);
  });

  it('rejects a list-info.json that names no list at all', () => {
    const problems = problemsOf(
      makePackage({ replace: { 'list-info.json': JSON.stringify({ builtAt: 'x', lists: [] }) } }),
    );
    assert.match(problems, /list-info\.json names the bundled lists/);
  });

  it('rejects a manifest that is not valid JSON', () => {
    const problems = problemsOf(makePackage({ replace: { 'manifest.json': '{"version": ' } }));
    assert.match(problems, /manifest\.json is valid JSON/);
  });

  it('rejects a package without manifest.json at the root', () => {
    const problems = problemsOf(makePackage({ remove: ['manifest.json'] }));
    assert.match(problems, /manifest\.json is at the archive root/);
  });

  it('rejects a manifest that is missing a required field', () => {
    const problems = problemsOf(makePackage({ manifestOverrides: { default_locale: undefined } }));
    assert.match(problems, /manifest declares the required fields/);
    assert.match(problems, /default_locale/);
  });

  it('rejects the browser leftovers the packaging audit exists to drop', () => {
    const problems = problemsOf(
      makePackage({
        extra: [{ name: '_metadata/generated_indexed_rulesets/ruleset.json', data: '{}' }],
      }),
    );
    assert.match(problems, /no browser leftovers/);
    assert.match(problems, /_metadata\//);
  });

  it('rejects a file name that states another version than the manifest', () => {
    const problems = problemsOf(makePackage(), 'adblow-1.0.1-edge.zip');
    assert.match(problems, /file name version matches the manifest version/);
  });

  it('reports a buffer that is not an archive instead of throwing', () => {
    const result = auditPackage(Buffer.from('this is not a zip file'), { packageVersion: VERSION });
    assert.equal(result.checks[0]?.ok, false);
    assert.match(result.problems.join('\n'), /archive is readable/);
    assert.equal(result.manifest, null);
  });
});

describe('the manifest file list', () => {
  it('collects every declared resource once, sorted', () => {
    const files = declaredFiles(manifest());
    assert.deepEqual(files, [
      'background.js',
      'content.js',
      'cosmetic.css',
      'icons/icon-128.png',
      'icons/icon-16.png',
      'manifest.json',
      'options.html',
      'popup.html',
      'rulesets/list-1.json',
    ]);
  });

  it('survives a manifest that declares almost nothing', () => {
    // A manifest with no icons and no rule resources must not make the audit throw.
    assert.deepEqual(declaredFiles({ manifest_version: 3 }), ['manifest.json']);
  });
});

describe('the unpack-audit command line', () => {
  it('reads the options, and refuses an unknown one or a missing value', () => {
    assert.deepEqual(parseArgs(['--zip', 'a.zip', '--root', 'tmp']), {
      zip: 'a.zip',
      root: 'tmp',
      help: false,
    });
    assert.throws(() => parseArgs(['--publish']), /unknown option: --publish/);
    assert.throws(() => parseArgs(['--zip']), /expects a value/);
  });

  /** A throwaway checkout holding package.json and, optionally, a release archive. */
  function makeCheckout(entries: Entry[] | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'adblow-verify-package-'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'adblow', version: VERSION })}\n`, 'utf8');
    if (entries) {
      mkdirSync(join(dir, 'release'), { recursive: true });
      writeFileSync(join(dir, 'release', `adblow-${VERSION}-edge.zip`), createZip(entries));
    }
    return dir;
  }

  function run(dir: string, argv: string[] = []) {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = runVerifyPackage(['--root', dir, ...argv], {
      log: (line) => lines.push(line),
      error: (line) => errors.push(line),
    });
    return { code, out: lines.join('\n'), errors: errors.join('\n') };
  }

  it('prints the usage and succeeds on --help, without touching an archive', () => {
    const lines: string[] = [];
    const code = runVerifyPackage(['--help'], { log: (line) => lines.push(line), error: () => {} });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Usage: node tools\/release\/verify-package\.mjs/);
    assert.match(lines.join('\n'), /--zip/);
  });

  it('returns the usage exit code for an unknown option', () => {
    const dir = makeCheckout(makePackage());
    try {
      assert.equal(run(dir, ['--publish']).code, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the archive of the current version and prints one line per check', () => {
    const dir = makeCheckout(makePackage());
    try {
      const result = run(dir);
      assert.equal(result.code, 0);
      assert.match(result.out, /\[ok\] archive is readable/);
      assert.match(result.out, /list-info\.json is in the archive/);
      assert.match(result.out, /checks passed/);
      assert.equal(result.errors, '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with the build command when the archive was never produced', () => {
    const dir = makeCheckout(null);
    try {
      const result = run(dir);
      assert.equal(result.code, 1);
      assert.match(result.errors, /does not exist/);
      assert.match(result.errors, /pnpm package/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on a package that lost list-info.json and names the failed check', () => {
    const dir = makeCheckout(makePackage({ remove: ['list-info.json'] }));
    try {
      const result = run(dir);
      assert.equal(result.code, 1);
      assert.match(result.out, /\[!!\] list-info\.json is in the archive/);
      assert.match(result.errors, /checks failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('audits an archive given by --zip instead of the default name', () => {
    const dir = makeCheckout(null);
    try {
      mkdirSync(join(dir, 'release'), { recursive: true });
      writeFileSync(join(dir, 'release', 'custom.zip'), createZip(makePackage()));
      const result = run(dir, ['--zip', join(dir, 'release', 'custom.zip')]);
      assert.equal(result.code, 0);
      assert.match(result.out, /custom\.zip/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when package.json carries no version to look for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adblow-verify-package-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"adblow"}\n', 'utf8');
      const result = run(dir);
      assert.equal(result.code, 1);
      assert.match(result.errors, /has no version/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
