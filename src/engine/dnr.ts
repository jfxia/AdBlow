import type { NetworkRule, ResourceType } from './rules.ts';

/**
 * Compile our own network rules into declarativeNetRequest rules. MV3 has no
 * blocking webRequest, so DNR is the only path. Structural types (not chrome.*)
 * keep the engine browser-agnostic; background asserts them to chrome types.
 */

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: 'block' };
  condition: {
    urlFilter?: string;
    regexFilter?: string;
    resourceTypes: ResourceType[];
    /** Does not apply under these initiator domains (exempts sites the user turned off). */
    excludedInitiatorDomains?: string[];
    /** Applies **only** under these initiator domains (caps a learned rule's blast radius). */
    initiatorDomains?: string[];
  };
}

export function toDnrRules(rules: NetworkRule[], idBase: number): DnrRule[] {
  return rules.map((r, i) => ({
    id: idBase + i,
    priority: 1,
    action: { type: 'block' as const },
    condition: {
      ...(r.kind === 'domain'
        ? { urlFilter: `||${r.value}^` }
        : r.kind === 'path'
          ? { urlFilter: r.value }
          : { regexFilter: r.value }),
      resourceTypes: r.resourceTypes,
    },
  }));
}
