/**
 * Scriptlet (`##+js(...)`) rule parsing and compilation (phase 3).
 *
 * Measured 2026-10-11 over 6 lists: 2,807 scriptlet rules, 3,748 domains, 50
 * distinct names, extremely skewed (top 5 = 61%, top 10 = 81%, top 20 = 94%).
 * Implementing the dozen-odd frequent names therefore covers the vast majority.
 *
 * MAIN world only: these scripts must patch the page's own JS (`window.open`,
 * `setTimeout`, property reads) and an ISOLATED world cannot see those objects.
 *
 * Browser-agnostic: unit-testable in Node.
 */

/** One scriptlet invocation. */
export type ScriptletInvocation = {
  /** Name as written in the rule (may be an alias). */
  name: string;
  /** Resolved canonical name (alias → long name); null when not in the table. */
  canonical: string | null;
  args: string[];
};

/** One scriptlet rule, including its scope domains. */
export type ScriptletRule = ScriptletInvocation & {
  raw: string;
  domains: string[];
  excludedDomains: string[];
};

/**
 * Alias → canonical name.
 *
 * Ordered by measured frequency (trailing numbers are observed counts). Only
 * aliases of names this implementation supports are listed; anything missing
 * resolves to null and is reported as an unknown name.
 */
export const SCRIPTLET_ALIASES: Record<string, string> = {
  // High frequency (measured top 10)
  aopr: 'abort-on-property-read', // 636
  acs: 'abort-current-script', // 359
  set: 'set-constant', // 327
  aeld: 'prevent-addEventListener', // 206 (verified in uBO source)
  nostif: 'no-setTimeout-if', // 195
  aopw: 'abort-on-property-write', // 184
  nowoif: 'no-window-open-if', // 178
  ra: 'remove-attr', // 30
  rc: 'remove-class',
  rmnt: 'remove-node-text', // 46
  nosiif: 'no-setInterval-if', // 26
  // Mid frequency
  'set-local-storage-item': 'set-local-storage-item', // 59
  'set-session-storage-item': 'set-session-storage-item',
  'remove-cookie': 'remove-cookie', // 51
  'cookie-remover': 'remove-cookie', // alias confirmed against uBO source
  'json-prune': 'json-prune', // 27
  'json-edit': 'json-edit',
  'no-xhr-if': 'no-xhr-if', // 39
  'no-fetch-if': 'no-fetch-if', // 36
  'prevent-fetch': 'no-fetch-if', // verified: no-fetch-if is the canonical name
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
 * Canonical names this implementation actually supports.
 *
 * Selection rule: high frequency, self-contained semantics, controllable blast
 * radius. Names left out, and why, are in SUPPORT_NOTES.
 */
export const SUPPORTED_SCRIPTLETS = new Set<string>([
  'set-constant',
  'abort-on-property-read',
  'abort-on-property-write',
  // Only when it carries a search needle -- see SCRIPTLETS_REQUIRING_NEEDLE.
  'abort-current-script',
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
 * Canonical names that are only safe with a search needle.
 *
 * `abort-current-script` traps a property and aborts whichever script reads it. Without a
 * needle the trap cannot tell the offending script from an innocent one, so the rule would
 * take down unrelated code on the same page -- the exact reason this name was left
 * unimplemented for two rounds. Rules without a needle are dropped at index time and
 * counted in `skippedNoNeedle`, never run with "everything matches".
 */
export const SCRIPTLETS_REQUIRING_NEEDLE = new Set<string>(['abort-current-script']);

/**
 * Unsupported canonical names and the reason (written down so nobody "just adds"
 * one). Semantics verified against uBO master source (2026-10-11), not memory.
 */
export const SUPPORT_NOTES: Record<string, string> = {
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
 * Parse the argument string inside `##+js(...)`.
 *
 * Syntax: `name, arg1, arg2, ...`; arguments may contain escaped commas (`\,`),
 * which a plain `split(',')` would break.
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
  // ⚠️ Keep empty arguments: they are positional placeholders in uBO, e.g.
  // `##+js(nostif, , 1000)` means "any callback, block only after 1000ms".
  // Dropping them would change the rule's meaning.
  return out;
}

/** Parse a full scriptlet rule line; null when it is not one. */
export function parseScriptletRule(rawLine: string): ScriptletRule | null {
  const raw = rawLine.trim();
  if (!raw || raw.startsWith('!')) return null;

  const hideIdx = raw.indexOf('##+js(');
  const exceptIdx = raw.indexOf('#@#+js(');
  // `#@#+js(...)` is an exception (cancel injection); unhandled for now → null,
  // and the caller counts it as unsupported.
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
  /** Domain → invocations to run there */
  byDomain: Map<string, { canonical: string; args: string[] }[]>;
  stats: {
    parsed: number;
    supported: number;
    unsupportedName: number;
    unknownName: number;
    /** Rules with `~` exclusions (a forward index cannot express them) */
    skippedExcluded: number;
    /** Supported names dropped for missing a mandatory search needle */
    skippedNoNeedle: number;
    /** Unsupported counts by canonical name, to guide what to do next */
    unsupportedByCanonical: Record<string, number>;
    domains: number;
  };
};

/** Build the domain → invocation list index from parsed rules. */
export function buildScriptletIndex(rules: ScriptletRule[]): ScriptletIndex {
  const byDomain = new Map<string, { canonical: string; args: string[] }[]>();
  const stats: ScriptletIndex['stats'] = {
    parsed: 0,
    supported: 0,
    unsupportedName: 0,
    unknownName: 0,
    skippedExcluded: 0,
    skippedNoNeedle: 0,
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
    if (SCRIPTLETS_REQUIRING_NEEDLE.has(rule.canonical) && (!rule.args[0] || !rule.args[1])) {
      // See SCRIPTLETS_REQUIRING_NEEDLE: running it without a needle would abort innocent
      // scripts. Drop it and report, rather than widen the rule to "match anything".
      stats.skippedNoNeedle += 1;
      continue;
    }
    if (rule.excludedDomains.length > 0) {
      stats.skippedExcluded += 1;
      continue;
    }
    if (rule.domains.length === 0) {
      // An unrestricted scriptlet would run everywhere: too risky
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
