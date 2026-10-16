// Type declarations for tools/release/release-core.mjs, needed because
// tests/unit/releaseTooling.test.ts imports its functions: without them
// `pnpm typecheck` reports TS7016 even though the tests pass.

export type RefRule = { file: string; before: string; after: string };

export type RuleHit = { file: string; line: number; before: string; after: string };

export type RuleResult = { text: string; hits: RuleHit[]; unmatched: string[] };

export type BumpEdit = { file: string; text: string; hits: RuleHit[]; unmatched: string[] };

export type TestCountRef = { file: string; line: number; value: number; match: string };

export type VersionResidue = { line: number; text: string };

export type ProblemReport = { ok: boolean; problems: string[] };

export type SnapshotReport = ProblemReport & {
  ageDays: number | null;
  date: string | null;
  fileName: string | null;
};

export type Attachment = { role: string; path: string; name: string };

export declare const RELEASE_NOTES_DIR: string;
export declare const DEFAULT_SNAPSHOT_MAX_AGE_DAYS: number;
export declare const VERSION_FILES: string[];
export declare const DEFAULT_REPO: string;
export declare const VERSION_REF_RULES: RefRule[];
export declare const TEST_COUNT_REF_RULES: RefRule[];

export declare function isSemver(value: unknown): boolean;
export declare function compareSemver(a: string, b: string): number;
export declare function expectedTag(version: string): string;
export declare function normalizeTag(tag: string): string | null;
export declare function applyRules(text: string, rules: RefRule[]): RuleResult;
export declare function expandRules(rules: RefRule[], from: string, to: string): RefRule[];
export declare function rewriteVersionRefs(
  text: string,
  from: string,
  to: string,
  file: string,
): RuleResult;
export declare function rewriteTestCounts(
  text: string,
  from: string,
  to: string,
  file: string,
): RuleResult;
export declare function findTestCountRefs(files: Record<string, string>): TestCountRef[];
export declare function planVersionBump(input: {
  files: Record<string, string>;
  from: string;
  to: string;
}): { ok: boolean; problems: string[]; edits: BumpEdit[] };
export declare function findVersionResidue(text: string, version: string): VersionResidue[];
export declare function checkVersionTriple(input: {
  packageVersion: string;
  requestedVersion: string;
  tag: string;
  manifestVersion: string | null;
  manifestSource: string;
}): ProblemReport;
export declare function checkWorkspace(input: {
  porcelain?: string;
  head?: string | null;
  upstream?: string | null;
  remoteHead?: string | null;
  branch?: string | null;
}): ProblemReport;
export declare function snapshotDate(fetchedAt: unknown): string | null;
export declare function snapshotAgeDays(fetchedAt: unknown, now?: Date): number | null;
export declare function snapshotFileName(fetchedAt: unknown): string | null;
export declare function checkSnapshotFreshness(
  meta: unknown,
  options?: { now?: Date; maxAgeDays?: number },
): SnapshotReport;
export declare function notesCandidates(version: string): string[];
export declare function resolveNotesPath(
  version: string,
  options: { explicit?: string | null; exists: (path: string) => boolean },
): { path: string; found: boolean; candidates: string[]; explicit: boolean };
export declare function checkNotes(input: {
  text: string | null;
  version: string;
  path: string;
}): ProblemReport;
export declare function planAttachments(input: {
  packagePath: string;
  snapshotPath: string;
}): Attachment[];
export declare function selectUploads(
  planned: Attachment[],
  existingNames?: string[],
): { uploads: Attachment[]; skipped: Attachment[] };
export declare function parseCredentialOutput(text: string): {
  username: string | null;
  password: string | null;
};
export declare function describeToken(token: string | null | undefined): string;
export declare function repoFromRemoteUrl(url: string): string | null;
