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
import {
  BADWARE_LIST_ID,
  createBadwareIndexLoader,
  isBadwareHost,
} from '../engine/badwareDomains.ts';
import {
  CONTEXT_MENU_PICK_ID,
  contextMenuPickTitle,
} from '../engine/contextMenu.ts';

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
 * Badware domain set, read from the packaged JSON once per service-worker lifetime.
 *
 * The previous implementation used `declarativeNetRequest.testMatchOutcome`, which Chrome
 * documents as available only for unpacked extensions; packaged builds therefore always
 * got no answer and had to fail closed. This snapshot works in every build.
 *
 * Failure direction is inverted on purpose: a missing/corrupt list means "no evidence",
 * so the caller allows banner handling. Never letting the feature run in the store build
 * is worse than not knowing whether one particular site is badware.
 */
const badwareIndex = createBadwareIndexLoader({
  loadFile: async () => {
    // Keep this path a string literal: tools/release/package.mjs finds reachable
    // extension resources by scanning built JS for chrome.runtime.getURL('...').
    const url = chrome.runtime.getURL('badware-domains.json');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  onLoaded: (count) => console.log(`[adblow] ${BADWARE_LIST_ID}: loaded ${count} domains`),
  onUnavailable: (error) =>
    console.log(
      '[adblow] badware domains unavailable; cookie banners will still be handled',
      error,
    ),
});


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

chrome.runtime.onInstalled.addListener(() => {
  void syncDnrRules();
  registerContextMenu();
});
chrome.runtime.onStartup.addListener(() => {
  void syncDnrRules();
  registerContextMenu();
});

/**
 * Rebuild the rules on every Service Worker wake-up: DNR dynamic rules are
 * **persistent**, so stale rules outlive a code update. Once learning blocked a
 * content-image CDN, the logic was fixed, but the old rules kept hiding images in
 * users' browsers. Rebuilding unconditionally keeps policy == current code.
 * Cost is negligible (one getDynamicRules + one idempotent updateDynamicRules).
 */
void syncDnrRules();

// ── Context menu: block the right-clicked element ───────────────────────────
//
// The menu only sends `{ preselected: true }` to the top frame; the content script owns
// the DOM side (which element was right-clicked, whether it still exists). Registering
// here, on every worker start, keeps the label in sync with the browser UI language even
// when the extension was updated in place: Chrome persists menu items per session, while
// the title is resolved from chrome.i18n at creation time.

/**
 * Serialised registration: the worker wakes for both onInstalled/onStartup and module
 * evaluation, and two concurrent removeAll/create pairs would race — one removeAll could
 * delete the item the other just created, and a duplicate id makes create fail.
 */
let menuRegistration: Promise<void> = Promise.resolve();

function registerContextMenu(): void {
  menuRegistration = menuRegistration
    .then(async () => {
      // removeAll first: this is also what makes a retry after a failed create safe.
      await chrome.contextMenus.removeAll();
      chrome.contextMenus.create(
        {
          id: CONTEXT_MENU_PICK_ID,
          title: contextMenuPickTitle((key) => chrome.i18n.getMessage(key)),
          // 'all' also covers links, images and selections: the item must be reachable
          // wherever the user sees the element they want to hide.
          contexts: ['all'],
        },
        () => {
          // Must be read inside the callback, or Chrome logs an unchecked lastError.
          const error = chrome.runtime.lastError;
          if (error) console.warn('[adblow] 创建右键菜单失败', error.message);
        },
      );
    })
    .catch((error) => {
      // A missing menu only hides a shortcut; DNR sync and messaging must keep working.
      console.warn('[adblow] 右键菜单注册失败', error);
    });
}

registerContextMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_PICK_ID) return;
  const tabId = tab?.id;
  if (tabId === undefined) return;

  // frameId 0 on purpose: the right-click recorder and the picker both live in the top
  // document, and iframe listeners reject the message. `preselected` tells the content
  // script to use the recorded element instead of asking for another hover/click.
  void chrome.tabs
    .sendMessage(tabId, { type: 'start-picker', preselected: true }, { frameId: 0 })
    .then((response) => {
      const reply = response as { ok?: boolean; reason?: string } | undefined;
      if (!reply?.ok) console.debug('[adblow] 右键拾取未进入', reply?.reason);
    })
    .catch(() => {
      // No receiver: chrome:// pages, the PDF viewer, or a tab loaded before the extension
      // was installed/reloaded. Injecting a content script here would require the
      // "scripting" permission, which this feature deliberately does not add.
      console.debug('[adblow] 右键拾取消息没有接收方');
    });
});


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
   * Is this host on the packaged badware-domain list?
   *
   * The answer has three states: `true` (matched, leave the banner alone), `false` (list
   * loaded, no match), and `null` (list unavailable — the caller deliberately allows the
   * banner). The old DNR gate returned `null` for a missing API and failed closed, which
   * disabled the feature entirely in packaged builds; see the loader above.
   */
  if (msg?.type === 'is-badware-site') {
    const host = msg.host ?? '';
    if (!host) {
      respond({ badware: null });
      return true;
    }
    void (async () => {
      try {
        const index = await badwareIndex.load();
        respond({ badware: index.available ? isBadwareHost(host, index.domains) : null });
      } catch (error) {
        // createBadwareIndexLoader resolves on its own failures; this is a last-resort guard.
        console.warn('[adblow] badware lookup failed; allowing banner handling', error);
        respond({ badware: null });
      }
    })();
    return true;
  }

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


