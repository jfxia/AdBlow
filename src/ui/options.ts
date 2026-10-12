import { clearSite, forgetSelector, listAllSites, type LearnedEntry } from '../content/learn.ts';
import {
  allDomainEntries,
  clearDomains,
  forgetDomain,
  type DomainEntry,
} from '../content/domainLearn.ts';
import { chromeLocal } from '../content/storage.ts';

/**
 * Options：自学习结果的审阅与撤销。
 *
 * 这不是「锦上添花」的界面，而是抗污染设计的必要一环：自学习规则晋级后会在
 * 后续访问中无条件生效（选择器在 DOM 层、域名在**网络层**），因此必须给用户
 * 一个看得见、删得掉的入口。
 *
 * 注意：这是**可选的审阅入口，不是必填配置**。普通用户不需要打开它。
 */

const store = chromeLocal();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

function renderEntry(host: string, entry: LearnedEntry): HTMLLIElement {
  const li = document.createElement('li');

  const code = document.createElement('code');
  code.textContent = entry.selector;
  li.appendChild(code);

  const pill = document.createElement('span');
  pill.className = entry.promoted ? 'pill on' : 'pill';
  pill.textContent = entry.promoted ? '已生效' : '观察中';
  li.appendChild(pill);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `命中 ${entry.hits}`;
  li.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = '删除';
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
  count.textContent = `${entries.filter((e) => e.promoted).length} 条生效 / 共 ${entries.length} 条`;
  header.appendChild(count);

  const clear = document.createElement('button');
  clear.className = 'danger';
  clear.textContent = '清空本站';
  clear.addEventListener('click', async () => {
    if (!confirm(`清空 ${host} 上的全部学习规则？`)) return;
    await clearSite(store, host);
    await render();
  });
  header.appendChild(clear);

  section.appendChild(header);

  const list = document.createElement('ul');
  for (const entry of entries) list.appendChild(renderEntry(host, entry));
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
      ? `选择器 ${active} 条生效 / 共 ${total} 条 · 域名 ${domainActive} 个已拦截 / 共 ${domainTotal} 个`
      : '';

  if (sites.length === 0 && domainSites.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有学到任何规则。浏览网页后，AdBlow 会在需要时自动积累。';
    container.appendChild(empty);
    return;
  }

  // 网络层（域名）优先展示：它的影响面比 DOM 选择器更大
  for (const site of domainSites) {
    container.appendChild(renderDomainSite(site.pageHost, site.entries));
  }
  for (const site of sites) container.appendChild(renderSite(site.host, site.entries));
}

function renderDomainEntry(pageHost: string, entry: DomainEntry): HTMLLIElement {
  const li = document.createElement('li');

  const code = document.createElement('code');
  code.textContent = entry.host;
  li.appendChild(code);

  const pill = document.createElement('span');
  pill.className = entry.promoted ? 'pill on' : 'pill';
  pill.textContent = entry.promoted ? '已拦截' : '观察中';
  li.appendChild(pill);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `出现 ${entry.hits} 次`;
  li.appendChild(meta);

  const del = document.createElement('button');
  del.className = 'danger';
  del.textContent = '不再拦截';
  del.addEventListener('click', async () => {
    await forgetDomain(store, pageHost, entry.host);
    await render();
  });
  li.appendChild(del);

  return li;
}

/** 网络层：在某站点上学到的广告域名。 */
function renderDomainSite(pageHost: string, entries: DomainEntry[]): HTMLElement {
  const section = document.createElement('section');

  const header = document.createElement('header');
  const name = document.createElement('strong');
  name.textContent = `网络层 · 在 ${pageHost} 上学到`;
  header.appendChild(name);

  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = `${entries.filter((e) => e.promoted).length} 个已拦截 / 共 ${entries.length} 个`;
  header.appendChild(count);

  const clear = document.createElement('button');
  clear.className = 'danger';
  clear.textContent = '清空本组';
  clear.addEventListener('click', async () => {
    if (!confirm(`清空在 ${pageHost} 上学到的全部域名？`)) return;
    await clearDomains(store, pageHost);
    await render();
  });
  header.appendChild(clear);

  section.appendChild(header);

  const hint = document.createElement('p');
  hint.className = 'count';
  hint.style.padding = '6px 13px 0';
  hint.textContent =
    '域名累计在广告里出现 3 次后自动拦截。凡是也被正常内容使用的域名一律不学。';
  section.appendChild(hint);

  const list = document.createElement('ul');
  for (const entry of entries) list.appendChild(renderDomainEntry(pageHost, entry));
  section.appendChild(list);

  return section;
}

el('refresh').addEventListener('click', () => void render());

el('export').addEventListener('click', async () => {
  const sites = await listAllSites(store);
  const payload = {
    product: 'AdBlow',
    exportedAt: new Date().toISOString(),
    sites,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'adblow-learned-rules.json';
  a.click();
  URL.revokeObjectURL(url);
});

void render();
