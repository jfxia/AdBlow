/**
 * cosmetic（页面元素隐藏）规则解析与编译。
 *
 * ## 范围决定：先做「域名专用」，通用规则留作可选项
 *
 * uBlock Origin Lite 的做法是**默认不启用通用 cosmetic 规则**（只在"完全模式"
 * 下开）。理由很实在：`##.ad` 这类无域名限定的选择器会被套用到全网站，
 * 误伤风险远高于收益。本实现采纳同样取舍：
 *
 *   - **域名专用**（`example.com##.ad`）：精确、可控 → 本期启用
 *   - **通用**（`##.ad`）：解析与统计照做，但默认不注入
 *
 * ## 语法覆盖（实测 6 份列表 36,019 条 cosmetic）
 *
 *   `##`   隐藏              → 启用
 *   `#@#`  例外（取消隐藏）    → 启用
 *   `#?#`  程序化（:has-text 等）→ 统计后暂缓（需要程序化引擎，第三期一起做）
 *   `#$#`  样式注入           → 统计后暂缓
 *   `##+js(...)`            → 第三期（脚本注入）
 *
 * 本模块浏览器无关，可在 Node 里直接单测。
 */

export type CosmeticFlavor = 'hide' | 'unhide' | 'procedural' | 'style' | 'scriptlet';

export type CosmeticFilter = {
  raw: string;
  /** 作用域名；空数组表示通用规则（所有网站）。 */
  domains: string[];
  /** `~domain` 形式排除的域名。 */
  excludedDomains: string[];
  /** 选择器（程序化/脚本类规则里是原始参数）。 */
  selector: string;
  flavor: CosmeticFlavor;
};

/** 分隔符 → 语义。顺序重要：长的先匹配。 */
const SEPARATORS: [string, CosmeticFlavor][] = [
  ['#@#+js(', 'scriptlet'],
  ['##+js(', 'scriptlet'],
  ['#@?#', 'procedural'],
  ['#?#', 'procedural'],
  ['#@$#', 'style'],
  ['#$#', 'style'],
  ['#@#', 'unhide'],
  ['##', 'hide'],
];

/**
 * 按顶层逗号切分选择器列表。
 *
 * 不能简单 `split(',')`：选择器里常有 `:has(a, b)`、`:not(.x, .y)`、
 * `[attr="a,b"]` 这类内含逗号的写法，切错会产出非法选择器。
 */