// ── Click-triggered navigation watch (record only) ───────────────────────────
//
// The content script reports clicks that landed on ordinary content; this side records a
// cross-site top-frame navigation that follows within a few seconds. Observation only: no
// behaviour depends on it, so a wrong record costs a line in the rule manager, not a page.
//
// The two signals arrive on independent channels and either may be first (a page that
// redirects inside its own click handler starts navigating before the message is handled),
// so both are stored and whichever arrives second settles the pair.
import {
  clickWatchKey,
  mergeIncident,
  shouldRecordClickNavigation,
  type ClickIncident,
  type PlainClick,
} from '../engine/clickWatch.ts';

const CLICK_PENDING_KEY = 'clickWatchPending';
const CLICK_NAV_KEY = 'clickWatchNav';
const CLICK_PENDING_TTL_MS = 60_000;

type PendingClicks = Record<string, PlainClick>;
type PendingNav = { fromUrl: string; toUrl: string; at: number };
type PendingNavs = Record<string, PendingNav>;

async function readSession<T>(key: string): Promise<T> {
  const stored = await chrome.storage.session.get(key);
  const value = stored[key];
  return (value && typeof value === 'object' ? value : {}) as T;
}

async function writeSession(key: string, value: unknown): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

/** Convert a pair into a record if it qualifies, then clear both sides for that tab. */
async function settle(tabId: number): Promise<void> {
  const key = String(tabId);
  const clicks = await readSession<PendingClicks>(CLICK_PENDING_KEY);
  const navs = await readSession<PendingNavs>(CLICK_NAV_KEY);
  const click = clicks[key];
  const nav = navs[key];
  if (!click || !nav) return;

  const now = Date.now();
  const verdict = shouldRecordClickNavigation({ click, toUrl: nav.toUrl, now });

  // A page's own initial load also produces a navigation event, and it may pair with the click
  // that arrives right after. That pair is same-host and must not consume the click: the real
  // (cross-site) navigation is still on its way and needs it.
  const sameOrigin =
    verdict.reason === 'same host' || verdict.reason === 'same registrable domain';
  if (sameOrigin) {
    delete navs[key];
    await writeSession(CLICK_NAV_KEY, navs);
    return;
  }

  delete clicks[key];
  delete navs[key];
  await writeSession(CLICK_PENDING_KEY, clicks);
  await writeSession(CLICK_NAV_KEY, navs);
  if (!verdict.record) return;

  const storageKey = clickWatchKey(click.host);
  const stored = await chrome.storage.local.get(storageKey);
  const existing = stored[storageKey] as ClickIncident | undefined;
  const incident = mergeIncident(existing, click.host, verdict.targetHost ?? '', now);
  await chrome.storage.local.set({ [storageKey]: incident });
  console.debug('[adblow] 点击后跨站跳转已记录', click.host, '→', verdict.targetHost, '次数', incident.count);
}

async function rememberPlainClick(tabId: number, url: string, at: number): Promise<void> {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    return;
  }
  if (!host) return;
  const clicks = await readSession<PendingClicks>(CLICK_PENDING_KEY);
  clicks[String(tabId)] = { host, url, at };
  await writeSession(CLICK_PENDING_KEY, clicks);
  await settle(tabId);
}

async function noteNavigation(tabId: number, toUrl: string, fromUrl: string): Promise<void> {
  const navs = await readSession<PendingNavs>(CLICK_NAV_KEY);
  navs[String(tabId)] = { fromUrl, toUrl, at: Date.now() };
  await writeSession(CLICK_NAV_KEY, navs);
  await settle(tabId);
}

/** Drop entries that can no longer matter (a tab that never settled). */
async function dropStale(): Promise<void> {
  const now = Date.now();
  const clicks = await readSession<PendingClicks>(CLICK_PENDING_KEY);
  const navs = await readSession<PendingNavs>(CLICK_NAV_KEY);
  let changed = false;
  for (const [key, click] of Object.entries(clicks)) {
    if (now - click.at > CLICK_PENDING_TTL_MS) {
      delete clicks[key];
      changed = true;
    }
  }
  for (const [key, nav] of Object.entries(navs)) {
    if (now - nav.at > CLICK_PENDING_TTL_MS) {
      delete navs[key];
      changed = true;
    }
  }
  if (!changed) return;
  await writeSession(CLICK_PENDING_KEY, clicks);
  await writeSession(CLICK_NAV_KEY, navs);
}

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const msg = message as { kind?: string; url?: string; at?: number } | null;
  if (!msg || msg.kind !== 'click-plain') return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  void rememberPlainClick(
    tabId,
    typeof msg.url === 'string' ? msg.url : '',
    typeof msg.at === 'number' ? msg.at : Date.now(),
  ).then(dropStale);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url;
  if (!url) return;
  void noteNavigation(tabId, url, tab?.pendingUrl ?? tab?.url ?? url).then(dropStale);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const clicks = await readSession<PendingClicks>(CLICK_PENDING_KEY);
    const navs = await readSession<PendingNavs>(CLICK_NAV_KEY);
    delete clicks[String(tabId)];
    delete navs[String(tabId)];
    await writeSession(CLICK_PENDING_KEY, clicks);
    await writeSession(CLICK_NAV_KEY, navs);
  })();
});
