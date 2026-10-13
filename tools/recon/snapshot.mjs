// Generates the regression fixture for the pilot site.
// Why sanitise instead of storing the raw HTML: the pilot site is an adult content
// aggregator whose raw pages carry a lot of explicit copy, while the tests only need
// structure and attributes (class / id / data-* / tags).
// Fidelity limits -- do not misuse: tag hierarchy, class, id, data-*, href, src,
// itemtype, rel and type are kept; all text nodes, script/style bodies and copy
// attributes (alt/title/content/style) are wiped. The fixture therefore only
// supports **structural** assertions; anything relying on copy or script content
// must fetch the real page with tools/recon/fetch.mjs.
// Run: node tools/recon/snapshot.mjs [url]
import { writeFileSync, mkdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const url = process.argv[2] ?? 'https://afford.gjvrohros.cc/category/jrxw1/';
/** Output filename (under tests/fixtures/); multi-site regression relies on it. */
const OUT_NAME = process.argv[3] ?? 'pilot-category.html';

const SCRATCH = new URL('../../_probe/', import.meta.url);
const FIXTURES = new URL('../../tests/fixtures/', import.meta.url);
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(FIXTURES, { recursive: true });

/** Human-readable attributes: values are always wiped, as tests never use them. */
const COPY_ATTRS = new Set([
  'alt',
  'title',
  'content',
  'aria-label',
  'aria-description',
  'placeholder',
  'value',
  'style',
  'data-original-title',
]);

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/g;

console.log(`抓取 ${url} ...`);
const res = await fetch(url, {
  headers: {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  redirect: 'follow',
});
if (!res.ok) {
  console.error(`抓取失败：HTTP ${res.status}`);
  process.exit(1);
}
const raw = await res.text();
writeFileSync(new URL('page.html', SCRATCH), raw, 'utf8');
console.log(`原始 HTML：${raw.length} 字节 -> _probe/page.html（已忽略，不入库）`);

const dom = new JSDOM(raw);
const { document } = dom.window;

// 1) wipe script / style bodies
for (const el of document.querySelectorAll('script, style, noscript, template')) {
  el.textContent = el.tagName === 'SCRIPT' ? '/*elided*/' : '';
}

// 2) wipe all text and comment nodes. Comments matter too: the site leaves Chinese
//    notes in them (e.g. a mobile-console remark), which text-only handling missed.
const walker = document.createTreeWalker(
  document.documentElement,
  4 /* SHOW_TEXT */ | 128 /* SHOW_COMMENT */,
);
const texts = [];
while (walker.nextNode()) texts.push(walker.currentNode);
for (const t of texts) t.nodeValue = '';

// 3) wipe human-readable attribute values, plus any CJK left in attributes
let cjkAttrs = 0;
for (const el of document.querySelectorAll('*')) {
  for (const attr of Array.from(el.attributes)) {
    if (COPY_ATTRS.has(attr.name)) {
      attr.value = '';
      continue;
    }
    if (CJK.test(attr.value)) {
      CJK.lastIndex = 0;
      attr.value = attr.value.replace(CJK, 'x');
      cjkAttrs++;
    }
  }
}

const out = '<!doctype html>\n' + document.documentElement.outerHTML + '\n';
writeFileSync(new URL(OUT_NAME, FIXTURES), out, 'utf8');

// 4) self-check: no CJK copy may survive sanitisation
CJK.lastIndex = 0;
const leftovers = out.match(CJK) ?? [];
console.log(`脱敏后 fixture：${out.length} 字节 -> tests/fixtures/${OUT_NAME}`);
console.log(`属性值中清理的 CJK 段：${cjkAttrs}`);
console.log(`残留 CJK 段：${leftovers.length}${leftovers.length ? ' -> ' + leftovers.slice(0, 5).join(' | ') : '（干净）'}`);
console.log(
  `结构自检：data-ssp-container=${(out.match(/data-ssp-container/g) ?? []).length} ` +
    `data-ssp-slot-node=${(out.match(/data-ssp-slot-node/g) ?? []).length} ` +
    `data-ssp-slot-root=${(out.match(/data-ssp-slot-root/g) ?? []).length} ` +
    `div.post-card=${(out.match(/<div[^>]*class="[^"]*\bpost-card\b[^"]*"/g) ?? []).length}`,
);
