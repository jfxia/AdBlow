/**
 * Anti-adblock wall detection: **copy signatures plus a shape requirement**.
 *
 * The site measures decoy ad slots, and once one measures 0 it covers the page with its own
 * copy ("Disable your adblocker", "add your adblocker's allowlist") and often hard-hides the
 * article. Detection is pure: no chrome.*, no global document, styles/geometry injected — so it
 * is regression-testable under Node + jsdom.
 *
 * Layering: this module imports **nothing** from src/content/**. The one content-layer heuristic
 * it needs (is this element article markup?) is injected through WallContext, and the "hidden by
 * us" marker is a local constant that must stay in step with `HIDDEN_ATTR` in
 * src/content/engine.ts.
 *
 * False positives are the expensive mistake here: an article *about* ad blockers carries the
 * same vocabulary as a wall, and hiding a normal page is far worse than missing one wall. Three
 * independent guards, in decreasing strength:
 *
 *   1. **Two evidence grades.** `strong` phrases are directives/notices about blocking software
 *      ("disable your ad blocker", "interfering with the intended operation", "检测到广告拦截");
 *      they do not occur in neutral prose. `weak` phrases are the bare concept ("ad blocker",
 *      "广告拦截"), which an ordinary article uses freely, so weak evidence saturates at one point
 *      (WALL_WEAK_MAX_COUNT) instead of accumulating.
 *   2. **A shape or a much higher copy threshold.** One strong phrase is only accepted when the
 *      element is overlay-shaped (fixed/absolute and covering a large share of the viewport);
 *      otherwise the copy must reach WALL_TEXT_ONLY_MIN_SCORE (2 strong + 1 weak).
 *   3. **Article markup is an absolute exclusion.** An element that is, or contains, schema.org
 *      article markup is never a prompt, whatever its shape and copy: the content layer's content
 *      guard outranks every heuristic here.
 *   4. **Size bounds.** A wall prompt is a short text block: WALL_SHAPED_MAX_CHARS /
 *      WALL_TEXT_ONLY_MAX_CHARS rule out whole-page wrappers and article bodies.
 */

/**
 * Elements we hid ourselves carry this attribute (see HIDDEN_ATTR in src/content/engine.ts).
 *
 * Duplicated as a literal on purpose: the engine layer must not depend on the content layer. The
 * two spellings are kept identical by hand; the integration tests cover the behaviour end to end.
 */
const HIDDEN_ATTR_LITERAL = 'data-adblow-hidden';

/** Element or ancestor hidden by us (ad blocking). Local mirror of content/engine's helper. */
function hiddenByUs(el: Element): boolean {
  try {
    return el.closest(`[${HIDDEN_ATTR_LITERAL}]`) !== null;
  } catch {
    return false;
  }
}


export type WallPhraseLang = 'en' | 'zh' | 'ja' | 'fr' | 'es';
export type WallPhraseWeight = 'strong' | 'weak';

export type WallPhrase = {
  /** Stable id: used by tests and by `data-adblow-why`. */
  id: string;
  lang: WallPhraseLang;
  /** `strong` = wall-only directive/notice, `weak` = the bare concept. */
  weight: WallPhraseWeight;
  /** Alternative wordings; spacing/hyphens/accents are ignored when matching (see wallMatchKey). */
  text: string[];
};

/**
 * The copy table. Kept as data so wording can be audited and extended without touching logic.
 *
 * English, Chinese and the other three locales each need a `strong` entry: a wall is localised,
 * and matching English only would miss every non-English site.
 */
