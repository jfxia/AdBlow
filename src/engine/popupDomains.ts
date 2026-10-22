import type { ParsedFilter } from './filterList/parse.ts';
import {
  domainFromAnchor,
  domainSetFromArray,
  isListedHost,
  parseDomainFile,
} from './domainList.ts';

/**
 * Popup denylist: built from the filter lists' `$popup` rules, enforced in the MAIN world.
 *
 * A popup / popunder ad is a window the page opens from a real click; there is no network
 * request to intercept, so `declarativeNetRequest` cannot see it. What the lists do provide is
 * the set of destination hosts where such windows land: `||ad.example^$popup`. This module
 * exports that set at build time and matches `window.open` targets against it.
 *
 * Delivery has to cross worlds: the guard that patches `window.open` runs in the page's MAIN
 * world and cannot read extension files, while the isolated world can message the worker. So
 * the isolated world parks the list in an inert `<script type="application/json">` element and
 * the MAIN world reads it lazily on the first `window.open`. Nothing executable is injected.
 *
 * Failure direction matches the badware gate: a missing or unreadable list means "no
 * evidence", and the window is allowed. Blocking on missing data would turn a build artifact
 * problem into broken navigation on every site.
 */

/** Label written into the generated file (not a list id: rules come from several lists). */
export const POPUP_LIST_ID = 'popup-rules';

/** File name at the extension root. Must stay a literal at the getURL call site. */
export const POPUP_DOMAINS_FILE = 'popup-domains.json';

/** ID of the inert JSON element the isolated world publishes to the MAIN world. */
export const POPUP_DENY_ELEMENT_ID = 'adblow-popup-deny';

/**
 * Attribute on `<html>` carrying the per-site "allow popups" switch.
 *
 * A DOM attribute rather than a second JSON element because it is a boolean that can change
 * while the page is open (the popup UI writes the same storage key). The MAIN-world guard reads
 * it on every `window.open`, so toggling it applies without a reload; window.open is rare enough
 * that the read is free.
 */
export const POPUP_ALLOW_ATTR = 'data-adblow-popup-allow';

/**
 * Event the MAIN-world guard dispatches for every refused window.
 *
 * The guard cannot use chrome.* (MAIN world), so it leaves the observation on the DOM and the
 * isolated content script forwards it to the worker. `detail` is deliberately a **string** URL:
 * primitives cross the world boundary safely, while a page-world object may be unreadable from
 * the isolated world. The channel is diagnostic only; a forged event can add a bogus record but
 * cannot change what is blocked.
 */
export const POPUP_BLOCK_EVENT = 'adblow-popup-blocked';

/** Shape written by tools/build/gen-rulesets.ts. */
export type PopupDomainFile = {
  generatedFrom: string;
  domains: string[];
};

/** `||example.com^`, `||example.com`, `||example.com^|` — a bare domain anchor. */
export function popupDomainFromPattern(pattern: string): string | null {
  return domainFromAnchor(pattern);
}

/**
 * Domains to export from the parsed popup rules.
 *
 * Only bare domain anchors qualify: a run-time popup gate knows the destination host but not
 * the path, the opener or the click target, so a path-shaped rule cannot be expressed exactly.
 * Scoped rules (`$domain=`, `$to=`, `$denyallow=`) are skipped for the same reason: the host is
 * only a popup target in the context of one site, and the gate has no opener context.
 * Exceptions (`@@`) subtract from the block set, and `$badfilter` rules are ignored because
 * they cancel another rule. The result is lowercase, unique and sorted.
 *
 * Deliberately ignoring `$third-party` / `~third-party`: the gate cannot see the opener, and a
 * listed popup host is a stronger signal than the party relation. This is slightly wider than
 * the list rule, but still limited to hosts the lists already call popup destinations.
 */
export function extractPopupDomains(filters: readonly ParsedFilter[]): string[] {
  const blocked = new Set<string>();
  const allowed = new Set<string>();

  for (const filter of filters) {
    // Guards against a caller passing network rules by mistake: a `$document` rule must not
    // become a popup block just because its host also appears somewhere.
    if (filter.popup !== true) continue;
    if (filter.badfilter) continue;
    if (filter.initiatorDomains?.length) continue;
    if (filter.excludedInitiatorDomains?.length) continue;
    if (filter.requestDomains?.length) continue;
    if (filter.excludedRequestDomains?.length) continue;
    const domain = domainFromAnchor(filter.pattern);
    if (!domain) continue;
    if (filter.exception) allowed.add(domain);
    else blocked.add(domain);
  }

  for (const domain of allowed) blocked.delete(domain);
  return [...blocked].sort();
}

