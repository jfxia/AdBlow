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
    // 只去掉末尾数字，保留分隔符：`ssp-card-3` → `[id^="ssp-card-"]`
    // 保留 '-' 比 `[id^="ssp-card"]` 更精确，不会误配 ssp-cardinal 这类名字。
    const prefix = id.replace(/\d+$/, '');
    if (prefix && prefix !== id) return `[id^="${escapeIdent(prefix)}"]`;
    return `#${escapeIdent(id)}`;
  }

  // ⚠️ 退无可退时**返回 null，而不是裸标签名**。
  //
  // 这里必须说清为什么：自学习规则会进入静态规则集，而静态规则命中即隐藏、
  // 不做任何判定。若在此返回 "a"，一条「隐藏页面上所有链接」的规则就会被
  // 写入规则库并在后续访问中无条件生效——灾难级误伤。
  // 没有稳定特征可泛化时，宁可只隐藏当前这一个元素、不产出规则。
  return null;
}

/**
 * 选择器宽度检查：自学习入库前的第二道防误伤闸门。
 *
 * 泛化器已经挡住了裸标签名，但「某一类名恰好在全站到处都是」仍然危险
 * （例如指向跨站推广的通用按钮类）。所以入库前实测命中数量，过宽即弃。
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
