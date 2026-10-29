import { isInjected, type PristineIndex } from '../engine/pristine.ts';
import { scoreNode, registrableDomain, isSameBrand, unwrapAdRedirect } from '../engine/score.ts';
import { crossSiteResourceDomains, pageWideMediaDomains } from '../engine/domains.ts';
import { NAMING_STRONG, NAMING_WEAK, namingSignal } from '../engine/lexicon.ts';
import { generalizeSelector, isSelectorSafe } from '../engine/selector.ts';
import { forbiddenSelectorReason, validateSitePack, type SitePack } from '../engine/rules.ts';

/**
 * Judging core of the content script.
 *
 * Deliberately free of chrome.* and the global document: DOM and timing are passed in, so the core
 * is regression-testable under Node + jsdom and the chrome wiring stays a thin layer.
 */

export const SCORE_THRESHOLD = 6;

export type Rejection = { packId: string; problems: string[] };

export type Hit = {
  /**
   * Generalized selector; null when no stable feature could be generalized — the element is
   * still hidden, but **no rule is produced** (see src/engine/selector.ts).
   */
  selector: string | null;
  score: number;
  reasons: string[];
};

/**
 * Filter hits down to selectors safe enough to persist.
 *
 * Four gates (2–4 added after the 2026-10-10 incident):
 *   1. the generalizer already rejects bare tag names (returns null)
 *   2. not a forbidden selector — reuses the rule-pack guardrails; validateSitePack never sees the
 *      learning path (which once derived a content-card class, see SelectorSet)
 *   3. no matched element may contain real content
 *   4. matched elements may hold only few images (≤ maxImages): a real ad slot holds 1–2 creatives,
 *      whereas a site-wide link wrapper matched 43 elements with 22 images
 *
 * Plus a width measurement: the match count must stay below maxMatches.
 *
 * Learned rules apply on later visits, so admission must be extremely conservative.
 */
export function recordableSelector(
  hit: Hit,
  root: ParentNode,
  maxMatches = 30,
  maxImages = 4,
): string | null {
  if (!hit.selector) return null;
  const selector = hit.selector;

  if (forbiddenSelectorReason(selector)) return null;
  if (!isSelectorSafe(selector, root, maxMatches)) return null;

  let matched: Element[] = [];
  try {
    matched = Array.from(root.querySelectorAll(selector));
  } catch {
    return null;
  }
  if (matched.length === 0) return null;

  let images = 0;
  for (const el of matched) {
    if (holdsRealContent(el)) return null;
    // Never learn an explicitly declared navigation element as hideable either.
    if (mustNotHide(el)) return null;
    images += el.matches(MEDIA_TAGS) ? 1 : 0;
    images += el.querySelectorAll('img,video,picture').length;
    if (images > maxImages) return null;
  }

  return selector;
}

export type InjectionTest = (el: Element) => boolean;

/**
 * Default injection test, used **only by the pure-behaviour tier** (see createJudge).
 *
 * `reliable` is a measurement requirement, not a conservative switch: at document_start almost
 * nothing is parsed, so an in-place snapshot index is empty and untrustworthy — and the pilot's
 * server HTML already holds compact link boxes scoring 8 against a threshold of 6, so the
 * behaviour tier misfires on all of them with such a snapshot. Raising the threshold instead
 * would lose the most valuable generic signal (cross-site link + promo parameter).
 *
 * `reliable === false`: that tier is off entirely (static rules and the naming tier remain).
 * `reliable === true`: a full server snapshot separates injected nodes by signature.
 * The naming tier is unaffected either way — strong ad naming is deterministic evidence.
 *
 * See buildPristineIndexFromHtml (engine/pristine.ts) and PRISTINE_STRATEGY (content/index.ts).
 */
export function makeInjectionTest(index: PristineIndex, reliable: boolean): InjectionTest {
  return (el: Element) => reliable && isInjected(el, index);
}

/**
 * Selector set: trusted and auto-derived selectors are kept strictly apart.
 *
 * Why (2026-10-10 incident): learned selectors used to be mixed with rule packs and written into
 * the document_start stylesheet — a path with **no per-element guard** — so a learned link-wrapper
 * class (22 images inside) and a content-card class hid a large slice of the page from the first
 * moment.
 *
 *   - `curated`: site rule packs, evidence + fixture regressions → may enter the stylesheet
 *   - `learned`: auto-derived → never enters the stylesheet, guarded per-element path only
 */
export type SelectorSet = {
  curated: string[];
  learned: string[];
  /**
   * Rules the user added with the element picker. They hide on match **without** needing
   * naming/behaviour evidence: a manual pick is an explicit instruction, unlike an
   * auto-derived guess. Kept apart from `learned` so the two privileges stay legible.
   */
  picked?: string[];
};

/** Collect selectors: rule packs → curated, learned → learned, manual picks → picked. */
export function selectorsFrom(
  packs: SitePack[],
  learned: string[],
  onReject?: (r: Rejection) => void,
  picked: string[] = [],
): SelectorSet {
  const curated = new Set<string>();

  for (const pack of packs) {
    const problems = validateSitePack(pack);
    if (problems.length) {
      onReject?.({ packId: pack.id, problems });
      continue;
    }
    for (const s of pack.cosmetic) curated.add(s);
  }

  return {
    curated: [...curated],
    learned: [...new Set(learned)],
    picked: [...new Set(picked)],
  };
}

/** Behaviour score a weak naming needs to count (one cross-site link = 4). */
export const WEAK_NAMING_MIN_BEHAVIOR = 4;

/**
 * Content markers: these mean the element holds **real content**.
 *
 * A hard exception to the naming tier, from a self-inflicted incident: the pilot's
 * `<div data-ssp-container="ssp-list">` counted as strong naming (the attribute contains
 * `data-ssp-`) and the whole article list was hidden. No evidence may overturn "this holds
 * content".
 *
 * ARIA landmark roles are the author's own declaration, exactly like the semantic tags above,
 * so they belong here — this gate runs before every naming tier, and that is the point.
 * `[role="main"]` is the one that matters most (real site, YouTube Shorts, 2026-10-29):
 * `<ytd-shorts … role="main">` *is* the page body, and a naming false positive (a boolean
 * attribute whose name contained `ads`) hid it — a blank page with sound still playing. A role
 * declaration cannot be talked out of by any heuristic, which is why it is a stronger fix than
 * tuning the naming word list.
 *
 * `[role="navigation"]` is also in NAVIGATION_MARKERS; repeating it here is deliberate —
 * NAVIGATION_MARKERS is consulted *after* the strong-naming tier (ads disguised as navigation
 * stay hideable), while this list is consulted first and grants absolute protection.
 */
export const CONTENT_MARKERS = [
  'article[itemtype*="BlogPosting"]',
  'article[itemprop]',
  '[itemprop="articleBody"]',
  'main article',
  '[role="main"]',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
];

/** The element is content itself, or holds real content. */
export function holdsRealContent(el: Element): boolean {
  return hasContentMarker(el) || hasSubstantiveText(el);
}

/**
 * Explicitly declared **navigation** structures.
 *
 * Like content markers this is the author's own declaration, so it is absolutely protected
 * (users reported hidden navigation lists). Navigation holds only short labels, so the
 * text-volume proxy cannot protect it (measured: 12 nav items, 72 characters in total).
 *
 * No `querySelector` propagation outwards, unlike content markers: nearly every `<body>` has a
 * `<nav>` and mixed navigation/ad containers are common, so propagating would make them all
 * unhideable and the ads would survive. Only the navigation itself (`isNavigationLike`) and its
 * insides (`isInsideNavigation`) are protected.
 */
export const NAVIGATION_MARKERS = [
  'nav',
  '[role="navigation"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
];

/**
 * **Class-based** navigation markers: protect the element itself, never its descendants.
 *
 * Most sites use `<div class="navbar">` instead of semantic tags — exactly the reported hidden
 * navigation bar. Propagation is impossible here: `[class*="navbar"]` matched page-level wrappers
 * (`.navbar-box`, `.top-navbar`), so every descendant counted as protected and ads survived
 * (6 integration tests failed at once). Semantic marker = declaration → may propagate;
 * class = heuristic → self only.
 */
