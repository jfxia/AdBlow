/**
 * 把解析后的过滤规则编译成 DNR 静态规则集。
 *
 * ## 为什么这个文件的主体是"预算与取舍"
 *
 * 实测（2026-10-11，六份主流列表）：
 *   网络规则合计 **132,585** 条，而 MV3 静态规则集的预算量级是 **3 万条**。
 *   也就是只能保留约 23% —— **裁剪策略就是这个编译器的核心**，不是附属逻辑。
 *
 * ## 优先级设计（决定了冲突时谁赢）
 *
 * DNR 里优先级高的规则胜出。这张表是刻意排的，不要随手改：
 *
 * | 优先级 | 来源 | 理由 |
 * |---|---|---|
 * | 7 | 列表的 important 例外 | ABP 语义里 important 例外最高 |
 * | 5 | 列表的 important 拦截 | ABP 语义：important 拦截要压过普通例外 |
 * | 4 | **本项目的站点规则包** | 逐站取证过，比通用列表更可信 |
 * | 3 | 列表的普通例外 | 例外是"防站点损坏"的主力，必须压过普通拦截 |
 * | 2 | **自学习域名拦截** | 高于列表拦截，但要能被列表例外推翻（自学习会学错） |
 * | 1 | 列表的普通拦截 | 兜底 |
 *
 * ## 两条刻意的偏离（有测试守着）
 *
 * 1. **默认不让列表规则拦主文档**（`allowMainFrame: false`）。列表里
 *    `||ads.x.com^` 这种不带类型选项的规则按 ABP 语义包含 document，
 *    照搬会导致用户点链接直接导航失败 —— 与本项目既有的「main_frame 永不拦」
 *    纪律冲突。只有显式写了 `$document` 的规则才拦主文档。
 * 2. **不认识选项的规则整条丢弃**（见 parse.ts），绝不静默放宽。
 */
import type { ResourceType } from '../rules.ts';
import type { ParsedFilter } from './parse.ts';
import { isValidRequestDomain, normalizeUrlFilter, urlFilterProblem } from './validate.ts';

export type DnrCondition = {
  urlFilter?: string;
  regexFilter?: string;
  /**
   * 请求域名列表。
   *
   * 这是**最关键的压缩手段**（2026-10-11 核实 uBOL 构建日志后加入）：
   * uBOL 把 Peter Lowe 的 3,552 条输入压成 **1 条**规则、urlhaus 的 3,029 条
   * 压成 **1 条**，靠的就是把几千个域名塞进一条规则的 `requestDomains`
   * （实测单规则可容纳约 3,500 个域名，官方无上限文档）。
   *
   * 本编译器原本"一个域名一条规则"，于是被 3 万条预算卡死；
   * 改用域名打包后，12 万个域名只需几百条规则。
   *
   * 语义上它还**更精确**：`requestDomains` 直接按请求域名匹配，
   * 不像 `||domain^` 依赖分隔符规则。
   */
  requestDomains?: string[];
  isUrlFilterCaseSensitive?: boolean;
  resourceTypes?: ResourceType[];
  excludedResourceTypes?: ResourceType[];
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  domainType?: 'firstParty' | 'thirdParty';
};

export type DnrListRule = {
  id: number;
  priority: number;
  action: { type: 'block' | 'allow' };
  condition: DnrCondition;
};

/** 优先级取值（见文件头表格）。 */
export const PRIORITY = {
  listBlock: 1,
  learnedBlock: 2,
  listAllow: 3,
  /** 站点规则包（动态规则，本文件不产出，仅在此登记取值以免冲突） */
  packBlock: 4,
  listImportantBlock: 5,
  listImportantAllow: 7,
} as const;

/** 全部子资源类型。 */
export const ALL_SUBRESOURCE_TYPES: ResourceType[] = [
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'media',
  'websocket',
  'other',
];

