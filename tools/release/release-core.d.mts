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

export type FingerprintCounts = Record<string, number>;

export type Fingerprint = {
  schema: number;
  lists: Record<string, string>;
  counts: FingerprintCounts;
  digest: string;
};

export type FingerprintChange = {
  kind: string;
  key: string;
  from: string | number | null;
  to: string | number | null;
};

export type AutoReleaseDecision = {
  decision: string;
  reason: string;
  problems: string[];
  changes: FingerprintChange[];
};

export declare const RELEASE_NOTES_DIR: string;
export declare const DEFAULT_SNAPSHOT_MAX_AGE_DAYS: number;
export declare const VERSION_FILES: string[];
export declare const DEFAULT_REPO: string;
export declare const VERSION_REF_RULES: RefRule[];
export declare const TEST_COUNT_REF_RULES: RefRule[];
export declare const BASELINE_PATH: string;
export declare const FINGERPRINT_SCHEMA: number;
export declare const FINGERPRINT_COUNT_FIELDS: string[];
export declare const AUTO_RELEASE_DECISIONS: string[];

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

export declare function hashText(text: unknown): string;
export declare function normalizeListText(text: unknown): string;
export declare function hashListText(text: unknown): string;
export declare function shortHash(hash: unknown): string;
export declare function sortedRecord<T>(input: Record<string, T> | null | undefined): Record<string, T>;
export declare function digestOf(input: {
  schema: number;
  lists: Record<string, string>;
  counts: FingerprintCounts;
}): string;
export declare function projectCounts(report: unknown): { counts: FingerprintCounts; missing: string[] };
export declare function buildFingerprint(input: {
  lists: { name: string; text: string }[];
  report: unknown;
  schema?: number;
}): { fingerprint: Fingerprint | null; problems: string[] };
export declare function diffFingerprints(
  from: { lists?: Record<string, string>; counts?: FingerprintCounts } | null | undefined,
  to: { lists?: Record<string, string>; counts?: FingerprintCounts } | null | undefined,
): FingerprintChange[];
export declare function decideAutoRelease(input: {
  baseline: unknown;
  current: Fingerprint | null;
}): AutoReleaseDecision;
export declare function nextPatchVersion(version: string): string | null;
export declare function describeFingerprintChange(change: FingerprintChange | null | undefined): string;
export declare function buildAutoReleaseNotes(input: {
  version: string;
  fingerprint: Fingerprint | null;
  changes?: FingerprintChange[];
  fetchedAt?: string | null;
  date?: string | null;
}): string;
export declare function decisionReport(input: {
  decision: AutoReleaseDecision;
  currentVersion: string;
  nextVersion?: string | null;
  baselinePath: string;
  wrote?: string[];
  recordedAt: string;
}): Record<string, unknown>;
