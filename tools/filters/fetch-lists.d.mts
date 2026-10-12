/**
 * `tools/filters/fetch-lists.mjs` 的类型声明。
 *
 * 需要它是因为 `tests/unit/listSources.test.ts` 要导入这个抓取脚本的纯函数
 * 来做「来源只限无付费白名单者」的回归 —— 没有声明文件时 `pnpm typecheck`
 * 会报 TS7016（测试能跑，但类型检查不过）。
 */

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