export type CompileOptions = {
  /** 静态规则总条数上限。 */
  budget: number;
  /** 单个静态规则集最多几条（便于分卷）。 */
  rulesetSize: number;
  /** 正则规则条数上限（DNR 有独立且更小的限额）。 */
  regexBudget: number;
  /** 是否允许列表规则拦主文档，默认 false（见文件头）。 */
  allowMainFrame?: boolean;
  /**
   * 每份列表的配额（条数）。未列出的列表用 defaultListQuota。
   *
   * 为什么要按列表配额：实测六份列表覆盖的域名**基本互不重叠**
   * （12 万候选里只有 59 条被多份列表提到），所以"多列表共识"没有区分度。
   * 若单纯按价值分排序，结果由**输入顺序**决定 —— 实测会把 EasyPrivacy
   * 几乎全部挤掉。配额保证每份列表都有份额。
   */
  listQuotas?: Record<string, number>;
  /** 未显式配置配额的列表的上限。 */
  defaultListQuota?: number;
};

export type CompileReport = {
  input: number;
  afterBadfilter: number;
  deduped: number;
  /** 因按域名归并而消失的规则条数。 */
  collapsedDomains: number;
  compiled: number;
  exceptions: number;
  regex: number;
  domainAnchored: number;
  dropped: Record<string, number>;
  budget: number;
  budgetUsed: number;
  budgetTruncated: number;
  rulesetCount: number;
  /** 被打包进 requestDomains 的域名总数与产出的规则条数。 */
  packedDomains: number;
  packedRules: number;
  /** `||*` 被规范化成 `*` 的条数（略微放宽，需知情）。 */
  normalizedPatterns: number;
  /** 多列表共识分布（预算有限时靠它排序）。 */
  consensus: { single: number; multi: number; maxLists: number };
  /** 每份来源列表实际保留的规则数（验证配额是否生效）。 */
  keptByList: Record<string, number>;
  /** 列表里**本来有多少**可供选择（用于判断我们丢掉了什么）。 */
  available: {
    domainAnchors: number;
    regex: number;
    exceptions: number;
    blocks: number;
  };
};

export type CompileResult = {
  rulesets: DnrListRule[][];
  report: CompileReport;
};

/** 从正则里尽量提取域名锚点；提不出来返回 null。 */
export function simplifyRegex(regexBody: string): string | null {
  // 只处理"以 http(s) 开头 + 域名"这一种最常见的形态；
  // 其余正则一律保留为正则（受独立的正则预算约束）
  if (!/https?\??:?/i.test(regexBody)) return null;

  // 抓第一段"域名形态"的文本（点号在正则里通常是转义的）
  const m = /([a-z0-9][a-z0-9-]*(?:\\?\.[a-z0-9-]+)+)/i.exec(regexBody);
  if (!m) return null;

  const domain = m[1]!.replace(/\\(.)/g, '$1');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) return null;
  if (!/\.[a-z]{2,}$/i.test(domain)) return null;
  return `||${domain}`;
}

type Candidate = {
  key: string;
  exception: boolean;
  important: boolean;
  condition: DnrCondition;
  /** 价值分：预算不够时按它从高到低保留。 */
  value: number;
  regex: boolean;
  /** 出现在哪些来源列表里（多列表共识 = 更高置信度）。 */
  sources: Set<string>;
};

/**
 * 多列表共识的每条加成。
 *
 * 预算只够保留约 20% 的候选，因此**排序依据决定了实际覆盖质量**。
 * 一个域名被 EasyList、EasyPrivacy、uBlock 同时拉黑，比只被一份列表提到
 * 更可能是真广告/追踪域名 —— 这是免费且有效的置信度信号。
 */
export const CONSENSUS_BONUS = 60;

function canonicalKey(exception: boolean, important: boolean, c: DnrCondition): string {
  return JSON.stringify([
    exception,
    important,
    c.urlFilter ?? c.regexFilter ?? '',
    [...(c.resourceTypes ?? [])].sort(),
    [...(c.excludedResourceTypes ?? [])].sort(),
    c.domainType ?? '',
    [...(c.initiatorDomains ?? [])].sort(),
    [...(c.excludedInitiatorDomains ?? [])].sort(),
  ]);
}