export const NAV_CONTAINER_MARKERS = [
  '[class*="navbar"]',
  '[class*="nav-bar"]',
  '[class*="navigation"]',
  '[class*="breadcrumb"]',
  '[class*="pagination"]',
  '[class*="mainmenu"]',
  '[class*="main-menu"]',
  '[class*="topmenu"]',
  '[class*="top-menu"]',
  '[class*="tabbar"]',
  '[class*="tab-bar"]',
];

export function isNavigationLike(el: Element): boolean {
  try {
    return (
      el.matches(NAVIGATION_MARKERS.join(',')) ||
      el.matches(NAV_CONTAINER_MARKERS.join(','))
    );
  } catch {
    return false;
  }
}

/** The element sits inside **semantic** navigation (class markers excluded, see above). */
export function isInsideNavigation(el: Element): boolean {
  return el.closest(NAVIGATION_MARKERS.join(',')) !== null;
}

/**
 * **Absolutely unhideable**: explicitly declared content and navigation. Every source must pass
 * this gate. Text volume is deliberately not here: it is a proxy that strong naming may
 * overturn (see createJudge).
 */
export function mustNotHide(el: Element): boolean {
  return hasContentMarker(el) || isNavigationLike(el);
}

/** Semantic markers (schema.org article markup) — absolutely protected, nothing overturns them. */
export function hasContentMarker(el: Element): boolean {
  const selector = CONTENT_MARKERS.join(',');
  return el.matches(selector) || el.querySelector(selector) !== null;
}

/** "Substantive text" threshold, in characters after whitespace collapse. */
export const SUBSTANTIVE_TEXT_MIN = 200;
/** A "solid paragraph" needs at least this many characters to count as article text. */
export const SUBSTANTIVE_PARA_MIN = 40;
/** This many solid paragraphs make the element article text. */
export const SUBSTANTIVE_PARA_COUNT = 2;

/**
 * Does the element hold **substantive text**?
 *
 * Why this exists (real incident): the content guard only knew schema.org article markup,
 * tuned on the pilot site which happens to carry it. On ordinary sites `<div class="content">`,
 * `<nav>`, `<ul class="menu">` and plain `<p>` bodies got no protection at all, so heuristics
 * wiped articles and navigation wholesale (the reported xchina.co symptom).
 *
 * Unlike semantic markers (direct evidence → absolute protection), text volume is a **proxy** —
 * ads can carry text too — so it is only a strong prior: weak naming and pure behaviour may not
 * hide it, strong naming (`.sponsored-post`) may (see createJudge).
 */
export function hasSubstantiveText(el: Element): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length >= SUBSTANTIVE_TEXT_MIN) return true;

  let solid = 0;
  for (const p of Array.from(el.querySelectorAll('p'))) {
    if ((p.textContent ?? '').replace(/\s+/g, ' ').trim().length >= SUBSTANTIVE_PARA_MIN) {
      solid += 1;
      if (solid >= SUBSTANTIVE_PARA_COUNT) return true;
    }
  }
  return false;
}

/**
 * The element sits **inside** content (itself or an ancestor carries a content marker).
 *
 * holdsRealContent asks "does it hold content", this asks "am I within content". Link farms
 * need the latter: a "related/ref links" block inside an article legitimately carries 5+ outbound
 * links and is authored content, while the same block in a footer or sidebar is spam.
 */
export function isInsideRealContent(el: Element): boolean {
  return el.closest(CONTENT_MARKERS.join(',')) !== null;
}

/**
 * An editorial list sitting inside an ad-named container.
 *
 * Why (real false positive, 2026-10-19, finance.sina.com.cn): the portal names its ad **slot
 * wrappers** `directAd_*` and `m-p-ad-*`. When a slot has no ad to show, it renders editorial
 * headlines inside instead of collapsing. `directAd_dell_fidx_01` splits to `direct ad dell
 * fidx 01`, matches the strong token `ad`, and naming alone (= threshold) hid the whole list:
 * nine content lists on the homepage, up to 22 article links each.
 *
 * The discriminator is content shape, not the name: a creative carries 0–2 links, an editorial
 * list carries many same-site article links with the text to go with them.
 */
export const EDITORIAL_LIST_MIN_LINKS = 3;
export const EDITORIAL_LIST_MIN_TEXT = 40;

export function looksLikeEditorialList(el: Element, pageHost: string): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < EDITORIAL_LIST_MIN_TEXT) return false;

  const pageReg = registrableDomain(pageHost);
  let sameSite = 0;
  for (const a of Array.from(el.querySelectorAll('a[href]'))) {
    // Links inside blocks we already hid are not evidence (same rule as scoreNode).
    if (a.closest('[data-adblow-hidden]') !== null) continue;
    const href = a.getAttribute('href') ?? '';
    if (!href || /^(?:javascript|mailto|tel):/i.test(href) || href.startsWith('#')) continue;
    let hostname: string;
    try {
      hostname = new URL(href, `https://${pageHost}`).hostname;
    } catch {
      continue;
    }
    if (registrableDomain(hostname) !== pageReg) continue;
    sameSite += 1;
    if (sameSite >= EDITORIAL_LIST_MIN_LINKS) return true;
  }
  return false;
}

/** Media selector: images, video, embedded objects. */
export const MEDIA_TAGS = 'img,video,source,embed,object,picture';

/** The element is media itself, or contains media. */
export function containsMedia(el: Element): boolean {
  return el.matches(MEDIA_TAGS) || el.querySelector(MEDIA_TAGS) !== null;
}

/**
 * Build a heuristic judge. **Three tiers, decreasing evidence strength.**
 *
 * This replaced an early "require script injection" single tier, which failed entirely on site two
 * (1024cg.com): its ads are server-rendered `article.ad-item`, so that gate excluded all of them.
 *
 *   ① deterministic naming (>= NAMING_STRONG): decide outright, ignoring injection and behaviour
 *   ② weak naming + behaviour: `banner` / `popup` / `sponsor` also appear in normal UI, so they
 *      count only with corroboration such as a cross-site link
 *   ③ pure behaviour: no naming, so script injection **must** be proven first (makeInjectionTest)
 *
 * All tiers are preceded by the content guard (holdsRealContent).
 */
export function createJudge(
  injected: InjectionTest,
  host: string,
  viewportArea: number,
  threshold: number = SCORE_THRESHOLD,
  contentCdnDomains?: Set<string>,
): (el: Element) => Hit | null {
  return (el: Element): Hit | null => {
    // Semantic markers outrank every other piece of evidence (incident regression guard).
    if (hasContentMarker(el)) return null;

    const naming = namingSignal(el).strength;
    const { score, behavior, reasons } = scoreNode(el, {
      pageHost: host,
      viewportArea,
      contentCdnDomains,
    });

    const hit = (): Hit => ({ selector: generalizeSelector(el), score, reasons });

    // ① Deterministic naming: strong naming may overturn the text-volume proxy, because
    // naming is explicit evidence — a `.sponsored-post` stays an ad slot even with text inside.
    //
    // Except when the slot holds an editorial list (see looksLikeEditorialList): the name then
    // only says "an ad would go here", and portals do fill such slots with headline lists when
    // no ad fills. Behavioural evidence still settles it.
    if (naming >= NAMING_STRONG && (!looksLikeEditorialList(el, host) || behavior >= threshold)) {
      return hit();
    }

    // Navigation is page skeleton: short labels escape text volume, so gate it separately.
    if (isNavigationLike(el) || isInsideNavigation(el)) return null;

    // Video/player: blocks containing `<video>` are never hidden on weak evidence (reported as
    // "the video window got blocked"). Ad-named video slots are already handled by the tier above.
    if (el.matches('video') || el.querySelector('video') !== null) return null;

    // Plenty of text = looks like content → weak naming and pure behaviour may not hide it
    // (this was the root cause of wholesale content/navigation kills, see hasSubstantiveText).
    if (hasSubstantiveText(el)) return null;

    // ② Weak naming + behavioural corroboration
    if (naming === NAMING_WEAK && behavior >= WEAK_NAMING_MIN_BEHAVIOR) return hit();

    // ③ Pure behaviour: must be proven script-injected and must not look like content.
    //
    // The weakest tier by construction: no naming clue, inference from behaviour only. Measured
    // (reported dgav40 player/recommendation rail, confirmed in a real browser): both were
    // created at runtime (injected=true) with covers/streams on a cross-site CDN, so this tier
    // killed them. Without naming, ads are small with few assets; big blocks full of thumbnails
    // are content.
    if (
      injected(el) &&
      behavior >= threshold &&
      !looksLikeContentBlock(el, viewportArea, { pageHost: host, contentCdnDomains })
    ) {
      return hit();
    }

    return null;
  };
}

