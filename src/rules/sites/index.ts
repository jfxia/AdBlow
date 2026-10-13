import type { SitePack } from '../../engine/rules.ts';
import { pilotPack } from './pilot.ts';
import { dgavPack } from './dgav.ts';

/**
 * All built-in site rule packs, used only for sites with no generic signals
 * (selectors hard-coded after review); ordinary sites rely on src/engine/.
 */
export const SITE_PACKS: SitePack[] = [pilotPack, dgavPack];

/** Rule packs matching a URL. */
export function packsForUrl(url: string, matcher: (pattern: string, url: string) => boolean): SitePack[] {
  return SITE_PACKS.filter((p) => p.matches.some((m) => matcher(m, url)));
}
