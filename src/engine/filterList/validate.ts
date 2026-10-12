/**
 * 生成规则集的自检。
 *
 * ## 为什么必须有这个文件
 *
 * 2026-10-11 实测踩坑：编译器一度让 119 条规则**同时**带 `resourceTypes` 和
 * `excludedResourceTypes`。官方约束是「二者只能出现其一」，于是浏览器
 * **整个扩展都加载不起来** —— 而这个错误在 Node 侧完全没有迹象，
 * 只有打开浏览器才暴露，排查代价很高。
 *
 * 因此把「规则是否合法」变成**构建期就失败**的检查：宁可构建报错，
 * 也不要产出一个装不上的扩展。
 *
 * 约束依据：Chrome declarativeNetRequest 官方文档（见
 * docs/plans/2026-10-11-filter-list-integration.md 的调研结论）。
 */
import type { ResourceType } from '../rules.ts';
import type { DnrListRule } from './compile.ts';

const ALLOWED_TYPES = new Set<ResourceType>([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
]);

/**
 * `urlFilter` 语法校验。
 *
 * ## 为什么必须逐条校验（血的教训）
 *
 * 2026-10-11 实测：**任何一条规则的 urlFilter 非法，浏览器就拒绝加载整个扩展**
 * （日志：`Rule with id 2783 specifies an incorrect value for the "urlFilter" key`）。
 * 也就是说规则集里 2 万条规则，错一条就等于整个 AdBlow 装不上。
 * 本地 Node 侧完全看不出问题，只有开浏览器才知道。
 *
 * 依据官方文档的 urlFilter 语法：`(可选左锚点/域名锚点) + 模式 + (可选右锚点)`，
 * 特殊字符只有 `*`、`|`、`^`；其中 **`||*` 开头是明确禁止的**
 * （"A pattern beginning with `||*` is not allowed. Use `*` instead."）。
 */
export function urlFilterProblem(urlFilter: string): string | null {
  if (!urlFilter) return 'urlFilter 为空';
  // 必须 ASCII（DNR 匹配的是 punycode + 百分号编码后的 URL）
  if (!/^[\x20-\x7E]+$/.test(urlFilter)) return 'urlFilter 含非 ASCII 字符';
  if (/[\s]/.test(urlFilter)) return 'urlFilter 含空白字符';
  if (urlFilter.startsWith('||*')) return '||* 开头被明确禁止（应改用 * 开头）';
  if (urlFilter === '||' || urlFilter === '|') return 'urlFilter 只有锚点没有模式';
  // `|` 只在两端有意义；出现在中间通常是清单里的错误写法
  const inner = urlFilter.slice(urlFilter.startsWith('||') ? 2 : urlFilter.startsWith('|') ? 1 : 0);
  const withoutRightAnchor = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  if (withoutRightAnchor.includes('|')) return 'urlFilter 中段出现 | （只在两端有意义）';
  return null;
}

/**
 * 按官方建议把 `||*` 开头的模式规范化。
 *
 * 文档原话是 "Use `*` instead"，即把域名锚点去掉、保留 `*` 开头的通配模式。
 * 这会比原模式略宽（不再要求域名锚定），因此调用方应把改动计入报告。
 */
export function normalizeUrlFilter(urlFilter: string): { value: string; changed: boolean } {
  if (urlFilter.startsWith('||*')) {
    return { value: urlFilter.slice(2), changed: true };
  }
  return { value: urlFilter, changed: false };
}
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * 是否是**真正可用作 `requestDomains` 的域名**（或 IPv4 字面量）。
 *
 * ## 为什么必须严格
 *
 * 实测（2026-10-11）：上游列表里存在**残缺的域名模式**，例如
 *   `||allyes.$third-party`   （缺 `.com^`）
 *   `||check-tl-$all`        （缺 TLD）
 *   `||valid-check-tl-$all`
 * 宽泛的 `[a-z0-9.-]+` 会把 `allyes.`、`check-tl-` 这类残片当成域名塞进
 * `requestDomains`，**产出非法规则 → 整个扩展加载不起来**。
 *
 * 因此打包只接受形状正确的域名；残缺的一律退回 `urlFilter`（列表作者的原意
 * 仍然生效，只是不做域名打包）。
 */