/** Largest viewport share the pure-behaviour tier may hide: bigger than this is a content block. */
export const BEHAVIOR_ONLY_MAX_AREA_RATIO = 0.25;
/** Most content assets this tier allows: ad creatives come in 1–2, content lists come in walls. */
export const BEHAVIOR_ONLY_MAX_MEDIA = 2;

/**
 * "Does this look like a content block?" — an extra gate for the pure-behaviour tier.
 *
 * Basis (2026-10-13, user confirmed in a real browser): a script-created player (`<video>`
 * container, cover on a cross-site CDN) and a recommendation rail (wall of CDN thumbnails,
 * large) both scored 6+ and were hidden.
 *
 * Assets must be judged by **source**, not count: a site put 3 ad images inside
 * `ul.streamer-box2`, and a pure count rule would treat that ad carousel as content. A wall of
 * assets from the site's own content CDN (or same origin) is a content list; assets from ad
 * domains stay ads however many there are.
 *
 * Only active **without naming evidence**: large blocks with strong naming (`.ad-slot`) still go.
 */
export function looksLikeContentBlock(
  el: Element,
  viewportArea: number,
  ctx?: { pageHost?: string; contentCdnDomains?: ReadonlySet<string> },
): boolean {
  // ① Large area
  if (viewportArea > 0) {
    const r = el.getBoundingClientRect();
    if ((r.width * r.height) / viewportArea > BEHAVIOR_ONLY_MAX_AREA_RATIO) return true;
  }

  // ② Wall of assets (content list / thumbnail grid) — count content-source assets only
  const cdn = ctx?.contentCdnDomains;
  const pageReg = ctx?.pageHost ? registrableDomain(ctx.pageHost) : null;
  let contentMedia = 0;
  for (const m of Array.from(el.querySelectorAll('img,picture,source,canvas'))) {
    // Assets already handled are not counted twice (same guard as in scoreNode).
    if (m.parentElement?.closest(`[${HIDDEN_ATTR}]`)) continue;
    const raw =
      m.getAttribute('src') ?? m.getAttribute('data-src') ?? m.getAttribute('srcset') ?? '';
    if (!raw) continue;
    let host: string | null = null;
    try {
      host = new URL(raw.split(/\s+/)[0]!, `https://${ctx?.pageHost ?? 'localhost'}`).hostname;
    } catch {
      continue;
    }
    const reg = registrableDomain(host);
    // Same-origin assets, or assets on the site's content CDN → content.
    const isContentSource = (pageReg !== null && reg === pageReg) || (cdn?.has(reg ?? '') ?? false);
    if (isContentSource) contentMedia += 1;
  }
  // Without CDN knowledge, fall back to counting all assets (bias towards hiding less).
  const mediaCount = cdn && cdn.size > 0
    ? contentMedia
    : el.querySelectorAll('img,picture,video,source,canvas').length;
  if (mediaCount > BEHAVIOR_ONLY_MAX_MEDIA) return true;

  // ③ Video / player container
  if (el.matches('video,iframe') || el.querySelector('video') !== null) return true;
  if (el.matches('[class*="player"],[id*="player"],[class*="video-"],[id*="video-"]')) return true;
  if (el.querySelector('[class*="player"],[id*="player"]') !== null) return true;
  return false;
}

/**
 * Roots that must never be hidden.
 *
 * Hiding `<body>` / `<html>` blanks the entire page, which is never a legitimate ad action.
 * Two reasons for the hard invariant:
 *   1. it is the last "the whole page vanished" safety net (harder than the page budget)
 *   2. measured: a test left `data-adblow-hidden` on `<body>`, so the engine really can target
 *      a root element
 */
const NEVER_HIDE_TAGS = new Set(['HTML', 'BODY', 'HEAD']);

/**
 * Mark of the picker's own host element.
 *
 * The picker mounts its UI inside a shadow root, but the host itself is a plain element in
 * the page's light DOM, so the engine would otherwise judge it like any other node. Both
 * the judge and every hiding path treat this subtree as off-limits: the picker must never
 * be classified as an ad and never hide itself mid-pick.
 */
export const PICKER_UI_ATTR = 'data-adblow-picker-ui';

/** Is this element part of the picker UI (host or, in tests, its wrapper)? */
export function isPickerUi(el: Element): boolean {
  try {
    return el.closest(`[${PICKER_UI_ATTR}]`) !== null;
  } catch {
    return false;
  }
}

/**
 * Never rendered: hiding one of these is a no-op visually, yet it would leave our marker
 * attributes on it (and `#removePlayerAD` on a `<style>` scores as ad naming, so the sweep
 * really does target it — real page snapshot, YouTube, 2026-10-29).
 */
const INERT_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE']);

/** XHTML namespace: the only namespace an `HTMLElement` lives in. */
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Hide with inline styles.
 *
 * Not a stylesheet: an inline `!important` sits at the top of the author origin and cannot be
 * countered by an `!important` rule the site injects later. The stylesheet is only the cheap first
 * line of defence against flashing.
 *
 * Why `pointer-events` / `visibility` too (real incident): on 1024cg the site reset `display` to
 * `block` with an inline `!important` from its own origin — same precedence, later wins — so a
 * `position:fixed; z-index:9999` layer covering 99.5% of the viewport reappeared and left the
 * whole page unclickable while `data-adblow-hidden` still claimed success. Hiding on several
 * fronts (`display`, `pointer-events`, `visibility`) means at least one survives.
 *
 * `reason` goes to `data-adblow-reason` and is the only means of triaging a false positive: it must
 * be obvious whether a rule pack, heuristic, overlay, link farm or list cosmetic rule did it.
 *
 * Returns false when the element was left untouched (never-rendered tag, non-HTML element, or no
 * inline style surface). Callers must not count a hide that did not happen: `verifyHiding` would
 * otherwise keep "re-hiding" a visible element and report it as stubborn forever.
 */
export function hideElement(el: Element, reason?: string): boolean {
  if (NEVER_HIDE_TAGS.has(el.tagName)) return false;
  if (INERT_TAGS.has(el.tagName)) return false;
  // The picker is our own UI: hiding it would break the very interaction in progress.
  if (isPickerUi(el)) return false;
  // Only HTML elements have the inline style surface this function drives. SVG/MathML (a
  // different namespace) would be tagged as hidden without actually being hidden — the exact
  // lie verifyHiding exists to catch. Namespace, not `instanceof HTMLElement`: the engine is
  // called with documents from other realms (jsdom fixtures), where the constructor differs.
  if (el.namespaceURI !== HTML_NS) return false;
  const style = (el as HTMLElement).style;
  if (!style) return false;

  el.setAttribute('data-adblow-hidden', '1');
  if (reason) el.setAttribute(REASON_ATTR, reason);
  style.setProperty('display', 'none', 'important');
  style.setProperty('visibility', 'hidden', 'important');
  style.setProperty('pointer-events', 'none', 'important');
  style.setProperty('height', '0', 'important');
  style.setProperty('margin', '0', 'important');
  style.setProperty('padding', '0', 'important');
  return true;
}

/** How often the site made a hidden element visible again (diagnostics). */
export const REFOUGHT_ATTR = 'data-adblow-refought';

export type HidingAudit = {
  /** Elements re-checked. */
  checked: number;
  /** Elements found visible again and re-hidden. */
  refought: number;
  /** Elements restored repeatedly (the site is fighting back), aggregated as selector digests. */
  stubborn: string[];
};

/**
 * Re-check that hiding still holds, and re-hide what the site restored.
 *
 * Required because `!important` is not invincible: a site script can overwrite it with an equally
 * `!important` inline style written later (measured on the 1024cg overlay, which left the whole
 * page unclickable). Without this pass `data-adblow-hidden` becomes a lie.
 */
