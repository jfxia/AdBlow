/**
 * Ordering for the rule manager (`options.html`).
 *
 * Why this exists: the page used to render entries in whatever order the storage layer
 * returned them, which reads as random as soon as a site has a few dozen learned rules.
 * The fixed order is: sites alphabetically by host, and within a site alphabetically by rule
 * (the selector for hiding rules, the host for learned ad domains).
 *
 * Comparison is deliberately plain rather than `localeCompare`: the result must be identical
 * in every browser locale and in tests, and rule text is selectors and domain names (ASCII
 * apart from the occasional IDN, where a codepoint order is both stable and predictable).
 * It is case-insensitive with a codepoint tiebreak so that `Ad.example` and `ad.example`
 * cannot swap places between renders.
 */

/** Case-insensitive comparison; ties fall back to codepoints so the order is total. */
export function compareRuleText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** New array, sorted by the host of each item. */
export function sortByHost<T>(items: readonly T[], hostOf: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareRuleText(hostOf(x), hostOf(y)));
}

/** New array, sorted by the rule text of each item. */
export function sortByRule<T>(items: readonly T[], ruleOf: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareRuleText(ruleOf(x), ruleOf(y)));
}