export function isValidRequestDomain(value: string): boolean {
  if (DOMAIN_RE.test(value)) return true;
  const m = IPV4_RE.exec(value);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  return false;
}

export type RuleProblem = { ruleset: number; ruleId: number; problem: string };

/** 单个规则集允许的正则规则数上限（官方常量 MAX_NUMBER_OF_REGEX_RULES）。 */
export const MAX_REGEX_RULES = 1_000;

export function validateRuleset(rules: DnrListRule[], rulesetIndex: number): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const seen = new Set<number>();
  let regexCount = 0;

  for (const r of rules) {
    const c = r.condition;
    const at = (problem: string): void => {
      problems.push({ ruleset: rulesetIndex, ruleId: r.id, problem });
    };

    if (!Number.isInteger(r.id) || r.id < 1) at(`非法 id: ${String(r.id)}`);
    if (seen.has(r.id)) at(`id 重复: ${r.id}`);
    seen.add(r.id);

    if (!Number.isInteger(r.priority) || r.priority < 1) at(`非法 priority: ${String(r.priority)}`);
    if (r.action.type !== 'block' && r.action.type !== 'allow') at(`非法 action: ${r.action.type}`);

    // 匹配条件：至少有一个，否则会匹配"一切"
    const hasMatcher = Boolean(c.urlFilter || c.regexFilter || c.requestDomains?.length);
    if (!hasMatcher) at('没有任何匹配条件（会匹配一切）');

    if (c.urlFilter && c.regexFilter) at('urlFilter 与 regexFilter 不能同时存在');
    if (c.urlFilter) {
      const problem = urlFilterProblem(c.urlFilter);
      if (problem) at(problem);
    }
    if (c.regexFilter) regexCount += 1;

    // ⚠️ 就是这条约束曾经让整个扩展加载失败
    if (c.resourceTypes && c.excludedResourceTypes) {
      at('resourceTypes 与 excludedResourceTypes 不能同时存在');
    }
    if (c.resourceTypes && c.resourceTypes.length === 0) at('resourceTypes 为空数组');
    for (const t of c.resourceTypes ?? []) {
      if (!ALLOWED_TYPES.has(t)) at(`未知资源类型: ${t}`);
    }
    for (const t of c.excludedResourceTypes ?? []) {
      if (!ALLOWED_TYPES.has(t)) at(`未知资源类型: ${t}`);
    }

    if (c.requestDomains && c.requestDomains.length === 0) at('requestDomains 为空数组');
    for (const d of c.requestDomains ?? []) {
      if (!isValidRequestDomain(d)) at(`requestDomains 含非法域名: ${d}`);
    }

    if (c.initiatorDomains && c.initiatorDomains.length === 0) at('initiatorDomains 为空数组');
    if (c.excludedInitiatorDomains && c.excludedInitiatorDomains.length === 0) {
      at('excludedInitiatorDomains 为空数组');
    }

    // 主文档纪律：默认不拦主文档。
    //
    // 只检查**非显式**的那一种：写了 excludedResourceTypes 却没排除 main_frame
    // （= "除 X 外全部"，含主文档，属于无意中拦了主文档）。
    //
    // 显式写了 $document 的规则是**有意为之**（编译器的既定偏离：列表里
    // 明确的 `$document` 规则才拦主文档），不算问题。
    // 两个字段都不写时，DNR 默认就是"除主文档外全部"，也不算问题。
    const accidentallyBlocksMainFrame =
      c.resourceTypes === undefined &&
      c.excludedResourceTypes !== undefined &&
      !c.excludedResourceTypes.includes('main_frame');
    if (r.action.type === 'block' && accidentallyBlocksMainFrame) {
      at('拦截规则会意外命中主文档（写了 excludedResourceTypes 但没排除 main_frame）');
    }
  }

  if (regexCount > MAX_REGEX_RULES) {
    problems.push({
      ruleset: rulesetIndex,
      ruleId: 0,
      problem: `正则规则 ${regexCount} 条，超过上限 ${MAX_REGEX_RULES}`,
    });
  }

  return problems;
}

export function validateRulesets(rulesets: DnrListRule[][]): RuleProblem[] {
  return rulesets.flatMap((rules, i) => validateRuleset(rules, i + 1));
}