/** Parse the generated list file (`{ generatedFrom, domains }`). */
export function parsePopupDomainFile(raw: unknown): Set<string> | null {
  return parseDomainFile(raw);
}

/** Parse the JSON array carried by the DOM element. */
export function parsePopupDomainArray(raw: unknown): Set<string> | null {
  return domainSetFromArray(raw);
}

/** Hostname suffix match at dot boundaries (see domainList.isListedHost). */
export function isPopupHost(host: string, domains: ReadonlySet<string>): boolean {
  return isListedHost(host, domains);
}

/**
 * Publish the list to the page as inert JSON.
 *
 * Returns false when the document has no root yet (unusual, but document_start is early): the
 * caller retries at a parse milestone instead of dropping the list.
 */
export function installPopupDenyElement(doc: Document, domains: readonly string[]): boolean {
  if (doc.getElementById(POPUP_DENY_ELEMENT_ID)) return true;
  const parent = doc.head ?? doc.documentElement;
  if (!parent) return false;

  const el = doc.createElement('script');
  // `type="application/json"` makes the element data, not code: the browser never executes it
  // and no CSP script-src grants or nonces are involved.
  el.setAttribute('type', 'application/json');
  el.id = POPUP_DENY_ELEMENT_ID;
  el.textContent = JSON.stringify(domains);
  parent.appendChild(el);
  return true;
}

/**
 * Read the list back out of the document.
 *
 * Returns null when the element is absent, has no content, or does not contain a JSON array.
 * An empty array is a valid list (an empty set), not a failure.
 */
export function readPopupDenyDomains(doc: Document): Set<string> | null {
  const el = doc.getElementById(POPUP_DENY_ELEMENT_ID);
  if (!el) return null;
  const text = el.textContent ?? '';
  if (!text) return null;
  try {
    return parsePopupDomainArray(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Publish the per-site switch for the MAIN world (the value "1" means allowed).
 *
 * Returns false when the document root does not exist yet, so the caller can retry at the next
 * parse milestone instead of leaving the switch unset for the lifetime of the page.
 */
export function publishPopupAllowance(doc: Document, allowed: boolean): boolean {
  const root = doc.documentElement;
  if (!root) return false;
  if (allowed) root.setAttribute(POPUP_ALLOW_ATTR, '1');
  else root.removeAttribute(POPUP_ALLOW_ATTR);
  return true;
}

/** Read the per-site switch published by the isolated world. Missing = not allowed. */
export function readPopupAllowance(doc: Document): boolean {
  return doc.documentElement?.getAttribute(POPUP_ALLOW_ATTR) === '1';
}

/**
 * Tell the isolated world that a window was refused, for the per-site record.
 *
 * Only a string travels; see POPUP_BLOCK_EVENT for why.
 */
export function announcePopupBlock(doc: Document, url: string): void {
  try {
    doc.dispatchEvent(new CustomEvent(POPUP_BLOCK_EVENT, { detail: url }));
  } catch {
    // No CustomEvent in a stripped context: the block already happened, only the record is lost.
  }
}

/** Resolve a `window.open` target to a hostname; null when the URL is unusable. */
function hostOfUrl(url: string, base?: string): string | null {
  try {
    return new URL(url, base).hostname || null;
  } catch {
    return null;
  }
}

export type PopupDenyGate = {
  /** True when the target host is on the list, i.e. the window must be refused. */
  isDenied(url: string, base?: string): boolean;
};

/**
 * Lazily-read, cached view of the DOM list for the MAIN-world guard.
 *
 * The read happens on the first `window.open`, not at startup, so the guard does not depend on
 * the order in which the isolated-world script and the page run. Only a *successful* read is
 * cached: if the element is not there yet, the next call reads again instead of disabling the
 * gate for the lifetime of the page (a page that opens a window during load would otherwise
 * never get the list). A missing list allows the window.
 */
export function createPopupDenyGate(doc: Document): PopupDenyGate {
  let domains: ReadonlySet<string> | null = null;
  return {
    isDenied(url: string, base?: string): boolean {
      if (!url) return false;
      if (domains === null) {
        domains = readPopupDenyDomains(doc);
        if (domains === null) return false;
      }
      const host = hostOfUrl(url, base);
      return host !== null && isPopupHost(host, domains);
    },
  };
}
