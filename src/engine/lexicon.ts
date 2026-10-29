/**
 * Our own ad-naming recognition (word lists).
 *
 * Rewritten after 1024cg.com defeated substring matching (it missed even `ad-item`
 * and a bare `ad`). Now tiered whole-word matching: names are split on
 * non-alphanumerics, so `download` / `header` / `add` do not match but `ad-card-0`
 * does. Tiers: SSP markers (decisive alone), strong ad terms, weak terms that are
 * common in normal UI and need corroboration.
 *
 * ❗**Word tokens, never prefixes or substrings — and no camelCase splitting**
 * (2026-10-29, AdBlow hid its own store listing): Microsoft Partner Center renders our
 * extension card as `<img title="AdBlow">` and `<a aria-label="AdBlow In the Store">`.
 * Naming used to split camelCase, so `AdBlow` became `ad` + `blow`, matched the ad word
 * `ad`, and the extension hid its own entry. A brand that merely *starts* with "ad"
 * (`AdBlow`, `adblow.com`, `adventure`, `adaptive`, `loading`) says nothing about the
 * element's role. Splitting therefore happens only at real separators (see TOKEN_SPLIT),
 * and concatenated ad forms are accepted through an explicit list (COMPACT_TOKENS)
 * instead of being re-derived from the `ad` prefix.
 *
 * ❗**Naming evidence comes from the class, the id, and the values of a few label
 * attributes — never from arbitrary attribute names** (2026-10-29, YouTube Shorts):
 * the shadow-DOM-era player puts internal feature switches on the host element as
 * boolean attributes, e.g. `<ytd-shorts … move-ads-overlay-to-shorts … role="main">`.
 * Scanning every attribute name found `ads` inside `move-ads-overlay-to-shorts`,
 * scored the whole page container as strong ad naming, and hid it — the page went
 * blank while the video kept playing. An attribute *name* is the site's internal
 * switch name, not a statement about the element's role; only human-readable
 * labels (`aria-label`, `title`) and the standard ad-slot attribute carry that
 * meaning, and only through their **values**.
 *
 * The one deliberate exception is the SSP forensics markers below: those are an
 * exact allowlist recovered from the pilot site's ad SDK (attribute names like
 * `data-ssp-container`), not a generic "the name contains an ad word" search.
 */

/** 3 = site-forensics marker; 2 = strong naming; 1 = weak naming; 0 = no signal */
export const NAMING_SSP = 3;
export const NAMING_STRONG = 2;
export const NAMING_WEAK = 1;
export const NAMING_NONE = 0;

/** Site-forensics markers from reverse-engineering ad-sdk / ssp.css: evidence, not guesses. */
const SSP_SUBSTRINGS = ['data-ssp-', 'xqbj-component-ssp', 'xqbj-recommand-item-banner'];

/** Strong naming: ad-specific terms normal content is not named with. Whole-word, so `ad` alone. */
const STRONG_TOKENS = new Set([
  'ad',
  'ads',
  'adv',
  'advert',
  'adverts',
  'advertising',
  'advertisement',
  'advertisements',
  'doubleclick',
  'guanggao',
  'popunder',
  'preroll',
  'interstitial',
  'ssp',
  // Video-ad industry terms (2026-10-10 acceptance): outstream/instream are the
  // standard stream names, vast/vmap/vpaid are IAB delivery protocols.
  'outstream',
  'instream',
  'vast',
  'vmap',
  'vpaid',
]);

/**
 * Compact spellings: `ad` glued to the following word, so no separator exists to split on.
 *
 * Kept as an **explicit list** on purpose (2026-10-29). Re-deriving these from an `ad`
 * prefix is exactly what hid `AdBlow`: a prefix rule accepts every brand and every English
 * word that happens to start with those two letters. A name is only evidence when it is in
 * this list, in STRONG_TOKENS, or splits into a token that is.
 *
 * Adding an entry is a deliberate decision about a real site's naming, not a loosening of
 * the matcher.
 */
const COMPACT_TOKENS = new Set([
  'adblk',
  'adbox',
  'adslot',
  'adunit',
  'aditem',
  'adcard',
  'adwrap',
  'adcontainer',
  'adframe',
  'adserver',
  'adsystem',
  'adbanner',
  'adspop',
  'admask',
  // AdSense writes the loader class as one blob, with the publisher id appended by the
  // snippet: `<ins class="adsbygoogle">`.
  'adsbygoogle',
]);

/**
 * `ssp` glued behind a site prefix (`tjssp`), where whole-word splitting cannot help.
 *
 * A **suffix** check rather than a substring: `passport` contains the letters `ssp` but is
 * not the acronym, and that is the same prefix/substring failure the file header describes.
 */
const SSP_CONCAT_SUFFIX = 'ssp';
const SSP_CONCAT_MIN_LENGTH = 4;

/** Weak naming: also common in normal UI, never decisive alone — e.g. a site's own
 * popup.js or a "sponsors" acknowledgement list. */
const WEAK_TOKENS = new Set([
  'banner',
  'promo',
  'promotion',
  'promoted',
  'sponsor',
  'sponsored',
  'popup',
  'pop',
  'float',
  'gg',
  // Sticky banner (fixed bottom/top bar). `sticky` also names sticky page headers in
  // normal UI, so it stays weak: cross-site links/assets must corroborate it.
  'sticky',
  // Ad carousel container (missed 2026-10-13): ads hung off a `Banner2` class
  // inside `.streamer-container2`, with 3 images from 3 ad domains. Weak, not
  // strong: a live-stream site's host cards may also be called streamer.
  'streamer',
  'couplet',
  'piaofu',
]);

