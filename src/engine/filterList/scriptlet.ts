/**
 * 脚本注入规则（`##+js(...)`）的解析与编译（第三期）。
 *
 * ## 实测数据（2026-10-11，6 份列表）
 *
 *   2,807 条脚本注入规则，涉及 **3,748 个域名**，50 个不同脚本名。
 *   频率分布极不均：**前 5 名覆盖 61%、前 10 名覆盖 81%、前 20 名覆盖 94%**。
 *
 *   aopr 636｜acs 359｜set 327｜aeld 206｜nostif 195｜aopw 184｜nowoif 178
 *
 * 因此"实现常用子集"是有依据的取舍：实现十几个高频名字就能覆盖绝大多数规则，
 * 而不是去追 50 个。
 *
 * ## 为什么只做 MAIN world
 *
 * 这些脚本要改写页面自己的 JS 行为（`window.open`、`setTimeout`、属性读写），
 * 只能在 MAIN world 生效。ISOLATED world 看不到页面的对象。
 *
 * 本模块浏览器无关，可在 Node 里直接单测。
 */

/** 一条脚本注入调用。 */
export type ScriptletInvocation = {
  /** 规则里的名字（可能是别名）。 */
  name: string;
  /** 已解析成规范名（别名 → 长名）；不在支持表里则为 null。 */
  canonical: string | null;
  args: string[];
};

/** 一条脚本注入规则（含作用域名）。 */
export type ScriptletRule = ScriptletInvocation & {
  raw: string;
  domains: string[];
  excludedDomains: string[];
};

/**
 * 别名 → 规范名。
 *
 * 依据实测频率排序（注释里的数字是实测出现次数）。
 * 只收录**本实现支持**的规范名对应的别名；其余别名解析出来但标记为不支持，
 * 以便在覆盖率报告里如实反映"我们没做哪些"。
 */
export const SCRIPTLET_ALIASES: Record<string, string> = {
  // 高频（实测前 10）
  aopr: 'abort-on-property-read', // 636
  acs: 'abort-current-script', // 359
  set: 'set-constant', // 327
  aeld: 'prevent-addEventListener', // 206（核实自 uBO 源码：不是我原先猜的 abort-on-element-load）
  nostif: 'no-setTimeout-if', // 195
  aopw: 'abort-on-property-write', // 184
  nowoif: 'no-window-open-if', // 178
  ra: 'remove-attr', // 30
  rc: 'remove-class',
  rmnt: 'remove-node-text', // 46
  nosiif: 'no-setInterval-if', // 26
  // 中频
  'set-local-storage-item': 'set-local-storage-item', // 59
  'set-session-storage-item': 'set-session-storage-item',
  'remove-cookie': 'remove-cookie', // 51
  'cookie-remover': 'remove-cookie', // 核实：cookie-remover 是 remove-cookie 的别名
  'json-prune': 'json-prune', // 27
  'json-edit': 'json-edit',
  'no-xhr-if': 'no-xhr-if', // 39
  'no-fetch-if': 'no-fetch-if', // 36
  'prevent-fetch': 'no-fetch-if', // 核实：prevent-fetch 是规范名，no-fetch-if 是它的别名
  'nano-sib': 'nano-setInterval-booster', // 51
  'nano-stb': 'nano-setTimeout-booster', // 31
  nowebrtc: 'nowebrtc', // 47
  noeval: 'noeval',
  nobab: 'no-bab',
  'href-sanitizer': 'href-sanitizer', // 71
  'popads-dummy': 'popads-dummy',
  aost: 'abort-on-stack-trace', // 30
  'trusted-set-cookie': 'trusted-set-cookie',
};

/**
 * 本实现**实际支持**的规范名子集。
 *
 * 取舍原则：优先高频、语义自包含、误伤风险可控。
 * 明确不做的（及原因）见 SUPPORT_NOTES。
 */
export const SUPPORTED_SCRIPTLETS = new Set<string>([
  'set-constant',
  'abort-on-property-read',
  'abort-on-property-write',
  'no-setTimeout-if',
  'no-setInterval-if',
  'no-window-open-if',
  'prevent-addEventListener',
  'no-fetch-if',
  'no-xhr-if',
  'json-prune',
  'set-local-storage-item',
  'remove-cookie',
]);

/**
 * 不做的规范名及原因（写下来避免以后有人"顺手加上"）。
 * 语义依据：子代理对 uBO master 源码的核实（2026-10-11），非记忆。
 */
