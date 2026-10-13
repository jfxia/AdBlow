import type { DnrRule } from './dnr.ts';
import type { ResourceType } from './rules.ts';

/**
 * Compile self-learned ad domains into DNR block rules.
 *
 * ⚠️ Three hard safety constraints, each from a real failure:
 * 1. never block `main_frame`: those are landing pages users may click, and a
 *    blocked main_frame breaks navigation (the hardest failure to diagnose);
 * 2. never block `image` / `media` (see SUBRESOURCE_TYPES);
 * 3. exempt per site — domains are global, but a site the user turned off must be
 *    fully exempt, or "off" only stops the DOM layer.
 */

/** Id range reserved for learned-domain rules, so they cannot clash with site packs. */
export const LEARNED_DOMAIN_ID_BASE = 30000;

/**
 * Resource types learned-domain rules may block. Never `image` / `media` (content and
 * ad assets share CDNs; that emptied 1024cg's images) and never `script` /
 * `stylesheet` / `font` (blocking a video site's own CDN broke its player): a learned
 * rule must never break the page's own assets. Cost: a few missed ad scripts, which the
 * static lists cover.
 */
export const SUBRESOURCE_TYPES: ResourceType[] = [
  'sub_frame',
  'object',
  'xmlhttprequest',
  'ping',
  'websocket',
  'other',
];

/** One learned domain plus **the site that taught it** (to cap the blast radius). */
export type LearnedDomain = {
  domain: string;
  /** Page hosts where it was learned. Empty means unrestricted (backward compatible). */
  initiators?: string[];
};

export function learnedDomainRules(
  domains: (string | LearnedDomain)[],
  excludedInitiatorDomains: string[] = [],
  idBase: number = LEARNED_DOMAIN_ID_BASE,
): DnrRule[] {
  const exclusions = [...new Set(excludedInitiatorDomains)].filter(Boolean).sort();

  return domains.map((raw, i) => {
    const domain = typeof raw === 'string' ? raw : raw.domain;
    const initiators =
      typeof raw === 'string' ? [] : [...new Set(raw.initiators ?? [])].filter(Boolean).sort();

    return {
      id: idBase + i,
      /**
       * Priority 2: above plain list blocking (1), below list exceptions (3), so a
       * list exception can always override self-learning (which does learn wrong).
       * See the PRIORITY table in filterList/compile.ts.
       */
      priority: 2,
      action: { type: 'block' as const },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: SUBRESOURCE_TYPES,
        /**
         * ❗Blast-radius limit: a learned rule applies only on the site that taught
         * it. Third-party CDNs are shared, so a domain learned on A may be B's own
         * resource source; a wrong learning then cannot spill onto other sites.
         */
        ...(initiators.length ? { initiatorDomains: initiators } : {}),
        // Sites the user turned off must be exempt, or "off" only stops the DOM layer
        ...(exclusions.length ? { excludedInitiatorDomains: exclusions } : {}),
      },
    };
  });
}