/** badfilter 的抵消键：与目标规则一致，但不含 badfilter 标记本身。 */
function badfilterKey(f: ParsedFilter): string {
  return JSON.stringify([
    f.exception,
    f.important,
    f.pattern,
    [...(f.resourceTypes ?? [])].sort(),
    [...(f.excludedResourceTypes ?? [])].sort(),
    f.domainType ?? '',
    [...(f.initiatorDomains ?? [])].sort(),
    [...(f.excludedInitiatorDomains ?? [])].sort(),
  ]);
}

/** 判断模式是否为"纯域名锚点"（覆盖最广、最值钱的一类）。 */
function isDomainAnchor(pattern: string, regex: boolean): boolean {
  if (regex) return false;
  return /^\|\|[a-z0-9.-]+\^?$/i.test(pattern);
}

function valueOf(f: ParsedFilter): number {
  let v = 0;
  if (isDomainAnchor(f.pattern, f.regex)) v += 1000;
  else if (!f.regex && f.pattern.startsWith('||')) v += 500;
  else if (!f.regex && f.pattern.startsWith('|')) v += 200;
  else v += 50;

  if (f.initiatorDomains?.length) v -= 50;
  if (f.excludedInitiatorDomains?.length) v -= 20;
  if (f.domainType === 'thirdParty') v += 10;
  if (f.important) v += 30;
  return v;
}

function toCandidate(
  f: ParsedFilter,
  opts: Required<CompileOptions>,
): { candidate: Candidate } | { dropped: string } {
  const condition: DnrCondition = {};

  if (f.regex) {
    const simplified = simplifyRegex(f.pattern.slice(1, -1));
    if (simplified) condition.urlFilter = simplified;
    else condition.regexFilter = f.pattern;
  } else {
    // `||*` 开头被 DNR 明确禁止（任何一条非法规则都会让整个扩展装不上），
    // 按官方建议规范化成 `*` 开头。改动量在 compileFilters 里统计。
    condition.urlFilter = normalizeUrlFilter(f.pattern).value;
  }

  // 最后一道过滤：urlFilter 语法不合法就丢弃这条规则。
  //
  // 为什么是"丢弃"而不是"交给校验器报错"：一条非法规则会让**整个扩展装不上**，
  // 而这类问题来自上游清单的写法瑕疵（实测：`||*xav.*/guang/*.gif`、
  // 中段带 `|` 的模式），数量极少、价值可忽略。丢掉它们比让用户装不上强得多。
  // 校验器仍然保留，作为"编译器本不该产出这种东西"的断言。
  if (condition.urlFilter) {
    const problem = urlFilterProblem(condition.urlFilter);
    if (problem) return { dropped: `invalid-urlfilter` };
  }

  if (f.matchCase) condition.isUrlFilterCaseSensitive = true;
  if (f.domainType) condition.domainType = f.domainType;
  if (f.initiatorDomains?.length) condition.initiatorDomains = f.initiatorDomains;
  if (f.excludedInitiatorDomains?.length) {
    condition.excludedInitiatorDomains = f.excludedInitiatorDomains;
  }

  const allowMainFrame = opts.allowMainFrame;
  if (f.resourceTypes?.length) {
    // 显式写了类型的规则照原意执行 —— 包括显式 $document（那是刻意拦主文档，
    // 见文件头第 1 条偏离）。这里**不能**把 main_frame 过滤掉，
    // 否则 `||x^$document` 会被整条丢弃，与设计意图相反。
    condition.resourceTypes = f.resourceTypes;
  } else if (f.excludedResourceTypes?.length) {
    // 排除型：只用 excludedResourceTypes。
    // ⚠️ 绝不能同时写 resourceTypes —— 官方约束是
    // "Only one of resourceTypes and excludedResourceTypes should be specified"，
    // 同时写会让规则非法（实测曾因此导致**整个扩展加载失败**，而且只在浏览器里
    // 才暴露出来）。不写 resourceTypes 时默认是"除主文档外全部"，
    // 所以只要把主文档补进排除表即可。
    const excluded = [...f.excludedResourceTypes];
    if (!allowMainFrame && !excluded.includes('main_frame')) excluded.push('main_frame');
    condition.excludedResourceTypes = excluded;
  } else {
    // 无类型选项：ABP 语义是"全部类型"（含主文档）。
    //
    // ⚠️ 但据官方文档：**"If neither of them is specified, all resource types
    // except main_frame are blocked."** 也就是说"除主文档外全部"正是 DNR 的默认，
    // 因此这里**什么也不写**即可 —— 比展开 11 种类型既准确又省空间，
    // 还能让更多规则共享同一条件签名（对域名打包有利）。
    //
    // 这同时实现了文件头第 1 条偏离：默认不拦主文档。
    if (allowMainFrame) {
      condition.resourceTypes = [...ALL_SUBRESOURCE_TYPES, 'main_frame'];
    }
  }

  return {
    candidate: {
      key: canonicalKey(f.exception, f.important, condition),
      exception: f.exception,
      important: f.important,
      condition,
      value: valueOf(f),
      regex: Boolean(condition.regexFilter),
      sources: new Set(f.source ? [f.source] : []),
    },
  };
}