export const WALL_PHRASES: readonly WallPhrase[] = [
  // ── English ────────────────────────────────────────────────────────────────
  {
    id: 'en-disable-adblocker',
    lang: 'en',
    weight: 'strong',
    text: [
      'disable your ad blocker',
      'disable your adblocker',
      'disable my ad blocker',
      'disable adblock',
      'disable the ad blocker',
      'disable your ad blocking',
      'turn off your ad blocker',
      'turn off adblock',
      'turn off the ad blocker',
      'deactivate your ad blocker',
      'please turn off your ad blocker',
    ],
  },
  {
    id: 'en-adblock-detected',
    lang: 'en',
    weight: 'strong',
    text: [
      'ad blocker detected',
      'adblocker detected',
      'adblock detected',
      'ad blocker has been detected',
      'we detected an ad blocker',
      'an ad blocker was detected',
      'an ad blocker is preventing',
      'it looks like you are using an ad blocker',
      'ad blocking software detected',
      'ad blocker is enabled',
      'adblocker is active',
    ],
  },
  {
    id: 'en-interfere',
    lang: 'en',
    weight: 'strong',
    text: [
      'interfere with the intended operation',
      'interfering with the intended operation',
      'interferes with the intended operation',
      'interfering with the operation of this site',
    ],
  },
  {
    id: 'en-allowlist',
    lang: 'en',
    weight: 'strong',
    text: [
      "add your adblocker's allowlist",
      "add your ad blocker's allowlist",
      'add us to your allowlist',
      'add our site to your allowlist',
      'add this site to your allowlist',
      'add to your allowlist',
      'allowlist our site',
      'whitelist us',
      'whitelist our site',
      'add us to your whitelist',
      'add our site to your whitelist',
      'support us by whitelisting',
    ],
  },
  {
    id: 'en-concept',
    lang: 'en',
    weight: 'weak',
    text: ['ad blocker', 'adblock', 'ad blocking', 'whitelist', 'allowlist', 'advertising revenue'],
  },

  // ── Chinese ────────────────────────────────────────────────────────────────
  {
    id: 'zh-disable-adblock',
    lang: 'zh',
    weight: 'strong',
    text: [
      '请关闭广告拦截',
      '关闭广告拦截',
      '请关闭广告过滤',
      '关闭广告过滤',
      '请关闭广告屏蔽',
      '关闭广告屏蔽',
      '请禁用广告拦截',
      '禁用广告拦截',
      '请关闭拦截插件',
      '请关闭去广告插件',
      '关闭广告拦截器',
      '请关闭您的广告拦截',
    ],
  },
  {
    id: 'zh-adblock-detected',
    lang: 'zh',
    weight: 'strong',
    text: [
      '检测到广告拦截',
      '检测到您使用了广告拦截',
      '检测到广告屏蔽',
      '检测到广告过滤',
      '您正在使用广告拦截',
      '我们检测到广告拦截',
    ],
  },
  {
    id: 'zh-allowlist',
    lang: 'zh',
    weight: 'strong',
    text: [
      '请将本站加入白名单',
      '请将本网站加入白名单',
      '把本站加入白名单',
      '加入白名单',
      '添加到白名单',
      '添加至白名单',
      '加白名单',
    ],
  },
  {
    id: 'zh-concept',
    lang: 'zh',
    weight: 'weak',
    text: ['广告拦截', '广告过滤', '广告屏蔽', '拦截插件', '去广告', '白名单'],
  },

  // ── Japanese ───────────────────────────────────────────────────────────────
  {
    id: 'ja-disable-adblock',
    lang: 'ja',
    weight: 'strong',
    text: [
      '広告ブロッカーを無効',
      '広告ブロッカーを解除',
      '広告ブロックを解除',
      '広告ブロッカーをオフ',
      '広告ブロッカーを停止',
      'adblockを無効',
      '広告ブロッカーが有効になっています',
    ],
  },
  {
    id: 'ja-adblock-detected',
    lang: 'ja',
    weight: 'strong',
    text: ['広告ブロッカーを検出', '広告ブロッカーが検出', '広告ブロックを検出', '広告ブロッカーが有効'],
  },
  {
    id: 'ja-allowlist',
    lang: 'ja',
    weight: 'strong',
    text: ['ホワイトリストに追加', 'ホワイトリストへ追加', '許可リストに追加', 'ホワイトリストに登録'],
  },
  {
    id: 'ja-concept',
    lang: 'ja',
    weight: 'weak',
    text: ['広告ブロッカー', 'アドブロック', '広告ブロック', 'ホワイトリスト'],
  },

  // ── French ─────────────────────────────────────────────────────────────────
  {
    id: 'fr-disable-adblock',
    lang: 'fr',
    weight: 'strong',
    text: [
      'désactivez votre bloqueur',
      'désactivez votre adblock',
      'désactivez adblock',
      'désactiver votre bloqueur',
      'veuillez désactiver votre bloqueur',
      'désactivez votre bloqueur de publicités',
    ],
  },
  {
    id: 'fr-adblock-detected',
    lang: 'fr',
    weight: 'strong',
    text: [
      'bloqueur de publicités détecté',
      'bloqueur de publicité détecté',
      'nous avons détecté un bloqueur',
      'un bloqueur de publicités a été détecté',
      'publicités bloquées',
    ],
  },
  {
    id: 'fr-allowlist',
    lang: 'fr',
    weight: 'strong',
    text: [
      'ajoutez-nous à votre liste blanche',
      'ajouter à la liste blanche',
      'ajoutez notre site à votre liste blanche',
      'autorisez notre site',
    ],
  },
  {
    id: 'fr-concept',
    lang: 'fr',
    weight: 'weak',
    text: ['bloqueur de publicités', 'bloqueur de pub', 'liste blanche', 'blocage des publicités'],
  },

  // ── Spanish ────────────────────────────────────────────────────────────────
  {
    id: 'es-disable-adblock',
    lang: 'es',
    weight: 'strong',
    text: [
      'desactiva tu bloqueador',
      'desactive su bloqueador',
      'deshabilita tu bloqueador',
      'desactiva adblock',
      'desactive el bloqueador',
      'desactiva tu bloqueador de anuncios',
    ],
  },
  {
    id: 'es-adblock-detected',
    lang: 'es',
    weight: 'strong',
    text: [
      'bloqueador de anuncios detectado',
      'hemos detectado un bloqueador',
      'se ha detectado un bloqueador',
      'publicidad bloqueada',
      'anuncios bloqueados',
    ],
  },
  {
    id: 'es-allowlist',
    lang: 'es',
    weight: 'strong',
    text: [
      'añádenos a tu lista blanca',
      'agrega nuestro sitio a la lista blanca',
      'añadir a la lista blanca',
      'agregar a la lista blanca',
      'permite los anuncios',
    ],
  },
  {
    id: 'es-concept',
    lang: 'es',
    weight: 'weak',
    text: ['bloqueador de anuncios', 'bloqueador de publicidad', 'lista blanca'],
  },
];

