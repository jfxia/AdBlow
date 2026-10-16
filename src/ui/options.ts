import { clearSite, forgetSelector, listAllSites, type LearnedEntry } from '../content/learn.ts';
import {
  allDomainEntries,
  clearDomains,
  forgetDomain,
  type DomainEntry,
} from '../content/domainLearn.ts';
import { chromeLocal } from '../content/storage.ts';
import { applyI18n, t } from './i18n.ts';
import { sortByRule, sortHosts } from './ruleSorting.ts';

/**
 * Options: review and revoke what self-learning produced.
 *
 * Not a nice-to-have: once promoted, learned rules apply unconditionally on later visits
 * (selectors at the DOM layer, domains at the network layer), so users need a visible place
 * to delete them. An optional review surface, not required configuration; all text goes
 * through i18n and site domains come from pages, so textContent only (see ui/i18n.ts).
 */

const store = chromeLocal();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

function button(labelKey: string, className = ''): HTMLButtonElement {
  const b = document.createElement('button');
  if (className) b.className = className;
  b.textContent = t(labelKey);
  return b;
}

function renderEntry(host: string, entry: LearnedEntry): HTMLLIElement {
  const li = document.createElement('li');

  const code = document.createElement('code');
  code.textContent = entry.selector;
  li.appendChild(code);

  const pill = document.createElement('span');
  pill.className = entry.promoted ? 'pill on' : 'pill';
  pill.textContent = t(entry.promoted ? 'optionsPillActive' : 'optionsPillObserving');
  li.appendChild(pill);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = t('optionsHits', [entry.hits]);
  li.appendChild(meta);

  const del = button('optionsDelete', 'danger');
  del.addEventListener('click', async () => {
    await forgetSelector(store, host, entry.selector);
    await render();
  });
  li.appendChild(del);

  return li;
}

function renderSite(host: string, entries: LearnedEntry[]): HTMLElement {
  const section = document.createElement('section');

  const header = document.createElement('header');
  const name = document.createElement('strong');
  name.textContent = host;
  header.appendChild(name);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = t('optionsCountSelectors', [
    entries.filter((e) => e.promoted).length,
    entries.length,
  ]);
  header.appendChild(count);

  const clear = button('optionsClearSite', 'danger');
  clear.addEventListener('click', async () => {
    if (!confirm(t('optionsConfirmClearSite', [host]))) return;
    await clearSite(store, host);
    await render();
  });
  header.appendChild(clear);

  section.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'rows';
  for (const entry of entries) list.appendChild(renderEntry(host, entry));
  section.appendChild(list);

  return section;
}

function renderDomainEntry(pageHost: string, entry: DomainEntry): HTMLLIElement {
  const li = document.createElement('li');

  const code = document.createElement('code');
  code.textContent = entry.host;
  li.appendChild(code);

  const pill = document.createElement('span');
  pill.className = entry.promoted ? 'pill on' : 'pill';
  pill.textContent = t(entry.promoted ? 'optionsPillBlocked' : 'optionsPillObserving');
  li.appendChild(pill);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = t('optionsSeen', [entry.hits]);
  li.appendChild(meta);

  const del = button('optionsUnblock', 'danger');
  del.addEventListener('click', async () => {
    await forgetDomain(store, pageHost, entry.host);
    await render();
  });
  li.appendChild(del);

  return li;
}

/** Network layer: ad domains learned on one site. */
function renderDomainSite(pageHost: string, entries: DomainEntry[]): HTMLElement {
  const section = document.createElement('section');

  const header = document.createElement('header');
  const name = document.createElement('strong');
  name.textContent = t('optionsDomainHeader', [pageHost]);
  header.appendChild(name);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = t('optionsCountDomains', [
    entries.filter((e) => e.promoted).length,
    entries.length,
  ]);
  header.appendChild(count);

  const clear = button('optionsClearGroup', 'danger');
  clear.addEventListener('click', async () => {
    if (!confirm(t('optionsConfirmClearGroup', [pageHost]))) return;
    await clearDomains(store, pageHost);
    await render();
  });
  header.appendChild(clear);

  section.appendChild(header);

  const hint = document.createElement('p');
  hint.className = 'count section-hint';
  hint.textContent = t('optionsDomainHint');
  section.appendChild(hint);

  const list = document.createElement('ul');
  list.className = 'rows';
  for (const entry of entries) list.appendChild(renderDomainEntry(pageHost, entry));
  section.appendChild(list);

  return section;
}