export function verifyHiding(root: ParentNode): HidingAudit {
  const audit: HidingAudit = { checked: 0, refought: 0, stubborn: [] };
  const win = (root as Document).defaultView;
  if (!win) return audit;

  for (const el of Array.from(root.querySelectorAll(`[${HIDDEN_ATTR}]`))) {
    audit.checked += 1;
    let visible = false;
    try {
      const cs = win.getComputedStyle(el);
      visible = cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch {
      continue;
    }
    if (!visible) continue;

    // Display was restored → re-apply, keeping the original reason for later statistics.
    const reason = el.getAttribute(REASON_ATTR) ?? undefined;
    const prev = Number(el.getAttribute(REFOUGHT_ATTR) ?? '0') + 1;
    hideElement(el, reason);
    el.setAttribute(REFOUGHT_ATTR, String(prev));
    audit.refought += 1;
    if (prev >= 2) {
      const tag = el.tagName.toLowerCase();
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      audit.stubborn.push(`${tag}${cls ? '.' + cls : ''}×${prev}`);
    }
  }
  return audit;
}

export function isHidden(el: Element): boolean {
  return el.getAttribute('data-adblow-hidden') === '1';
}

/** The element or any ancestor is already hidden (so it is invisible). */
export function isInsideHidden(el: Element): boolean {
  return el.closest('[data-adblow-hidden]') !== null;
}

// ── Media recovery: a block hidden before its <video> existed ────────────────

/**
 * Hide reasons media recovery may undo: the decision came from **our own automatic judging of
 * this element**. Everything else stays hidden, deliberately:
 *   - `rule` (site pack) and any filter-list cosmetic hit are curated/per-domain rules — an
 *     explicit list decision, not a judgement this pass may second-guess;
 *   - `picked` is the user's explicit instruction;
 *   - `overlay` / `linkfarm` / `fake-close` / `click-layer` are their own shape passes;
 *   - `anti-adblock-wall` hides a wall prompt, never content.
 *
 * `learned` is included (2026-10-29): it is an auto-derived selector, not a curated rule, and it is
 * exactly where the lazy-load misfire comes back — visit one hides the empty shell by heuristic
 * and records a selector, visit two lets that selector hide the shell again **before** the video
 * arrives. Excluding it would turn one bad visit into a permanently blank player.
 *
 * Why this narrow: video ads live inside the player too, so only the automatic tiers that can
 * misjudge an empty shell qualify. Widening this further re-opens the exact hole it closes.
 */
export const MEDIA_RECOVERABLE_REASONS: ReadonlySet<string> = new Set(['heuristic', 'learned']);

/** Mark of an element media recovery re-showed: never hidden again on this page. */
export const KEEP_ATTR = 'data-adblow-keep';

/** Most elements a keep selector may match before it is dropped as too broad. */
export const KEEP_SELECTOR_MAX_MATCHES = 3;

/**
 * Page-scoped "do not hide again" set.
 *
 * The recovered node itself carries KEEP_ATTR, which covers it for as long as it stays in the
 * document — and that alone breaks the hide/recover loop with the upkeep sweeps. A site that
 * re-renders the player replaces the node and loses the attribute, so a **narrow selector digest**
 * is kept alongside it (see recoverMediaBlocks).
 */
export type KeepState = { selectors: Set<string> };

export function createKeepState(): KeepState {
  return { selectors: new Set<string>() };
}

/** Is this element off-limits for hiding on this page (see recoverMediaBlocks)? */
export function isKept(el: Element, keep?: KeepState): boolean {
  if (el.getAttribute(KEEP_ATTR) === '1') return true;
  if (!keep) return false;
  for (const selector of keep.selectors) {
    try {
      if (el.matches(selector)) return true;
    } catch {
      // A digest that stopped parsing must not disable the guard for every element.
      keep.selectors.delete(selector);
    }
  }
  return false;
}

/**
 * "The video is actually showing a picture": a decoded frame (`videoWidth > 0`) **and** playback
 * under way (`!paused`). Both are required: a paused or not-yet-decoded video proves nothing, and
 * the empty shell we mis-hid is exactly the not-yet-decoded case.
 */
export function isPlayingVideo(video: Element): boolean {
  try {
    const { videoWidth, paused } = video as HTMLVideoElement;
    return typeof videoWidth === 'number' && videoWidth > 0 && paused === false;
  } catch {
    return false;
  }
}

/**
 * Strong ad naming on the video itself or on a wrapper between it and the hidden block.
 *
 * A step tighter than "the block's own naming" on purpose: `<div class="video-ads"><video>` is an
 * ad-named player inside a generically named shell, and unmasking it would put a video ad back.
 */
function hasStrongAdNamingUpTo(video: Element, stop: Element): boolean {
  let node: Element | null = video;
  while (node !== null) {
    if (namingSignal(node).strength >= NAMING_STRONG) return true;
    if (node === stop) return false;
    node = node.parentElement;
  }
  return false;
}

/** The first playing video inside `el`, ignoring ad-named player wrappers. */
function playingVideoIn(el: Element): Element | null {
  let videos: Element[];
  try {
    videos = Array.from(el.querySelectorAll('video'));
  } catch {
    return null;
  }
  for (const video of videos) {
    if (!isPlayingVideo(video)) continue;
    if (hasStrongAdNamingUpTo(video, el)) continue;
    return video;
  }
  return null;
}

/**
 * Inline declarations hideElement writes, with the serializations the CSSOM may report for them.
 *
 * Length values are serialized with a unit (`0` → `0px`) and the shorthands expand, so both forms
 * are listed. Recovery removes a declaration only when the value and the `!important` priority
 * still match ours: anything the site wrote itself (a `display:block !important` counter-attack,
 * its own `display:none`) is left untouched.
 */
const HIDE_STYLES: readonly { prop: string; values: readonly string[] }[] = [
  { prop: 'display', values: ['none'] },
  { prop: 'visibility', values: ['hidden'] },
  { prop: 'pointer-events', values: ['none'] },
  { prop: 'height', values: ['0', '0px'] },
  { prop: 'margin', values: ['0', '0px'] },
  { prop: 'padding', values: ['0', '0px'] },
];

/**
 * Undo hideElement: drop our marker attributes and exactly our inline declarations, then mark the
 * element as never-hide-again. Does not touch the site's own styles. Returns whether it was hidden.
 */
export function unhideElement(el: Element): boolean {
  const style = (el as HTMLElement).style;
  if (style) {
    for (const { prop, values } of HIDE_STYLES) {
      try {
        if (
          values.includes(style.getPropertyValue(prop)) &&
          style.getPropertyPriority(prop) === 'important'
        ) {
          style.removeProperty(prop);
        }
      } catch {
        // A hostile element must not stop the recovery of the rest.
      }
    }
  }
  const wasHidden = el.getAttribute(HIDDEN_ATTR) === '1';
  el.removeAttribute(HIDDEN_ATTR);
  el.removeAttribute(REASON_ATTR);
  el.removeAttribute(WHY_ATTR);
  el.removeAttribute(REFOUGHT_ATTR);
  el.setAttribute(KEEP_ATTR, '1');
  return wasHidden;
}

export type MediaRecovery = {
  /** Hidden elements examined. */
  checked: number;
  /** Elements re-shown by this call (never re-counted: see the isKept guard). */
  restored: number;
  /** Selector digests added to the page-level keep set. */
  selectors: string[];
};

/**
 * Media recovery: undo a hide that a **playing video** later proved wrong.
 *
 * Why (real site, YouTube Shorts, 2026-10-29): the content area holds almost no text, so the
 * content guards (hasSubstantiveText / looksLikeContentBlock) do not apply. At judging time the
 * lazy-loaded `<video>` did not exist yet, so the empty block was scored as an ad slot and hidden;
 * the video was then inserted into the **already hidden** container. `display:none` does not stop
 * playback, so the symptom was "sound plays, no picture".
 *
 * The existing verifyHiding pass only re-hides what the site re-showed — there is no reverse
 * direction. This is it, and the conditions are deliberately tight:
 *   1. a playing video (frame decoded **and** not paused), see isPlayingVideo;
 *   2. no strong ad naming on the block, nor on any wrapper between the video and the block;
 *   3. the hide reason is one of our automatic judging tiers (MEDIA_RECOVERABLE_REASONS), never
 *      a curated rule, a list hit, or a manual pick;
 *   4. the element is not already in the keep set (idempotent: one recovery, one count).
 *
 * Each recovery removes our attributes and inline hides and puts the element into the page's
 * keep set, so the next sweep cannot hide it again — otherwise the hide/recover passes would
 * fight each other every upkeep round.
 */
export function recoverMediaBlocks(root: ParentNode, keep?: KeepState): MediaRecovery {
  const result: MediaRecovery = { checked: 0, restored: 0, selectors: [] };

  let hidden: Element[];
  try {
    hidden = Array.from(root.querySelectorAll(`[${HIDDEN_ATTR}]`));
  } catch {
    return result;
  }

  for (const el of hidden) {
    result.checked += 1;
    // Idempotence, and a guard against a keep-set member being touched twice.
    if (isKept(el, keep)) continue;

    const reason = el.getAttribute(REASON_ATTR);
    if (!reason || !MEDIA_RECOVERABLE_REASONS.has(reason)) continue;

    // Naming is deterministic evidence and outranks media: `.video-ads`-style blocks stay hidden.
    if (namingSignal(el).strength >= NAMING_STRONG) continue;

    if (playingVideoIn(el) === null) continue;

    if (!unhideElement(el)) continue;
    result.restored += 1;

    // Same node → KEEP_ATTR. Re-rendered node → selector digest, but only when the digest is
    // narrow: a broad class would make whole regions unhideable for the rest of the page's life.
    const selector = generalizeSelector(el);
    if (selector && isSelectorSafe(selector, root, KEEP_SELECTOR_MAX_MATCHES)) {
      keep?.selectors.add(selector);
      result.selectors.push(selector);
    }
  }

  return result;
}

export const HIDDEN_ATTR = 'data-adblow-hidden';

/** Attribute holding the hide reason (used to triage false positives). */
export const REASON_ATTR = 'data-adblow-reason';

/**
 * Attribute holding the judging evidence (finer-grained than REASON_ATTR).
 *
 * `data-adblow-reason` only says "heuristic / rule pack / link farm", while triage needs **which
 * evidence** fired: `cross-site-iframe`, `cross-site-media`, `geometry-growth`.
 */
export const WHY_ATTR = 'data-adblow-why';

/**
 * Overlay detection: **its own traversal, never part of per-element scoring.**
 *
 * Why separate (measured 2026-10-10): overlay checks inside `scoreNode` meant a `getComputedStyle`
 * per element while the same scan kept rewriting inline styles; the alternation invalidated
 * style/layout repeatedly and a full scan of a large page like 1024cg never finished — symptom
 * "the stylesheet is injected but not one element is hidden". Now a cheap attribute pre-filter
 * (see OVERLAY_PRESELECTOR) gates `getComputedStyle` plus geometry for a few candidates.
 *
 * Criteria: fixed/absolute + high z-index + a large viewport share — **not sufficient alone**
 * (cookie banners and login modals look the same), so results are candidates needing
 * corroboration rather than ads.
 */
export const OVERLAY_AREA_RATIO = 0.4;
export const OVERLAY_MIN_Z = 1000;

/** Cheap pre-filter: only elements carrying inline positioning styles. */
export const OVERLAY_PRESELECTOR = '[style*="position"]';

export type OverlayContext = {
  viewportArea: number;
  styleOf?: (el: Element) => { position: string; zIndex: string } | null;
  rectOf?: (el: Element) => { width: number; height: number } | null;
};

const defaultStyleOf = (el: Element): { position: string; zIndex: string } | null => {
  const g = globalThis as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration };
  if (typeof g.getComputedStyle !== 'function') return null;
  try {
    const s = g.getComputedStyle(el);
    return { position: s.position, zIndex: s.zIndex };
  } catch {
    return null;
  }
};

