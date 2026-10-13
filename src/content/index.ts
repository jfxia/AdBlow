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
import { promotedSelectors, recordHit } from './learn.ts';
import { applyListCosmetic } from './listCosmetic.ts';
import { recordDomains } from './domainLearn.ts';
import { isSiteDisabled, writeStats } from './settings.ts';
import { chromeLocal } from './storage.ts';

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

const store = chromeLocal();

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
    (el) => holdsRealContent(el) || mustNotHide(el),
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

async function boot(): Promise<void> {
  const host = location.hostname;

  // Kill switch: when the site is disabled, bail out without touching anything.
  if (await isSiteDisabled(store, host)) {
    console.debug(`[adblow] ${host} 已被用户关闭，本次不做任何处理`);
    return;
  }

  const packs = await loadPacks(location.href);
  const learned = await promotedSelectors(store, host);
  const selectorSet = selectorsFrom(packs, learned, (r) =>
    console.warn('[adblow] 规则包被误伤护栏拒绝，整包丢弃', r.packId, r.problems),
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
