/**
 * Injection + content guard for filter-list cosmetic selectors.
 *
 * List selectors come from community lists covering tens of thousands of
 * domains, unlike site-pack selectors (per-site evidence + fixture tests) that go
 * straight into a stylesheet. The content guard is the only safety-critical part,
 * hence its own module with `document` injected so jsdom can exercise it.
 *
 * Two kinds of selectors must be dropped:
 *   1. ones hiding real content — invariant: no rule from any source may hide an
 *      element that holds content; list rules are broad by nature
 *   2. invalid ones — one invalid selector makes the browser discard the whole
 *      stylesheet (1466 were already filtered at build time; runtime still needs
 *      the fallback)
 */

export const LIST_COSMETIC_ATTR = 'data-adblow-list-cosmetic';

import { looksLikeValidSelector } from '../engine/filterList/cosmetic.ts';

export type ListCosmeticResult = {
  /** Selectors actually injected. */
  injected: number;
  /** Dropped: would have hidden real content. */
  droppedForContent: string[];
  /** Dropped: invalid selector. */
  droppedInvalid: string[];
};

/** Inject the surviving selectors as one stylesheet; report what the guard dropped. */
export function applyListCosmetic(
  doc: Document,
  selectors: string[],
  holdsContent: (el: Element) => boolean,
): ListCosmeticResult {
  const droppedForContent: string[] = [];
  const droppedInvalid: string[] = [];

  if (selectors.length === 0) {
    return { injected: 0, droppedForContent, droppedInvalid };
  }

  const safe = selectors.filter((sel) => {
    // Cheap syntax pre-filter: parsers differ in leniency (measured: jsdom does
    // not throw on `div{class:red}`), so try/catch alone cannot be trusted.
    if (!looksLikeValidSelector(sel)) {
      droppedInvalid.push(sel);
      return false;
    }

    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(sel));
    } catch {
      // An invalid selector takes the whole stylesheet down with it.
      droppedInvalid.push(sel);
      return false;
    }
    for (const el of matches) {
      if (holdsContent(el)) {
        droppedForContent.push(sel);
        return false;
      }
    }
    return true;
  });

  let style = doc.querySelector(`style[${LIST_COSMETIC_ATTR}]`) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.setAttribute(LIST_COSMETIC_ATTR, '');
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = safe.map((s) => `${s}{display:none!important;}`).join('');

  return {
    injected: safe.length,
    droppedForContent,
    droppedInvalid,
  };
}