/** 纯域名锚点（无路径、无作用域）的解析结果。 */
function domainAnchorOf(c: Candidate): { domain: string } | null {
  if (c.regex) return null;
  if (c.condition.initiatorDomains?.length) return null;
  if (c.condition.excludedInitiatorDomains?.length) return null;
  const m = /^\|\|([a-z0-9.-]+)\^?$/i.exec(c.condition.urlFilter ?? '');
  if (!m) return null;
  // 只接受形状正确的域名：上游列表里有 `||allyes.$third-party`、`||check-tl-$all`
  // 这类残缺模式，当成域名打包会产出非法规则（实测导致扩展加载失败）。
  if (!isValidRequestDomain(m[1]!)) return null;
  return { domain: m[1]!.toLowerCase() };
}

/**
 * 按域名归并同类规则。
 *
 * ## 为什么这是必要的（实测数据驱动）
 *
 * 首次编译（2026-10-11，六份列表）的实测：域名锚点可用 **120,585** 条，
 * 而预算只允许保留 24,000 条 —— 丢掉 96,700 条，且选择是**任意的**
 * （按输入顺序，结果是 EasyPrivacy 几乎全被丢掉，只剩前两份列表的前段）。
 *
 * 但列表里同一个域名常有多个变体：
 *   `||d^$third-party`、`||d^$script`、`||d^$image,script`、`||d^`
 * 它们可以安全地合并成一条 `||d^$script,image`（甚至 `||d^`）。
 * 归并后**同一个预算能覆盖多得多的域名**。
 *
 * ## 为什么合并是语义安全的
 *
 * 合并取的是**各条意图的并集**：`$script` 与 `$image` 并成 `$script,image`；
 * 一条不限类型 + 一条限类型 → 不限类型；`$third-party` 与 `$first-party`
 * 并成"不限"。这与"这些规则同时存在"的最终效果一致。
 *
 * ## 为什么只归并"无作用域"的规则
 *
 * 带 `$domain=site.com` 的规则是**站点专用**的（无论拦截还是例外）。
 * 把它归并成全局规则会：拦截规则变成全局过度拦截，例外规则变成全局放行
 * （可能放走广告）。因此这类规则一律不参与归并。
 */
