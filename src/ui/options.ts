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
import {
  countSites,
  groupBySite,
  isWholeSite,
  pickKey,
  togglePick,
  type PickMap,
  type PickRef,
} from './bulkSelection.ts';

/**
 * Options: review and revoke what self-learning produced.
 *
 * Not a nice-to-have: once promoted, learned rules apply unconditionally on later visits
 * (selectors at the DOM layer, domains at the network layer), so users need a visible place
 * to delete them. An optional review surface, not required configuration; all text goes
 * through i18n and site domains come from pages, so textContent only (see ui/i18n.ts).
 *
 * Deletion is **in place**: the row is removed from the list and the counts are recomputed from
 * the DOM. Re-rendering the whole page after a delete used to scroll the list back to the top
 * (the container was emptied and rebuilt), which made revoking a rule deep in a long site list
 * lose the user's place.
 */

const store = chromeLocal();

/** Current selection for bulk actions. */
const picked: PickMap = new Map();

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

function checkbox(className: string, labelKey: string): HTMLInputElement {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = className;
  box.setAttribute('aria-label', t(labelKey));
  return box;
}

/** The rule a row stands for, read back from its checkbox's data attributes. */
function refOfRow(row: Element): PickRef | null {
  const box = row.querySelector<HTMLInputElement>('input.pick');
  if (!box) return null;
  const { kind, host, rule } = box.dataset;
  if (!kind || host === undefined || rule === undefined) return null;
  return { kind: kind as PickRef['kind'], host, rule };
}

function rowsOf(section: Element): HTMLLIElement[] {
  return Array.from(section.querySelectorAll<HTMLLIElement>('ul.rows > li'));
}

function sections(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#sites section'));
}

/** Update the summary line and every checkbox from the current selection. */
function syncSelectionUi(): void {
  const bulkBar = el('bulkbar');
  const count = picked.size;
  if (count === 0) {
    bulkBar.hidden = true;
  } else {
    bulkBar.hidden = false;
    el('bulkcount').textContent = t('optionsSelected', [count, countSites(picked)]);
  }

  for (const section of sections()) {
    const rows = rowsOf(section);
    const sitePick = section.querySelector<HTMLInputElement>('input.site-pick');
    if (sitePick) {
      const keys = rows.map((row) => {
        const ref = refOfRow(row);
        return ref ? pickKey(ref) : '';
      });
      const on = keys.filter((key) => key && picked.has(key)).length;
      sitePick.checked = rows.length > 0 && on === rows.length;
      sitePick.indeterminate = on > 0 && on < rows.length;
    }
    for (const row of rows) {
      const box = row.querySelector<HTMLInputElement>('input.pick');
      const ref = refOfRow(row);
      if (box && ref) box.checked = picked.has(pickKey(ref));
    }
  }
}

/** Totals recomputed from the rows still in the DOM (they are the page's own record). */
function refreshSummary(): void {
  const rows = Array.from(document.querySelectorAll<HTMLLIElement>('#sites li'));
  const promoted = (list: HTMLLIElement[]): number =>
    list.filter((row) => row.querySelector('.pill.on') !== null).length;
  const isSelector = (row: HTMLLIElement): boolean =>
    (row.querySelector<HTMLInputElement>('input.pick')?.dataset.kind ?? '') === 'selector';
  const selectors = rows.filter(isSelector);
  const domains = rows.filter((row) => !isSelector(row));
  el('summary').textContent = rows.length
    ? t('optionsSummary', [
        promoted(selectors),
        selectors.length,
        promoted(domains),
        domains.length,
      ])
    : '';
}

/** Recount one section's header from its remaining rows. */
function updateSectionCount(section: HTMLElement): void {
  const labelKey = section.dataset.countKey;
  const target = section.querySelector('header .count');
  if (!labelKey || !target) return;
  const rows = rowsOf(section);
  const promoted = rows.filter((row) => row.querySelector('.pill.on') !== null).length;
  target.textContent = t(labelKey, [promoted, rows.length]);
}