/** Evidence a `strong` phrase carries. */
export const WALL_STRONG_WEIGHT = 2;
/** Evidence a `weak` phrase carries. */
export const WALL_WEAK_WEIGHT = 1;
/**
 * Weak phrases saturate at this count.
 *
 * They all name the same concept, so a text that mentions an ad blocker usually matches several
 * of them at once ("ad blocker", "adblock", "adblocking"). Summing them would let one quoted
 * sentence in an article reach the copy-only threshold; saturating keeps weak evidence as the
 * single "the concept is present" signal it really is.
 */
export const WALL_WEAK_MAX_COUNT = 1;

/**
 * Copy threshold for an element that is **overlay-shaped**: one strong phrase is enough there,
 * because the shape already excludes article bodies (a weak-only match scores 1 and never passes).
 */
export const WALL_SHAPED_MIN_SCORE = WALL_STRONG_WEIGHT;
/**
 * Copy threshold **without** shape evidence: 2 strong phrases plus the concept — the only way to
 * reach 5, since weak evidence saturates at 1. Deliberately unreachable for an article snippet
 * that merely *discusses* ad blockers.
 */
export const WALL_TEXT_ONLY_MIN_SCORE = WALL_STRONG_WEIGHT * 2 + WALL_WEAK_WEIGHT;
/** A wall prompt is a short block; longer text without shape evidence is article text. */
export const WALL_TEXT_ONLY_MAX_CHARS = 400;
/** Even an overlay is rejected above this much text: that is a page wrapper, not a prompt. */
export const WALL_SHAPED_MAX_CHARS = 2000;
/** Share of the viewport an overlay-shaped wall must cover. */
export const WALL_MIN_AREA_RATIO = 0.2;

/** Ancestor levels searched for the wall layer that holds a matched copy block. */
export const WALL_MAX_PROMOTE_DEPTH = 4;
/** An ancestor holding more text than this is the page, not the wall. */
export const WALL_PROMOTED_MAX_TEXT = 1200;

/** Roots that can never be a prompt (hiding them blanks the page). */
const WALL_ROOT_TAGS = new Set(['HTML', 'BODY', 'HEAD']);