/**
 * Deliberately **not** included (recorded so nobody "helpfully" adds them):
 * - `overlay`: the generic class of legitimate dialogs, which often hold cross-site
 *   share/payment links; video overlay ads are handled by geometry instead.
 * - `video`: matches every player, i.e. it would hide all video on the site.
 */

/** Negation prefixes: the `banner` in `no-banner-image` is not a signal. */
const NEGATIONS = new Set(['no', 'not', 'non', 'without']);

/**
 * Token separators: `-`, `_`, whitespace and every other non-alphanumeric character.
 *
 * `.` / `/` / `:` matter for label values (`adblow.com`, `Ads / Sponsored`), which are
 * prose rather than identifiers. CamelCase is **not** a separator — see the file header;
 * `AdBlow` stays one token, `adblow`.
 */
const TOKEN_SPLIT = /[^a-z0-9]+/;

/**
 * Trailing digits are a slot index or a creative size, not part of the word: `ad1`,
 * `ad300x250`, `banner2` all name the same thing as their stem.
 */
const NUMERIC_SUFFIX = /(?:\d+x\d+|\d+)$/;

/**
 * Attributes whose **values** are naming evidence.
 *
 * `aria-label` / `title` are the accessible, human-visible labels a site writes on an ad slot;
 * `data-ad-slot` is the standard AdSense slot marker. Nothing else is read — see the file header
 * for the boolean-attribute incident that forced this restriction.
 */
const NAMING_VALUE_ATTRS = ['aria-label', 'title', 'data-ad-slot'] as const;

export type NamingSignal = {
  strength: number;
  /** The matched word or marker, for debugging and stats */
  matched: string[];
  /**
   * True when the only naming evidence is in a label attribute's **value** (`aria-label`,
   * `title`, `data-ad-slot`) and the element's own class/id carry none.
   *
   * Those labels are written for humans — a product name, a button caption — and are the
   * weakest naming source we read. They may justify hiding an element, but never teaching a
   * rule: see recordableSelector and the 2026-10-29 AdBlow incident.
   */
  labelOnly: boolean;
};

/** Which vocabulary word a token names, if any. */
function classifyToken(token: string): 'strong' | 'weak' | null {
  if (STRONG_TOKENS.has(token) || COMPACT_TOKENS.has(token)) return 'strong';
  if (WEAK_TOKENS.has(token)) return 'weak';
  // `tjssp`: a site prefix glued in front of the acronym, so there is no separator to split on.
  if (token.length >= SSP_CONCAT_MIN_LENGTH && token.endsWith(SSP_CONCAT_SUFFIX)) return 'strong';

  const stem = token.replace(NUMERIC_SUFFIX, '');
  if (stem && stem !== token) return classifyToken(stem);
  return null;
}

type WordScan = { strength: number; matched: string[] };

/**
 * Scan one naming haystack in isolation.
 *
 * Sources are scanned separately on purpose: `namingSignal` needs to know whether the
 * evidence sits in the class/id or only in a label value, and a combined scan cannot tell.
 */
function scanWords(hay: string): WordScan {
  const strong: string[] = [];
  const weak: string[] = [];
  const tokens = hay.toLowerCase().split(TOKEN_SPLIT).filter(Boolean);

  for (const [i, token] of tokens.entries()) {
    // `no-banner-image` / `without-banner`: the ad word is negated, so it is not a signal.
    if (i > 0 && NEGATIONS.has(tokens[i - 1]!)) continue;
    const word = classifyToken(token);
    if (word === 'strong') strong.push(token);
    else if (word === 'weak') weak.push(token);
  }

  if (strong.length) return { strength: NAMING_STRONG, matched: strong };
  if (weak.length) return { strength: NAMING_WEAK, matched: weak };
  return { strength: NAMING_NONE, matched: [] };
}

export function namingSignal(el: Element): NamingSignal {
  const names = [el.getAttribute('class') ?? '', el.getAttribute('id') ?? ''].join(' ');
  const values = NAMING_VALUE_ATTRS.map((name) => el.getAttribute(name) ?? '').join(' ');

  // 1) Site-forensics markers (substring, pilot-site specific). The only path allowed to read
  // attribute *names*: an exact list of SDK markers from reverse-engineering, see file header.
  const forensicHay = [
    names,
    Array.from(el.attributes)
      .map((a) => a.name)
      .join(' '),
  ].join(' ');
  for (const marker of SSP_SUBSTRINGS) {
    if (forensicHay.includes(marker)) {
      return { strength: NAMING_SSP, matched: [marker], labelOnly: false };
    }
  }

  // 2) Word tokens, by source. Strength is the stronger of the two: class/id naming plus
  // label naming never exceeds the strongest single piece of evidence.
  const nameScan = scanWords(names);
  const valueScan = scanWords(values);

  return {
    strength: Math.max(nameScan.strength, valueScan.strength),
    matched: [...nameScan.matched, ...valueScan.matched],
    labelOnly: valueScan.strength >= NAMING_WEAK && nameScan.strength === NAMING_NONE,
  };
}

export function adSignalStrength(el: Element): number {
  return namingSignal(el).strength;
}