const defaultRectOf = (el: Element): { width: number; height: number } | null => {
  try {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  } catch {
    return null;
  }
};

export function isOverlay(el: Element, ctx: OverlayContext): boolean {
  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  if (!style) return false;
  if (style.position !== 'fixed' && style.position !== 'absolute') return false;

  const z = Number.parseInt(style.zIndex, 10);
  if (!Number.isFinite(z) || z < OVERLAY_MIN_Z) return false;

  const rect = (ctx.rectOf ?? defaultRectOf)(el);
  if (!rect || ctx.viewportArea <= 0) return false;

  const areaRatio = (rect.width * rect.height) / ctx.viewportArea;
  if (areaRatio >= OVERLAY_AREA_RATIO) return true;

  // ② Overlays inside a player (added from acceptance measurements, 2026-10-10).
  //
  // A video overlay only covers the player, often under 40% of the viewport, so the viewport
  // ratio misses it. Requiring "covers an ancestor almost completely + that ancestor holds
  // `<video>`" matches player overlays only, and never normal layouts such as carousels or card
  // images that absolutely cover their parent.
  return coversVideoAncestor(el, rect, ctx);
}

/** Does the element almost completely cover an ancestor holding `<video>` (player overlay)? */
function coversVideoAncestor(
  el: Element,
  rect: { width: number; height: number },
  ctx: OverlayContext,
): boolean {
  const rectOf = ctx.rectOf ?? defaultRectOf;
  const ownArea = rect.width * rect.height;
  if (ownArea <= 0) return false;

  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const hasVideo = parent.querySelector('video') !== null;
    if (hasVideo) {
      const pr = rectOf(parent);
      if (pr) {
        const parentArea = pr.width * pr.height;
        const parentRatio = parentArea / Math.max(ctx.viewportArea, 1);
        const coverage = ownArea / Math.max(parentArea, 1);
        if (coverage >= OVERLAY_CONTAINER_COVERAGE && parentRatio >= OVERLAY_CONTAINER_MIN_RATIO) {
          return true;
        }
      }
      return false;
    }
    parent = parent.parentElement;
  }
  return false;
}

/** Player overlay: minimum share of its container it must cover. */
export const OVERLAY_CONTAINER_COVERAGE = 0.8;
/** The container must cover this share of the viewport, so corner widgets never trigger it. */
export const OVERLAY_CONTAINER_MIN_RATIO = 0.08;

/** Overlay candidates: fixed/absolute boxes covering a large part of the viewport. */
export function findOverlays(root: ParentNode, ctx: OverlayContext): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(OVERLAY_PRESELECTOR))) {
    if (isInsideHidden(el)) continue;
    if (isOverlay(el, ctx)) out.push(el);
  }
  return out;
}

/** Extra score when the overlay shape itself serves as corroboration. */
export const OVERLAY_BONUS = 4;
/** Corroboration an overlay requires (weak naming or a cross-site link already qualifies). */
export const OVERLAY_CORROBORATION = 4;

export type OverlayAd = { element: Element; hit: Hit };

/**
 * Find and judge overlay ads.
 *
 * Corroboration is required: cookie banners, login modals and interstitials share the "fixed +
 * high z-index + large viewport" shape, and breaking a cookie banner can leave a site unusable.
 * So one more signal is needed — weak naming or better, or behaviour such as cross-site
 * links/media/iframes (which usually means an ad rather than the site's own UI).
 */
export function findOverlayAds(
  root: ParentNode,
  opts: { host: string; viewportArea: number; overlay?: OverlayContext },
): OverlayAd[] {
  const overlayCtx: OverlayContext = opts.overlay ?? { viewportArea: opts.viewportArea };
  const out: OverlayAd[] = [];

  for (const el of findOverlays(root, overlayCtx)) {
    const naming = namingSignal(el).strength;
    const { score, behavior, reasons } = scoreNode(el, {
      pageHost: opts.host,
      viewportArea: opts.viewportArea,
    });

    if (naming < NAMING_WEAK && behavior < OVERLAY_CORROBORATION) continue;

    out.push({
      element: el,
      hit: {
        selector: generalizeSelector(el),
        score: score + OVERLAY_BONUS,
        reasons: [...reasons, 'overlay'],
      },
    });
  }

  return out;
}

// ── Link farms (ad/SEO spam built from many off-site links) ──────────────────

/**
 * This many **distinct** cross-site domains inside one container make it a link farm.
 *
 * Evidence (2026-10-10): a footer held **39 distinct cross-site domains** (`a.referrerLink`, all
 * `target=_blank`) injected by the site's own `/js/partners.js` into `[data-javeve-partners]`.
 *
 * A single cross-site link is worth 4, below the deliberate pure-behaviour threshold of 6, and the
 * container has too many descendants (>12) for descendant signals — yet normal content never
 * organises itself as "5+ distinct off-site domains in one block".
 */
export const LINK_FARM_MIN_DOMAINS = 5;

/**
 * Minimum number of "own-domain redirect whose payload declares an ad" links.
 *
 * Measured (2026-10-13): the site routes ad links through its own domain
 * (`/traffic/go?t=<base64 {"kind":"ad",...}>`), invisible to the cross-site criteria, while the
 * container is too descendant-heavy (>12) for descendant signals — so a whole ad carousel
 * (`ul.streamer-box2`, 10 slots) stayed visible.
 *
 * The payload's `"kind":"ad"` is deterministic evidence, on par with 5 distinct off-site domains.
 */
