// Type declarations for tools/release/zip.mjs, needed because
// tests/unit/releaseZip.test.ts imports its functions: without them
// `pnpm typecheck` reports TS7016 even though the tests pass.

export type ZipEntryInput = {
  name: string;
  data: Buffer | string;
};

export type ZipEntry = {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export declare function crc32(buf: Buffer): number;
export declare function createZip(
  entries: ZipEntryInput[],
  options?: { date?: Date; level?: number },
): Buffer;
export declare function listZipEntries(buf: Buffer): ZipEntry[];
export declare function readZipEntry(buf: Buffer, name: string): Buffer | null;
export declare function readZipText(buf: Buffer, name: string, encoding?: BufferEncoding): string | null;
