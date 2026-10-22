/**
 * Compiles parsed filter rules into DNR static rulesets.
 *
 * Measured 2026-10-11 over six lists: 132,585 network rules against a static
 * ruleset budget on the order of 30k — only ~23% can be kept, so trimming is the
 * core of this compiler, not an afterthought.
 *
 * Priority (higher wins on conflict); deliberately ordered, do not reshuffle:
 *   7 list important allow — ABP semantics put important exceptions on top
 *   5 list important block — must beat plain exceptions
 *   4 site packs — per-site, hand-verified, more trustworthy than generic lists
 *   3 list allow — the main defence against site breakage, beats plain blocks
 *   2 learned domains — above list blocks but overridable (learning can be wrong)
 *   1 list block — fallback
 *
 * Two deliberate deviations, both covered by tests:
 *   1. List rules never block the main document (`allowMainFrame: false`). ABP
 *      reads a plain `||ads.x.com^` as including `document`, which would break
 *      navigation on click; only explicit `$document` rules block main frames.
 *   2. Rules with unknown options are dropped whole (see parse.ts), never
 *      silently widened.
 */
import type { ResourceType } from '../rules.ts';
import type { ParsedFilter } from './parse.ts';
import { isValidRequestDomain, normalizeUrlFilter, urlFilterProblem } from './validate.ts';

export type DnrCondition = {
  urlFilter?: string;
  regexFilter?: string;
  /**
   * Request-domain list — the single most effective compression lever.
   *
   * uBOL packs Peter Lowe's 3,552 inputs into 1 rule and urlhaus' 3,029 into 1
   * this way (measured ~3,500 domains per rule; no documented cap). It is also
   * more precise than separator-sensitive `||domain^`: 120k domains fit in a few
   * hundred rules instead of exhausting the 30k budget one rule at a time.
   */
  requestDomains?: string[];
  /**
   * Hosts the rule must not touch: `$denyallow=` and the `~` half of `$to=`.
   *
   * Coexists with `requestDomains` on purpose — the docs allow both, and DNR then
   * applies "target is one of these AND is not one of those". The exclusion is
   * resolved by longest suffix match, so an excluded subdomain beats an included
   * TLD (`requestDomains: ['com']` + `excludedRequestDomains: ['bank.com']`).
   *
   * Known gap when both are present: a *shorter* excluded domain does not veto a
   * longer included one (`$to=sub.a.com` + `$denyallow=a.com` still fires on
   * `x.sub.a.com`), because DNR compares suffix lengths. One rule cannot express a
   * stronger exclusion; the combination is rare (53 rules today), and the failure
   * direction is "blocks where the list allowed", never the reverse.
   */
  excludedRequestDomains?: string[];
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

/** Priority values (see the header table). */
export const PRIORITY = {
  listBlock: 1,
  learnedBlock: 2,
  listAllow: 3,
  /** Site packs (dynamic rules, not produced here; value registered to avoid clashes) */
  packBlock: 4,
  listImportantBlock: 5,
  listImportantAllow: 7,
} as const;

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
  /** Total static-rule budget. */
  budget: number;
  /** Max rules per static ruleset (for chunking). */
  rulesetSize: number;
  /** Regex-rule limit; DNR caps regexes separately and much lower. */
  regexBudget: number;
  /** Allow list rules to block main frames; default false (see header). */
  allowMainFrame?: boolean;
  /**
   * Per-list rule quota; lists not listed here fall back to defaultListQuota.
   *
   * Measured: the six lists barely overlap (only 59 of 120k candidate domains are
   * mentioned by more than one), so "multi-list consensus" has no discriminating
   * power. Ranking purely by value follows input order and starved EasyPrivacy;
   * quotas guarantee every list a share.
   */
  listQuotas?: Record<string, number>;
  /** Cap for lists without an explicit quota. */
  defaultListQuota?: number;
};