async function render(): Promise<void> {
  const container = el('sites');
  container.textContent = '';

  const sites = await listAllSites(store);
  const domainSites = await allDomainEntries(store);
  const total = sites.reduce((n, s) => n + s.entries.length, 0);
  const active = sites.reduce((n, s) => n + s.entries.filter((e) => e.promoted).length, 0);
  const domainTotal = domainSites.reduce((n, s) => n + s.entries.length, 0);
  const domainActive = domainSites.reduce(
    (n, s) => n + s.entries.filter((e) => e.promoted).length,
    0,
  );

  el('summary').textContent =
    sites.length || domainSites.length
      ? t('optionsSummary', [active, total, domainActive, domainTotal])
      : '';

  if (sites.length === 0 && domainSites.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = t('optionsEmpty');
    container.appendChild(empty);
    return;
  }

  // One block per site, all sites in a single alphabetical order: a site's learned ad domains
  // and its hiding rules belong together, and two separate alphabetical blocks made the same
  // site appear twice. Inside a site the two rule kinds are still rendered by their own
  // renderer (different columns and actions), each sorted by rule text; `www.` is ignored
  // when ordering hosts so that `www.example.com` and `example.com` land in one place.
  const merged = new Map<string, { domains: DomainEntry[]; selectors: LearnedEntry[] }>();
  const bucket = (host: string) => {
    const existing = merged.get(host);
    if (existing) return existing;
    const created = { domains: [] as DomainEntry[], selectors: [] as LearnedEntry[] };
    merged.set(host, created);
    return created;
  };
  for (const site of domainSites) bucket(site.pageHost).domains.push(...site.entries);
  for (const site of sites) bucket(site.host).selectors.push(...site.entries);

  for (const host of sortHosts([...merged.keys()])) {
    const { domains, selectors } = merged.get(host)!;
    if (domains.length > 0) {
      container.appendChild(renderDomainSite(host, sortByRule(domains, (e) => e.host)));
    }
    if (selectors.length > 0) {
      container.appendChild(renderSite(host, sortByRule(selectors, (e) => e.selector)));
    }
  }
}

/**
 * Show which filter-list revision is bundled.
 *
 * The lists are compiled into packaged static rulesets, and MV3 has no API to
 * replace those remotely, so this date is the only way to tell whether the
 * installed build still carries fresh rules. Read from the extension's own
 * `list-info.json`; if it is missing (older build), show nothing rather than a
 * misleading placeholder.
 */
async function showListData(): Promise<void> {
  const target = el('listdata');
  try {
    const url = chrome.runtime.getURL('list-info.json');
    const info = (await (await fetch(url)).json()) as {
      listsFetchedAt?: string | null;
      lists?: string[];
      networkRules?: number | null;
    };
    const when = info.listsFetchedAt ? new Date(info.listsFetchedAt) : null;
    if (!when || Number.isNaN(when.getTime())) return;
    const date = when.toISOString().slice(0, 10);
    target.textContent = t('optionsListData', [
      date,
      String(info.lists?.length ?? 0),
      String(info.networkRules ?? 0),
    ]);
  } catch {
    /* 没有这个文件（旧产物或未构建）时静默跳过 */
  }
}

el('refresh').addEventListener('click', () => void render());

el('export').addEventListener('click', async () => {
  const sites = await listAllSites(store);
  const payload = {
    product: 'AdBlow',
    productVersion: chrome.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    // Sorted like the page: two exports of the same rules then differ only where the rules
    // differ, which makes the files diffable instead of noisy.
    sites: sortHosts(sites.map((s) => s.host)).map((host) => {
      const site = sites.find((s) => s.host === host)!;
      return { ...site, entries: sortByRule(site.entries, (e) => e.selector) };
    }),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'adblow-learned-rules.json';
  a.click();
  URL.revokeObjectURL(url);
});

applyI18n();
void render();
void showListData();
