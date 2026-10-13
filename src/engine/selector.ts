/**
 * Selector generalization: turn a one-off node fingerprint into a reusable rule
 * for the learning store.
 *
 * Preference order (earlier is more stable): semantic `data-ssp-*` attributes,
 * then stable class names (build hashes like css-1x9f2kd dropped), then id prefix
 * with sequence numbers stripped.
 */

const HASHY = /^(?:css-|jsx-|sc-|[a-z]?\d[0-9a-f]{5,})/i;

const SEMANTIC_ATTRS = [
  'data-ssp-slot-root',
  'data-ssp-sdk-popup-overlay',
  'data-ssp-sdk-fullscreen',
  'data-ssp-marquee',
  'data-ssp-slot-node',
  'data-ssp-container',
  'data-ssp-landing',
];

const SAFE_IDENT = /^[A-Za-z_][\w-]*$/;

/** Does not rely on CSS.escape (jsdom does not reliably provide it). */
function escapeIdent(ident: string): string {
  if (SAFE_IDENT.test(ident)) return ident;
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS?.escape === 'function') return g.CSS.escape(ident);
  return ident.replace(/[^\w-]/g, (c) => `\\${c}`);
}

export function generalizeSelector(el: Element): string | null {
  for (const attr of SEMANTIC_ATTRS) {
    if (el.hasAttribute(attr)) return `[${attr}]`;
  }

  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith('data-ssp-')) return `[${a.name}]`;
  }

  const classes = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => c && !HASHY.test(c));
  const stable =
    classes.find((c) => /(?:^|[-_])(?:ssp|ad|ads|advert|banner|float|popup|sponsor)/i.test(c)) ??
    classes[0];
  if (stable) return `.${escapeIdent(stable)}`;

  const id = el.getAttribute('id');
  if (id) {
    // Strip trailing digits only, keeping the separator: `ssp-card-3` → `[id^="ssp-card-"]`.
    // Keeping '-' is more precise than `[id^="ssp-card"]`, which would also match ssp-cardinal.
    const prefix = id.replace(/\d+$/, '');
    if (prefix && prefix !== id) return `[id^="${escapeIdent(prefix)}"]`;
    return `#${escapeIdent(id)}`;
  }

  // ⚠️ With nothing stable left, return null — **never a bare tag name**. Learned
  // rules enter the static ruleset, where a match hides with no judgement, so
  // returning "a" would write "hide every link" and apply it unconditionally on
  // later visits. Hide this one element instead.
  return null;
}

/**
 * Selector-width check: the second false-positive gate before a rule is stored.
 * The generalizer blocks bare tag names, but "a class name that is everywhere" is
 * still dangerous, so the match count is measured and too-wide selectors dropped.
 */
export function isSelectorSafe(
  selector: string,
  root: ParentNode,
  maxMatches = 30,
): boolean {
  if (!selector || selector.length < 2) return false;
  try {
    return root.querySelectorAll(selector).length <= maxMatches;
  } catch {
    return false;
  }
}
