/**
 * 选择器泛化：把一次性节点指纹变成可复用规则，供自学习入库。
 *
 * 优先序（越靠前越稳定）：
 *   1. 语义化 data-ssp-* 属性 —— 只有站点改版才会变
 *   2. 以分隔符结尾的稳定类名（丢弃 css-1x9f2kd 这类构建期哈希）
 *   3. id 前缀（把 -3 / -7 这类序号去掉）
 *   4. 兜底：标签名
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

/** 不依赖 CSS.escape（jsdom 不保证提供）。 */
function escapeIdent(ident: string): string {
  if (SAFE_IDENT.test(ident)) return ident;
  const g = globalThis as unknown as { CSS?: { escape?: (s: string) => string } };
  if (typeof g.CSS?.escape === 'function') return g.CSS.escape(ident);
  return ident.replace(/[^\w-]/g, (c) => `\\${c}`);
}

export function generalizeSelector(el: Element): string {
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
    // 只去掉末尾数字，保留分隔符：`ssp-card-3` → `[id^="ssp-card-"]`
    // 保留 '-' 比 `[id^="ssp-card"]` 更精确，不会误配 ssp-cardinal 这类名字。
    const prefix = id.replace(/\d+$/, '');
    if (prefix && prefix !== id) return `[id^="${escapeIdent(prefix)}"]`;
    return `#${escapeIdent(id)}`;
  }

  return el.tagName.toLowerCase();
}
