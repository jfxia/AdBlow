/**
 * Element picker: turn one user click into a safe, site-scoped hiding rule.
 *
 * The picker reuses the self-learning path instead of inventing a second rule model, so a
 * manual rule lands in `learned:<host>` and is applied by the same code. Two gates keep
 * that path from being a bypass for unsafe selectors:
 *
 *   1. generation prefers `generalizeSelector` (stable attributes/classes/ids) and falls
 *      back to a conservative id / tag.class / `tag:nth-of-type(n)` path;
 *   2. everything the user edits in the panel is re-validated with the existing
 *      `isSelectorSafe` width check and `forbiddenSelectorReason` blocklist before saving.
 *
 * Pure DOM code, no chrome.* — testable under Node + jsdom.
 */
import { forbiddenSelectorReason } from './rules.ts';
import {
  conservativeSelector,
  generalizeSelector,
  isSelectorSafe,
} from './selector.ts';

/** Widest selector a manual pick may produce: same ceiling the learned path uses. */
export const PICKER_MAX_MATCHES = 30;

/** A selector with no class, id, attribute or pseudo is a bare tag (never allowed). */
const BARE_TAG = /^[A-Za-z][\w-]*$/;

function matchesElement(selector: string, root: ParentNode, el: Element): boolean {
  try {
    return Array.from(root.querySelectorAll(selector)).includes(el);
  } catch {
    return false;
  }
}

/**
 * Best selector the element itself supports.
 *
 * Generalization wins even when it matches more than the clicked node (that is the point of
 * a rule: `.ad-slot` should hide every slot it names). It is dropped only when it is null
 * or fails the width gate; then the conservative fallback takes over.
 */
export function pickerSelector(
  el: Element,
  root: ParentNode,
  maxMatches = PICKER_MAX_MATCHES,
): string | null {
  const generalized = generalizeSelector(el);
  if (
    generalized !== null &&
    forbiddenSelectorReason(generalized) === null &&
    isSelectorSafe(generalized, root, maxMatches) &&
    matchesElement(generalized, root, el)
  ) {
    return generalized;
  }
  return conservativeSelector(el, root, maxMatches);
}

export type PickerSelectorProblem =
  | 'empty'
  | 'bare-tag'
  | 'forbidden'
  | 'invalid'
  | 'no-match'
  | 'too-wide';

/**
 * Why the selector in the panel cannot be saved, or null when it can.
 *
 * Deliberately uses the same two gates as the learned path, in the same order, so the
 * picker cannot write data the engine would later reject (or worse, a rule that hides the
 * page). `no-match` is included because a rule matching nothing is bad data that would
 * silently never fire.
 */
export function pickerSelectorProblem(
  selector: string,
  root: ParentNode,
  maxMatches = PICKER_MAX_MATCHES,
): PickerSelectorProblem | null {
  const trimmed = selector.trim();
  if (!trimmed || trimmed.length < 2) return 'empty';
  if (BARE_TAG.test(trimmed)) return 'bare-tag';
  if (forbiddenSelectorReason(trimmed)) return 'forbidden';

  let count: number;
  try {
    count = root.querySelectorAll(trimmed).length;
  } catch {
    return 'invalid';
  }
  if (count === 0) return 'no-match';
  if (count > maxMatches || !isSelectorSafe(trimmed, root, maxMatches)) return 'too-wide';
  return null;
}