export type CompileReport = {
  input: number;
  afterBadfilter: number;
  deduped: number;
  /** Rules merged away by domain collapsing. */
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
  /** Domains packed into requestDomains, and the rules produced. */
  packedDomains: number;
  packedRules: number;
  /** Patterns normalized from `||*` to `*` (slightly wider, hence reported). */
  normalizedPatterns: number;
  /** Consensus distribution; drives ranking when the budget binds. */
  consensus: { single: number; multi: number; maxLists: number };
  /** Rules actually kept per source list (verifies the quotas). */
  keptByList: Record<string, number>;
  /** How much each category had to choose from. */
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

/** Extract a domain anchor from a regex body, or null. */
export function simplifyRegex(regexBody: string): string | null {
  // Only the common "http(s) prefix + domain" shape; anything else stays a regex
  // and is subject to the separate regex budget.
  if (!/https?\??:?/i.test(regexBody)) return null;

  // Grab the first domain-shaped run (dots are usually escaped in regexes)
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
  /** Value score; kept highest-first when the budget binds. */
  value: number;
  regex: boolean;
  /** Source lists it came from (consensus = higher confidence). */
  sources: Set<string>;
};

/**
 * Per-extra-list consensus bonus.
 *
 * The budget keeps only ~20% of candidates, so ranking decides real coverage: a
 * domain blocked by EasyList, EasyPrivacy and uBlock at once is far likelier to
 * be genuine ad/tracking infrastructure than one mentioned by a single list.
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
    [...(c.requestDomains ?? [])].sort(),
    [...(c.excludedRequestDomains ?? [])].sort(),
  ]);
}

/** Cancellation key for badfilter: matches the target rule minus the flag itself. */
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
    [...(f.requestDomains ?? [])].sort(),
    [...(f.excludedRequestDomains ?? [])].sort(),
  ]);
}

/** Whether the pattern is a bare domain anchor (widest and most valuable kind). */
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
  // Narrower scope than the same pattern unscoped, so rank it like `$domain=`.
  if (f.requestDomains?.length) v -= 50;
  if (f.excludedRequestDomains?.length) v -= 20;
  if (f.domainType === 'thirdParty') v += 10;
  if (f.important) v += 30;
  return v;
}

/**
 * Convert a list's regex text into a DNR `regexFilter`, or null when DNR cannot accept it.
 *
 * Lists write regex rules as `/…/`; those slashes are syntax, not part of the pattern, and DNR
 * rejects them. DNR runs RE2, which has no backreferences, lookaround, possessive quantifiers or
 * `\C`, and **one** invalid `regexFilter` makes the whole ruleset fail to load, which makes the
 * extension uninstallable. Measured 2026-10-22: `\1` in a badware rule (`…\?t=\1&cid=…`) broke
 * every install, and the build self-check had not looked at regexes at all.
 */
