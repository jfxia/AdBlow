/**
 * Self-check for generated rulesets.
 *
 * Measured 2026-10-11: 119 rules once carried both `resourceTypes` and
 * `excludedResourceTypes`; the docs allow only one of them, and the browser then
 * refused to load the whole extension — with no Node-side symptom at all. So rule
 * validity must fail the **build**: a failed build beats an uninstallable extension.
 *
 * Constraints per the Chrome declarativeNetRequest docs (see
 * docs/plans/2026-10-11-filter-list-integration.md).
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
 * `urlFilter` syntax check.
 *
 * Measured 2026-10-11: one rule with an illegal urlFilter makes the browser reject
 * the entire extension (`Rule with id 2783 specifies an incorrect value for the
 * "urlFilter" key`) — one bad rule among 20,000 and nothing installs, invisibly
 * from Node. Special characters are only `*`, `|`, `^`, and a leading `||*` is
 * explicitly forbidden ("A pattern beginning with `||*` is not allowed. Use `*`
 * instead.").
 */
export function urlFilterProblem(urlFilter: string): string | null {
  if (!urlFilter) return 'urlFilter 为空';
  // Must be ASCII (DNR matches the punycode + percent-encoded URL)
  if (!/^[\x20-\x7E]+$/.test(urlFilter)) return 'urlFilter 含非 ASCII 字符';
  if (/[\s]/.test(urlFilter)) return 'urlFilter 含空白字符';
  if (urlFilter.startsWith('||*')) return '||* 开头被明确禁止（应改用 * 开头）';
  if (urlFilter === '||' || urlFilter === '|') return 'urlFilter 只有锚点没有模式';
  // `|` is only meaningful at either end; mid-string it is a list typo
  const inner = urlFilter.slice(urlFilter.startsWith('||') ? 2 : urlFilter.startsWith('|') ? 1 : 0);
  const withoutRightAnchor = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  if (withoutRightAnchor.includes('|')) return 'urlFilter 中段出现 | （只在两端有意义）';
  return null;
}

/**
 * Normalize `||*`-prefixed patterns as the docs advise.
 *
 * "Use `*` instead" means dropping the domain anchor while keeping the wildcard
 * pattern. That is slightly wider than the original, so callers must report it.
 */
export function normalizeUrlFilter(urlFilter: string): { value: string; changed: boolean } {
  if (urlFilter.startsWith('||*')) {
    return { value: urlFilter.slice(2), changed: true };
  }
  return { value: urlFilter, changed: false };
}
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SINGLE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Whether a value is genuinely usable as a `requestDomains` entry (or IPv4 literal).
 *
 * Measured 2026-10-11: upstream lists contain truncated domain patterns such as
 * `||allyes.$third-party` (missing `.com^`) and `||check-tl-$all` (missing TLD). A
 * loose `[a-z0-9.-]+` would pack `allyes.` / `check-tl-` as domains → illegal rules
 * → the extension will not load. Malformed values fall back to `urlFilter`, so the
 * list author's intent still applies, just without domain packing.
 */
export function isValidRequestDomain(value: string): boolean {
  if (DOMAIN_RE.test(value)) return true;
  const m = IPV4_RE.exec(value);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  return false;
}

/**
 * Whether a value may appear in a DNR domain list (`requestDomains`,
 * `excludedRequestDomains`, and by extension the initiator lists).
 *
 * Looser than isValidRequestDomain by one label on purpose: `$to=com` means "any
 * .com host", and Chromium's domain lists accept it — `PopulateIncludedAndExcludedDomains`
 * (components/url_pattern_index) only rejects non-ASCII entries and trims trailing
 * dots, while matching uses `url::DomainIs` plus a longest-suffix comparison, which
 * a single label supports. Packing still requires a full domain, because a packed
 * table is built from `||domain^` patterns and `com` there would mean every .com site.
 *
 * Non-ASCII is rejected because Chromium refuses a rule whose domain entry is not
 * ASCII (internationalized hosts must be punycode).
 */
export function isValidDomainListEntry(value: string): boolean {
  if (isValidRequestDomain(value)) return true;
  return SINGLE_LABEL_RE.test(value);
}

export type RuleProblem = { ruleset: number; ruleId: number; problem: string };

/** Per-ruleset regex limit (official MAX_NUMBER_OF_REGEX_RULES). */
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

    // At least one matcher, or the rule matches everything
    const hasMatcher = Boolean(c.urlFilter || c.regexFilter || c.requestDomains?.length);
    if (!hasMatcher) at('没有任何匹配条件（会匹配一切）');

    if (c.urlFilter && c.regexFilter) at('urlFilter 与 regexFilter 不能同时存在');
    if (c.urlFilter) {
      const problem = urlFilterProblem(c.urlFilter);
      if (problem) at(problem);
    }
    if (c.regexFilter) regexCount += 1;

    // ⚠️ Exactly this constraint once made the whole extension fail to load
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
      if (!isValidDomainListEntry(d)) at(`requestDomains 含非法域名: ${d}`);
    }

    if (c.excludedRequestDomains && c.excludedRequestDomains.length === 0) {
      at('excludedRequestDomains 为空数组');
    }
    for (const d of c.excludedRequestDomains ?? []) {
      if (!isValidDomainListEntry(d)) at(`excludedRequestDomains 含非法域名: ${d}`);
    }

    if (c.initiatorDomains && c.initiatorDomains.length === 0) at('initiatorDomains 为空数组');
    if (c.excludedInitiatorDomains && c.excludedInitiatorDomains.length === 0) {
      at('excludedInitiatorDomains 为空数组');
    }

    // Main-document discipline: main frames are not blocked by default.
    //
    // Only the *implicit* case is flagged: excludedResourceTypes set without
    // excluding main_frame means "everything but X", so main frames get blocked by
    // accident. Explicit `$document` rules are intentional (a compiler deviation,
    // see compile.ts) and two unset fields is the DNR default, so neither is a
    // problem.
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
