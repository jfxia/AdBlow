import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  createZip,
  crc32,
  listZipEntries,
  readZipEntry,
  readZipText,
} from '../../tools/release/zip.mjs';

/**
 * The ZIP container is shared by the store package and the filter-list snapshot, and
 * the release gate reads `manifest.json` back out of the package it is about to
 * publish. Both directions therefore need to hold: a writer that loses a byte and a
 * reader that trusts the local header would each pass a broken package.
 */

const root = new URL('../../', import.meta.url);

/** Deterministic incompressible bytes (a plain LCG), to exercise the store path. */
function noise(length: number): Buffer {
  const out = Buffer.alloc(length);
  let state = 12345;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

describe('zip writer and reader', () => {
  it('computes the standard CRC-32 check value', () => {
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  });

  it('round-trips entries with their names, order and content', () => {
    const icon = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const zip = createZip([
      { name: 'manifest.json', data: '{"version":"1.0.2"}' },
      { name: 'icons/icon-16.png', data: icon },
    ]);

    assert.deepEqual(
      listZipEntries(zip).map((e) => e.name),
      ['manifest.json', 'icons/icon-16.png'],
    );
    assert.equal(readZipText(zip, 'manifest.json'), '{"version":"1.0.2"}');
    assert.deepEqual(readZipEntry(zip, 'icons/icon-16.png'), icon);
  });

  it('deflates compressible data and stores incompressible data', () => {
    const text = 'a'.repeat(4096);
    const random = noise(4096);
    const zip = createZip([
      { name: 'text.txt', data: text },
      { name: 'noise.bin', data: random },
    ]);

    const methods = new Map(listZipEntries(zip).map((e) => [e.name, e.method]));
    assert.equal(methods.get('text.txt'), 8, 'highly compressible content should use deflate');
    assert.equal(methods.get('noise.bin'), 0, 'deflate that grows the data should fall back to store');
    assert.equal(readZipText(zip, 'text.txt'), text);
    assert.deepEqual(readZipEntry(zip, 'noise.bin'), random);
  });

  it('keeps non-ASCII names and content intact', () => {
    const zip = createZip([{ name: 'docs/naïve-tëst.txt', data: 'café — naïve\n' }]);
    assert.deepEqual(
      listZipEntries(zip).map((e) => e.name),
      ['docs/naïve-tëst.txt'],
    );
    assert.equal(readZipText(zip, 'docs/naïve-tëst.txt'), 'café — naïve\n');
  });

  it('returns null for an entry the archive does not have', () => {
    const zip = createZip([{ name: 'manifest.json', data: '{}' }]);
    assert.equal(readZipEntry(zip, 'missing.json'), null);
    assert.equal(readZipText(zip, 'missing.json'), null);
  });

  it('rejects a buffer that is not a ZIP archive', () => {
    assert.throws(() => listZipEntries(Buffer.from('this is not a zip file at all')), /not a ZIP archive/);
  });

  it('rejects an archive with a corrupt central directory', () => {
    const zip = createZip([{ name: 'manifest.json', data: '{}' }]);
    const eocd = zip.length - 22; // the writer never adds an archive comment
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
    const centralOffset = zip.readUInt32LE(eocd + 16);

    const corrupt = Buffer.from(zip);
    corrupt.writeUInt32LE(0, centralOffset);
    assert.throws(() => readZipEntry(corrupt, 'manifest.json'), /corrupt central directory/);
  });

  it('writes sizes both in the local header and in the central directory', () => {
    const zip = createZip([{ name: 'a.txt', data: 'hello' }]);
    const [entry] = listZipEntries(zip);
    assert.ok(entry);
    const localNameLength = zip.readUInt16LE(entry.localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(entry.localHeaderOffset + 28);
    assert.equal(zip.readUInt32LE(entry.localHeaderOffset + 18), entry.compressedSize);
    assert.equal(zip.readUInt32LE(entry.localHeaderOffset + 22), entry.uncompressedSize);
    assert.equal(localNameLength, 'a.txt'.length);
    assert.equal(localExtraLength, 0);
  });

  it('reads the snapshot the Python tooling wrote, when it is on disk', (t) => {
    // Cross-implementation check: release/adblow-filter-lists-*.zip is written by
    // Python's zipfile (see docs/RELEASE.md), which adds an extra field to every local
    // header. It is build output and gitignored, so the test skips when it is absent.
    let names: string[];
    try {
      names = readdirSync(new URL('release/', root));
    } catch {
      t.skip('release/ is not present (gitignored build output)');
      return;
    }
    const snapshot = names.find((n) => /^adblow-filter-lists-\d{4}-\d{2}-\d{2}\.zip$/.test(n));
    if (!snapshot) {
      t.skip('no filter-list snapshot in release/');
      return;
    }

    const zip = readFileSync(new URL(`release/${snapshot}`, root));
    const entries = listZipEntries(zip);
    assert.ok(entries.length > 1, 'the snapshot should hold the lists plus meta.json');
    assert.deepEqual(
      entries.map((e) => e.name).filter((n) => !n.endsWith('.txt')),
      ['meta.json'],
    );

    const meta = JSON.parse(readZipText(zip, 'meta.json') ?? '{}') as { fetchedAt?: string };
    assert.match(meta.fetchedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });
});
