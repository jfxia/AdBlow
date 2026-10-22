import { buildPristineIndexFromHtml } from '../engine/pristine.ts';
import { withTimeout } from '../engine/async.ts';
import { findInvisibleClickLayers } from '../engine/clickLayer.ts';
import { frequentMediaDomains } from '../engine/domains.ts';
import { collectGrownElements, createGrowthTracker } from '../engine/geometry.ts';
import type { SitePack } from '../engine/rules.ts';
import {
  applyVerdict,
  createHidingBudget,
  cosmeticCss,
  findOverlayAds,
  findFakeCloseAds,
  findLinkFarms,
  hideElement,
  holdsRealContent,
  isPickerUi,
  mustNotHide,
  judgeGrownElement,
  learnableAdDomains,
  makeInjectionTest,
  processAdded,
  recordableSelector,
  selectorsFrom,
  sweep,
  verifyHiding,
  type Hit,
  type JudgeOptions,
} from './engine.ts';
import { allEntries, recordHit } from './learn.ts';
import { applyListCosmetic } from './listCosmetic.ts';
import { recordDomains } from './domainLearn.ts';
import {
  POPUP_ALLOW_PREFIX,
  isPopupAllowed,
  isSiteDisabled,
  isWallFixEnabled,
  markWallDetected,
  wallFixKey,
  writeStats,
} from './settings.ts';
import {
  POPUP_BLOCK_EVENT,
  installPopupDenyElement,
  publishPopupAllowance,
} from '../engine/popupDomains.ts';
import { chromeLocal } from './storage.ts';
import { createPicker, resolvePreselect } from './picker.ts';
import { t } from '../ui/i18n.ts';
import { detectWall } from '../engine/antiAdblock.ts';
import { consentGate } from '../engine/cookieConsent.ts';
import { clickConsentControl, createConsentController, findConsentBanner } from './consent.ts';
import {
  captureContentBaseline,
  neutralizeWall,
  refreshContentBaseline,
  wallContext,
} from './wallFix.ts';

/**
 * Debounce for the geometry pass.
 *
 * Expand-on-hover ads fire on mouse/scroll, so an on-demand pass beats a permanent
 * poll (one pass = one querySelectorAll + up to 600 size reads). But the baseline
 * must be recorded *before* expansion, or the grown size is stored as normal and
 * growth is never seen — hence upkeep also runs a geometry pass every round.
 */
const GEOMETRY_DEBOUNCE_MS = 600;

/**
 * Content script (ISOLATED world).
 *
 * Only chrome.* wiring and phase orchestration; all judging lives in engine.ts so
 * it stays testable under jsdom. Two phases, and the order matters:
 *   1. document_start: static rules only — exact anchors, safe, no bandwidth cost.
 *   2. after a snapshot backfill: heuristics on (see makeInjectionTest in engine.ts).
 */

/**
 * Snapshot backfill strategy.
 *   auto (default) backfill only when no site pack matched — such sites need no
 *                  heuristics, saving one same-origin request (~189KB on the pilot)
 *   always         always backfill
 *   never          never backfill; heuristics stay off entirely
 */
const PRISTINE_STRATEGY: 'auto' | 'always' | 'never' = 'auto';

/**
 * Cap on waiting for the backfill.
 *
 * The worker refetches the whole page (~189KB on the pilot) and occasionally
 * stalls; without a timeout the whole boot blocks here — symptom: "elements do get
 * hidden, but no ready log and not a single learned domain".
 */
const BACKFILL_TIMEOUT_MS = 6000;

/**
 * Debounce for the anti-adblock wall pass.
 *
 * A wall is inserted as a node (and a site that re-hides the content usually writes a style,
 * which raises no mutation record), so this pass is driven by mutations plus the upkeep rounds
 * rather than by a permanent poll.
 */
const WALL_DEBOUNCE_MS = 800;

const store = chromeLocal();

