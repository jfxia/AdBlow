/**
 * MAIN world entry of the scriptlet engine (Rollup emits it as `scriptlets-engine.js`).
 *
 * Engine and data are separate: this file is declared `<all_urls>` in the manifest and only
 * implements and dispatches, while the build-generated `scriptlets/bundle-N.js` contains the
 * rule table for one group of domains and is declared for those domains — so the browser
 * injects it only where it is relevant.
 *
 * Why: scriptlets must finish at `document_start`, before page scripts. Asking the service
 * worker for data from the content script would race the page (SW messages are async);
 * manifest-driven injection does not race. uBlock Origin Lite uses the same mechanism.
 */
import { domainKeysForHost } from '../engine/filterList/cosmetic.ts';
import { runScriptlets, type Invocation } from './scriptlets.ts';

export type ScriptletTable = Record<string, Invocation[]>;

/** Decode one entry body (`nameIndex \x01 args… \x02 …`). */
export function decodeEntry(names: string[], body: string): Invocation[] {
  const invocations: Invocation[] = [];
  for (const raw of body.split('\x02')) {
    if (!raw) continue;
    const parts = raw.split('\x01');
    const canonical = names[Number(parts[0])];
    if (!canonical) continue;
    invocations.push({ canonical, args: parts.slice(1) });
  }
  return invocations;
}

/** Full decode (for tests and readability; runtime uses runPacked's lazy path). */
export function decodePacked(namesJoined: string, data: string): Map<string, Invocation[]> {
  const map = new Map<string, Invocation[]>();
  if (!data) return map;
  const names = namesJoined ? namesJoined.split('\x01') : [];
  for (const entry of data.split('\x04')) {
    if (!entry) continue;
    const sep = entry.indexOf('\x03');
    if (sep < 0) continue;
    const invocations = decodeEntry(names, entry.slice(sep + 1));
    if (invocations.length) map.set(entry.slice(0, sep), invocations);
  }
  return map;
}

/**
 * Pure lookup: pick the invocations for a host from the packed table, without executing
 * anything.
 *
 * Split out to stay testable — execution needs `window`, and the lookup logic (especially
 * the boundary-character guard against false hits) is the most error-prone part of this
 * encoding.
 */
export function selectPacked(namesJoined: string, data: string, host: string): Invocation[] {
  const names = namesJoined ? namesJoined.split('\x01') : [];
  const invocations: Invocation[] = [];

  for (const key of domainKeysForHost(host)) {
    const start = data.indexOf(`\x04${key}\x03`);
    if (start < 0) continue;
    const bodyStart = start + key.length + 2;
    const end = data.indexOf('\x04', bodyStart);
    invocations.push(
      ...decodeEntry(names, data.slice(bodyStart, end < 0 ? data.length : end)),
    );
  }

  return invocations;
}

/**
 * Look up the invocations for a host in the packed table and run them; returns how many ran.
 *
 * Lazy lookup rather than building a Map first: the table is 277 KB, so decoding it fully on
 * every page (and every iframe) would create 2,800+ strings and objects — on an ad-heavy page
 * with a dozen iframes that turns "one stall at extension load" into "a stall on every page",
 * only moving the problem.
 *
 * Instead native `indexOf` locates the host with boundary characters (tens of microseconds)
 * and only a hit gets decoded. The `\x04` prefix and `\x03` suffix keep `a.com` from matching
 * `b.a.com`.
 */
export function runPacked(namesJoined: string, data: string, host: string): number {
  return execute(selectPacked(namesJoined, data, host));
}

/** Look up and run the invocations for a host from an object table. */
export function runTable(table: ScriptletTable, host: string): number {
  const invocations: Invocation[] = [];
  for (const key of domainKeysForHost(host)) {
    const list = table[key];
    if (!list) continue;
    for (const inv of list) invocations.push(inv);
  }
  return execute(invocations);
}

function execute(invocations: Invocation[]): number {
  if (invocations.length === 0) return 0;

  const result = runScriptlets(invocations, window as unknown as Record<string, unknown>);
  try {
    console.debug(
      `[adblow] 脚本注入：执行 ${result.applied.length}/${invocations.length}` +
        (result.failed.length
          ? `，失败 ${result.failed.length}（${result.failed
              .slice(0, 3)
              .map((f) => `${f.canonical}:${f.error}`)
              .join(' | ')}）`
          : ''),
    );
  } catch {
    /* stay silent even when console is unavailable */
  }
  return result.applied.length;
}

// Consumed by the build-generated bundle files.
(window as unknown as Record<string, unknown>).__adblowScriptlets = {
  run: runTable,
  runPacked,
};
