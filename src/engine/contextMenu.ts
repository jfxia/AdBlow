/**
 * Context-menu constants and label resolution (pure, no chrome.*).
 *
 * The service worker owns `chrome.contextMenus`, which is unavailable under Node + jsdom.
 * Keeping the label logic here makes the one failure that matters testable: a missing
 * translation. `chrome.i18n.getMessage` returns '' for an unknown key, and an empty title
 * makes the menu item invisible or untranslated in every context, so the caller needs a
 * working fallback rather than an empty string.
 */

/** One stable id: re-creating the item must replace the old one, never add a second. */
export const CONTEXT_MENU_PICK_ID = 'adblow-pick-element';

/**
 * Shown when chrome.i18n has no `contextMenuPick` message.
 *
 * English on purpose: it is a last resort for a broken/partial locale catalog, and the
 * extension's own name is what makes the entry recognisable in that case.
 */
export const CONTEXT_MENU_PICK_FALLBACK = 'Block this element with AdBlow';

/**
 * Resolve the menu label, falling back when the lookup yields nothing.
 *
 * The getter is injected so tests can simulate a missing message, a thrown lookup, or a
 * locale that returns whitespace; the service worker passes `chrome.i18n.getMessage`.
 */
export function contextMenuPickTitle(
  getMessage: (key: string) => string | undefined | null,
): string {
  let message: string | undefined | null;
  try {
    message = getMessage('contextMenuPick');
  } catch {
    // chrome.i18n itself can be unavailable in a torn-down worker; a label is not worth
    // breaking the rest of the service worker over.
    message = null;
  }
  return typeof message === 'string' && message.trim() ? message : CONTEXT_MENU_PICK_FALLBACK;
}
