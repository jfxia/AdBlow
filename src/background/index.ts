import { toDnrRules } from '../engine/dnr.ts';
import { learnedDomainRules } from '../engine/learnedRules.ts';
import { matchPattern } from '../engine/match.ts';
import { validateSitePack, type NetworkRule } from '../engine/rules.ts';
import {
  COSMETIC_SHARD_COUNT,
  selectorsFromShards,
  shardsForHost,
  type CosmeticShard,
} from '../engine/filterList/cosmetic.ts';
import { allPromotedDomainScopes } from '../content/domainLearn.ts';
import { migrateLearnedSchema } from '../content/learn.ts';
import { disabledKey } from '../content/settings.ts';
import { chromeLocal } from '../content/storage.ts';
import { SITE_PACKS } from '../rules/sites/index.ts';

/**
 * In-process cache of cosmetic shards (index → shard; null means unavailable, so a
 * failure is not retried). The SW may be recycled and lose it — acceptable, local
 * file reads are cheap.
 */
const cosmeticShardCache = new Map<number, CosmeticShard | null>();

async function loadShard(index: number): Promise<CosmeticShard | null> {
  const cached = cosmeticShardCache.get(index);
  if (cached !== undefined) return cached;

  try {
    const url = chrome.runtime.getURL(`cosmetic/shard-${index}.json`);
    const res = await fetch(url);
    const shard = res.ok ? ((await res.json()) as CosmeticShard) : null;
    cosmeticShardCache.set(index, shard);
    return shard;
  } catch {
    cosmeticShardCache.set(index, null);
    return null;
  }
}

/**
 * Domain-specific cosmetic selectors that apply to a hostname.
 *
 * Reads only the shards holding the hostname and its parents (measured: usually 2-3
 * shards of a few KB); [] when no shards exist yet, so the extension keeps working
 * before the list is generated.
 */
async function cosmeticForHost(host: string): Promise<string[]> {
  const indexes = shardsForHost(host, COSMETIC_SHARD_COUNT);
  const shards = await Promise.all(indexes.map((i) => loadShard(i)));
  return selectorsFromShards(shards, host);
}


/**
 * Service Worker entry point: syncs network rules into DNR dynamic rules, dispatches
 * site packs by URL, and serves snapshot backfill. MV3 has no blocking webRequest, so
 * interception only exists via declarativeNetRequest.
 *
 * Network rules come from the site packs and from learned ad domains; learning is what
 * makes unknown sites improve, with no user configuration.
 */

const ID_BASE = 10000;

function usableRules(): NetworkRule[] {
  return SITE_PACKS.flatMap((pack) => {
    const problems = validateSitePack(pack);
    if (problems.length) {
      console.warn('[adblow] 规则包被误伤护栏拒绝，不生成网络规则', pack.id, problems);
      return [];
    }
    return pack.network;
  });
}

async function disabledHosts(): Promise<string[]> {
  const store = chromeLocal();
  const keys = await store.keys();
  return keys
    .filter((k) => k.startsWith('disabled:'))
    .map((k) => k.slice('disabled:'.length))
    .sort();
}

async function syncDnrRules(): Promise<void> {
  const store = chromeLocal();

  try {
    // Migrate first: learning results from before the safety gate are untrusted and
    // must be discarded. This has to run before rules are generated, or the voided
    // domains would simply be written back as DNR rules.
    try {
      const cleaned = await migrateLearnedSchema(store);
      if (cleaned) console.log('[adblow] 自学习数据版本已更新，旧的学习结果已清空');
    } catch (error) {
      console.warn('[adblow] 自学习数据迁移失败', error);
    }

    const packRules = toDnrRules(usableRules(), ID_BASE);
    // Sites the user disabled must be exempt from every network rule, or "disable
    // here" would only stop the DOM layer
    const excluded = await disabledHosts();
    // Learned domains carry the site that taught them, bounding the blast radius
    // (see learnedDomainRules: a global rule once blocked a site's own CDN)
    const scopes = await allPromotedDomainScopes(store);
    const learnedRules = learnedDomainRules(
      [...scopes].map(([domain, initiators]) => ({ domain, initiators })),
      excluded,
    );

    const desired = [...packRules, ...learnedRules];

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: desired as unknown as chrome.declarativeNetRequest.Rule[],
    });
    console.log(
      `[adblow] 已同步 ${desired.length} 条 DNR 规则` +
        `（站点包 ${packRules.length} + 自学习域名 ${learnedRules.length}，豁免 ${excluded.length} 个站点）`,
    );
  } catch (error) {
    console.error('[adblow] 同步 DNR 规则失败', error);
  }
}

