/**
 * 界面文案的多语言（chrome.i18n）。
 *
 * ## 为什么单独一个模块
 *
 * 文案出现在两个页面（popup / options）与 manifest 里，而取文案的方式各不相同：
 *   - manifest：`__MSG_key__`（浏览器直接替换）
 *   - HTML：靠 `data-i18n*` 属性 + 本模块统一填充
 *   - JS 动态拼的字符串：`t('key', [替换值])`
 * 三者共用同一份 `_locales/<lang>/messages.json`，避免"manifest 翻译了、界面没翻"。
 *
 * ## 为什么用 textContent 而不是 innerHTML
 *
 * 文案里可能带站点域名（用户可访问任意站点，域名来自页面）。用 `innerHTML`
 * 填充等于把页面可控字符串塞进扩展页面 —— 那是 XSS 面。一律 `textContent`。
 */

/** 取一条文案；缺失时回落到 key（便于一眼看出漏翻的项）。 */
export function t(key: string, substitutions?: (string | number)[]): string {
  const subs = substitutions?.map((s) => String(s));
  const msg = chrome.i18n.getMessage(key, subs);
  return msg || key;
}

/**
 * 把 `data-i18n*` 属性填成对应语言的文案。
 *
 * 支持的属性：
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

  // 让 `<html lang>` 反映实际语言（影响字体回退、断行、无障碍朗读）
  const uiLang = chrome.i18n.getUILanguage?.() ?? 'zh-CN';
  document.documentElement.lang = uiLang;
}