function collapseByDomain(candidates: Map<string, Candidate>): {
  collapsed: Map<string, Candidate>;
  mergedAway: number;
} {
  const byDomain = new Map<string, Candidate>();
  const passthrough = new Map<string, Candidate>();
  let mergedAway = 0;

  for (const [key, c] of candidates) {
    const anchor = domainAnchorOf(c);
    if (!anchor) {
      passthrough.set(key, c);
      continue;
    }

    const groupKey = `${c.exception ? 'allow' : 'block'}|${anchor.domain}`;
    const existing = byDomain.get(groupKey);
    if (!existing) {
      // 统一成带 ^ 的形式：更精确，避免 `||domain` 匹配到 `domainfoo.com`
      byDomain.set(groupKey, { ...c, condition: { ...c.condition, urlFilter: `||${anchor.domain}^` } });
      continue;
    }

    mergedAway += 1;
    // 类型限制的并集：
    //   - 任一方**没写**类型（语义是"除主文档外全部"，最宽）→ 合并后也不写类型
    //   - 否则取两边类型的并集
    // ⚠️ 早期版本在两边都没写类型时生成了 `resourceTypes: []` —— 空数组是非法规则，
    // 会让整个扩展加载失败（由构建期自检抓到）。
    const eitherUntyped =
      existing.condition.resourceTypes === undefined || c.condition.resourceTypes === undefined;
    const mergedTypes = new Set<ResourceType>([
      ...(existing.condition.resourceTypes ?? []),
      ...(c.condition.resourceTypes ?? []),
    ]);
    for (const s of c.sources) existing.sources.add(s);
    const mergedCondition: DnrCondition = {
      ...existing.condition,
      urlFilter: `||${anchor.domain}^`,
    };
    if (eitherUntyped) {
      delete mergedCondition.resourceTypes;
    } else if (mergedTypes.size >= ALL_SUBRESOURCE_TYPES.length) {
      delete mergedCondition.resourceTypes;
    } else {
      mergedCondition.resourceTypes = [...mergedTypes];
    }
    const merged: Candidate = {
      key: existing.key,
      exception: existing.exception,
      important: existing.important || c.important,
      value: Math.max(existing.value, c.value),
      regex: false,
      sources: existing.sources,
      condition: mergedCondition,
    };
    // 一方限第三方、另一方不限 → 取"不限"
    if (existing.condition.domainType !== c.condition.domainType) {
      delete merged.condition.domainType;
    }
    // 大小写敏感只有全部成员都敏感时才算敏感（否则会漏拦）
    if (!(existing.condition.isUrlFilterCaseSensitive && c.condition.isUrlFilterCaseSensitive)) {
      delete merged.condition.isUrlFilterCaseSensitive;
    }
    byDomain.set(groupKey, merged);
  }

  const out = new Map<string, Candidate>();
  for (const [k, v] of passthrough) out.set(k, v);
  for (const [k, v] of byDomain) out.set(`collapsed|${k}`, v);
  return { collapsed: out, mergedAway };
}

/**
 * 按列表配额挑选拦截规则。
 *
 * 两段式：
 *   1. 每份列表先按自己的配额取（内部按价值分、再按域名层级浅的优先 ——
 *      层级浅的域名覆盖更广：`doubleclick.net` 比 `a.b.c.example.com` 值钱）
 *   2. 配额没用满的列表腾出的余量，再按全局价值分补满
 */
function selectBlocksByQuota(
  blocks: Candidate[],
  budget: number,
  opts: Required<CompileOptions>,
): Candidate[] {
  const rank = (a: Candidate, b: Candidate): number =>
    b.value - a.value || labelDepth(a) - labelDepth(b);

  const bySource = new Map<string, Candidate[]>();
  for (const c of blocks) {
    // 归并后的候选可能来自多个列表；配额归属取第一个来源
    const key = c.sources.size ? [...c.sources][0]! : '(unknown)';
    const list = bySource.get(key);
    if (list) list.push(c);
    else bySource.set(key, [c]);
  }

  const picked: Candidate[] = [];
  const pickedSet = new Set<Candidate>();
  for (const [source, list] of bySource) {
    const quota = opts.listQuotas[source] ?? opts.defaultListQuota;
    list.sort(rank);
    for (const c of list.slice(0, quota)) {
      if (picked.length >= budget) break;
      picked.push(c);
      pickedSet.add(c);
    }
  }

  if (picked.length < budget) {
    const rest = blocks.filter((c) => !pickedSet.has(c)).sort(rank);
    for (const c of rest) {
      if (picked.length >= budget) break;
      picked.push(c);
    }
  }

  return picked;
}