export function splitTopLevel(selectorList: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (const ch of selectorList) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);

    if (ch === ',' && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * 粗筛选择器是否可能是合法 CSS。
 *
 * 不做完整 CSS 解析（浏览器才是最终裁判），只挡掉明显非法的形态：
 * 空、只有空格、尖括号、以及会导致整张样式表失效的裸花括号。
 * ⚠️ 关键：**一条非法选择器会让整个样式表规则被丢弃**，所以宁可少注入。
 */
export function looksLikeValidSelector(selector: string): boolean {
  const s = selector.trim();
  if (!s || s.length > 500) return false;
  if (/[{}<>]/.test(s)) return false;
  // 必须以标签名/#/. /[ /: / * 开头
  return /^[a-z*#.[:]/i.test(s);
}

/** 解析一条 cosmetic 规则；不是 cosmetic 则返回 null。 */
export function parseCosmeticLine(rawLine: string): CosmeticFilter | null {
  const raw = rawLine.trim();
  if (!raw || raw.startsWith('!')) return null;

  let sepIndex = -1;
  let flavor: CosmeticFlavor | null = null;
  for (const [sep, f] of SEPARATORS) {
    const i = raw.indexOf(sep);
    if (i >= 0 && (sepIndex < 0 || i < sepIndex)) {
      sepIndex = i;
      flavor = f;
    }
  }
  if (sepIndex < 0 || !flavor) return null;

  const sep = SEPARATORS.find(([, f]) => f === flavor)![0];
  const domainPart = raw.slice(0, sepIndex);
  // 脚本注入类：选择器部分是 `+js(...)` 的参数，不是 CSS
  const selectorPart =
    flavor === 'scriptlet' ? raw.slice(sepIndex).replace(/^#@?#?##?\+js\(/, '').replace(/\)$/, '') : raw.slice(sepIndex + sep.length);

  const domains: string[] = [];
  const excludedDomains: string[] = [];
  if (domainPart) {
    for (const item of domainPart.split(',')) {
      const d = item.trim().toLowerCase();
      if (!d) continue;
      if (d.startsWith('~')) excludedDomains.push(d.slice(1));
      else domains.push(d);
    }
  }

  const selector = selectorPart.trim();
  if (!selector) return null;

  return { raw, domains, excludedDomains, selector, flavor };
}

export type CosmeticIndex = {
  /** 域名 → 该域名下要隐藏的选择器 */
  hideByDomain: Map<string, Set<string>>;
  /** 域名 → 该域名下要**取消**隐藏的选择器（`#@#`） */
  unhideByDomain: Map<string, Set<string>>;
  /** 通用隐藏选择器（默认不注入，见文件头） */
  genericHide: Set<string>;
  /** 通用例外 */
  genericUnhide: Set<string>;
  stats: {
    parsed: number;
    hide: number;
    unhide: number;
    generic: number;
    domainSpecific: number;
    /** 程序化 / 样式 / 脚本注入：本期不产出，只计数 */
    deferred: Record<string, number>;
    invalidSelectors: number;
    /** 带 `~` 排除的规则：目前只支持"排除整条规则"，无法表达"除某域名外全站" */
    skippedExcluded: number;
  };
};

/**
 * 把解析结果编译成按域名索引的结构。
 *
 * ⚠️ 关于 `~domain` 排除：ABP 语义是"除这些域名外都生效"。我们的索引是
 * **正向域名索引**，表达不了这种负向规则，因此**跳过不处理**并计数，
 * 而不是错误地当成正向规则（那会把规则套用到它本来要排除的站点上）。
 */
export function buildCosmeticIndex(filters: CosmeticFilter[]): CosmeticIndex {
  const index: CosmeticIndex = {
    hideByDomain: new Map(),
    unhideByDomain: new Map(),
    genericHide: new Set(),
    genericUnhide: new Set(),
    stats: {
      parsed: filters.length,
      hide: 0,
      unhide: 0,
      generic: 0,
      domainSpecific: 0,
      deferred: {},
      invalidSelectors: 0,
      skippedExcluded: 0,
    },
  };

  const add = (map: Map<string, Set<string>>, domain: string, selector: string): void => {
    const set = map.get(domain);
    if (set) set.add(selector);
    else map.set(domain, new Set([selector]));
  };

  for (const f of filters) {
    // 程序化 / 样式 / 脚本注入本期不产出
    if (f.flavor === 'procedural' || f.flavor === 'style' || f.flavor === 'scriptlet') {
      index.stats.deferred[f.flavor] = (index.stats.deferred[f.flavor] ?? 0) + 1;
      continue;
    }

    if (!looksLikeValidSelector(f.selector)) {
      index.stats.invalidSelectors += 1;
      continue;
    }

    // 带 ~ 排除的规则无法用正向索引表达 → 跳过并计数
    if (f.excludedDomains.length > 0) {
      index.stats.skippedExcluded += 1;
      continue;
    }

    const isHide = f.flavor === 'hide';
    if (f.domains.length === 0) {
      // 通用规则
      if (isHide) {
        index.genericHide.add(f.selector);
        index.stats.hide += 1;
      } else {
        index.genericUnhide.add(f.selector);
        index.stats.unhide += 1;
      }
      index.stats.generic += 1;
      continue;
    }

    for (const domain of f.domains) {
      if (isHide) add(index.hideByDomain, domain, f.selector);
      else add(index.unhideByDomain, domain, f.selector);
    }
    index.stats.domainSpecific += 1;
    if (isHide) index.stats.hide += 1;
    else index.stats.unhide += 1;
  }

  return index;
}

/**
 * 取出某个主机名下应生效的选择器。
 *
 * ABP 语义：`example.com##.ad` 对 `example.com` 及其**所有子域**生效。
 * 因此要沿主机名逐级向上查（`a.b.example.com` → `b.example.com` → `example.com`），
 * 并扣除这些层级里出现的 `#@#` 例外。
 */
export function selectorsForHost(index: CosmeticIndex, host: string): string[] {
  const keys = domainKeysForHost(host);
  const result = new Set<string>();
  const unhide = new Set<string>();

  for (const key of keys) {
    for (const s of index.hideByDomain.get(key) ?? []) result.add(s);
    for (const s of index.unhideByDomain.get(key) ?? []) unhide.add(s);
  }

  for (const s of unhide) result.delete(s);
  return [...result];
}

/** 生成注入用的 CSS（`display:none !important` 与既有 hideElement 保持一致）。 */
export function cosmeticCssFor(selectors: string[]): string {
  if (selectors.length === 0) return '';
  return `${selectors.join(',')}{display:none!important;}`;
}

// ── 分片投递 ─────────────────────────────────────────────────────
//
// 为什么分片：域名专用规则总量在万级、涉及上万个主机名。整份 JSON 有几 MB，
// 每开一个页面都读它不现实；而"运行期按主机名取"又必须先知道规则在哪儿。
//
// 方案：构建期按**域名的哈希**把「域名 → 选择器」切成 N 片，运行期只取
// 当前主机名及其各级父域所在的那几片（通常是 2–3 片、每片几 KB），
// 而且是通过 `chrome.runtime.getURL()` 读**本地文件**，不走网络。
//
// 生成端与运行端必须用同一套哈希 —— 所以它放在这里并有单测。

/** 分片总数。256 片时每片约几十个域名，文件几 KB。 */
export const COSMETIC_SHARD_COUNT = 256;

/** FNV-1a 32 位哈希（确定、无依赖、生成端与运行端一致）。 */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function shardOf(domain: string, shardCount = COSMETIC_SHARD_COUNT): number {
  return fnv1a(domain.toLowerCase()) % shardCount;
}

/**
 * 列出某个主机名在 ABP 语义下需要查询的域名（自身 + 各级父域）。
 *
 * `a.b.example.com` → `['a.b.example.com','b.example.com','example.com']`。
 * 上限 6 级，避免畸形主机名引出过多请求。
 */
export function domainsToQuery(host: string, maxLevels = 6): string[] {
  const labels = host.toLowerCase().split('.').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < labels.length && i < maxLevels; i += 1) {
    out.push(labels.slice(i).join('.'));
  }
  return out;
}

/**
 * 在上一函数基础上加上**通配 TLD 键**。
 *
 * 列表里存在 `amazon.*`、`momondo.*` 这类"任意顶级域"规则（实测 250 个键，
 * 占 2.3%）。只按字面后缀查会**永远匹配不上**它们 —— 这是实测发现的漏洞。
 * 因此对每一级后缀再补一个 `xxx.*` 形式。
 */
export function domainKeysForHost(host: string, maxLevels = 6): string[] {
  const keys = new Set(domainsToQuery(host, maxLevels));
  for (const d of [...keys]) {
    const parts = d.split('.');
    if (parts.length < 2) continue;
    // 只替换最后一段：`amazon.com` → `amazon.*`
    keys.add([...parts.slice(0, -1), '*'].join('.'));
    // ccTLD 的二阶后缀（co.jp / com.au / co.uk…）需要再放宽一级，
    // 因为 `amazon.*` 在 ABP 语义里覆盖**任意公共后缀**，包括多段后缀。
    // 不引入完整公共后缀表，用"末段是 2 字母"这个便宜判据覆盖常见情形。
    const tld = parts[parts.length - 1]!;
    if (/^[a-z]{2}$/.test(tld) && parts.length >= 3) {
      keys.add([...parts.slice(0, -2), '*'].join('.'));
    }
  }
  return [...keys];
}

/** 该主机名需要取哪几片（去重、升序）。 */
export function shardsForHost(host: string, shardCount = COSMETIC_SHARD_COUNT): number[] {
  const set = new Set(domainKeysForHost(host).map((d) => shardOf(d, shardCount)));
  return [...set].sort((a, b) => a - b);
}

export type CosmeticShard = {
  /** 域名 → 隐藏选择器 */
  hide: Record<string, string[]>;
  /** 域名 → 取消隐藏的选择器 */
  unhide: Record<string, string[]>;
};

/** 把索引切成 N 片。 */
export function shardIndex(index: CosmeticIndex, shardCount = COSMETIC_SHARD_COUNT): CosmeticShard[] {
  const shards: CosmeticShard[] = Array.from({ length: shardCount }, () => ({ hide: {}, unhide: {} }));
  for (const [domain, selectors] of index.hideByDomain) {
    shards[shardOf(domain, shardCount)]!.hide[domain] = [...selectors];
  }
  for (const [domain, selectors] of index.unhideByDomain) {
    shards[shardOf(domain, shardCount)]!.unhide[domain] = [...selectors];
  }
  return shards;
}

/**
 * 从若干分片里取出某主机名应生效的选择器。
 *
 * 运行端的主逻辑，因此做成纯函数：给分片数组 + 主机名 → CSS 选择器列表。
 * 语义与 `selectorsForHost` 一致：沿各级父域收集，再用 `#@#` 扣除。
 */
export function selectorsFromShards(
  shards: (CosmeticShard | null)[],
  host: string,
): string[] {
  const domains = domainKeysForHost(host);
  const hide = new Set<string>();
  const unhide = new Set<string>();

  for (const shard of shards) {
    if (!shard) continue;
    for (const domain of domains) {
      for (const s of shard.hide[domain] ?? []) hide.add(s);
      for (const s of shard.unhide[domain] ?? []) unhide.add(s);
    }
  }
  for (const s of unhide) hide.delete(s);
  return [...hide];
}
