import type { SitePack } from '../../engine/rules.ts';
import { pilotPack } from './pilot.ts';

/**
 * 全部内置站点规则包。
 *
 * 目前只有试点站。通用站点不靠规则包，靠 src/engine/ 的行为检测 + 自学习。
 */
export const SITE_PACKS: SitePack[] = [pilotPack];

/** 取出适用于该 URL 的规则包。 */
export function packsForUrl(url: string, matcher: (pattern: string, url: string) => boolean): SitePack[] {
  return SITE_PACKS.filter((p) => p.matches.some((m) => matcher(m, url)));
}
