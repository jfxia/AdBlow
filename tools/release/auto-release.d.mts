// Type declarations for tools/release/auto-release.mjs, needed because
// tests/unit/autoRelease.test.ts imports its functions: without them
// `pnpm typecheck` reports TS7016 even though the tests pass.

export type AutoReleaseOptions = {
  write: boolean;
  decisionFile: string | null;
  baseline: string | null;
  root: string | null;
  filtersDir: string | null;
  report: string | null;
  help: boolean;
};

export type AutoReleaseIo = {
  log?: (line: string) => void;
  error?: (line: string) => void;
};

export declare const USAGE: string;

export declare function parseArgs(argv: string[]): AutoReleaseOptions;

export declare function runAutoRelease(argv: string[], io?: AutoReleaseIo): number;
