import { allEntries, clearSite } from '../content/learn.ts';
import { isSiteDisabled, readStats, setSiteDisabled } from '../content/settings.ts';
import { chromeLocal } from '../content/storage.ts';

/**
 * Popup：站点开关 + 运行统计 + 清空本站学习结果。
 *
 * 站点开关是**安全阀**：任何会在某站点上出错的过滤器都必须能单站关掉，
 * 否则用户只能整个禁用扩展。
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

function showNotice(text: string): void {
  const notice = el('notice');
  notice.textContent = text;
  notice.hidden = false;
  el('toggle-row').hidden = true;
  el('stats').hidden = true;
  el('stats-hint').hidden = true;
}

async function render(): Promise<void> {
  el('version').textContent = `v${chrome.runtime.getManifest().version}`;

  const host = await currentHost();
  if (!host) {
    el('host').textContent = '当前页面不适用';
    showNotice('浏览器内部页面、扩展页面无法过滤。请在普通网页上使用。');
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
    hint.textContent = '本站已关闭，过滤与学习都已停止。';
  } else if (stats) {
    hint.textContent = `已学习规则在累计 3 次命中后才生效（当前晋级 ${promoted} 条）。`;
  } else {
    hint.textContent = '本页尚未产生统计，刷新后可见。';
  }
}

el<HTMLInputElement>('enabled').addEventListener('change', async (event) => {
  const host = await currentHost();
  if (!host) return;
  const enabled = (event.target as HTMLInputElement).checked;
  await setSiteDisabled(store, host, !enabled);
  await render();
});

el('clear-site').addEventListener('click', async () => {
  const host = await currentHost();
  if (!host) return;
  if (!confirm(`清空 ${host} 上 AdBlow 学到的全部规则？`)) return;
  await clearSite(store, host);
  await render();
});

el('open-options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

void render();
