/**
 * Our own ad-naming recognition (word lists).
 *
 * Rewritten after 1024cg.com defeated substring matching (it missed even `ad-item`
 * and a bare `ad`). Now tiered whole-word matching: names are split on
 * non-alphanumerics, so `download` / `header` / `add` do not match but `ad-card-0`
 * does. Tiers: SSP markers (decisive alone), strong ad terms, weak terms that are
 * common in normal UI and need corroboration.
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
  'adbox',
  'adslot',
  'adunit',
  'aditem',
  'adcard',
  'adwrap',
  'adcontainer',
  'adspop',
  'admask',
  'adframe',
  'adserver',
  'adsystem',
  'adbanner',
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

/** Concatenated forms: no word boundary to split on, so substring matching is the only option. */
const STRONG_SUBSTRINGS = [
  'adsbygoogle',
  'doubleclick',
  'adserver',
  'adsystem',
  'guanggao',
  'advertisement',
  // 'ssp' is an ad-tech acronym that barely appears in normal naming, and sites
  // commonly write it concatenated (`tjssp`), where whole-word splitting fails.
  'ssp',
];

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

const SPLIT = /[^a-z0-9]+/;

export type NamingSignal = {
  strength: number;
  /** The matched word or marker, for debugging and stats */
  matched: string[];
};

export function namingSignal(el: Element): NamingSignal {
  const hay = [
    el.getAttribute('class') ?? '',
    el.getAttribute('id') ?? '',
    Array.from(el.attributes)
      .map((a) => a.name)
      .join(' '),
  ].join(' ');

  // 1) Site-forensics markers (substring, pilot-site specific)
  for (const marker of SSP_SUBSTRINGS) {
    if (hay.includes(marker)) return { strength: NAMING_SSP, matched: [marker] };
  }

  // 2) Concatenated strong forms (substring)
  for (const sub of STRONG_SUBSTRINGS) {
    if (hay.includes(sub)) return { strength: NAMING_STRONG, matched: [sub] };
  }

  // 3) Whole-word matching
  //
  // ⚠️ Splitting must break camelCase and digit boundaries (missed 2026-10-13):
  // the site's top banner ad was `.topBanner`, and `topbanner` is not `banner`, so
  // an obvious ad container matched nothing. After splitting: `topBanner` →
  // `top banner`, `adCard0` → `ad card 0`.
  const normalized = hay.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const tokens = normalized.split(SPLIT).filter(Boolean);
  const strong: string[] = [];
  const weak: string[] = [];

  for (const [i, token] of tokens.entries()) {
    const negated = i > 0 && NEGATIONS.has(tokens[i - 1]!);
    if (negated) continue;
    if (STRONG_TOKENS.has(token)) strong.push(token);
    else if (WEAK_TOKENS.has(token)) weak.push(token);
  }

  if (strong.length) return { strength: NAMING_STRONG, matched: strong };
  if (weak.length) return { strength: NAMING_WEAK, matched: weak };
  return { strength: NAMING_NONE, matched: [] };
}

export function adSignalStrength(el: Element): number {
  return namingSignal(el).strength;
}
