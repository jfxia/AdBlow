// Type declarations for tools/release/verify-package.mjs, needed because
// tests/unit/verifyPackage.test.ts imports its functions: without them
// `pnpm typecheck` reports TS7016 even though the tests pass.

export type VerifyPackageOptions = {
  zip: string | null;
  root: string | null;
  help: boolean;
};

export type PackageCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type PackageAudit = {
  checks: PackageCheck[];
  problems: string[];
  manifest: Record<string, unknown> | null;
  entryCount: number;
};

export type VerifyPackageIo = {
  log?: (line: string) => void;
  error?: (line: string) => void;
};

export declare const USAGE: string;

export declare function parseArgs(argv: string[]): VerifyPackageOptions;

export declare function declaredFiles(manifest: Record<string, unknown>): string[];

export declare function auditPackage(
  buf: Buffer,
  context?: { packageVersion?: string | null; zipName?: string | null },
): PackageAudit;

export declare function runVerifyPackage(argv: string[], io?: VerifyPackageIo): number;
