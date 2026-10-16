/**
 * Zero-dependency ZIP container: writer and reader, shared by the release tooling.
 *
 * Why hand-written: this repository takes no dependency on archiver/jszip, the store
 * package must contain exactly the files the audit selected, in a stable order, and
 * external `zip` / `Compress-Archive` are not guaranteed to be present.
 * Why the writer moved here: the filter-list snapshot attached to every GitHub release
 * is a second ZIP, so one implementation beats two copies of the same sixty lines
 * (it was previously inlined in tools/release/package.mjs).
 * Why a reader exists as well: the release check must open the package about to be
 * published and read `manifest.json` from inside it, rather than trusting the build log.
 *
 * Format per PKWARE APPNOTE.TXT: local file header, central directory, EOCD.
 * The reader tolerates data descriptors (general-purpose flag bit 3) because the sizes
 * in the central directory are authoritative, and it inflates method 0 (store) and
 * method 8 (deflate). ZIP64 is rejected explicitly rather than mis-parsed.
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_SENTINEL = 0xffffffff;

/** Standard CRC-32 table (polynomial 0xedb88320), built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** @param {Buffer} buf @returns {number} unsigned CRC-32 of the whole buffer */
export function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** MS-DOS time/date, as ZIP stores them (2-second resolution, 1980 epoch). */
function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Build a ZIP archive in memory.
 *
 * @param {{ name: string, data: Buffer | string }[]} entries archive paths, `/` separated
 * @param {{ date?: Date, level?: number }} [options] timestamp stored in both headers
 * @returns {Buffer} the complete archive
 */
export function createZip(entries, options = {}) {
  const { date = new Date(), level = 9 } = options;
  const { time: dosTime, day: dosDate } = dosDateTime(date);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const compressed = deflateRawSync(data, { level });
    // fall back to store (method 0) when deflate grows the data, per spec
    const useDeflate = compressed.length < data.length;
    const body = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const nameBuf = Buffer.from(entry.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // flags: UTF-8 filename
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra len
    localParts.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(0x031e, 4);      // version made by (UNIX-ish)
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);          // extra
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(0, 36);          // internal attrs
    // external attrs: -rw-r--r--  (`<<` is signed 32-bit in JS, so `>>> 0` is needed)
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

/** Locate the end-of-central-directory record, scanning back over any archive comment. */
function findEocd(buf) {
  if (buf.length < 22) return -1;
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * List the central-directory records of an archive.
 *
 * @param {Buffer} buf
 * @returns {{ name: string, method: number, crc32: number, compressedSize: number,
 *   uncompressedSize: number, localHeaderOffset: number }[]}
 */
export function listZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('not a ZIP archive: end-of-central-directory record not found');

  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralOffset === ZIP64_SENTINEL) throw new Error('ZIP64 archives are not supported');

  const entries = [];
  let off = centralOffset;
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_SIG) {
      throw new Error(`corrupt central directory at entry ${i}`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compressedSize = buf.readUInt32LE(off + 20);
    const uncompressedSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    if (compressedSize === ZIP64_SENTINEL || localHeaderOffset === ZIP64_SENTINEL) {
      throw new Error(`ZIP64 entry is not supported: ${String(i)}`);
    }
    const name = buf
      .subarray(off + 46, off + 46 + nameLen)
      .toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, method, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Extract one entry by its exact archive path.
 *
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer | null} null when the archive has no such entry
 */
export function readZipEntry(buf, name) {
  const entry = listZipEntries(buf).find((e) => e.name === name);
  if (!entry) return null;

  const lo = entry.localHeaderOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOCAL_SIG) {
    throw new Error(`corrupt local header for ${name}`);
  }
  // local header name/extra lengths may differ from the central directory's copies
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const body = buf.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return Buffer.from(body);
  if (entry.method === 8) return inflateRawSync(body);
  throw new Error(`unsupported compression method ${entry.method} for ${name}`);
}

/** Extract one entry and decode it as text; null when absent. */
export function readZipText(buf, name, encoding = 'utf8') {
  const data = readZipEntry(buf, name);
  return data === null ? null : data.toString(encoding);
}
