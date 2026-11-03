/**
 * Network rules from filter lists that are known to break a site.
 *
 * Matching is on the exact urlFilter string, so a list that rewrites the rule stops matching and the
 * entry can be deleted. Each entry needs a reason: the next reader has to be able to re-judge it.
 */
export type NetworkRuleException = { urlFilter: string; reason: string };

export const NETWORK_RULE_EXCEPTIONS: readonly NetworkRuleException[] = [
  {
    urlFilter: '||redditstatic.com/shreddit/sentry-',
    reason:
      'Blocks a lazy-loaded webpack chunk of the Reddit app. The boot awaits it, the blocked request ' +
      'leaves the promise unsettled, and the page stops after the server-rendered posts: no comments ' +
      'and no further chunks. Measured 2026-11-03 by removing this single rule with the other 21,000 ' +
      'left in place: the thread then renders completely. A saved page from the broken state had five ' +
      'script tags in total, i.e. the app never loaded its own bundles.',
  },
  {
    urlFilter: '||reddit.com/api/jail^',
    reason:
      'First-party XHR to a Reddit endpoint. Excluded on 2026-10-29 on a hypothesis that later proved ' +
      'wrong (pages kept hanging with it gone); kept excluded because the endpoint has nothing to do ' +
      'with ad serving, and blocking an unknown first-party call is not worth the risk.',
  },
  {
    urlFilter: '||embed.reddit.com/svc/shreddit',
    reason:
      'Reddit embed service. Excluded in the same 2026-10-29 experiment as the rule above, also on the ' +
      'wrong hypothesis. Kept excluded for the same reason: it is an embed service, not an ad host.',
  },
];

/** True when a list's network rule is on the exception table. */
export function isNetworkRuleException(urlFilter: string): boolean {
  const filter = urlFilter.trim();
  return NETWORK_RULE_EXCEPTIONS.some((entry) => entry.urlFilter === filter);
}
