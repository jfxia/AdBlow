/**
 * UI text via chrome.i18n.
 *
 * Why a dedicated module: the same strings appear in two pages plus the manifest, each with
 * its own lookup path — manifest `__MSG_key__` (replaced by the browser), HTML `data-i18n*`
 * attributes filled by this module, and JS-built strings via `t('key', [subs])` — all backed
 * by one `_locales/<lang>/messages.json`, so the manifest cannot end up translated while the
 * UI is not.
 *
 * Why textContent instead of innerHTML: substitutions can contain site domains, and domains
 * come from arbitrary pages. innerHTML would push page-controlled strings into an extension
 * page — an XSS surface. Always textContent.
 */

/** Fetch one message; falls back to the key, so missing translations are obvious. */
export function t(key: string, substitutions?: (string | number)[]): string {
  const subs = substitutions?.map((s) => String(s));
  const msg = chrome.i18n.getMessage(key, subs);
  return msg || key;
}

/**
 * Fill `data-i18n*` attributes with the text for the current language:
 *   data-i18n             → textContent
 *   data-i18n-title       → title
 *   data-i18n-aria        → aria-label
 *   data-i18n-placeholder → placeholder
 */
export function applyI18n(root: ParentNode = document): void {
  const fill = (selector: string, apply: (el: HTMLElement, value: string) => void): void => {
    for (const node of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
      const key = node.getAttribute(selector === '[data-i18n]' ? 'data-i18n' : selector.slice(1, -1));
      if (!key) continue;
      apply(node, t(key));
    }
  };

  fill('[data-i18n]', (el, v) => {
    el.textContent = v;
  });
  fill('[data-i18n-title]', (el, v) => {
    el.title = v;
  });
  fill('[data-i18n-aria]', (el, v) => {
    el.setAttribute('aria-label', v);
  });
  fill('[data-i18n-placeholder]', (el, v) => {
    (el as HTMLInputElement).placeholder = v;
  });

  // Keep `<html lang>` accurate: it affects font fallback, line breaking and screen readers.
  const uiLang = chrome.i18n.getUILanguage?.() ?? 'zh-CN';
  document.documentElement.lang = uiLang;
}