// ── Popup policy data for the MAIN world ────────────────────────────────────
//
// The window.open guard runs in the page's MAIN world, where neither chrome.storage nor
// extension files are reachable. This script is the bridge, and it publishes **data only**:
//   - `$popup` denylist → `<script type="application/json" id="adblow-popup-deny">`, an inert
//     element the browser never executes;
//   - the per-site "allow popups" switch → an attribute on `<html>`, so a toggle in the popup
//     UI applies to the already-open page without a reload.
//
// The list is requested from the worker instead of fetched here: a content-script fetch of an
// extension resource runs with the page's origin and would need `web_accessible_resources`,
// exposing the list to every page (the cosmetic shards are handled the same way).
//
// Everything here runs at document_start, before `boot()`: the policy must be in place before
// the first click, and none of it depends on the per-site kill switch.

/** Insert the deny list, retrying if the document root does not exist yet. */
function publishPopupDeny(domains: readonly string[]): void {
  if (installPopupDenyElement(document, domains)) return;
  const retry = (): void => {
    if (installPopupDenyElement(document, domains)) {
      document.removeEventListener('readystatechange', retry);
    }
  };
  document.addEventListener('readystatechange', retry);
}

async function publishPopupDenyList(): Promise<void> {
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: 'get-popup-deny' }),
      2500,
    )) as { domains?: unknown } | null | undefined;
    // `null`/missing means the worker could not read the packaged list. Publish nothing: the
    // `$popup` layer then adds no denial, and the default cross-site policy is unchanged.
    // Missing data is not evidence against a site, so it must not create a denial.
    if (!Array.isArray(res?.domains)) return;
    const domains = res.domains.filter((value): value is string => typeof value === 'string');
    publishPopupDeny(domains);
  } catch (error) {
    console.debug('[adblow] popup denylist unavailable; windows follow the default policy', error);
  }
}

/** Publish the switch value, retrying if the document root does not exist yet. */
function publishPopupSettingNow(allowed: boolean): void {
  if (publishPopupAllowance(document, allowed)) return;
  const retry = (): void => {
    if (publishPopupAllowance(document, allowed)) {
      document.removeEventListener('readystatechange', retry);
    }
  };
  document.addEventListener('readystatechange', retry);
}

/**
 * Resolve the switch for the page this frame belongs to.
 *
 * The switch is stored per top-level site, so a frame asks the worker (only it sees the tab
 * URL). If the worker cannot answer, the frame's own host is used -- the same key a top
 * document would read, so a failure degrades to "works in the top frame only" rather than
 * "never allowed".
 */
async function popupAllowedForPage(): Promise<boolean> {
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: 'get-popup-allow' }),
      2500,
    )) as { allowed?: unknown } | null | undefined;
    if (typeof res?.allowed === 'boolean') return res.allowed;
  } catch (error) {
    console.debug('[adblow] popup switch lookup failed; falling back to this host', error);
  }
  return isPopupAllowed(store, location.hostname);
}

async function publishPopupSetting(): Promise<void> {
  try {
    publishPopupSettingNow(await popupAllowedForPage());
  } catch (error) {
    // Storage failure means "not allowed": the safe default is the deny policy.
    console.debug('[adblow] could not read the popup switch', error);
  }
}

void publishPopupDenyList();
void publishPopupSetting();

try {
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !changes) return;
    // Any site's switch may be the tab's top-level one, which a frame cannot derive; ask again
    // rather than filtering by this frame's host.
    if (!Object.keys(changes).some((key) => key.startsWith(POPUP_ALLOW_PREFIX))) return;
    void publishPopupSetting();
  });
} catch (error) {
  console.debug('[adblow] popup switch watcher unavailable', error);
}

/**
 * Forward refused windows to the worker, which keeps one record per site.
 *
 * The MAIN world cannot call chrome.*, so it dispatches a DOM event with a string detail; this
 * listener is the receiving end. One record per second is enough for diagnosis and keeps a page
 * that retries a popup in a loop from writing storage continuously.
 */
let popupBlockReportedAt = 0;
try {
  document.addEventListener(
    POPUP_BLOCK_EVENT,
    (event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail !== 'string' || !detail) return;
      let target: string;
      try {
        target = new URL(detail, location.href).href;
      } catch {
        return;
      }
      const now = Date.now();
      if (now - popupBlockReportedAt < 1000) return;
      popupBlockReportedAt = now;
      try {
        void chrome.runtime.sendMessage({ type: 'record-popup-block', target }).catch(() => {});
      } catch {
        // Extension reloaded or tab torn down: the record is optional.
      }
    },
    { capture: true },
  );
} catch (error) {
  console.debug('[adblow] popup block recorder unavailable', error);
}

