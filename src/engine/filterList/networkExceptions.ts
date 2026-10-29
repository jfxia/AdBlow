/**
 * Network rules from filter lists that are known to break a site.
 *
 * Matching is on the exact urlFilter string, so a list that rewrites the rule stops matching and the
 * entry can be deleted. Each entry needs a reason: the next reader has to be able to re-judge it.
 */
export type NetworkRuleException = { urlFilter: string; reason: string };

export const NETWORK_RULE_EXCEPTIONS: readonly NetworkRuleException[] = [
  {
    urlFilter: '||reddit.com/api/jail^',
    reason:
      'First-party XHR to a Reddit endpoint. Measured 2026-10-29: with it blocked, a thread page ' +
      'renders the first screen and then stops loading, and no comments are rendered.',
  },
  {
    urlFilter: '||embed.reddit.com/svc/shreddit',
    reason:
      'Reddit embed service called while rendering a thread. Removed in the same experiment as the ' +
      'rule above; which of the two breaks the page was not isolated, and both are cheap to drop.',
  },
];

/** True when a list's network rule is on the exception table. */
export function isNetworkRuleException(urlFilter: string): boolean {
  const filter = urlFilter.trim();
  return NETWORK_RULE_EXCEPTIONS.some((entry) => entry.urlFilter === filter);
}
