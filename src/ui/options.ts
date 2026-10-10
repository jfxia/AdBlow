import { clearSite, forgetSelector, listAllSites, type LearnedEntry } from '../content/learn.ts';
import { chromeLocal } from '../content/storage.ts';

/**
 * Options：自学习规则的审阅与撤销。
 *
 * 这不是「锦上添花」的界面，而是抗污染设计的必要一环：自学习规则晋级后会在
 * 后续访问中无条件生效，因此必须给用户一个看得见、删得掉的入口。
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
  const total = sites.reduce((n, s) => n + s.entries.length, 0);
  const active = sites.reduce((n, s) => n + s.entries.filter((e) => e.promoted).length, 0);
  el('summary').textContent = sites.length
    ? `${sites.length} 个站点 · ${active} 条生效 · 共 ${total} 条`
    : '';

  if (sites.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有学到任何规则。浏览网页后，AdBlow 会在需要时自动积累。';
    container.appendChild(empty);
    return;
  }

  for (const site of sites) container.appendChild(renderSite(site.host, site.entries));
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