export const AD_REDIRECT_BLOCK_MIN = 3;

/** Tags that can host a link farm. Excludes body/html/main/article (those hold content). */
const FARM_TAGS = 'div,ul,ol,section,aside,nav,footer,dl,table';

/**
 * Find **aggregating ad/spam blocks**:
 *   - link farms: ≥5 distinct off-site domains
 *   - own-redirect ad blocks: ≥3 redirects whose payload declares an ad, see AD_REDIRECT_BLOCK_MIN
 *
 * Only the **deepest** candidates are returned: parents usually qualify too (a whole footer can),
 * but hiding the deepest layer clears the farm without also wiping normal content in the same
 * container (footer navigation, copyright notices).
 */
export function findLinkFarms(
  root: ParentNode,
  opts: { host: string; minDomains?: number },
): Element[] {
  const min = opts.minDomains ?? LINK_FARM_MIN_DOMAINS;
  const base = `https://${opts.host}`;
  const pageReg = registrableDomain(opts.host);

  const candidates: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(FARM_TAGS))) {
    if (isInsideHidden(el)) continue;
    // Already holds a hidden farm → this is the outer container of the same farm. Measured
    // (dgav40): one footer farm was hidden layer by layer 4 times, because every parent "holds the
    // same links" and qualified again. Handled evidence must not be counted twice.
    if (el.querySelector(`[${HIDDEN_ATTR}][${REASON_ATTR}="linkfarm"]`) !== null) continue;

    const domains = new Set<string>();
    let adRedirects = 0;
    for (const a of Array.from(el.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
      try {
        const parsed = new URL(href, base);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const reg = registrableDomain(parsed.hostname);
        if (!reg || reg === pageReg) {
          // Same site: may be an ad wrapped in an own-domain redirect (payload says kind=ad).
          if (unwrapAdRedirect(href, base).declaredAd) adRedirects += 1;
          continue;
        }
        // Same-brand mirror/backup domains do not count as "another domain": the body of
        // dgav36's "latest mirror URLs" index page is dozens of them, and counting those as
        // cross-site turned the entire article into a link farm (reported misfire).
        if (isSameBrand(parsed.hostname, opts.host)) continue;
        domains.add(reg);
      } catch {
        /* Ignore invalid URLs */
      }
    }
    // Criterion 1: ≥5 distinct off-site domains (link farm).
    const farmByDomains = domains.size >= min;
    // Criterion 2: ≥3 "own redirect whose payload declares an ad" links.
    // Ad naming is required too (measured misfire, 2026-10-13): on link count alone a generic
    // wrapper (`div.text-center`) holding a few ad redirects hid a whole content block (39 cards).
    // With naming, only real ad containers (`ul.streamer-box2`, `#topBanner`) take this path.
    const blockByRedirects =
      adRedirects >= AD_REDIRECT_BLOCK_MIN && namingSignal(el).strength >= NAMING_WEAK;
    if (!farmByDomains && !blockByRedirects) continue;
    if (holdsRealContent(el)) continue;
    // Navigation (itself or inside) is not a link farm — users reported hidden navigation lists.
    // Ads disguised as navigation still get caught: when they carry strong ad naming of their own
    // (`nav.ad-links`), that naming is explicit evidence and wins. This exception applies to the
    // semantic `<nav>` tag only: an ARIA landmark (`role="navigation"` etc.) is in CONTENT_MARKERS
    // and was already rejected by holdsRealContent above, by design (2026-10-29).
    if (isNavigationLike(el) || isInsideNavigation(el)) {
      if (namingSignal(el).strength < NAMING_STRONG) continue;
    }
    // A link farm is a wall of links with no text. Substantive text means content: nav lists,
    // partner-link notes and index pages all legitimately carry many outbound links.
    if (hasSubstantiveText(el)) continue;
    // "Related/reference links" inside an article are authored content, not ad spam.
    if (isInsideRealContent(el)) continue;
    candidates.push(el);
  }

  return candidates.filter(
    (el) => !candidates.some((other) => other !== el && el.contains(other)),
  );
}

/**
 * Only tags that **load resources**; `<a href>` is a click target, not a "use" of the domain.
 */
export const RESOURCE_TAGS = 'img,script,link,iframe,video,source,embed,object';

// ── Geometry-growth re-judging (grow-on-hover / auto-enlarge) ────────────────

/** Extra score when geometry growth serves as corroboration. */
export const GROWTH_BONUS = 4;

/**
 * Judge an element whose area just jumped.
 *
 * Unlike the three tiers it does **not** require proof of script injection: growth is evidence in
 * itself. A previously unremarkable box that suddenly fills 15%+ of the viewport while carrying
 * weak naming or cross-site links/assets is an expanding ad.
 *
 * The hit deliberately carries **no selector**: geometry is **transient evidence**, and a normal
 * component that grew once must not become a permanent rule.
 */
export function judgeGrownElement(el: Element, options: JudgeOptions): Verdict | null {
  if (isPickerUi(el)) return null;
  if (isHidden(el)) return null;
  // A recovered player grows when its video arrives; growth is not evidence against it.
  if (isKept(el, options.keep)) return null;
  if (holdsRealContent(el)) return null;

  const naming = namingSignal(el).strength;
  const { score, behavior, reasons } = scoreNode(el, {
    pageHost: options.host,
    viewportArea: options.viewportArea,
  });

  if (naming < NAMING_WEAK && behavior < OVERLAY_CORROBORATION) return null;

  return {
    kind: 'heuristic',
    hit: {
      selector: null,
      score: score + GROWTH_BONUS,
      reasons: [...reasons, 'geometry-growth'],
    },
  };
}

// ── Fake close buttons (a "close" control that is a cross-site link) ─────────

/**
 * Clues that something "looks like a close control": a cheap attribute-selector pre-filter, then
 * looksLikeCloseControl decides.
 */
export const CLOSE_HINT_SELECTOR = [
  '[class*="close"]',
  '[class*="Close"]',
  '[id*="close"]',
  '[id*="Close"]',
  '[class*="dismiss"]',
  '[class*="Dismiss"]',
  '[aria-label*="close"]',
  '[aria-label*="Close"]',
  '[aria-label*="关闭"]',
  '[title*="close"]',
  '[title*="Close"]',
  '[title*="关闭"]',
].join(',');

/** Common close symbols and words. */
const CLOSE_TEXTS = new Set(['×', '✕', '✖', '╳', 'x', 'X', '关', '关闭', 'close', 'Close', 'CLOSE']);

/** Does the element look like it is meant to close something? */
export function looksLikeCloseControl(el: Element): boolean {
  const hay = [
    el.getAttribute('class') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
    el.getAttribute('role') ?? '',
  ]
    .join(' ')
    .toLowerCase();

  if (/close|dismiss|关闭/.test(hay)) return true;

  const text = (el.textContent ?? '').trim();
  return CLOSE_TEXTS.has(text);
}