/** Debounce: a promoted domain or a site toggle requires a resync. */
let syncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSync(): void {
  if (syncTimer !== undefined) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncDnrRules();
  }, 400);
}

chrome.runtime.onInstalled.addListener(() => void syncDnrRules());
chrome.runtime.onStartup.addListener(() => void syncDnrRules());

/**
 * Rebuild the rules on every Service Worker wake-up: DNR dynamic rules are
 * **persistent**, so stale rules outlive a code update. Once learning blocked a
 * content-image CDN, the logic was fixed, but the old rules kept hiding images in
 * users' browsers. Rebuilding unconditionally keeps policy == current code.
 * Cost is negligible (one getDynamicRules + one idempotent updateDynamicRules).
 */
void syncDnrRules();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(changes)) {
    if (key.startsWith('adDomains:') || key.startsWith('disabled:')) {
      scheduleSync();
      return;
    }
  }
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  const msg = message as { type?: string; url?: string; host?: string } | undefined;

  /**
   * Cosmetic rules: return the domain-specific selectors for a hostname.
   *
   * The SW reads the files instead of the content script, because a content script
   * would need them in `web_accessible_resources` — exposing them to the page (one
   * more fingerprinting surface). Shards are split by domain hash; only those holding
   * the current hostname and its parents are read (measured: 256 shards, largest
   * 6.3 KB), cached in-process.
   */
  if (msg?.type === 'get-cosmetic') {
    const host = msg.host;
    if (!host) {
      respond([]);
      return true;
    }
    void (async () => {
      try {
        const selectors = await cosmeticForHost(host);
        respond({ selectors });
      } catch (error) {
        console.warn('[adblow] 读取 cosmetic 分片失败', error);
        respond({ selectors: [] });
      }
    })();
    return true;
  }

  if (msg?.type === 'get-site-packs') {
    const url = msg.url ?? '';
    respond(SITE_PACKS.filter((p) => p.matches.some((m) => matchPattern(m, url))));
    return true;
  }

  /**
   * Snapshot backfill: hand the content script the full server-returned HTML.
   *
   * Only the SW can do it — a content script cannot see the original response, and at
   * document_start the DOM is barely parsed. Without it there is no way to tell a
   * server-rendered link box from a script-injected ad, so the heuristics would have
   * to be off wholesale (see content/engine.ts). Cost: one same-origin request per
   * page on unknown sites, so the content script decides whether to ask.
   */
  if (msg?.type === 'get-pristine') {
    const url = msg.url;
    if (!url) {
      respond(null);
      return true;
    }
    void (async () => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          redirect: 'follow',
          cache: 'no-cache',
        });
        respond(res.ok ? { html: await res.text() } : null);
      } catch (error) {
        console.warn('[adblow] 回填快照请求失败', error);
        respond(null);
      }
    })();
    return true; // async response
  }

  if (msg?.type === 'list-packs') {
    respond(
      SITE_PACKS.map((p) => ({
        id: p.id,
        matches: p.matches,
        network: p.network.length,
        cosmetic: p.cosmetic.length,
      })),
    );
    return true;
  }

  return false;
});