// ── Element picker wiring ────────────────────────────────────────────────────
//
// The picker object is created and its capture-phase blockers are installed at
// document_start (module evaluation), *not* on first use: page scripts register their own
// window handlers later, and only a listener installed earlier can stop a click before it
// reaches them. `start()` mounts the shadow-root UI; the context-menu path additionally
// passes the element that was right-clicked, so no second hover/click is needed.

const picker = createPicker({
  doc: document,
  host: location.hostname,
  store,
  strings: () => ({
    title: t('pickerTitle'),
    hint: t('pickerHint'),
    selectorLabel: t('pickerSelectorLabel'),
    save: t('pickerSave'),
    cancel: t('pickerCancel'),
    invalid: t('pickerInvalid'),
  }),
});
picker.attach();

/**
 * Element the most recent native context menu was opened on (top document only).
 *
 * Recorded in the capture phase so page handlers cannot hide or replace the target before
 * this listener sees it. This event is the only DOM signal tied to the right-click itself:
 * Chrome's menu item click arrives later as a runtime message with no element information,
 * so the target has to be remembered here and re-validated when that message arrives.
 */
let contextTarget: Element | null = null;
try {
  if (window.top === window) {
    window.addEventListener(
      'contextmenu',
      (event) => {
        // `event.target` (not composedPath[0]) is deliberate: outside a shadow tree it is
        // retargeted to the host, which is the node a page-level selector can describe.
        contextTarget = event.target instanceof Element ? event.target : null;
      },
      { capture: true, passive: true },
    );
  }
} catch (error) {
  // Cross-origin frame or a torn-down context: no preselection, ordinary picking remains.
  console.debug('[adblow] 右键目标记录不可用', error);
}

/** Popup or context menu → content: enter picking mode (top frame only). */
function startPicker(
  message: unknown,
  _sender: unknown,
  respond: (response?: unknown) => void,
): boolean {
  const msg = message as { type?: string; preselected?: boolean } | null;
  if (msg?.type !== 'start-picker') return false;
  // Only the top frame owns the page the user sees; iframes return false so the sender's
  // frame-0-targeted message is answered by the right document.
  if (window.top !== window) return false;

  void (async () => {
    try {
      if (await isSiteDisabled(store, location.hostname)) {
        respond({ ok: false, reason: 'disabled' });
        return;
      }

      let target: Element | null = null;
      if (msg.preselected === true) {
        const decision = resolvePreselect(contextTarget, document);
        target = decision.target;
        // Clear either way: a detached node must not be kept alive (or retried) by us.
        contextTarget = null;
        if (!target) {
          console.debug(`[adblow] 右键预选不可用（${decision.fallback}），退回普通拾取`);
        }
      }

      picker.start(target ?? undefined);
      respond({ ok: true, preselected: target !== null });
    } catch (error) {
      // Storage or DOM failure: tell the sender instead of leaving it waiting for a response.
      console.warn('[adblow] 进入拾取模式失败', error);
      respond({ ok: false, reason: 'error' });
    }
  })();
  return true;
}

try {
  chrome.runtime.onMessage?.addListener(startPicker);
} catch (error) {
  // A reloaded extension has no runtime bridge; the rest of the content script still runs.
  console.debug('[adblow] 拾取器消息通道不可用', error);
}


async function loadPacks(url: string): Promise<SitePack[]> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'get-site-packs', url })) as
      | SitePack[]
      | undefined;
    return res ?? [];
  } catch (error) {
    console.warn('[adblow] 取站点规则包失败', error);
    return [];
  }
}

/** Domain-specific cosmetic selectors from the filter lists for this host. */
async function requestListCosmetic(host: string): Promise<string[]> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'get-cosmetic', host })) as
      | { selectors?: string[] }
      | undefined;
    return res?.selectors ?? [];
  } catch (error) {
    console.warn('[adblow] 取列表 cosmetic 规则失败', error);
    return [];
  }
}

async function requestPristineHtml(url: string): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'get-pristine', url })) as
      | { html: string }
      | null;
    return res?.html ?? null;
  } catch (error) {
    console.warn('[adblow] 回填服务端快照失败', error);
    return null;
  }
}

