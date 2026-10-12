import type { SitePack } from '../../engine/rules.ts';
import { pilotPack } from './pilot.ts';
import { dgavPack } from './dgav.ts';

/**
 * 全部内置站点规则包。
 *
 * 站点规则包只用于"零通用信号"的站点（取证后写死精确选择器）；
 * 通用站点靠 src/engine/ 的行为检测 + 自学习，不需要规则包。
 */
export const SITE_PACKS: SitePack[] = [pilotPack, dgavPack];

/** 取出适用于该 URL 的规则包。 */
export function packsForUrl(url: string, matcher: (pattern: string, url: string) => boolean): SitePack[] {
  return SITE_PACKS.filter((p) => p.matches.some((m) => matcher(m, url)));
}
