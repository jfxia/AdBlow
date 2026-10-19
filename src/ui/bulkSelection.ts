/**
 * Selection bookkeeping for the rule manager's bulk actions.
 *
 * Kept free of DOM and chrome.*: the page owns the checkboxes, this owns "what is selected" and
 * the two questions the page asks about it (how many sites, is this whole section selected).
 * The rule manager is the only screen a user has for revoking learned rules, so a wrong answer
 * here means deleting something the user did not pick.
 */

/** The two rule kinds the page lists, in the order they are rendered. */
export type PickKind = 'selector' | 'domain';

/** One selectable rule. `rule` is the selector text, or the ad domain for domain rules. */
export type PickRef = { kind: PickKind; host: string; rule: string };

/** Selection state, keyed by {@link pickKey}. */
export type PickMap = Map<string, PickRef>;

/**
 * Stable key for one rule. Deliberately not parsed back: the `|` separator only has to make
 * distinct triples distinct, and `kind` is a closed set of two values that cannot contain it.
 */
export function pickKey(ref: PickRef): string {
  return `${ref.kind}|${ref.host}|${ref.rule}`;
}

/** Key for the section a rule belongs to: one site's rules of one kind. */
export function siteKey(ref: PickRef): string {
  return `${ref.kind}|${ref.host}`;
}

/** Add or remove a rule; returns the new checked state. */
export function togglePick(picked: PickMap, ref: PickRef, on?: boolean): boolean {
  const key = pickKey(ref);
  const next = on ?? !picked.has(key);
  if (next) picked.set(key, ref);
  else picked.delete(key);
  return next;
}

/** Selected rules grouped by section key, preserving selection order. */
export function groupBySite(picked: PickMap): Map<string, PickRef[]> {
  const groups = new Map<string, PickRef[]>();
  for (const ref of picked.values()) {
    const key = siteKey(ref);
    const bucket = groups.get(key);
    if (bucket) bucket.push(ref);
    else groups.set(key, [ref]);
  }
  return groups;
}

/** How many distinct sites (kind + host) the selection spans. */
export function countSites(picked: PickMap): number {
  return new Set([...picked.values()].map(siteKey)).size;
}

/**
 * Does the selection cover a whole section?
 *
 * Used to choose between one bulk write (`clearSite` / `clearDomains`) and per-rule deletes:
 * selecting every rule of a site is the same operation the section's own "clear" button performs.
 */
export function isWholeSite(picked: PickMap, sectionKeys: readonly string[]): boolean {
  return sectionKeys.length > 0 && sectionKeys.every((key) => picked.has(key));
}