/**
 * Ask the worker whether this host is on the packaged badware-domain list.
 *
 * `null` means "list unavailable" (old/corrupt artifact, message failed). The caller
 * deliberately allows banner handling in that case: unlike the DNR gate this replaced,
 * a missing list must not disable the feature in every packaged build.
 */
async function requestBadwareSite(host: string): Promise<boolean | null> {
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: 'is-badware-site', host }),
      2500,
    )) as { badware?: boolean | null } | null | undefined;
    return typeof res?.badware === 'boolean' ? res.badware : null;
  } catch (error) {
    console.debug('[adblow] badware lookup failed; allowing banner handling', error);
    return null;
  }
}

function installCosmeticStyle(selectors: string[]): void {
  const style = document.createElement('style');
  style.setAttribute('data-adblow-cosmetic', '');
  style.textContent = cosmeticCss(selectors);
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * Filter-list cosmetic selectors, per domain (phase two).
 *
 * Unlike site-pack selectors (per-site evidence + fixtures → trusted, they may enter
 * the stylesheet directly), these are community-maintained across tens of thousands
 * of domains and must clear the content guard in content/listCosmetic.ts.
 */
function installListCosmetic(selectors: string[]): number {
  if (selectors.length === 0) return 0;
  // List rules must clear both the content and navigation gate: they are applied
  // per domain in bulk, and one over-broad selector can wipe a whole site.
  const result = applyListCosmetic(
    document,
    selectors,
    (el) => holdsRealContent(el) || mustNotHide(el) || isPickerUi(el),
  );
  if (result.droppedForContent.length) {
    console.debug(
      `[adblow] 列表选择器会隐藏正文，已剔除 ${result.droppedForContent.length} 条：` +
        result.droppedForContent.slice(0, 3).map((s) => s.slice(0, 40)).join(' | '),
    );
  }
  if (result.droppedInvalid.length) {
    console.debug(`[adblow] 列表选择器非法，已剔除 ${result.droppedInvalid.length} 条`);
  }
  return result.injected;
}

/**
 * Cookie-consent banners: click a site-provided button, never hide anything.
 *
 * Two gates run inside `isAllowed`, before every look:
 *   1. the per-site kill switch (the popup writes `disabled:<host>`);
 *   2. the worker's badware-domain answer for this host. Only a confirmed match blocks;
 *      a missing list (`null`) allows handling (see badwareDomains.ts).
 *
 * The first look is delayed so the site's own scripts can render the banner; later looks
 * are driven by mutations and throttled by the controller. Only the top document is
 * considered: consent banners inside ad iframes are not ours to answer.
 */
function installCookieConsent(): void {
  try {
    if (window.top !== window) return;
  } catch {
    return; // cross-origin top access: not a frame we can reason about
  }

  const host = location.hostname;
  // Start the question now so the worker has time to answer before the first look.
  const badwareSite = requestBadwareSite(host);

  const isAllowed = async (): Promise<boolean> => {
    const siteDisabled = await isSiteDisabled(store, host);
    const gate = consentGate({ topFrame: true, siteDisabled, badwareSite: await badwareSite });
    if (!gate.allowed) {
      console.debug(`[adblow] cookie banner left alone: ${gate.reason}`);
    }
    return gate.allowed;
  };

  let observer: MutationObserver | null = null;
  const controller = createConsentController({
    isAllowed,
    find: () => findConsentBanner(document),
    click: clickConsentControl,
    onFinish: () => observer?.disconnect(),
    log: (message) => console.debug(`[adblow] ${message}`),
  });

  try {
    observer = new MutationObserver(() => controller.notifyMutation());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch (error) {
    // Without mutations the first delayed look still runs; the feature degrades, never breaks.
    console.debug('[adblow] cookie consent observer could not attach', error);
  }

  controller.start();
}

async function boot(): Promise<void> {
  const host = location.hostname;

  // Kill switch: when the site is disabled, bail out without touching anything.
  if (await isSiteDisabled(store, host)) {
    console.debug(`[adblow] ${host} 已被用户关闭，本次不做任何处理`);
    return;
  }

  const packs = await loadPacks(location.href);
  // One pruned read for both kinds: `learned` (auto-derived, evidence still required) and
  // `picked` (manual, hides on match). Reading them separately would prune the same map twice.
  const entries = await allEntries(store, host);
  const learned = entries.filter((e) => e.promoted && !e.picked).map((e) => e.selector);
  const picked = entries.filter((e) => e.picked).map((e) => e.selector);
  const selectorSet = selectorsFrom(
    packs,
    learned,
    (r) => console.warn('[adblow] 规则包被误伤护栏拒绝，整包丢弃', r.packId, r.problems),
    picked,
  );

  // Only curated (site-pack) selectors may enter the anti-flash stylesheet: it has
  // no per-element guard, while learned selectors are auto-derived and untested.
  // Measured: learned selectors in the stylesheet hid a large slice of the page from
  // the first moment. Learned selectors use the guarded per-element path only.
  installCosmeticStyle(selectorSet.curated);

  // Filter-list cosmetic rules (phase two).
  //
  // Earlier is better (anti-flash), but the fetch is async (shards live in the
  // worker), so start it without blocking judging; apply under the guard on arrival.
  let listCosmeticCount = 0;
  void requestListCosmetic(host).then((selectors) => {
    listCosmeticCount = installListCosmetic(selectors);
    if (listCosmeticCount || selectors.length) {
      console.debug(
        `[adblow] 列表 cosmetic：候选 ${selectors.length} 条，通过内容守卫 ${listCosmeticCount} 条`,
      );
    }
    // The content guard needs parsed elements; re-check once parsing is done.
    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          listCosmeticCount = installListCosmetic(selectors);
        },
        { once: true },
      );
    }
  });

  // Record only selectors that passed the width check; others are hidden, not learned.
  const learn = (hits: Hit[]): void => {
    for (const hit of hits) {
      const selector = recordableSelector(hit, document);
      if (selector) void recordHit(store, host, selector);
    }
  };

  /**
   * Network-layer learning: promote the cross-site domains used by hidden ads into
   * DNR block rules after enough hits. This is what makes unknown sites improve with
   * use and with no configuration; the safety filters live in learnableAdDomains.
   */
  const learnAdDomains = (): void => {
    const candidates = learnableAdDomains(document, host);
    if (candidates.length > 0) void recordDomains(store, host, candidates, location.href);
  };

  // Page-level budget fallback against wiping a whole page. At document_start the
  // body is nearly empty (zero links), so the baseline is remeasured below.
  const budget = createHidingBudget(document);

  /**
   * Recompute "the site's own content CDN".
   *
   * Cross-site media scores 3 each, so any script-rendered block with two CDN images
   * reached 6 and got hidden, while serving thumbnails from a CDN is universal (the
   * reported hidden recommendation rails and body content were this). The page loads
   * progressively, so recount before every sweep.
   */
  const refreshContentCdn = (): void => {
    options.contentCdnDomains = frequentMediaDomains(document, host);
  };

  // ── Anti-adblock wall (manual confirmation per site) ────────────────────────
  //
  // Detection always runs, so the popup can report "a wall was found here"; the page itself is
  // not changed until the user confirms the fix for this site (`wallfix:<host>`, see
  // settings.ts). Neutralising a wall never relaxes ad blocking — content/wallFix.ts keeps our
  // `data-adblow-hidden` untouched.
  let wallFixOn = await isWallFixEnabled(store, host);
  // Baseline of "content that is visible now": only an element recorded here may later be
  // re-shown, which is what keeps the restore off content the site hid by design.
  const wallBaseline = captureContentBaseline(document);
  let wallDetected = false;
  let wallHidden = 0;
  let wallRestored = 0;

  const wallPass = (): void => {
    try {
      const wall = wallContext(innerWidth * innerHeight);
      const detection = detectWall(document, wall);
      if (detection.detected && !wallDetected) {
        // One write per page load: the popup reads this timestamp for its hint.
        void markWallDetected(store, host);
      }
      if (detection.detected) wallDetected = true;
      if (!wallFixOn) return;

      refreshContentBaseline(wallBaseline, document);
      const result = neutralizeWall(document, { baseline: wallBaseline, wall });
      wallHidden += result.hiddenPrompts.length;
      wallRestored += result.restored.length;
      if (result.hiddenPrompts.length || result.restored.length) {
        const kinds = [...new Set(result.restored.map((r) => r.reason))].join(',');
        console.debug(
          `[adblow] 反过滤墙：隐藏提示 ${result.hiddenPrompts.length} 个、` +
            `恢复正文 ${result.restored.length} 个${kinds ? `（${kinds}）` : ''}`,
        );
      }
    } catch (error) {
      console.warn('[adblow] 反过滤墙处理失败', error);
    }
  };

  /** Debounced pass: a wall is inserted as a node, so mutations are the main trigger. */
  let wallTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleWallPass = (): void => {
    // Once a wall is known and the fix is off, another look cannot change anything (the popup
    // hint is already recorded), so dynamic pages do not pay for repeated scans.
    if (wallDetected && !wallFixOn) return;
    if (document.hidden || wallTimer !== null) return;
    wallTimer = setTimeout(() => {
      wallTimer = null;
      wallPass();
    }, WALL_DEBOUNCE_MS);
  };

  // Confirmation can arrive while the page is open (the popup writes the same key). There is no
  // message protocol here, so chrome.storage is the channel; storage is also what the acceptance
  // harness seeds before navigation, and both paths must work.
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes) return;
      const key = wallFixKey(host);
      if (!(key in changes)) return;
      wallFixOn = changes[key]?.newValue === true;
      // Act at once: the wall the user is looking at is already up.
      if (wallFixOn) wallPass();
    });
  } catch (error) {
    console.warn('[adblow] 监听反过滤墙开关失败', error);
  }

  // Phase one: static rules only. injected always false turns heuristics off.
  let options: JudgeOptions = {
    injected: () => false,
    host,
    viewportArea: innerWidth * innerHeight,
    selectors: selectorSet,
    budget,
  };

  let rule = 0;
  let heuristic = 0;

  /** Geometry snapshots, used to spot ads that expand purely through CSS. */
  const tracker = createGrowthTracker();

  // One observer plus a mutable options object: the phase-two upgrade neither
  // rebuilds the observer nor reprocesses anything.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const added = processAdded(node as Element, options);
        rule += added.rule;
        heuristic += added.hits.length;
        learn(added.hits);
      }
    }
    // A late (or re-inserted) wall arrives as a node; the pass is debounced.
    scheduleWallPass();
  }).observe(document.documentElement, { childList: true, subtree: true });

  // sweep skips already-hidden elements, so repeated passes never double-count.
  const sweepNow = (): number => {
    refreshContentCdn();
    const r = sweep(document.documentElement, options);
    learn(r.hits);
    rule += r.hiddenByRule;
    heuristic += r.hiddenByHeuristic;
    return r.hiddenByRule;
  };

  /**
   * Geometry-growth re-judging (grow-on-hover / auto-enlarge) — its own pass.
   *
   * These ads work through pure CSS, inserting no nodes, so MutationObserver never
   * fires (three acceptance cases failed on exactly this). Growth is evidence in
   * itself, so this pass needs no proof of script injection.
   */
  const recheckGrown = (): number => {
    const grown = collectGrownElements(document, tracker, {
      viewportArea: innerWidth * innerHeight,
    });
    let n = 0;
    for (const el of grown) {
      const verdict = judgeGrownElement(el, options);
      if (verdict) {
        applyVerdict(el, verdict, budget);
        heuristic += 1;
        n += 1;
      }
    }
    if (n) console.debug(`[adblow] 几何突增重判隐藏 ${n} 个元素`);
    return n;
  };

  /**
   * Link farms (ad/SEO spam blocks built from many distinct off-site links) — own pass.
   *
   * Measured: a footer carried 39 distinct cross-site domains injected by the site's
   * own partners.js. A single cross-site link scores only 4, below the 6 threshold
   * (deliberately), and such containers have too many descendants for descendant
   * signals to be trusted — hence a separate check.
   */
  /** Budget-guarded hide, shared by the standalone passes. Returns whether it hid. */
  const hideGuarded = (el: Element, reason: string): boolean => {
    if (!budget.canHide(el)) {
      console.debug(`[adblow] 页级预算兜底：拒绝隐藏 ${reason}（会清空整页）`);
      return false;
    }
    hideElement(el, reason);
    budget.commit(el);
    return true;
  };

  const hideLinkFarms = (): number => {
    const farms = findLinkFarms(document, { host });
    let n = 0;
    for (const el of farms) {
      if (!hideGuarded(el, 'linkfarm')) continue;
      heuristic += 1;
      n += 1;
    }
    if (n) console.debug(`[adblow] 链接农场：隐藏 ${n} 个块`);
    return n;
  };

  /**
   * Fake close buttons (a "close" control that is really a cross-site link) — own pass.
   *
   * Such pop-ups miss the overlay area threshold and carry no ad naming, yet a close
   * control pointing at another domain is suspicious by itself. Hiding the outer ad
   * container beats blocking the click, which would leave the ad in place.
   */
  const hideFakeClose = (): number => {
    const ads = findFakeCloseAds(document, { host });
    let n = 0;
    for (const { element, hit } of ads) {
      if (!hideGuarded(element, 'fake-close')) continue;
      heuristic += 1;
      n += 1;
      learn([hit]);
    }
    if (n) console.debug(`[adblow] 假关闭按钮：隐藏 ${n} 个广告浮窗`);
    return n;
  };

  /**
   * Invisible click layers (clickjacking) — own pass.
   *
   * As with overlays, geometry and style checks stay out of the per-element hot path.
   * Hiding beats intercepting the click: clicks never reach it, and it renders nothing
   * visible, so hiding it removes no text or links.
   */
  const hideClickLayers = (): number => {
    const layers = findInvisibleClickLayers(document, {
      viewportArea: innerWidth * innerHeight,
    });
    let n = 0;
    for (const el of layers) {
      // Click layers skip the budget fallback: leaving one in place costs far more
      // (the whole page becomes unclickable) than a misjudgement, and since it
      // renders nothing visible, hiding it removes no text or links.
      hideElement(el, 'click-layer');
      heuristic += 1;
      n += 1;
    }
    if (n) {
      console.debug(`[adblow] 已隐藏 ${n} 个隐形点击层`);
    }
    return n;
  };

  /**
   * Overlays get their own pass (never part of per-element scoring).
   *
   * Run last: regular rules and heuristics have landed by then, so corroboration sees
   * the fullest context; and because this pass rewrites inline styles, running it
   * after the scoring sweeps keeps those sweeps fast.
   */
  const hideOverlays = (): number => {
    const ads = findOverlayAds(document, { host, viewportArea: innerWidth * innerHeight });
    let n = 0;
    for (const { element, hit } of ads) {
      if (!hideGuarded(element, 'overlay')) continue;
      heuristic += 1;
      n += 1;
      learn([hit]);
    }
    return n;
  };

  // First-screen pass: whatever is scannable now. At document_start the body is not
  // parsed yet, so this usually only covers <head>; the real sweep comes later.
  sweepNow();

  /**
   * Finalisation: overlays, network learning, stats.
   *
   * Never schedule it after the snapshot backfill: the backfill refetches the page
   * through the worker and, when it stalls, would block all of this — symptom
   * "elements hidden, but no ready log and not one learned domain". None of it
   * depends on the backfill.
   */
  const upkeep = (label: string): void => {
    // Geometry pass first: the initial round records the baselines growth is measured against.
    recheckGrown();
    // More content may have loaded → refresh the budget denominator (it only grows).
    budget.refresh(document);
    refreshContentCdn();
    // Wall handling before the hiding passes: the baseline must see newly parsed content, and a
    // restored article must not be re-judged as an ad slot.
    refreshContentBaseline(wallBaseline, document);
    wallPass();
    const farms = hideLinkFarms();
    const fakeClose = hideFakeClose();
    const layers = hideClickLayers();
    const overlays = hideOverlays();
    // Re-check that what we hid is still hidden. Must come last: verifying a
    // just-hidden element is pointless, and sites typically restore display after
    // their own scripts ran (measured: a 1024cg overlay left links unclickable).
    const audit = verifyHiding(document);
    const bs = budget.stats();
    learnAdDomains();
    void writeStats(store, host, { rule, heuristic });
    console.debug(
      `[adblow] ${label} host=${host} 规则包=${packs.length} ` +
        `选择器=${selectorSet.curated.length}包+${selectorSet.learned.length}学 ` +
        `隐藏 rule=${rule} heuristic=${heuristic} overlay=${overlays} 点击层=${layers} ` +
        `假关闭=${fakeClose} 链接农场=${farms} ` +
        `复核=${audit.checked}/重新隐藏=${audit.refought} ` +
        `反过滤墙=检测${wallDetected ? '有' : '无'}/隐藏提示${wallHidden}/恢复正文${wallRestored} ` +
        `预算=文字${bs.text}/${bs.totalText} 链接${bs.links}/${bs.totalLinks} 兜底拒绝=${bs.suppressed}` +
        (audit.stubborn.length ? ` 顽固=[${audit.stubborn.slice(0, 3).join(' ')}]` : ''),
    );
  };

  /**
   * On-demand geometry pass: only after mouse-in / scroll, never a permanent poll.
   *
   * Those are exactly the triggers for expanding ads, so checking afterwards is
   * enough and costs nothing in between. A permanent timer would also keep
   * "run the build and observe" test processes from exiting.
   */
  let geometryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleGeometryPass = (): void => {
    if (document.hidden || geometryTimer !== null) return;
    geometryTimer = setTimeout(() => {
      geometryTimer = null;
      recheckGrown();
      hideFakeClose();
      hideLinkFarms();
    }, GEOMETRY_DEBOUNCE_MS);
  };

  for (const type of ['mouseover', 'pointerover', 'scroll', 'wheel'] as const) {
    document.addEventListener(type, scheduleGeometryPass, { capture: true, passive: true });
  }

  // Key: sweep once more once the DOM is parsed. MutationObserver alone could cover
  // this, but an explicit sweep is more reliable (the observer can drop events).
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
    // Content is only parsed now → re-measure the budget baseline (it only grows).
    budget.refresh(document);
    sweepNow();
    // First full look at the parsed DOM: record the wall baseline before the page can hide the
    // article, and repair a wall that is already up (see content/wallFix.ts).
    refreshContentBaseline(wallBaseline, document);
    wallPass();
  }

  // Phase-one finalisation: independent of the backfill, so land it right away.
  upkeep('就绪(仅静态规则)');

  // Finalise again a couple of rounds later, covering lazy-loaded and late-injected
  // ad slots. A finite number of timers instead of a permanent one keeps idle cost zero.
  for (const delay of [4000, 12000]) {
    setTimeout(() => upkeep('巡回收尾'), delay);
  }

  // Phase two: backfill the full server-side snapshot to enable heuristics.
  // The timeout is required: the worker refetches the page, and a stall must not
  // leave judging stuck in the static tier forever.
  const wantBackfill =
    PRISTINE_STRATEGY === 'always' || (PRISTINE_STRATEGY === 'auto' && packs.length === 0);
  if (!wantBackfill) return;

  const html = await withTimeout(requestPristineHtml(location.href), BACKFILL_TIMEOUT_MS);
  if (!html) {
    console.debug('[adblow] 快照回填未在超时内返回，保持仅静态规则档');
    return;
  }

  try {
    const index = buildPristineIndexFromHtml(html, new DOMParser());
    // Upgrade to heuristic judging; the full sweep below re-covers handled nodes.
    options = { ...options, injected: makeInjectionTest(index, true) };
    sweepNow();
    upkeep('就绪(含启发式)');
  } catch (error) {
    console.warn('[adblow] 解析服务端快照失败，退化为仅静态规则', error);
  }
}

void boot();
void installCookieConsent();


// ── Click-triggered navigation watch (record only) ───────────────────────────
//
// Observation, not enforcement. A click on ordinary content is reported to the service worker,
// which records a cross-site top-frame navigation that follows within a few seconds; the rule
// manager shows the result. Nothing here changes what the page is allowed to do.

/** Controls the user expects to open something: a click there is not the hijack shape. */
const CLICK_WATCH_CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [onclick], [contenteditable="true"]';

let clickWatchLastAt = 0;
addEventListener(
  'click',
  (ev) => {
    if (ev.isTrusted === false) return; // script-synthesised: not a user click
    if (window.top !== window) return; // only the top document can navigate the tab
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest?.(CLICK_WATCH_CONTROL_SELECTOR)) return;
    const now = Date.now();
    if (now - clickWatchLastAt < 1000) return; // one report per second is plenty
    clickWatchLastAt = now;
    try {
      void chrome.runtime
        .sendMessage({ kind: 'click-plain', url: location.href, at: now })
        .catch(() => {});
    } catch {
      // Extension reloaded or tab torn down: nothing to report.
    }
  },
  { capture: true, passive: true },
);
