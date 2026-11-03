/**
 * Rules that can stall a site by blocking its own scripts.
 *
 * Why this exists: a rule blocking a lazy-loaded chunk of the site's own app can leave the app waiting
 * forever, with a clean console and nothing hidden. Measured 2026-11-03 on Reddit
 * (`||redditstatic.com/shreddit/sentry-`): the thread rendered its server-side posts and then stopped,
 * and only five script tags had loaded in total.
 *
 * The set is small and every entry is worth a human glance, so this produces a list for review rather
 * than a pass/fail verdict; `compareWithBaseline` turns it into a gate by failing on new entries.
 */

/** Domains a site needs to load its own application code and data. */
export type CanarySite = { name: string; ownDomains: readonly string[] };

export const CANARY_SITES: readonly CanarySite[] = [
  { name: 'reddit', ownDomains: ['reddit.com', 'redditstatic.com', 'redditmedia.com', 'redd.it'] },
  { name: 'sina', ownDomains: ['sina.com.cn', 'sina.cn', 'sinaimg.cn', 'sinaedge.com'] },
  { name: 'youtube', ownDomains: ['youtube.com', 'ytimg.com', 'googlevideo.com', 'youtube-nocookie.com'] },
  { name: 'bbc', ownDomains: ['bbc.com', 'bbc.co.uk', 'bbci.co.uk'] },
];

/** Resource types whose loss can leave an application waiting. */
const STALLING_TYPES = ['script', 'xmlhttprequest', 'sub_frame'];

export type DnrLikeRule = {
  id: number;
  action?: { type?: string };
  condition?: {
    urlFilter?: string;
    regexFilter?: string;
    requestDomains?: string[];
    resourceTypes?: string[];
  };
};

export type OwnDomainFinding = {
  site: string;
  domain: string;
  ruleId: number;
  ruleSet: string;
  match: string;
  types: string;
};

/** True when the host is the domain itself or a subdomain of it. */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith('.' + d);
}

/** Domains mentioned by a rule's match expression (a substring check on domain boundaries). */
export function domainsInRule(rule: DnrLikeRule, domains: readonly string[]): string[] {
  const condition = rule.condition ?? {};
  const parts = [
    condition.urlFilter ?? '',
    condition.regexFilter ?? '',
    ...(condition.requestDomains ?? []),
  ]
    .join('\n')
    .toLowerCase();
  return domains.filter((domain) => {
    const d = domain.toLowerCase();
    // Match the domain as a whole label run: "reddit.com" must not match "notreddit.com".
    const escaped = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9.-])\\.?' + escaped + '([^a-z0-9-]|$)', 'i').test(parts);
  });
}

/** True when blocking this rule could stall an app: it is a block rule for script/xhr/frame (or all types). */
export function canStall(rule: DnrLikeRule): boolean {
  if ((rule.action?.type ?? '') !== 'block') return false;
  const types = rule.condition?.resourceTypes;
  if (!types || types.length === 0) return true; // no types means every type
  return types.some((type) => STALLING_TYPES.includes(type));
}

/** Findings for one ruleset file. */
export function inspectRuleSet(rules: readonly DnrLikeRule[], ruleSet: string, sites = CANARY_SITES): OwnDomainFinding[] {
  const findings: OwnDomainFinding[] = [];
  for (const rule of rules) {
    if (!canStall(rule)) continue;
    for (const site of sites) {
      const hit = domainsInRule(rule, site.ownDomains);
      if (hit.length === 0) continue;
      findings.push({
        site: site.name,
        domain: hit.join(','),
        ruleId: rule.id,
        ruleSet,
        match: String(rule.condition?.urlFilter ?? rule.condition?.regexFilter ?? (rule.condition?.requestDomains ?? []).join(',')).slice(0, 100),
        types: (rule.condition?.resourceTypes ?? []).join(',') || '(all)',
      });
    }
  }
  return findings;
}

/** Key used to compare against the reviewed baseline. */
export function findingKey(finding: OwnDomainFinding): string {
  return `${finding.site}|${finding.ruleSet}|${finding.ruleId}|${finding.match}`;
}

/** Findings that are not in the baseline — each of them needs a human decision. */
export function newFindings(findings: readonly OwnDomainFinding[], baseline: readonly string[]): OwnDomainFinding[] {
  const known = new Set(baseline);
  return findings.filter((finding) => !known.has(findingKey(finding)));
}
