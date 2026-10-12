/**
 * 过滤列表语法解析（EasyList / Adblock Plus 语法 → 中间模型）。
 *
 * ⚠️ 核心安全原则：**遇到不认识的选项就丢弃整条规则**，绝不"忽略选项继续拦"。
 * 例如 `||x.com^$csp=...`：我们表达不了 `$csp`，如果忽略它就变成"拦 x.com 的全部"，
 * 比原规则**范围更宽** —— 这类静默放宽正是最容易造成站点损坏的地方。
 *
 * 本模块浏览器无关，可在 Node 里直接单测。
 */
import type { ResourceType } from '../rules.ts';

/** 一条解析成功的网络规则。 */
export type ParsedFilter = {
  raw: string;
  /** 来源列表 id（由 parseList 填入，用于"多列表共识"排序）。 */
  source?: string;
  /** `@@` 开头（例外规则）。 */
  exception: boolean;
  /** 模式部分（已去掉选项）。 */
  pattern: string;
  /** 模式是否为正则形式 `/.../ `。 */
  regex: boolean;
  /** `$badfilter`：抵消同模式的规则。 */
  badfilter: boolean;
  important: boolean;
  matchCase: boolean;
  /** 未指定类型 → undefined（表示"除 main_frame 外的全部"，见 compile 的说明）。 */
  resourceTypes?: ResourceType[];
  excludedResourceTypes?: ResourceType[];
  /** `$domain=` 的肯定部分 → DNR initiatorDomains。 */
  initiatorDomains?: string[];
  /** `$domain=` 的否定部分（`~b.com`）→ DNR excludedInitiatorDomains。 */
  excludedInitiatorDomains?: string[];
  /** `$third-party` → 'thirdParty'；`~third-party`/`$first-party` → 'firstParty'。 */
  domainType?: 'firstParty' | 'thirdParty';
};

/** 解析结果：要么是一条网络规则，要么被跳过（附原因，用于覆盖率报告）。 */
export type ParseOutcome =
  | { kind: 'network'; filter: ParsedFilter }
  | { kind: 'cosmetic'; raw: string; flavor: 'basic' | 'extended' | 'scriptlet' | 'html' | 'style' }
  | { kind: 'skip'; raw: string; reason: string };

/** 类型选项 → DNR 资源类型。 */
const TYPE_MAP: Record<string, ResourceType> = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  'css': 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  document: 'main_frame',
  doc: 'main_frame',
  ping: 'ping',
  websocket: 'websocket',
  media: 'media',
  font: 'font',
  other: 'other',
  webrtc: 'other',
};

/** 无法表达、必须丢弃整条规则的选项（丢弃而不是忽略 —— 见文件头）。 */
const UNSUPPORTED_OPTIONS = new Set([
  'csp',
  'redirect',
  'redirect-rule',
  'removeparam',
  'removeheader',
  'generichide',
  'ghide',
  'genericblock',
  'elemhide',
  'ehide',
  'specifichide',
  'shide',
  'inline-script',
  'inline-font',
  'popup',
  'popunder',
  'empty',
  'rewrite',
  'permissions',
  'urltransform',
  'replace',
  'app',
  'sitekey',
  'denyallow',
  'method',
  'to',
  'from',
  'header',
  'strict1p',
  'strict3p',
  'strict-first-party',
  'strict-third-party',
  'network',
]);

/** 无参数、直接跳过（语义上是"不拦这类请求"，我们当作不支持处理）。 */
const NEGATED_ONLY_OPTIONS = new Set(['~document', '~subdocument', '~popup', '~all']);

/** 用于剔除纯通配的模式，避免"匹配一切"。 */
const MATCHES_EVERYTHING = new Set(['*', '**', '|', '||', '^', '/', '/*']);

/**
 * 解析一行过滤规则。
 *
 * 非网络规则（注释、cosmetic、脚本注入、HTML 过滤）会被分类返回，
 * 交给第二、三期处理，而不是当作失败。
 */