/** Lowercase, collapse whitespace, normalise apostrophes and exotic spaces. */
export function normalizeWallText(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc\u00b4`]/g, "'")
    .replace(/[\u00a0\u2000-\u200b\u202f\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Matching key: case-, accent-, space- and hyphen-insensitive.
 *
 * Why: the same prompt is written "ad blocker", "adblocker", "ad-blocker" and "AdBlocker", and
 * a table with every variant would drift. Removing spaces is safe for these long phrases — the
 * only way to match by accident is that exact run of characters appearing across word
 * boundaries, which for a ≥10-character directive does not happen in prose.
 */
export function wallMatchKey(raw: string): string {
  return normalizeWallText(raw)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-\u2010-\u2015]/g, '')
    .replace(/\s+/g, '');
}

/** Phrase table with matching keys precomputed once at load. */
const PHRASE_KEYS: readonly { id: string; weight: WallPhraseWeight; keys: string[] }[] =
  WALL_PHRASES.map((p) => ({ id: p.id, weight: p.weight, keys: p.text.map(wallMatchKey) }));

export type WallPhraseEvidence = {
  /** Weighted total: strong phrases count fully, weak evidence saturates (see WALL_WEAK_MAX_COUNT). */
  score: number;
  /** Ids of the matched strong phrases. */
  strong: string[];
  /** Ids of the matched weak phrases. */
  weak: string[];
};

/** Which wall phrases appear in this text (one count per phrase entry, not per occurrence). */
export function wallPhraseEvidence(text: string): WallPhraseEvidence {
  const haystack = wallMatchKey(text);
  const strong: string[] = [];
  const weak: string[] = [];
  if (haystack.length === 0) return { score: 0, strong, weak };

  for (const phrase of PHRASE_KEYS) {
    if (!phrase.keys.some((k) => k.length > 0 && haystack.includes(k))) continue;
    if (phrase.weight === 'strong') strong.push(phrase.id);
    else weak.push(phrase.id);
  }

  const weakCount = Math.min(weak.length, WALL_WEAK_MAX_COUNT);
  return {
    score: strong.length * WALL_STRONG_WEIGHT + weakCount * WALL_WEAK_WEIGHT,
    strong,
    weak,
  };
}

/** The style facts detection needs; injected so jsdom tests need no layout engine. */
export type WallStyle = {
  position: string;
  zIndex?: string;
  display?: string;
  visibility?: string;
  opacity?: string;
};

export type WallContext = {
  viewportArea: number;
  /** Defaults to `getComputedStyle`; tests inject their own. */
  styleOf?: (el: Element) => WallStyle | null;
  /** Defaults to `getBoundingClientRect`; tests inject their own (jsdom does no layout). */
  rectOf?: (el: Element) => { width: number; height: number } | null;
  /**
   * Article-markup test (schema.org markers), injected by the content layer.
   *
   * The engine layer stays free of content-layer heuristics, and the default is `false` — the
   * conservative direction for the copy-only gate would be "assume content", but assuming that
   * would silently disable detection for every caller that forgets to pass it, so the content
   * script always supplies the real implementation (see wallContext in content/wallFix.ts).
   */
  hasContentMarker?: (el: Element) => boolean;
};

const defaultStyleOf = (el: Element): WallStyle | null => {
  const g = globalThis as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration };
  if (typeof g.getComputedStyle !== 'function') return null;
  try {
    const s = g.getComputedStyle(el);
    return {
      position: s.position,
      zIndex: s.zIndex,
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
    };
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

/** Below this opacity the element does not render. */
export const WALL_MIN_OPACITY = 0.05;

function isDisplayed(style: WallStyle): boolean {
  if ((style.display ?? 'block') === 'none') return false;
  const visibility = style.visibility ?? 'visible';
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  const opacity = Number.parseFloat(style.opacity ?? '1');
  return !Number.isFinite(opacity) || opacity > WALL_MIN_OPACITY;
}

/** Fixed/absolute **and** covering WALL_MIN_AREA_RATIO of the viewport. */
export function isOverlayShaped(el: Element, ctx: WallContext): boolean {
  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  if (!style) return false;
  if (style.position !== 'fixed' && style.position !== 'absolute') return false;

  const rect = (ctx.rectOf ?? defaultRectOf)(el);
  if (!rect || ctx.viewportArea <= 0) return false;
  return (rect.width * rect.height) / ctx.viewportArea >= WALL_MIN_AREA_RATIO;
}

/**
 * Is this single element a wall prompt?
 *
 * `hiddenByUs` only skips subtrees **we** hid: an already-hidden element is invisible, so it
 * cannot be the overlay the user is complaining about.
 */
export function isWallPrompt(el: Element, ctx: WallContext): boolean {
  if (WALL_ROOT_TAGS.has(el.tagName)) return false;
  if (hiddenByUs(el)) return false;

  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  if (style && !isDisplayed(style)) return false;

  const text = normalizeWallText(el.textContent ?? '');
  if (text.length === 0) return false;

  const evidence = wallPhraseEvidence(text);
  if (evidence.score < WALL_SHAPED_MIN_SCORE) return false;
  // Article markup (schema.org) outranks every other piece of evidence: a wall prompt must not
  // be — or contain — declared article content, whatever shape and copy it carries.
  if (ctx.hasContentMarker?.(el) === true) return false;

  // ① Shape evidence: a directive on top of an overlay box that is not a page wrapper.
  if (isOverlayShaped(el, ctx) && text.length <= WALL_SHAPED_MAX_CHARS) return true;

  // ② Copy-only evidence: much higher threshold, prompt-sized text.
  if (evidence.score < WALL_TEXT_ONLY_MIN_SCORE) return false;
  if (text.length > WALL_TEXT_ONLY_MAX_CHARS) return false;
  return true;
}

/**
 * Promote a matched copy block to the enclosing wall layer.
 *
 * Real walls often put the copy in an inner box and the full-viewport backdrop in a parent: hiding
 * only the inner box would leave the backdrop covering the page. Walking up while the ancestor
 * holds a bounded amount of text (WALL_PROMOTED_MAX_TEXT) keeps the promotion from climbing to the
 * page wrapper; `<body>`/`<html>` are never candidates, and an ancestor holding article markup is
 * refused as well (a wrapper that contains the article is not a wall layer).
 */
export function promoteToWallLayer(el: Element, ctx: WallContext): Element {
  let best = el;
  let node = el.parentElement;
  for (let i = 0; i < WALL_MAX_PROMOTE_DEPTH && node; i++) {
    if (WALL_ROOT_TAGS.has(node.tagName)) break;
    if (ctx.hasContentMarker?.(node) === true) break;
    if (normalizeWallText(node.textContent ?? '').length > WALL_PROMOTED_MAX_TEXT) break;
    if (isOverlayShaped(node, ctx)) best = node;
    node = node.parentElement;
  }
  return best;
}

/**
 * Suspected prompt/overlay elements, outermost first.
 *
 * Only the outermost of a nested pair is returned: one hide clears the whole wall.
 *
 * Cost: one page-level text read gates the per-element scan, so pages without wall copy (the
 * overwhelming majority) never pay for a traversal.
 */
export function findWallPrompts(root: ParentNode, ctx: WallContext): Element[] {
  let candidates: Element[];
  try {
    candidates = Array.from(root.querySelectorAll('*'));
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  // Cheap gate: no wall vocabulary anywhere on the page → nothing to scan.
  const pageText = normalizeWallText(
    (root as Element).textContent ?? (root as Document).documentElement?.textContent ?? '',
  );
  if (wallPhraseEvidence(pageText).score < WALL_SHAPED_MIN_SCORE) return [];

  const matched: Element[] = [];
  for (const el of candidates) {
    try {
      if (isWallPrompt(el, ctx)) matched.push(promoteToWallLayer(el, ctx));
    } catch {
      // A hostile page can make style reads throw; one bad element must not stop the scan.
      continue;
    }
  }

  const unique = [...new Set(matched)];
  return unique.filter((el) => !unique.some((other) => other !== el && other.contains(el)));
}

export type WallDetection = {
  detected: boolean;
  /** Number of prompt elements found. */
  count: number;
  /** Ids of the phrases that matched, for diagnostics. */
  phrases: string[];
};

/** Detection summary for the popup hint (no element handles cross the message boundary). */
export function detectWall(root: ParentNode, ctx: WallContext): WallDetection {
  let prompts: Element[] = [];
  try {
    prompts = findWallPrompts(root, ctx);
  } catch {
    prompts = [];
  }

  const phrases = new Set<string>();
  for (const el of prompts) {
    const evidence = wallPhraseEvidence(el.textContent ?? '');
    for (const id of [...evidence.strong, ...evidence.weak]) phrases.add(id);
  }

  return { detected: prompts.length > 0, count: prompts.length, phrases: [...phrases] };
}