export const SUPPORT_NOTES: Record<string, string> = {
  'abort-current-script':
    '需要靠 getter 陷阱 + document.currentScript 反查"当前正在执行哪个内联脚本"，实现复杂且容易误伤同页其它脚本',
  'abort-on-stack-trace':
    '依赖错误栈字符串匹配，Chromium/Firefox 归一化方式不同、脆弱',
  'remove-attr':
    'uBO 已标记 deprecated（改用 :remove-attr() 程序化操作符）；且属 DOM 改写，与既有 cosmetic 层职责重叠',
  'remove-class': '同上（uBO 已标记 deprecated，改用 :remove-class()）',
  'remove-node-text': 'DOM 改写，与 cosmetic 层职责重叠，收益有限',
  'nano-setInterval-booster':
    '只是把定时器延迟乘一个系数（默认 20 倍加速），收益低且有副作用风险',
  'nano-setTimeout-booster': '同上',
  nowebrtc: '与广告过滤无关的隐私向脚本，不在本项目范围',
  noeval: '会移除页面 eval（返回 undefined），依赖 eval 的页面会静默失效，风险高',
  'no-bab': '需要匹配 BlockAdblock 特征词集（≥80%），特征易变，维护成本高',
  'href-sanitizer': '改写链接，容易影响正常导航，风险高于收益',
  'popads-dummy': '针对单一广告网络，不是通用机制',
  'json-edit': '与 json-prune 重叠；且其"赋值"能力在 uBO 属受信任通道，先只做 prune',
  'set-session-storage-item': '与 localStorage 版本同源，后续按需补',
  'trusted-set-cookie': 'uBO 的"受信任脚本"通道（requiresTrust），普通规则不可用，不实现',
};

/**
 * 解析 `##+js(...)` 里的参数串。
 *
 * 语法：`name, arg1, arg2, ...`。参数可含转义逗号（`\,`）——uBO 支持这种写法，
 * 直接 `split(',')` 会把参数切错。
 */
export function parseScriptletArgs(payload: string): string[] {
  const out: string[] = [];
  let current = '';
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i]!;
    if (ch === '\\' && payload[i + 1] === ',') {
      current += ',';
      i += 1;
      continue;
    }
    if (ch === ',') {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  // ⚠️ 保留空参数：uBO 里空参数是**位置占位符**，
  // 例如 `##+js(nostif, , 1000)` 表示"任意回调、延迟 1000 才拦"。
  // 过滤掉空参数会把这些规则的含义改错。
  return out;
}

/** 解析一条完整的脚本注入规则行；不是脚本注入则返回 null。 */
export function parseScriptletRule(rawLine: string): ScriptletRule | null {
  const raw = rawLine.trim();
  if (!raw || raw.startsWith('!')) return null;

  const hideIdx = raw.indexOf('##+js(');
  const exceptIdx = raw.indexOf('#@#+js(');
  // `#@#+js(...)` 是例外（取消注入）；本期不处理例外，返回 null 由调用方计入未支持
  if (exceptIdx >= 0 && (hideIdx < 0 || exceptIdx < hideIdx)) return null;
  if (hideIdx < 0) return null;

  const domainPart = raw.slice(0, hideIdx);
  const after = raw.slice(hideIdx + '##+js('.length);
  const close = after.lastIndexOf(')');
  if (close < 0) return null;
  const payload = after.slice(0, close);

  const parts = parseScriptletArgs(payload);
  if (!parts.length || !parts[0]) return null;

  const name = parts[0]!;
  const args = parts.slice(1);

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

  return {
    raw,
    name,
    canonical: SCRIPTLET_ALIASES[name] ?? null,
    args,
    domains,
    excludedDomains,
  };
}

export type ScriptletIndex = {
  /** 域名 → 该域名要执行的调用序列 */
  byDomain: Map<string, { canonical: string; args: string[] }[]>;
  stats: {
    parsed: number;
    supported: number;
    unsupportedName: number;
    unknownName: number;
    /** 带 `~` 排除的规则（正向索引表达不了） */
    skippedExcluded: number;
    /** 按规范名统计的未支持条数，用于决定下一步做什么 */
    unsupportedByCanonical: Record<string, number>;
    domains: number;
  };
};

/** 由解析结果构建「域名 → 调用序列」索引。 */
export function buildScriptletIndex(rules: ScriptletRule[]): ScriptletIndex {
  const byDomain = new Map<string, { canonical: string; args: string[] }[]>();
  const stats: ScriptletIndex['stats'] = {
    parsed: 0,
    supported: 0,
    unsupportedName: 0,
    unknownName: 0,
    skippedExcluded: 0,
    unsupportedByCanonical: {},
    domains: 0,
  };

  for (const rule of rules) {
    stats.parsed += 1;

    if (!rule.canonical) {
      stats.unknownName += 1;
      continue;
    }
    if (!SUPPORTED_SCRIPTLETS.has(rule.canonical)) {
      stats.unsupportedName += 1;
      stats.unsupportedByCanonical[rule.canonical] =
        (stats.unsupportedByCanonical[rule.canonical] ?? 0) + 1;
      continue;
    }
    if (rule.excludedDomains.length > 0) {
      stats.skippedExcluded += 1;
      continue;
    }
    if (rule.domains.length === 0) {
      // 无域名限定的脚本注入对全站执行，风险过高，不做
      stats.unknownName += 1;
      continue;
    }

    stats.supported += 1;
    for (const domain of rule.domains) {
      const list = byDomain.get(domain);
      const entry = { canonical: rule.canonical, args: rule.args };
      if (list) list.push(entry);
      else byDomain.set(domain, [entry]);
    }
  }

  stats.domains = byDomain.size;
  return { byDomain, stats };
}
