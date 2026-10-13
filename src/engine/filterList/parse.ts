/**
 * Filter-list syntax parsing (EasyList / Adblock Plus → intermediate model).
 *
 * ⚠️ An unrecognized option drops the whole rule, never "ignore it and block
 * anyway": for `||x.com^$csp=...` ignoring `$csp` would block all of x.com —
 * wider than the original, and exactly what breaks sites. Browser-agnostic.
 */
import type { ResourceType } from '../rules.ts';

/** One successfully parsed network rule. */
export type ParsedFilter = {
  raw: string;
  /** Source list id (set by parseList; drives consensus ranking). */
  source?: string;
  /** `@@` prefix (exception rule). */
  exception: boolean;
  /** Pattern part (options stripped). */
  pattern: string;
  /** Pattern is the `/.../ ` regex form. */
  regex: boolean;
  /** `$badfilter`: cancels the matching rule. */
  badfilter: boolean;
  important: boolean;
  matchCase: boolean;
  /** Unset means "all types except main_frame" (see compile.ts). */
  resourceTypes?: ResourceType[];
  excludedResourceTypes?: ResourceType[];
  /** Positive half of `$domain=` → DNR initiatorDomains. */
  initiatorDomains?: string[];
  /** Negated half of `$domain=` (`~b.com`) → DNR excludedInitiatorDomains. */
  excludedInitiatorDomains?: string[];
  /** `$third-party` / `$first-party` (and their `~` forms) → DNR domainType. */
  domainType?: 'firstParty' | 'thirdParty';
};

/** Parse outcome: either a network rule, or a skip with a reason for the report. */
export type ParseOutcome =
  | { kind: 'network'; filter: ParsedFilter }
  | { kind: 'cosmetic'; raw: string; flavor: 'basic' | 'extended' | 'scriptlet' | 'html' | 'style' }
  | { kind: 'skip'; raw: string; reason: string };

/** Type option → DNR resource type. */
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

/** Options we cannot express: drop the whole rule rather than ignore them (see header). */
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

/** Argument-less options to skip (semantically "do not block this type"). */
const NEGATED_ONLY_OPTIONS = new Set(['~document', '~subdocument', '~popup', '~all']);

/** Pure-wildcard patterns, which would match everything. */
const MATCHES_EVERYTHING = new Set(['*', '**', '|', '||', '^', '/', '/*']);

/**
 * Parse one filter line. Non-network rules (comments, cosmetic, scriptlets, HTML
 * filters) are classified for later phases rather than treated as failures.
 */
export function parseFilterLine(rawLine: string): ParseOutcome {
  const raw = rawLine.trim();

  if (!raw) return { kind: 'skip', raw, reason: 'empty' };
  if (raw.startsWith('!') || raw.startsWith('[')) return { kind: 'skip', raw, reason: 'comment' };
  // uBlock metadata line
  if (/^#(if|endif|include|@include)/.test(raw)) return { kind: 'skip', raw, reason: 'directive' };

  // cosmetic family (phases 2-3)
  if (raw.includes('##+js(') || raw.includes('#@#+js(')) {
    return { kind: 'cosmetic', raw, flavor: 'scriptlet' };
  }
  if (raw.includes('##^') || raw.includes('#@#^')) return { kind: 'cosmetic', raw, flavor: 'html' };
  if (raw.includes('#?#')) return { kind: 'cosmetic', raw, flavor: 'extended' };
  if (raw.includes('#$#')) return { kind: 'cosmetic', raw, flavor: 'style' };
  if (raw.includes('##') || raw.includes('#@#')) return { kind: 'cosmetic', raw, flavor: 'basic' };

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
        // `$all` means "every type", same as omitting types
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
      // Options may carry values (`csp=...`, `domain=...`, `redirect=...`); support
      // is decided on the name before the equals sign only.
      const name = (negated ? opt.slice(1) : opt).split('=')[0]!.trim();

      const mapped = TYPE_MAP[name];
      if (mapped) {
        (negated ? negative : positive).add(mapped);
        continue;
      }

      if (UNSUPPORTED_OPTIONS.has(name)) {
        return { kind: 'skip', raw, reason: `unsupported-option:${name}` };
      }

      // Completely unknown option: drop the whole rule (safe default)
      return { kind: 'skip', raw, reason: `unknown-option:${name}` };
    }

    if (positive.size) filter.resourceTypes = [...positive];
    if (negative.size) filter.excludedResourceTypes = [...negative];
    if (initiators.length) filter.initiatorDomains = initiators;
    if (excludedInitiators.length) filter.excludedInitiatorDomains = excludedInitiators;
  }

  if (MATCHES_EVERYTHING.has(pattern)) return { kind: 'skip', raw, reason: 'match-everything' };
  if (!pattern) return { kind: 'skip', raw, reason: 'no-pattern' };

  return { kind: 'network', filter };
}

/** Aggregate the parse outcomes of a batch of lines, for coverage reporting. */
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
