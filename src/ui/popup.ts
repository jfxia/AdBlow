import { allEntries, clearSite } from '../content/learn.ts';
import {
  isSiteDisabled,
  isWallFixEnabled,
  readStats,
  readWallDetected,
  setSiteDisabled,
  setWallFixEnabled,
} from '../content/settings.ts';
import { chromeLocal } from '../content/storage.ts';
import { applyI18n, t } from './i18n.ts';

/**
 * Popup: per-site toggle, run stats, wall fix, and clearing this site's learned results.
 *
 * The toggle is a safety valve: a filter that misbehaves on one site must be switchable per
 * site, otherwise the only option left is disabling the whole extension. All text goes
 * through i18n (`t()` / `data-i18n`) — see ui/i18n.ts.
 *
 * The anti-adblock wall fix is a **separate, explicit confirmation**: the popup only offers it
 * after the content script reported a wall on this site, and the copy states exactly what it
 * does — hide that prompt layer and re-show the content the page covered, with ad blocking
 * unchanged.
 */

const store = chromeLocal();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

async function currentHost(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url;
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}

function showNotice(text: string, hostLabel = false): void {
  const notice = el('notice');
  notice.textContent = text;
  notice.hidden = false;
  el('toggle-row').hidden = true;
  el('stats').hidden = true;
  el('stats-hint').hidden = true;
  el('wall-card').hidden = true;
  if (hostLabel) el('host').textContent = t('popupNotApplicable');
}

/**
 * Wall card: hidden unless the site is being filtered and either the fix is on or a wall was
 * detected here before. The button is the only way the fix can ever start.
 */
async function renderWall(host: string, disabled: boolean): Promise<void> {
  const card = el('wall-card');
  if (disabled) {
    card.hidden = true;
    return;
  }

  const [detectedAt, fixOn] = await Promise.all([
    readWallDetected(store, host),
    isWallFixEnabled(store, host),
  ]);
  if (!fixOn && detectedAt === undefined) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  el('wall-detail').textContent = fixOn ? t('popupWallOn') : t('popupWallDetected');
  el<HTMLButtonElement>('wall-toggle').textContent = fixOn
    ? t('popupWallDisable')
    : t('popupWallEnable');
}

async function render(): Promise<void> {
  el('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const host = await currentHost();
  if (!host) {
    el('host').textContent = t('popupNotApplicable');
    showNotice(t('popupInternalNotice'));
    el<HTMLButtonElement>('clear-site').disabled = true;
    return;
  }

  el('host').textContent = host;

  const disabled = await isSiteDisabled(store, host);
  const enabledBox = el<HTMLInputElement>('enabled');
  enabledBox.checked = !disabled;
  el('toggle-row').hidden = false;

  const [stats, entries] = await Promise.all([readStats(store, host), allEntries(store, host)]);
  const promoted = entries.filter((e) => e.promoted).length;

  el('stat-rule').textContent = String(stats?.rule ?? 0);
  el('stat-heuristic').textContent = String(stats?.heuristic ?? 0);
  el('stat-learned').textContent = `${promoted} / ${entries.length}`;
  el('stats').hidden = false;

  const hint = el('stats-hint');
  hint.hidden = false;
  if (disabled) {
    hint.textContent = t('popupHintDisabled');
  } else if (stats) {
    hint.textContent = t('popupHintLearning', [promoted]);
  } else {
    hint.textContent = t('popupHintNoStats');
  }

  await renderWall(host, disabled);
}

el<HTMLInputElement>('enabled').addEventListener('change', async (event) => {
  const host = await currentHost();
  if (!host) return;
  const enabled = (event.target as HTMLInputElement).checked;
  await setSiteDisabled(store, host, !enabled);
  await render();
});

el('wall-toggle').addEventListener('click', async () => {
  const host = await currentHost();
  if (!host) return;
  const fixOn = await isWallFixEnabled(store, host);
  // Same key the content script reads (and watches via chrome.storage.onChanged).
  await setWallFixEnabled(store, host, !fixOn);
  await render();
});

el('clear-site').addEventListener('click', async () => {
  const host = await currentHost();
  if (!host) return;
  if (!confirm(t('popupConfirmClear', [host]))) return;
  await clearSite(store, host);
  await render();
});

el('open-options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

applyI18n();
void render();
