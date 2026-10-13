<div align="center">

<img src="public/icons/icon-128.png" width="96" alt="AdBlow icon" />

# AdBlow

**An ad blocker that judges ads by how a page behaves — not only by matching filter lists.**

[![Manifest V3](https://img.shields.io/badge/manifest-v3-blueviolet)](#)
[![Tests](https://img.shields.io/badge/tests-631%20passing-brightgreen)](#testing--verification)
[![UI languages](https://img.shields.io/badge/UI%20languages-5-informational)](#user-interface)

[中文说明](README.zh-CN.md)

</div>

---

## Why another ad blocker?

AdBlow ships the same EasyList-family filter lists that every blocker uses, and then adds a
second, independent line of defence: a runtime engine that scores each element on **how it
behaves** — script-injected into the page, pulling media from a domain that never appears
elsewhere, growing its own geometry, wrapping its links in the site's own redirect endpoint,
hiding its creatives behind a base64 CDN proxy. Lists miss that long tail; behaviour catches it.

The second difference is what happens when the engine is *wrong*. Every self-learned rule is
scoped to the site that taught it, is revocable one by one, and is structurally incapable of
touching images, video, stylesheets or scripts. The design bias is explicit:

> **Better to miss an ad than to break a page.**

And unlike AdBlock Plus, there is no paid "Acceptable Ads" whitelist — nothing is let through
for money. The build even refuses to fetch a list that contains one.

## Features

**Network layer** — 6 filter lists (EasyList, EasyList China, EasyPrivacy, uBlock
filters/privacy/badware) compiled into declarativeNetRequest rulesets: 127,336 input rules
deduped and validated down to 21,146 block rules + 2,369 exceptions across 6 rulesets, with
105,675 domain anchors collapsed into 113 packed rules.

**Cosmetic layer** — 25,478 domain-specific selectors covering 11,389 domains, split into 256
hash shards and delivered to the content script on demand (no `web_accessible_resources`, so
one less fingerprinting surface).

**Behaviour engine** — a pristine-snapshot diff plus an ad-likeness score. Signals include
script injection, cross-site links/media/iframes, geometry growth, promo query parameters, ad
naming across 3 confidence tiers, full-screen overlays, click layers, fake close buttons and
link farms. It also **unwraps** two tricks used to defeat cross-site detection: own-domain
redirect endpoints whose payload declares `{"kind":"ad", ...}`, and CDN paths that base64-wrap
the real media URL.

**Anti-hijack guards** (MAIN world) — `window.open` guard, click-hijack guard, popup-state
scrubbing from `localStorage`/`sessionStorage`/`window.name`, and rejection of document-level
click handlers that only navigate.

**Scriptlet support** — 12 canonical `##+js(...)` scriptlets (`abort-on-property-read`,
`set-constant`, `json-prune`, `no-fetch-if`, `no-setTimeout-if`, …) covering 2,841 domains,
delivered as one inlined table so it runs before page scripts.

**Self-learning** — remembers hiding selectors and ad domains per site, promotes after 3 hits,
and exposes everything in a rule manager where you can revoke any entry or export it as JSON.

**Per-site switch** — the popup can disable filtering for the current site, which also suspends
that site's learned network rules. Always a way out.

**User interface** — Chinese (simplified, default), English, Japanese, French, Spanish,
selected automatically from the browser UI language.

**Privacy** — everything runs locally. No telemetry, no accounts, no remote config. The only
outbound traffic is the browser updating the extension itself.

## Screenshots

| Popup (site switch + live stats) | Rule manager |
|---|---|
| ![Popup](store/store-1280x800-popup-zhCN.png) | ![Rule manager](store/store-1280x800-options-enUS.png) |

## Install

**From source** (works today):

```bash
git clone <this repo> && cd adblow
pnpm install
pnpm filters        # fetch the 6 filter lists (not in the repo — see Licensing)
pnpm rulesets       # compile them into DNR rulesets + cosmetic shards + scriptlet table
pnpm build          # -> dist/
```

Then open `edge://extensions` (or `chrome://extensions`), enable **Developer mode**, choose
**Load unpacked**, and select the `dist/` directory.

A store release (`adblow-1.0.0-edge.zip`) is prepared but not published yet.

## Build and package

```bash
pnpm test           # 631 unit + integration tests, in-process
pnpm typecheck      # tsc --noEmit
pnpm verify         # build + tests
pnpm icons          # regenerate icons (16/32/48/128 + store icon)
pnpm package        # build + audit + zip -> release/adblow-<version>-edge.zip
```

Requirements: Node.js 24+, pnpm, and Python 3 with Pillow (icons and store screenshots only).

The packaging step audits `dist/` against what the manifest actually declares, drops anything
that is not a product file (for example the browser-generated `_metadata/` ruleset cache), and
writes a zip with `manifest.json` at the root. If a browser currently has `dist/` loaded,
Windows locks the directory — build to an alternate one instead of fighting it:

```bash
ADBLOW_DIST=dist-release pnpm package
```

## Architecture

Four layers, each one narrower and more conservative than the last:

| Layer | Runs in | Mechanism | Why it exists |
|---|---|---|---|
| **L1 Network** | `declarativeNetRequest` | Static rulesets from filter lists + dynamic rules for learned domains | Stops requests before they leave the browser |
| **L2 Cosmetic** | Isolated world | Domain-scoped CSS, inline `!important` hiding for judged elements | Removes what should never render |
| **L3 Behaviour** | Isolated world | Pristine snapshot diff, ad-likeness scoring, self-learning | Catches what lists have never seen |
| **L4 Guards** | MAIN world | `window.open`, click hijack, storage scrub, listener rejection | Stops the page from fighting back |

```
src/
  background/      service worker: DNR sync, cosmetic shard delivery, stats
  content/         L2+L3: engine, judge, learning store, per-site settings
  engine/          pure logic, browser-free: scoring, lexicon, geometry, DNR, filter-list
                   compiler, scriptlet parser, selector generalisation
  inject/          L4: MAIN-world guards, scriptlet runtime
  rules/sites/     hand-written site packs (per-site, verified selectors)
  ui/              popup + rule manager + i18n (5 locales)
tools/
  filters/         list fetching (refuses lists with paid whitelists)
  build/           ruleset + cosmetic + scriptlet codegen, bundling, icon generation
  e2e/             23-category in-browser acceptance suite, live-site pilot
  release/         audit, zip, store screenshots
  diagnostics/     copy-paste console snippets for triaging a broken page
tests/             631 unit + integration tests (jsdom)
public/            manifest, _locales, icons
```

### Safety invariants

These are enforced in code and covered by tests, because each one exists because we got it
wrong at least once:

- Learned network rules **never** touch `image`, `media`, `script`, `stylesheet` or `font` —
  content thumbnails and ad creatives routinely share one CDN.
- Learned rules are scoped to the **sites that taught them** (`initiatorDomains`), so a domain
  learned on site A can never break site B.
- Nothing implicit ever blocks a `main_frame`; only an explicit `$document` rule may.
- The engine never hides `html`, `body` or `head`: hiding those blanks the whole page.
- A hiding budget limits how much of a page's text and links may be hidden, and elements that
  hold real content or navigation are exempt.
- Hiding sets `display`, `visibility` *and* `pointer-events`, then re-checks later: sites do
  re-assert `display` with their own `!important`.

## Testing & verification

```bash
node tests/run-all.ts     # 631 tests, 0 failures
node tools/e2e/acceptance.mjs   # 23 ad categories, measured in a real browser
```

`tools/e2e/acceptance.mjs` is the interesting one. It builds a fixture page for each of 23
ad-interference categories (pop-ups, pop-unders, interstitials, floating bars, corner widgets,
sticky banners, outstream video, preroll, mid-roll, video overlays, full-page clickable ads,
fake close buttons, click hijacking, tab-under, region expanders, flashing GIFs, rich media,
own-domain redirect wrapping, base64 CDN wrapping, …). For **every** fixture it first measures a
baseline with the extension disabled — if the ad is not actually interfering in the baseline,
the fixture is considered worthless — then measures again with the extension loaded. Ads must
be gone **and** the fixture's real content must still be visible.

There is also a live-site end-to-end run (`tools/e2e/run.mjs <url>`) with image guards, CDN
guards and site-owned-domain guards, so a fix that starts hiding content fails loudly.

## Known limitations

Stated plainly, because a README that only lists wins is not useful:

- Generic (non-domain-specific) cosmetic rules are not injected; domain-scoped rules are.
- Procedural cosmetic filters (`#?#`) and HTML filtering (`##^`) are not implemented.
- `##+js(abort-current-script)` and a few other scriptlets (359 rules in the lists) are
  unsupported; the build reports what it skips rather than silently widening a rule.
- Filter lists are compiled at build time, so updating them requires rebuilding the extension
  (an MV3 constraint — no remote rulesets).
- No published performance benchmarks yet, and no head-to-head comparison against other
  blockers on neutral sites.

## Credits

Filter lists are the work of their maintainers and are **not** part of this repository; they
are fetched at build time:

| List | License |
|---|---|
| [EasyList](https://easylist.to/), [EasyList China](https://easylist.to/), [EasyPrivacy](https://easylist.to/) | GPLv3 / CC BY-SA 3.0 |
| [uBlock Origin assets](https://github.com/uBlockOrigin/uAssets) (filters, privacy, badware) | GPLv3 |

Please respect those licenses when redistributing anything built from this repository.

## License

**Not chosen yet — this is the one open decision before publishing.** The source code in this
repository is the author's work, but a *built* extension embeds the GPLv3/CC BY-SA filter lists
above, which is why the two cannot be decided independently. Reasonable options:

1. **GPL-3.0** for the whole project — simplest to reason about given the bundled lists.
2. **MIT or Apache-2.0 for the code**, with a clear notice that built artifacts bundle
   third-party GPL/CC BY-SA data and inherit those obligations.

Until a `LICENSE` file is added, all rights are reserved by default.

---

<div align="center">
<sub>AdBlow 1.0.0 · Manifest V3 · Edge &amp; Chrome</sub>
</div>
