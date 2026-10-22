/**
 * Per-site record of refused popup windows — **observation only**.
 *
 * The new window.open policy denies by default, which is correct for drive-by popunders but can
 * break a site that opens a cross-site window from script (an OAuth button, a "share" button).
 * A silent refusal is impossible to diagnose, so every block leaves a record: how many, when,
 * and which host the page tried to open. The rule manager shows it, and the per-site "allow
 * popups" switch is the fix.
 *
 * Separate from clickWatch.ts on purpose: that one records navigations after a plain-area click,
 * this one records refused `window.open` calls. Merging them would make the counts mean two
 * different things.
 *
 * Pure module: no chrome.*, no DOM.
 */

export const POPUP_BLOCK_PREFIX = 'popupblock:';

/** Storage key for a site's popup-block record. */
export function popupBlockKey(host: string): string {
  return `${POPUP_BLOCK_PREFIX}${host}`;
}

export type PopupBlockRecord = {
  /** Site whose page called window.open (the tab's top-level host). */
  host: string;
  count: number;
  firstAt: number;
  lastAt: number;
  /** Host the page most recently tried to open. */
  lastTargetHost: string;
};

/**
 * Fold one blocked attempt into a site's record.
 *
 * Defensive about the stored value: storage can hold an older or partially written shape, and a
 * record is not worth an exception on the messaging path.
 */
export function mergePopupBlockRecord(
  existing: PopupBlockRecord | null | undefined,
  host: string,
  targetHost: string,
  at: number,
): PopupBlockRecord {
  if (!existing || typeof existing.count !== 'number' || existing.count < 0) {
    return {
      host,
      count: 1,
      firstAt: at,
      lastAt: at,
      lastTargetHost: targetHost,
    };
  }
  return {
    host: existing.host || host,
    count: existing.count + 1,
    firstAt: existing.firstAt || at,
    lastAt: at,
    lastTargetHost: targetHost,
  };
}