/** 域名层级数（越少越"上位"，覆盖越广）。非域名锚点返回很大值。 */
function labelDepth(c: Candidate): number {
  const m = /^\|\|([a-z0-9.-]+)\^/i.exec(c.condition.urlFilter ?? '');
  if (!m) return 99;
  return m[1]!.split('.').length;
}
/**
 * 单条规则里最多塞多少个域名。
 *
 * 官方**没有文档化的上限**；实测 uBOL 单条规则装了约 3,500 个域名。
 * 这里取 2,000，留出足够余量，同时避免单条规则 JSON 过大。
 */
export const MAX_DOMAINS_PER_RULE = 2_000;

type PackGroup = {
  condition: DnrCondition;
  domains: string[];
  exception: boolean;
  important: boolean;
  value: number;
  sources: Set<string>;
};

/**
 * 把"纯域名锚点"候选打包成 `requestDomains` 规则。
 *
 * 条件（同样是域名、同样的类型限制、同样是拦截或例外、同样 important）
 * 完全一致的域名归到一组，一组产出若干条规则（按 MAX_DOMAINS_PER_RULE 切）。
 *
 * 这一步是**覆盖面的决定性改进**：不做它，12 万个域名要被 3 万条预算砍掉 80%；
 * 做了它，几乎所有域名都能进规则集。
 */
function packDomainAnchors(list: Candidate[]): {
  groups: PackGroup[];
  packedDomains: number;
  domainsBySource: Record<string, number>;
} {
  const groups = new Map<string, PackGroup>();
  const domainsBySource: Record<string, number> = {};
  let packedDomains = 0;

  for (const c of list) {
    const m = /^\|\|([a-z0-9.-]+)\^$/i.exec(c.condition.urlFilter ?? '');
    if (!m) continue;
    if (!isValidRequestDomain(m[1]!)) continue;
    // 带 initiatorDomains 的规则不适合打包成共享域名表（作用域不同）
    if (c.condition.initiatorDomains?.length) continue;
    if (c.condition.excludedInitiatorDomains?.length) continue;

    const rest: DnrCondition = { ...c.condition };
    delete rest.urlFilter;
    const signature = JSON.stringify([c.exception, c.important, rest]);

    let g = groups.get(signature);
    if (!g) {
      g = {
        condition: rest,
        domains: [],
        exception: c.exception,
        important: c.important,
        value: c.value,
        sources: new Set<string>(),
      };
      groups.set(signature, g);
    }
    g.domains.push(m[1]!.toLowerCase());
    for (const s of c.sources) {
      g.sources.add(s);
      // 按**域名**计数（不是按组）：一个组会混合多份列表的域名，
      // 按组累加会重复计数（曾经因此得出 11 万这种明显错误的数字）
      domainsBySource[s] = (domainsBySource[s] ?? 0) + 1;
    }
    packedDomains += 1;
  }

  for (const g of groups.values()) g.domains = [...new Set(g.domains)].sort();
  return { groups: [...groups.values()], packedDomains, domainsBySource };
}

/**
 * 编译一批解析结果。
 *
 * 顺序很重要：**先 badfilter 抵消 → 去重（合并来源）→ 按域名归并
 * → 域名打包 → 剩余部分按配额裁剪**。
 *
 * 裁剪时**优先保住全部例外规则** —— 例外是防站点损坏的主力，
 * 只留拦截不留例外会让站点直接坏掉。
 */