/** Empty state when the last section is gone. */
function ensureEmptyState(): void {
  const container = el('sites');
  if (container.querySelector('section') !== null) return;
  container.textContent = '';
  const empty = document.createElement('p');
  empty.className = 'empty';
  empty.textContent = t('optionsEmpty');
  container.appendChild(empty);
}

/**
 * Remove one row from the page and keep the counters honest.
 *
 * Never re-renders: a full rebuild scrolls the page back to the top, which is exactly what
 * deleting a rule deep in a long list must not do.
 */
function removeRow(row: HTMLLIElement): void {
  const list = row.parentElement;
  const section = row.closest('section');
  row.remove();
  if (section) {
    if (rowsOf(section).length === 0) section.remove();
    else updateSectionCount(section);
  }
  void list;
  refreshSummary();
  syncSelectionUi();
  ensureEmptyState();
}

async function deleteOne(ref: PickRef): Promise<void> {
  if (ref.kind === 'selector') await forgetSelector(store, ref.host, ref.rule);
  else await forgetDomain(store, ref.host, ref.rule);
}

/** Bulk delete: one write per section when a whole section is selected, else per rule. */
async function deletePicked(): Promise<void> {
  if (picked.size === 0) return;
  if (!confirm(t('optionsConfirmDeleteSelected', [picked.size]))) return;

  const rowByKey = new Map<string, HTMLLIElement>();
  for (const row of Array.from(document.querySelectorAll<HTMLLIElement>('#sites li'))) {
    const ref = refOfRow(row);
    if (ref) rowByKey.set(pickKey(ref), row);
  }

  for (const [key, refs] of groupBySite(picked)) {
    const host = refs[0]!.host;
    const section = document.querySelector<HTMLElement>(
      `#sites section[data-site-key="${key}"]`,
    );
    const sectionKeys = section ? rowsOf(section).map((row) => {
      const ref = refOfRow(row);
      return ref ? pickKey(ref) : '';
    }) : [];
    if (section && isWholeSite(picked, sectionKeys)) {
      // Same operation as the section's own "clear" button.
      if (refs[0]!.kind === 'selector') await clearSite(store, host);
      else await clearDomains(store, host);
    } else {
      for (const ref of refs) await deleteOne(ref);
    }
  }

  const doomed = [...picked.values()]
    .map((ref) => rowByKey.get(pickKey(ref)))
    .filter((row): row is HTMLLIElement => row !== undefined);
  picked.clear();
  for (const row of doomed) removeRow(row);
  syncSelectionUi();
}

function renderEntry(host: string, entry: LearnedEntry): HTMLLIElement {
  const li = document.createElement('li');

  const pick = checkbox('pick', 'optionsPickRow');
  pick.dataset.kind = 'selector';
  pick.dataset.host = host;
  pick.dataset.rule = entry.selector;
  pick.addEventListener('change', () => {
    togglePick(picked, { kind: 'selector', host, rule: entry.selector }, pick.checked);
    syncSelectionUi();
  });
  li.appendChild(pick);

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
    await deleteOne({ kind: 'selector', host, rule: entry.selector });
    removeRow(li);
  });
  li.appendChild(del);

  return li;
}

function renderSite(host: string, entries: LearnedEntry[]): HTMLElement {
  const section = document.createElement('section');
  section.dataset.siteKey = `selector|${host}`;
  section.dataset.countKey = 'optionsCountSelectors';

  const header = document.createElement('header');

  const sitePick = checkbox('site-pick', 'optionsPickSite');
  header.appendChild(sitePick);

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
    picked.clear();
    section.remove();
    refreshSummary();
    syncSelectionUi();
    ensureEmptyState();
  });
  header.appendChild(clear);

  sitePick.addEventListener('change', () => {
    for (const row of rowsOf(section)) {
      const ref = refOfRow(row);
      if (!ref) continue;
      togglePick(picked, ref, sitePick.checked);
    }
    syncSelectionUi();
  });

  section.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'rows';
  for (const entry of entries) list.appendChild(renderEntry(host, entry));
  section.appendChild(list);

  return section;
}