export function dnrRegexFilter(pattern: string): string | null {
  let body = pattern.trim();
  if (body.length > 2 && body.startsWith('/') && body.endsWith('/')) body = body.slice(1, -1);
  body = body.trim();
  if (!body || body.length > 2000) return null;

  if (/\\[1-9]/.test(body)) return null; // backreferences
  if (/\(\?(?:<|=|!|>|#)/.test(body)) return null; // lookaround, atomic group, comment
  if (/(?:[*+?]|\{\d+(?:,\d*)?\})\+/.test(body)) return null; // possessive quantifier
  if (/\\[Ck]/.test(body)) return null; // \C, \k<name>

  // DNR applies the regex to the URL, so a leading anchor is redundant; dropping it also avoids
  // implementations that refuse anchored patterns.
  if (body.startsWith('^')) body = body.slice(1);
  return body;
}

function toCandidate(
  f: ParsedFilter,
  opts: Required<CompileOptions>,
): { candidate: Candidate } | { dropped: string } {
  const condition: DnrCondition = {};

  if (f.regex) {
    const simplified = simplifyRegex(f.pattern.slice(1, -1));
    if (simplified) condition.urlFilter = simplified;
    else {
      const regex = dnrRegexFilter(f.pattern);
      if (!regex) return { dropped: 'invalid-regex' };
      condition.regexFilter = regex;
    }
  } else {
    // DNR forbids a leading `||*`, and one illegal rule stops the whole extension
    // from installing, so normalize to `*` as the docs advise; counted in the report.
    condition.urlFilter = normalizeUrlFilter(f.pattern).value;
  }

  // Last filter: drop the rule when the urlFilter syntax is invalid. One invalid
  // rule makes the entire extension uninstallable, and the offenders are upstream
  // typos (measured: `||*xav.*/guang/*.gif`, mid-string `|`) — few and worthless.
  // The validator stays as an assertion that the compiler never emits one.
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
  if (f.requestDomains?.length) condition.requestDomains = f.requestDomains;
  if (f.excludedRequestDomains?.length) {
    condition.excludedRequestDomains = f.excludedRequestDomains;
  }

  const allowMainFrame = opts.allowMainFrame;
  if (f.resourceTypes?.length) {
    // Rules with explicit types run as written — including explicit $document
    // (deliberately blocking the main frame, see deviation 1 in the header).
    // main_frame must NOT be filtered out here, or `||x^$document` would be
    // dropped entirely, the opposite of the intent.
    condition.resourceTypes = f.resourceTypes;
  } else if (f.excludedResourceTypes?.length) {
    // Exclusion form: set excludedResourceTypes only.
    // ⚠️ Never alongside resourceTypes: the official constraint is "Only one of
    // resourceTypes and excludedResourceTypes should be specified", and breaking
    // it once made the whole extension fail to load — visible only in a browser.
    // Without resourceTypes the meaning is "all but main_frame", so adding
    // main_frame to the exclusion list is enough.
    const excluded = [...f.excludedResourceTypes];
    if (!allowMainFrame && !excluded.includes('main_frame')) excluded.push('main_frame');
    condition.excludedResourceTypes = excluded;
  } else {
    // No type options: the docs say "If neither of them is specified, all
    // resource types except main_frame are blocked" — that IS the DNR default, so
    // write nothing: more accurate and cheaper than expanding 11 types, and more
    // rules then share one condition signature (which helps domain packing).
    // This also implements deviation 1 from the header.
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

/** Resolved bare domain anchor (no path, no scope), or null. */
function domainAnchorOf(c: Candidate): { domain: string } | null {
  if (c.regex) return null;
  if (c.condition.initiatorDomains?.length) return null;
  if (c.condition.excludedInitiatorDomains?.length) return null;
  // A `$to=` / `$denyallow=` rule is scoped to specific target hosts; merging it
  // with the global `||domain^` rule of the same domain would drop that scope
  // (the merge keeps only the type union), blocking or allowing hosts the list
  // author explicitly excluded.
  if (c.condition.requestDomains?.length) return null;
  if (c.condition.excludedRequestDomains?.length) return null;
  const m = /^\|\|([a-z0-9.-]+)\^?$/i.exec(c.condition.urlFilter ?? '');
  if (!m) return null;
  // Only well-formed domains qualify: upstream lists contain fragments such as
  // `||allyes.$third-party` or `||check-tl-$all`, and packing those emits illegal
  // rules (measured to break extension loading).
  if (!isValidRequestDomain(m[1]!)) return null;
  return { domain: m[1]!.toLowerCase() };
}

/**
 * Merge same-kind rules by domain.
 *
 * Measured on the first compile (2026-10-11, six lists): 120,585 usable domain
 * anchors against a 24,000 budget — 96,700 dropped, and arbitrarily (by input
 * order, which starved EasyPrivacy). One domain usually has several variants
 * (`||d^$third-party`, `||d^$script`, `||d^`) that merge into one wider rule, so
 * the same budget covers far more domains.
 *
 * Merging takes the union of the intents (untyped beats typed; `$third-party`
 * plus `$first-party` means untyped), i.e. what having all rules at once does.
 *
 * Only unscoped rules merge: a `$domain=site.com` rule is site-specific, and
 * merging it would globalize a block or, worse, an exception.
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
      // Normalize to the `^` form: `||domain` would also match `domainfoo.com`
      byDomain.set(groupKey, { ...c, condition: { ...c.condition, urlFilter: `||${anchor.domain}^` } });
      continue;
    }

    mergedAway += 1;
    // Union of the type limits:
    //   - either side untyped ("all but main_frame", the widest) → stay untyped
    //   - otherwise union both type sets
    // ⚠️ An early version emitted `resourceTypes: []` when both sides were
    // untyped — an empty array is illegal and broke extension loading (caught by
    // the build-time self-check).
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
    // One side third-party, the other unconstrained → unconstrained
    if (existing.condition.domainType !== c.condition.domainType) {
      delete merged.condition.domainType;
    }
    // Sensitive only if every member is, or requests would slip through
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
 * Pick block rules per list quota, in two passes:
 *   1. each list takes up to its own quota, ranked by value then by shallower
 *      domain (shallower covers more: `doubleclick.net` beats `a.b.c.example.com`)
 *   2. quota left over by lists that did not fill theirs goes to the global ranking
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
    // Merged candidates can come from several lists; quota goes to the first source
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

/** Domain label count (fewer = broader). Non-domain anchors get a large value. */
function labelDepth(c: Candidate): number {
  const m = /^\|\|([a-z0-9.-]+)\^/i.exec(c.condition.urlFilter ?? '');
  if (!m) return 99;
  return m[1]!.split('.').length;
}

/**
 * Max domains stuffed into one rule.
 *
 * No documented official limit; uBOL was measured at ~3,500 domains per rule.
 * 2,000 leaves headroom while keeping each rule's JSON small.
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
 * Pack bare domain anchors into `requestDomains` rules.
 *
 * Domains sharing an identical condition (same types, same block/allow, same
 * important flag) form one group, split into rules of MAX_DOMAINS_PER_RULE.
 * Without this, 120k domains lose 80% of themselves to the 30k budget.
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
    // Rules with initiatorDomains cannot share one domain table (different scope)
    if (c.condition.initiatorDomains?.length) continue;
    if (c.condition.excludedInitiatorDomains?.length) continue;
    // Packing writes the pattern domains into requestDomains, which would overwrite
    // the `$to=` list and widen a target-scoped rule to every host.
    if (c.condition.requestDomains?.length) continue;
    if (c.condition.excludedRequestDomains?.length) continue;

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
      // Count per *domain*, not per group: a group mixes domains from several
      // lists, so accumulating per group double-counts (once produced 110k here)
      domainsBySource[s] = (domainsBySource[s] ?? 0) + 1;
    }
    packedDomains += 1;
  }

  for (const g of groups.values()) g.domains = [...new Set(g.domains)].sort();
  return { groups: [...groups.values()], packedDomains, domainsBySource };
}

/**
 * Compile a batch of parsed filters.
 *
 * Order matters: badfilter cancellation → dedupe (merging sources) → collapse by
 * domain → pack domains → trim the remainder by quota. Trimming keeps *all*
 * exceptions first: they are the main defence against site breakage.
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

  // Patterns normalized from `||*` to `*` (slightly wider; counted in the report)
  const normalizedPatterns = filters.filter((f) => !f.regex && f.pattern.startsWith('||*')).length;

  // (1) badfilter cancellation
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
      // Dedupe: merge source lists (consensus signal), keep the higher value
      for (const s of c.sources) existing.sources.add(s);
      existing.value = Math.max(existing.value, c.value);
      drop('duplicate');
    } else {
      candidates.set(c.key, c);
    }
  }

  // Consensus bonus: the more lists mention a domain, the likelier it is genuine
  // ad/tracking infrastructure. Applied after dedupe so `sources` is complete.
  // ⚠️ Never spread 120k elements at once (Math.max(...arr) overflows the stack).
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

  // (2) Collapse by domain (variants of one domain become one wider rule)
  const { collapsed, mergedAway } = collapseByDomain(candidates);

  // (3) Pack domains into requestDomains rules (decisive for coverage)
  const all = [...collapsed.values()];
  const isPackable = (c: Candidate): boolean =>
    !c.regex &&
    !c.condition.initiatorDomains?.length &&
    !c.condition.excludedInitiatorDomains?.length &&
    !c.condition.requestDomains?.length &&
    !c.condition.excludedRequestDomains?.length &&
    /^\|\|[a-z0-9.-]+\^$/i.test(c.condition.urlFilter ?? '');

  const packable = all.filter(isPackable);
  const rest = all.filter((c) => !isPackable(c));
  const { groups, packedDomains, domainsBySource } = packDomainAnchors(packable);

  const packedRules: DnrListRule[] = [];
  for (const g of groups) {
    for (let i = 0; i < g.domains.length; i += MAX_DOMAINS_PER_RULE) {
      packedRules.push({
        id: 0, // numbered below
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

  // (4) Trim the remainder (path rules, regexes, scoped rules) by quota
  const exceptions = rest.filter((c) => c.exception);
  const blocks = rest.filter((c) => !c.exception);

  // Exceptions first. The cap is max(50, 25%): on small compiles 25% can be as
  // little as one rule, and exceptions are what prevents site breakage.
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

  // (5) Regex budget (DNR caps regexFilter separately and lower)
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

  // (6) Merge packed and per-rule rules, assign ids, split by rulesetSize
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

  // Distribution stats: answer "what did we drop, how much room is left"
  const availableDomainAnchors = packable.length;
  const availableRegex = all.filter((c) => c.regex).length;
  const availableExceptions = all.filter((c) => c.exception).length;

  // How much each list actually covers (counted per domain)
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