export function compileFilters(
  filters: ParsedFilter[],
  options: CompileOptions,
): CompileResult {
  const opts: Required<CompileOptions> = {
    budget: options.budget,
    rulesetSize: options.rulesetSize,
    regexBudget: options.regexBudget,
    allowMainFrame: options.allowMainFrame ?? false,
    listQuotas: options.listQuotas ?? {},
    defaultListQuota: options.defaultListQuota ?? options.budget,
  };

  const dropped: Record<string, number> = {};
  const drop = (reason: string, n = 1): void => {
    dropped[reason] = (dropped[reason] ?? 0) + n;
  };

  // `||*` 开头的模式被规范化成 `*` 开头的条数（会略微放宽，计入报告）
  const normalizedPatterns = filters.filter((f) => !f.regex && f.pattern.startsWith('||*')).length;

  // ① badfilter 抵消
  const cancelled = new Set<string>();
  for (const f of filters) {
    if (f.badfilter) cancelled.add(badfilterKey(f));
  }

  const candidates = new Map<string, Candidate>();
  let afterBadfilter = 0;
  for (const f of filters) {
    if (f.badfilter) continue;
    if (cancelled.has(badfilterKey(f))) {
      drop('badfilter-cancelled');
      continue;
    }
    afterBadfilter += 1;

    const result = toCandidate(f, opts);
    if ('dropped' in result) {
      drop(result.dropped);
      continue;
    }
    const c = result.candidate;
    const existing = candidates.get(c.key);
    if (existing) {
      // 去重：合并来源列表（共识信号），保留价值更高的条件
      for (const s of c.sources) existing.sources.add(s);
      existing.value = Math.max(existing.value, c.value);
      drop('duplicate');
    } else {
      candidates.set(c.key, c);
    }
  }

  // 共识加成：出现在越多列表里，越可能是真广告/追踪域名。
  // 必须在去重之后统一施加（去重时各条规则的 sources 才合并完整）。
  // ⚠️ 不能对 12 万元素用展开运算符（Math.max(...arr) 会栈溢出）。
  let consensusSingle = 0;
  let consensusMulti = 0;
  let consensusMax = 0;
  for (const c of candidates.values()) {
    if (c.sources.size <= 1) consensusSingle += 1;
    else consensusMulti += 1;
    if (c.sources.size > consensusMax) consensusMax = c.sources.size;
    if (c.sources.size > 1) c.value += (c.sources.size - 1) * CONSENSUS_BONUS;
  }
  const consensus = { single: consensusSingle, multi: consensusMulti, maxLists: consensusMax };

  // ② 按域名归并（同一域名的多个变体压成一条，让预算覆盖更多域名）
  const { collapsed, mergedAway } = collapseByDomain(candidates);

  // ③ 域名打包：把"纯域名锚点"压成 requestDomains 规则（覆盖面的决定性一步）
  const all = [...collapsed.values()];
  const isPackable = (c: Candidate): boolean =>
    !c.regex &&
    !c.condition.initiatorDomains?.length &&
    !c.condition.excludedInitiatorDomains?.length &&
    /^\|\|[a-z0-9.-]+\^$/i.test(c.condition.urlFilter ?? '');

  const packable = all.filter(isPackable);
  const rest = all.filter((c) => !isPackable(c));
  const { groups, packedDomains, domainsBySource } = packDomainAnchors(packable);

  const packedRules: DnrListRule[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.domains.length; i += MAX_DOMAINS_PER_RULE) {
      packedRules.push({
        id: 0, // 稍后统一编号
        priority: g.exception
          ? g.important
            ? PRIORITY.listImportantAllow
            : PRIORITY.listAllow
          : g.important
            ? PRIORITY.listImportantBlock
            : PRIORITY.listBlock,
        action: { type: g.exception ? 'allow' : 'block' },
        condition: { ...g.condition, requestDomains: g.domains.slice(i, i + MAX_DOMAINS_PER_RULE) },
      });
    }
  }

  // ④ 剩余部分（路径规则、正则、带作用域的规则）按配额裁剪
  const exceptions = rest.filter((c) => c.exception);
  const blocks = rest.filter((c) => !c.exception);

  // 例外优先保留。上限取 max(50, 25%)：小批量编译时 25% 会小到只有 1 条，
  // 而例外正是防站点损坏的主力，不该在规模小时被掐掉。
  const remainingBudget = Math.max(0, opts.budget - packedRules.length);
  const exceptionReserve = Math.min(
    exceptions.length,
    Math.max(50, Math.floor(opts.budget * 0.25)),
    remainingBudget,
  );
  const keptExceptions = [...exceptions].sort((a, b) => b.value - a.value).slice(0, exceptionReserve);
  if (exceptions.length > keptExceptions.length) {
    drop('exception-over-reserve', exceptions.length - keptExceptions.length);
  }

  const blockBudget = remainingBudget - keptExceptions.length;
  const keptBlocks = selectBlocksByQuota(blocks, Math.max(0, blockBudget), opts);
  if (blocks.length > keptBlocks.length) drop('over-budget', blocks.length - keptBlocks.length);

  // ⑤ 正则预算（DNR 对 regexFilter 有独立的、更小的限额）
  let regexUsed = 0;
  const selected: Candidate[] = [];
  for (const c of [...keptExceptions, ...keptBlocks]) {
    if (c.regex) {
      if (regexUsed >= opts.regexBudget) {
        drop('over-regex-budget');
        continue;
      }
      regexUsed += 1;
    }
    selected.push(c);
  }

  // ⑥ 合并「打包规则」与「逐条规则」，统一编号，按 rulesetSize 分卷
  const restRules: DnrListRule[] = selected.map((c) => ({
    id: 0,
    priority: c.exception
      ? c.important
        ? PRIORITY.listImportantAllow
        : PRIORITY.listAllow
      : c.important
        ? PRIORITY.listImportantBlock
        : PRIORITY.listBlock,
    action: { type: c.exception ? 'allow' : 'block' },
    condition: c.condition,
  }));

  const rules: DnrListRule[] = [...packedRules, ...restRules].map((r, i) => ({ ...r, id: i + 1 }));

  const rulesets: DnrListRule[][] = [];
  for (let i = 0; i < rules.length; i += opts.rulesetSize) {
    rulesets.push(rules.slice(i, i + opts.rulesetSize));
  }

  // 分布统计：用于回答"我们丢掉了什么、还剩多少余地"
  const availableDomainAnchors = packable.length;
  const availableRegex = all.filter((c) => c.regex).length;
  const availableExceptions = all.filter((c) => c.exception).length;

  // 每份列表实际覆盖了多少（按域名计数）
  const keptByList: Record<string, number> = { ...domainsBySource };
  for (const c of [...keptBlocks, ...keptExceptions]) {
    for (const s of c.sources) keptByList[s] = (keptByList[s] ?? 0) + 1;
  }

  const report: CompileReport = {
    input: filters.length,
    afterBadfilter,
    deduped: candidates.size,
    collapsedDomains: mergedAway,
    compiled: rules.length,
    exceptions: keptExceptions.length,
    regex: regexUsed,
    domainAnchored: selected.filter((c) => c.condition.urlFilter?.startsWith('||')).length,
    dropped,
    budget: opts.budget,
    budgetUsed: rules.length,
    budgetTruncated: blocks.length - keptBlocks.length,
    rulesetCount: rulesets.length,
    packedDomains,
    packedRules: packedRules.length,
    normalizedPatterns,
    consensus,
    keptByList,
    available: {
      domainAnchors: availableDomainAnchors,
      regex: availableRegex,
      exceptions: availableExceptions,
      blocks: blocks.length,
    },
  };

  return { rulesets, report };
}