/** Cross-site link test, by registrable domain. */
function isCrossSiteLink(href: string, pageHost: string): boolean {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
  try {
    const parsed = new URL(href, `https://${pageHost}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return registrableDomain(parsed.hostname) !== registrableDomain(pageHost);
  } catch {
    return false;
  }
}

/** Fake close button: how many ancestor levels to walk looking for the ad container. */
export const FAKE_CLOSE_MAX_DEPTH = 6;

/**
 * Find fake close buttons and return the ad container that should be hidden.
 *
 * The trick: the "×" on an ad pop-up is a cross-site link, so it navigates instead of closing.
 * Regular criteria miss it (under the 40% overlay area threshold, usually no ad naming) — yet no
 * legitimate close button sends the user to another domain. Blocking the click would leave the ad
 * in place, so hide the outer container.
 */
export function findFakeCloseAds(
  root: ParentNode,
  opts: { host: string; maxDepth?: number },
): OverlayAd[] {
  const maxDepth = opts.maxDepth ?? FAKE_CLOSE_MAX_DEPTH;
  const out: OverlayAd[] = [];
  const seen = new Set<Element>();

  for (const el of Array.from(root.querySelectorAll(CLOSE_HINT_SELECTOR))) {
    if (isInsideHidden(el)) continue;
    if (!looksLikeCloseControl(el)) continue;

    const anchor = el.closest('a[href]');
    if (!anchor) continue;
    if (!isCrossSiteLink(anchor.getAttribute('href') ?? '', opts.host)) continue;

    // Walk up from the link looking for a container that looks like an ad pop-up.
    //
    // Prefer the positioned ancestor (real bug caught by a unit test, 2026-10-10): the outermost
    // matching ancestor could be any generic wrapper div holding an image, landing
    // far away from the pop-up and hiding far too much. Ad pop-ups are always fixed/absolute.
    let positioned: Element | null = null;
    let mediaFallback: Element | null = null;
    let node: Element | null = anchor.parentElement;
    for (let i = 0; i < maxDepth && node; i++) {
      if (node === document.body || node === document.documentElement) break;
      // Stop at any ancestor holding content: better to miss an ad than to break content.
      if (holdsRealContent(node)) break;

      let isPositioned = false;
      try {
        const pos = getComputedStyle(node).position;
        isPositioned = pos === 'fixed' || pos === 'absolute';
      } catch {
        isPositioned = false;
      }

      if (isPositioned) {
        // Keep overwriting: the outermost element of the positioned chain is the whole pop-up.
        positioned = node;
      } else if (positioned === null && mediaFallback === null) {
        // Only when no positioned ancestor exists: fall back to a nearby container with media.
        if (node.querySelector('img,video,iframe,canvas') !== null) mediaFallback = node;
      }

      node = node.parentElement;
    }

    const container = positioned ?? mediaFallback;
    if (!container || seen.has(container)) continue;
    seen.add(container);

    out.push({
      element: container,
      hit: {
        selector: generalizeSelector(container),
        score: 0,
        reasons: ['fake-close-cross-site'],
      },
    });
  }

  return out;
}

/**
 * Places where a site declares its own infrastructure (canonical / og / icons).
 *
 * Why: the pilot's canonical points at `cgw666.com`, a **mirror domain** that also hosts article
 * images, and a hidden recommendation image referenced it. Learning it as an ad domain would kill
 * every article image at once — the same class of error as §2 risk A, entered through another door.
 */
const SITE_OWNED_SELECTOR = [
  'link[rel~="canonical"]',
  'link[rel~="icon"]',
  'link[rel~="apple-touch-icon"]',
  'link[rel~="alternate"]',
  'meta[property="og:url"]',
  'meta[property="og:image"]',
  'meta[name="twitter:image"]',
].join(',');

/** Domains the site declares as its own, extracted from head metadata. */
export function siteOwnedDomains(root: ParentNode, pageHost: string): Set<string> {
  const out = new Set<string>();
  const consider = (raw: string): void => {
    if (!raw) return;
    let parsed: URL;
    try {
      parsed = new URL(raw, `https://${pageHost}`);
    } catch {
      return;
    }
    const reg = registrableDomain(parsed.hostname);
    if (reg) out.add(reg);
  };

  for (const node of Array.from(root.querySelectorAll(SITE_OWNED_SELECTOR))) {
    consider(node.getAttribute('href') ?? '');
    consider(node.getAttribute('content') ?? '');
  }
  return out;
}

/**
 * Derive the cross-site domains that are **safe to learn** from already-hidden ads.
 *
 * The decision core of network-layer learning, hence in the pure layer rather than the wiring.
 *
 * Three hard filters, each with a regression test:
 *   1. never learn a domain that served an image/video anywhere on this page, visible or not.
 *      From a real incident: 1024cg's content thumbnails and ad creatives shared `pic.jtzatly.cn`,
 *      and because content images lazy-load, "is it used by visible content" was fooled by timing;
 *      learning it blanked every image on the site. Now a structural, timing-free test.
 *   2. never learn a domain visible content also uses (risk A: the pilot's `pic.wvxrrip.cn`)
 *   3. never learn a domain the site declares as its own (canonical/og/icons — the mirror
 *      `cgw666.com`, which hosts article images)
 */
export function learnableAdDomains(root: ParentNode, pageHost: string): string[] {
  const hidden = root.querySelectorAll(`[${HIDDEN_ATTR}]`);
  if (hidden.length === 0) return [];

  const adDomains = new Set<string>();
  for (const el of hidden) {
    // Include links while learning: blocking the ad landing page's subresources stops pop-ups,
    // and subresource blocking leaves <a href> navigation alone (main_frame is excluded already).
    for (const d of crossSiteResourceDomains(el, pageHost, { includeLinks: true })) {
      adDomains.add(d);
    }
  }
  if (adDomains.size === 0) return [];

  // Filter ① (structural, timing-independent): never learn page-wide media domains.
  const media = pageWideMediaDomains(root, pageHost);

  // Filter ②: domains visible content uses. Links do not count here — a visible content link to
  // a domain does not make that domain a normal resource source for the site.
  const usedByVisible = new Set<string>();
  for (const el of root.querySelectorAll(RESOURCE_TAGS)) {
    if (isInsideHidden(el)) continue;
    for (const d of crossSiteResourceDomains(el, pageHost)) usedByVisible.add(d);
  }

  // Filter ③: domains the site declares as its own.
  const owned = siteOwnedDomains(root, pageHost);

  return [...adDomains].filter((d) => !media.has(d) && !usedByVisible.has(d) && !owned.has(d));
}

/** Build the anti-flash stylesheet body. */
export function cosmeticCss(selectors: string[]): string {
  return selectors
    .map(
      (s) =>
        `${s}{display:none !important;height:0 !important;margin:0 !important;padding:0 !important;}`,
    )
    .join('\n');
}

/**
 * Does the element match any static rule selector?
 *
 * Joining the selectors and doing one matches() beats matching one by one; if the joined string
 * is invalid, fall back to one by one so a single broken selector cannot disable a whole pack.
 */
export function matchesAny(el: Element, selectors: string[]): boolean {
  if (selectors.length === 0) return false;
  try {
    return el.matches(selectors.join(','));
  } catch {
    return selectors.some((s) => {
      try {
        return el.matches(s);
      } catch {
        return false;
      }
    });
  }
}

export type Verdict = { kind: 'rule' } | { kind: 'picked' } | { kind: 'heuristic'; hit: Hit };

export type JudgeOptions = {
  injected: InjectionTest;
  host: string;
  viewportArea: number;
  selectors: SelectorSet;
  threshold?: number;
  /** Page-level budget fallback (see createHidingBudget). Omit for no fallback (tests). */
  budget?: HidingBudget;
  /** The site's own content CDN (see frequentMediaDomains). Omit to skip that exclusion. */
  contentCdnDomains?: Set<string>;
  /** Page-level "do not hide again" set filled by media recovery (see recoverMediaBlocks). */
  keep?: KeepState;
};

/**
 * Judge one element: rule selectors first, then heuristics.
 *
 * `curated` and `learned` must not be treated alike:
 *   - `curated` (site packs): evidence + fixture regressions, hidden on match
 *   - `learned` (auto-derived): only exempt from "must be proven script-injected", still needs
 *     naming or behaviour evidence of its own (see SelectorSet)
 *   - `picked` (manual): an explicit user instruction, hidden on match like `curated`, and
 *     unlike automatic sources it overrides the content guard
 *
 * "Never hide an element holding content" is the invariant for every **automatic** source,
 * curated included. A manual pick is the single exception: it is the user's explicit choice
 * and can be revoked in the rule manager (see judgeElement).
 */
export function judgeElement(el: Element, options: JudgeOptions): Verdict | null {
  if (isPickerUi(el)) return null;
  if (isHidden(el)) return null;
  // Recovered by media recovery (a video was playing inside): never hide it again on this page,
  // or the upkeep sweeps would fight the recovery pass forever. Checked before every tier,
  // learned selectors included — a learned selector recorded before the video loaded is exactly
  // the path that would re-hide the player.
  if (isKept(el, options.keep)) return null;

  const { threshold = SCORE_THRESHOLD } = options;

  // A manual pick is an explicit instruction about this exact node. It therefore hides on
  // match *before* the content guard: the user saw the element and chose it, and the rule is
  // revocable in the manager. Automatic sources (curated/learned/heuristics) stay bound by
  // "never hide content"; for them this exception must not exist.
  if (
    options.selectors.picked !== undefined &&
    options.selectors.picked.length > 0 &&
    matchesAny(el, options.selectors.picked)
  ) {
    return { kind: 'picked' };
  }

  if (holdsRealContent(el)) return null;

  if (options.selectors.curated.length > 0 && matchesAny(el, options.selectors.curated)) {
    return { kind: 'rule' };
  }

  if (options.selectors.learned.length > 0 && matchesAny(el, options.selectors.learned)) {
    // Learned rules only accelerate; they grant no privilege: naming or behaviour still needed.
    const naming = namingSignal(el).strength;
    const { behavior, score, reasons } = scoreNode(el, {
      pageHost: options.host,
      viewportArea: options.viewportArea,
    });
    if (naming >= NAMING_WEAK || behavior >= threshold) {
      return {
        kind: 'heuristic',
        hit: { selector: null, score, reasons: [...reasons, 'learned-selector'] },
      };
    }
  }

  const hit = createJudge(
    options.injected,
    options.host,
    options.viewportArea,
    threshold,
    options.contentCdnDomains,
  )(el);
  return hit ? { kind: 'heuristic', hit } : null;
}

