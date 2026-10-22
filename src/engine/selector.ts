/**
 * Selector generalization: turn a one-off node fingerprint into a reusable rule
 * for the learning store.
 *
 * Preference order (earlier is more stable): semantic `data-ssp-*` attributes,
 * then stable class names (build hashes like css-1x9f2kd dropped), then id prefix
 * with sequence numbers stripped.
 */
import { forbiddenSelectorReason } from './rules.ts';

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

// ── Manual picker fallback ───────────────────────────────────────────────────
//
// The picker must always produce a usable rule, but it may not resurrect the danger the
// generalizer exists to prevent: a bare tag name ("hide every link"). When generalization
// yields nothing safe, fall back to the most specific thing the element itself offers:
// its id, a tag+class pair, or a positional path. The last one always carries
// `:nth-of-type()`, so it can never be a bare tag.

/** Hiding one of these blanks the page, so a picker click on them is not a valid target. */
const UNPICKABLE_TAGS = new Set(['HTML', 'BODY', 'HEAD']);

/** Deepest ancestor chain the positional fallback walks before giving up. */
const MAX_PATH_DEPTH = 8;

function matchesElement(selector: string, root: ParentNode, el: Element): boolean {
  try {
    return Array.from(root.querySelectorAll(selector)).includes(el);
  } catch {
    return false;
  }
}

/** 1-based index among same-tag siblings, i.e. the `n` of `:nth-of-type(n)`. */
function nthOfType(el: Element): number {
  const parent = el.parentElement;
  if (!parent) return 1;
  let index = 0;
  for (const child of Array.from(parent.children)) {
    if (child.tagName === el.tagName) index += 1;
    if (child === el) return index;
  }
  return 1;
}

/**
 * Conservative selector for manual picks, used only when `generalizeSelector` produced
 * null or an unsafe selector. Ordering: `#id`, then `tag.class`, then a positional path of
 * `tag:nth-of-type(n)` segments. The path requires exactly one match so a pick never
 * silently hides sibling blocks.
 */
export function conservativeSelector(
  el: Element,
  root: ParentNode,
  maxMatches = 30,
): string | null {
  if (UNPICKABLE_TAGS.has(el.tagName)) return null;
  const tag = el.tagName.toLowerCase();

  // A candidate is usable only when it clears both existing gates. The forbidden check
  // matters here too: `.post-card` is a stable class name, yet a rule that hides every
  // article card must never be produced *or* accepted from the editable field.
  const usable = (candidate: string): boolean =>
    forbiddenSelectorReason(candidate) === null &&
    isSelectorSafe(candidate, root, maxMatches) &&
    matchesElement(candidate, root, el);

  const id = el.getAttribute('id');
  if (id) {
    const candidate = `#${escapeIdent(id)}`;
    if (usable(candidate)) return candidate;
  }

  // Keep only class names that need no escaping, do not look like build hashes, and are not
  // banned as a bare class: `div.post-card` is just as dangerous as `.post-card`.
  const classes = (el.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter(
      (c) =>
        c &&
        SAFE_IDENT.test(c) &&
        !HASHY.test(c) &&
        forbiddenSelectorReason(`.${c}`) === null,
    );
  for (const name of classes.slice(0, 3)) {
    const candidate = `${tag}.${name}`;
    if (usable(candidate)) return candidate;
  }
  if (classes.length >= 2) {
    const candidate = `${tag}.${classes[0]}.${classes[1]}`;
    if (usable(candidate)) return candidate;
  }

  let path = '';
  let node: Element | null = el;
  for (let depth = 0; node !== null && depth < MAX_PATH_DEPTH; depth += 1) {
    const segment = `${node.tagName.toLowerCase()}:nth-of-type(${nthOfType(node)})`;
    path = path ? `${segment} > ${path}` : segment;
    try {
      const found = root.querySelectorAll(path);
      if (found.length === 1 && found[0] === el) return path;
    } catch {
      return null;
    }
    if (node === root) break;
    const parent: Element | null = node.parentElement;
    // Never include the caller's root (document or a detached container) as a segment.
    if (!parent || parent === root) break;
    node = parent;
  }

  return null;
}