function renderDomainEntry(pageHost: string, entry: DomainEntry): HTMLLIElement {
  const li = document.createElement('li');

  const pick = checkbox('pick', 'optionsPickRow');
  pick.dataset.kind = 'domain';
  pick.dataset.host = pageHost;
  pick.dataset.rule = entry.host;
  pick.addEventListener('change', () => {
    togglePick(picked, { kind: 'domain', host: pageHost, rule: entry.host }, pick.checked);
    syncSelectionUi();
  });
  li.appendChild(pick);

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
    await deleteOne({ kind: 'domain', host: pageHost, rule: entry.host });
    removeRow(li);
  });
  li.appendChild(del);

  return li;
}

/** Network layer: ad domains learned on one site. */
function renderDomainSite(pageHost: string, entries: DomainEntry[]): HTMLElement {
  const section = document.createElement('section');
  section.dataset.siteKey = `domain|${pageHost}`;
  section.dataset.countKey = 'optionsCountDomains';

  const header = document.createElement('header');

  const sitePick = checkbox('site-pick', 'optionsPickSite');
  header.appendChild(sitePick);

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
    picked.clear();
    section.remove();
    refreshSummary();
    syncSelectionUi();
    ensureEmptyState();
  });
  header.appendChild(clear);

  sitePick.addEventListener('change', () => {
    for (const row of rowsOf(section)) {
      const ref = refOfRow(row);
      if (!ref) continue;
      togglePick(picked, ref, sitePick.checked);
    }
    syncSelectionUi();
  });

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
  picked.clear();

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
    ensureEmptyState();
    syncSelectionUi();
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

  syncSelectionUi();
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
el('bulkdelete').addEventListener('click', () => void deletePicked());
el('bulkclear').addEventListener('click', () => {
  picked.clear();
  syncSelectionUi();
});

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


// ── Click-triggered navigation observations ─────────────────────────────────
//
// Record-only data written by the background script (see src/engine/clickWatch.ts): a click on
// ordinary content followed by a cross-site top-level navigation. Shown so that a misbehaving
// site leaves a visible trace; nothing acts on it yet.

const CLICK_WATCH_PREFIX = 'clickwatch:';

type ClickWatchRow = { host: string; count: number; lastAt: number; targetHost: string };

async function renderClickWatch(): Promise<void> {
  const box = el('clickwatch');
  box.textContent = '';

  const keys = (await store.keys()).filter((key) => key.startsWith(CLICK_WATCH_PREFIX));
  if (keys.length === 0) {
    box.hidden = true;
    return;
  }

  const rows: ClickWatchRow[] = [];
  for (const key of keys) {
    const value = await store.get<{ count?: number; lastAt?: number; lastTargetHost?: string }>(key);
    if (!value) continue;
    rows.push({
      host: key.slice(CLICK_WATCH_PREFIX.length),
      count: typeof value.count === 'number' ? value.count : 0,
      lastAt: typeof value.lastAt === 'number' ? value.lastAt : 0,
      targetHost: typeof value.lastTargetHost === 'string' ? value.lastTargetHost : '',
    });
  }
  rows.sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);

  const title = document.createElement('h2');
  title.textContent = t('optionsClickWatchTitle');
  box.appendChild(title);

  const hint = document.createElement('p');
  hint.className = 'lede';
  hint.textContent = t('optionsClickWatchHint');
  box.appendChild(hint);

  const section = document.createElement('section');
  const list = document.createElement('ul');
  list.className = 'rows';
  for (const row of rows) {
    const li = document.createElement('li');

    const code = document.createElement('code');
    code.textContent = row.host;
    li.appendChild(code);

    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = t('optionsClickWatchRow', [
      String(row.count),
      row.lastAt ? new Date(row.lastAt).toLocaleString() : '-',
      row.targetHost || '-',
    ]);
    li.appendChild(meta);

    const del = button('optionsDelete', 'danger');
    del.addEventListener('click', async () => {
      await store.remove(`${CLICK_WATCH_PREFIX}${row.host}`);
      await renderClickWatch();
    });
    li.appendChild(del);

    list.appendChild(li);
  }
  section.appendChild(list);
  box.appendChild(section);
  box.hidden = false;
}

void renderClickWatch();