/** Judge and apply hiding; the reason goes to `data-adblow-reason` for later triage. */
export function applyVerdict(
  el: Element,
  verdict: Verdict | null,
  budget?: HidingBudget,
): Verdict | null {
  if (!verdict) return null;
  // Picker UI is never a hiding target, even if a broad selector happens to match it.
  if (isPickerUi(el)) return null;
  // Page-level budget fallback: never blank the whole page (see createHidingBudget).
  // A manual pick is exempt: it is one explicit node the user asked to hide, not a
  // per-element judgement that could run away. The hide is still counted, so the budget
  // stays conservative for automatic rules that follow.
  if (verdict.kind !== 'picked' && budget && !budget.canHide(el)) return null;
  const reason =
    verdict.kind === 'rule'
      ? 'rule'
      : verdict.kind === 'picked'
        ? 'picked'
        : (verdict.hit?.reasons ?? []).includes('learned-selector')
          ? 'learned'
          : 'heuristic';
  // Record **which evidence** fired: the most valuable information when triaging a misfire.
  // Only after the hide actually happened, so a never-rendered element is not tagged.
  if (!hideElement(el, reason)) return null;
  if (verdict.kind === 'heuristic' && verdict.hit.reasons.length) {
    el.setAttribute(WHY_ATTR, verdict.hit.reasons.join(','));
  }
  budget?.commit(el);
  return verdict;
}

/** Share of a page's text / links that may be hidden: blocking less beats blanking a page. */
export const PAGE_TEXT_BUDGET_SHARE = 0.7;
export const PAGE_LINK_BUDGET_SHARE = 0.7;
/**
 * The budget stays **off** while a page holds too little content.
 *
 * Forced by acceptance measurements: a fixture page with one ad probe has that probe as 100%
 * of its links, so the 70% threshold rejected it and ads went unblocked (21/21 → 12/21).
 * The fallback exists so that pages holding content are never blanked, not trivial ones.
 */
export const BUDGET_MIN_TOTAL_LINKS = 10;
export const BUDGET_MIN_TOTAL_TEXT = 400;

export type HidingBudget = {
  /** May this element still be hidden (false when it would break the page budget)? */
  canHide(el: Element): boolean;
  /** Account for a hidden element; call only after actually hiding it. */
  commit(el: Element): void;
  /** Re-measure the baseline as the page keeps loading (the denominator only grows). */
  refresh(doc: Document): void;
  stats(): {
    text: number;
    links: number;
    totalText: number;
    totalLinks: number;
    suppressed: number;
    enabled: boolean;
  };
};

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Measure a page's "content volume", **excluding code text inside `<script>` / `<style>`** — else
 * JS-heavy pages report hundreds of thousands of characters (measured: dgav36 reported 110034) and
 * the budget never triggers.
 */
function measureContent(root: Element): { text: number; links: number } {
  let clone: Element;
  try {
    clone = root.cloneNode(true) as Element;
  } catch {
    return { text: 0, links: 0 };
  }
  for (const el of Array.from(clone.querySelectorAll('script,style,noscript,template'))) {
    el.remove();
  }
  return {
    text: collapse(clone.textContent ?? '').length,
    links: clone.querySelectorAll('a[href]').length,
  };
}

/**
 * Page-level budget fallback: **the last line of defence beyond per-element judging**.
 *
 * Why it exists (reported misfire): dgav36.xyz's "latest mirror URLs" index page is entirely dozens
 * of mirror cards; each card had evidence (cross-site links), so per-element judging hid all 96
 * blocks and the user saw "content killed". Per-element judging never asks "am I blanking the whole
 * page?".
 *
 * Three design points, all learned the hard way:
 *   1. pages with too little content keep the budget off (a fixture page with one probe would
 *      otherwise lose its only link: acceptance 21/21 → 12/21)
 *   2. text volume must exclude `<script>`, or inline JS inflates the denominator
 *   3. measure the baseline **before** touching anything and only grow the denominator —
 *      re-measuring while hiding would drop hidden parts from it. `refresh` adds new content.
 */
export function createHidingBudget(
  doc: Document,
  opts: {
    textShare?: number;
    linkShare?: number;
    minLinks?: number;
    minText?: number;
  } = {},
): HidingBudget {
  const textShare = opts.textShare ?? PAGE_TEXT_BUDGET_SHARE;
  const linkShare = opts.linkShare ?? PAGE_LINK_BUDGET_SHARE;
  const minLinks = opts.minLinks ?? BUDGET_MIN_TOTAL_LINKS;
  const minText = opts.minText ?? BUDGET_MIN_TOTAL_TEXT;

  let text = 0;
  let links = 0;
  let totalText = 0;
  let totalLinks = 0;
  let suppressed = 0;

  const enabled = (): boolean => totalLinks >= minLinks || totalText >= minText;

  const initial = doc.body ?? doc.documentElement;
  if (initial) {
    const m = measureContent(initial);
    totalText = m.text;
    totalLinks = m.links;
  }

  return {
    canHide(el: Element): boolean {
      // Too little content → fallback off (blocking less matters more than misfiring less here).
      if (!enabled()) return true;
      const t = collapse(el.textContent ?? '').length;
      const l = el.querySelectorAll('a[href]').length;
      if (text + t > totalText * textShare || links + l > totalLinks * linkShare) {
        suppressed += 1;
        return false;
      }
      return true;
    },
    commit(el: Element): void {
      text += collapse(el.textContent ?? '').length;
      links += el.querySelectorAll('a[href]').length;
    },
    refresh(current: Document): void {
      const root = current.body ?? current.documentElement;
      if (!root) return;
      const m = measureContent(root);
      // Visible now + hidden by us = the total ever observed; the denominator only grows.
      totalText = Math.max(totalText, m.text + text);
      totalLinks = Math.max(totalLinks, m.links + links);
    },
    stats: () => ({ text, links, totalText, totalLinks, suppressed, enabled: enabled() }),
  };
}

export type SweepResult = {
  hiddenByRule: number;
  hiddenByHeuristic: number;
  hits: Hit[];
};

/** Sweep an entire subtree (root itself excluded). */
export function sweep(root: ParentNode, options: JudgeOptions): SweepResult {
  const result: SweepResult = { hiddenByRule: 0, hiddenByHeuristic: 0, hits: [] };

  for (const el of Array.from(root.querySelectorAll('*'))) {
    // A subtree already hidden by an ancestor needs no judging: saves time, avoids double counts.
    if (isHidden(el)) continue;
    const verdict = applyVerdict(el, judgeElement(el, options), options.budget);
    if (!verdict) continue;
    if (verdict.kind === 'rule' || verdict.kind === 'picked') result.hiddenByRule += 1;
    else {
      result.hiddenByHeuristic += 1;
      result.hits.push(verdict.hit);
    }
  }

  return result;
}

export type AddedResult = { rule: number; hits: Hit[] };

/** Handle one added node: judge it, then sweep its subtree. Returns counts and learnable hits. */
export function processAdded(el: Element, options: JudgeOptions): AddedResult {
  const self = applyVerdict(el, judgeElement(el, options), options.budget);
  if (self) {
    // Itself hidden → the whole subtree is already invisible, so judge nothing further.
    // Judging on would be wasted work and would flood the learned store with the generic
    // selectors of every node inside the ad.
    return self.kind === 'heuristic'
      ? { rule: 0, hits: [self.hit] }
      : { rule: 1, hits: [] };
  }
  const swept = sweep(el, options);
  return { rule: swept.hiddenByRule, hits: swept.hits };
}
