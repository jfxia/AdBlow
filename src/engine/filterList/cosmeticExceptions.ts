/**
 * Element-hiding rules taken from filter lists that are known to be wrong.
 *
 * A list rule carries no page context: `finance.sina.com.cn##.m-s-tab + div` was written for a
 * page where the block after the tab bar is an ad slot, but on the stock quote page the same
 * sibling is the 投资研报 / 大V观点 panel, so the rule hides editorial content. Sibling combinators
 * (`+`, `~`) depend on page structure and are the usual source of this class of false positive
 * (measured 2026-10-29: 3035 such rules across the six lists).
 *
 * Entries are matched on the exact host and the exact selector, so a list fixing the selector upstream
 * simply stops matching. Every entry needs a reason, because the next reader has to be able to judge it.
 */
export type CosmeticException = { host: string; selector: string; reason: string };

export const COSMETIC_EXCEPTIONS: readonly CosmeticException[] = [
  {
    host: 'finance.sina.com.cn',
    selector: '.m-s-tab + div',
    reason:
      'Hides the panel after the tab bar, which on realstock/company pages is the editorial ' +
      '(投资研报 / 大V观点) panel, not an ad slot.',
  },
];

/** True when a list's hiding rule is on the exception table. */
export function isCosmeticException(host: string, selector: string): boolean {
  const h = host.trim().toLowerCase();
  const s = selector.trim();
  return COSMETIC_EXCEPTIONS.some((entry) => entry.host === h && entry.selector === s);
}

/** True when a whole list line (host##selector) is on the exception table. */
export function isCosmeticExceptionRaw(raw: string): boolean {
  const line = raw.trim();
  return COSMETIC_EXCEPTIONS.some((entry) => line === `${entry.host}##${entry.selector}`);
}
