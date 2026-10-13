// Type declarations for tools/filters/fetch-lists.mjs, needed because
// tests/unit/listSources.test.ts imports its pure functions: without them
// `pnpm typecheck` reports TS7016 even though the tests pass.

export type ListSource = {
  id: string;
  url: string;
  license?: string;
  licenseUrl?: string;
  note?: string;
};

export type ListStats = {
  total: number;
  comments: number;
  empty: number;
  network: number;
  exceptions: number;
  cosmetic: number;
  extended: number;
  scriptlets: number;
  html: number;
};

export declare const LIST_SOURCES: ListSource[];
export declare const FORBIDDEN_SOURCE_PATTERNS: string[];
export declare const FORBIDDEN_HEADER_MARKERS: string[];

export declare function checkNoPaidWhitelist(sources?: ListSource[]): string[];
export declare function scanTextForPaidWhitelist(text: string): string[];
export declare function summarizeList(text: string): ListStats;