export function parseFilterLine(rawLine: string): ParseOutcome {
  const raw = rawLine.trim();

  if (!raw) return { kind: 'skip', raw, reason: 'empty' };
  if (raw.startsWith('!') || raw.startsWith('[')) return { kind: 'skip', raw, reason: 'comment' };
  // uBlock 的元数据行
  if (/^#(if|endif|include|@include)/.test(raw)) return { kind: 'skip', raw, reason: 'directive' };

  // ── cosmetic 家族（第二、三期）──
  if (raw.includes('##+js(') || raw.includes('#@#+js(')) {
    return { kind: 'cosmetic', raw, flavor: 'scriptlet' };
  }
  if (raw.includes('##^') || raw.includes('#@#^')) return { kind: 'cosmetic', raw, flavor: 'html' };
  if (raw.includes('#?#')) return { kind: 'cosmetic', raw, flavor: 'extended' };
  if (raw.includes('#$#')) return { kind: 'cosmetic', raw, flavor: 'style' };
  if (raw.includes('##') || raw.includes('#@#')) return { kind: 'cosmetic', raw, flavor: 'basic' };

  // ── 网络规则 ──
  let body = raw;
  let exception = false;
  if (body.startsWith('@@')) {
    exception = true;
    body = body.slice(2);
  }

  const dollar = body.indexOf('$');
  const pattern = (dollar >= 0 ? body.slice(0, dollar) : body).trim();
  const optionText = dollar >= 0 ? body.slice(dollar + 1) : '';

  const filter: ParsedFilter = {
    raw,
    exception,
    pattern,
    regex: pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/'),
    badfilter: false,
    important: false,
    matchCase: false,
  };

  // 选项解析
  if (optionText) {
    const positive = new Set<ResourceType>();
    const negative = new Set<ResourceType>();
    const initiators: string[] = [];
    const excludedInitiators: string[] = [];

    for (const rawOpt of optionText.split(',')) {
      const opt = rawOpt.trim().toLowerCase();
      if (!opt) continue;

      if (opt === 'badfilter') {
        filter.badfilter = true;
        continue;
      }
      if (opt === 'important') {
        filter.important = true;
        continue;
      }
      if (opt === 'match-case') {
        filter.matchCase = true;
        continue;
      }
      if (opt === 'all') {
        // $all 表示"全部类型"，与不写类型等价
        continue;
      }
      if (opt === 'third-party' || opt === '3p') {
        filter.domainType = 'thirdParty';
        continue;
      }
      if (opt === '~third-party' || opt === '~3p' || opt === 'first-party' || opt === '1p') {
        filter.domainType = 'firstParty';
        continue;
      }
      if (opt.startsWith('domain=')) {
        for (const d of opt.slice('domain='.length).split('|')) {
          const item = d.trim();
          if (!item) continue;
          if (item.startsWith('~')) excludedInitiators.push(item.slice(1));
          else initiators.push(item);
        }
        continue;
      }

      if (NEGATED_ONLY_OPTIONS.has(opt)) {
        return { kind: 'skip', raw, reason: `unsupported-option:${opt}` };
      }

      const negated = opt.startsWith('~');
      // 选项可能带值（`csp=...` / `domain=...` / `redirect=...`），
      // 判断"是否支持"必须只看等号前的名字
      const name = (negated ? opt.slice(1) : opt).split('=')[0]!.trim();

      const mapped = TYPE_MAP[name];
      if (mapped) {
        (negated ? negative : positive).add(mapped);
        continue;
      }

      if (UNSUPPORTED_OPTIONS.has(name)) {
        return { kind: 'skip', raw, reason: `unsupported-option:${name}` };
      }

      // 完全不认识的选项：丢弃整条（安全默认）
      return { kind: 'skip', raw, reason: `unknown-option:${name}` };
    }

    if (positive.size) filter.resourceTypes = [...positive];
    if (negative.size) filter.excludedResourceTypes = [...negative];
    if (initiators.length) filter.initiatorDomains = initiators;
    if (excludedInitiators.length) filter.excludedInitiatorDomains = excludedInitiators;
  }

  // 纯通配模式没有意义，且会变成"匹配一切"
  if (MATCHES_EVERYTHING.has(pattern)) return { kind: 'skip', raw, reason: 'match-everything' };
  if (!pattern) return { kind: 'skip', raw, reason: 'no-pattern' };

  return { kind: 'network', filter };
}

/** 统计一批行的解析结果，用于覆盖率报告。 */
export function parseList(
  text: string,
  source?: string,
): {
  network: ParsedFilter[];
  cosmetic: { raw: string; flavor: string }[];
  skipped: { raw: string; reason: string }[];
} {
  const network: ParsedFilter[] = [];
  const cosmetic: { raw: string; flavor: string }[] = [];
  const skipped: { raw: string; reason: string }[] = [];

  for (const line of text.split(/\r?\n/)) {
    const outcome = parseFilterLine(line);
    if (outcome.kind === 'network') {
      if (source) outcome.filter.source = source;
      network.push(outcome.filter);
    } else if (outcome.kind === 'cosmetic') {
      cosmetic.push({ raw: outcome.raw, flavor: outcome.flavor });
    } else if (outcome.reason !== 'empty' && outcome.reason !== 'comment' && outcome.reason !== 'directive') {
      skipped.push({ raw: outcome.raw, reason: outcome.reason });
    }
  }

  return { network, cosmetic, skipped };
}
