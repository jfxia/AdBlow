/**
 * 生成试点站的回归测试 fixture。
 *
 * 为什么要「脱敏」而不是直接存原始 HTML：
 *   试点站是成人向内容聚合站，原始页面含大量露骨文案。测试只需要验证
 *   **结构与属性**（class / id / data-* / 标签），不需要任何文案。
 *   因此这里保留全部标签与结构属性，抹掉文本节点与人类可读属性值。
 *
 * 保真边界（重要，别误用）：
 *   - 保留：标签层级、class、id、data-*、href、src、itemtype、rel、type 等
 *   - 抹掉：所有文本节点、script/style 正文，以及 alt/title/content/style 等文案属性
 *   - 因此本 fixture 只适用于**结构断言**；任何依赖文案或脚本内容的测试
 *     必须改用 tools/recon/fetch.mjs 抓取真实页面。
 *
 * 用法：node tools/recon/snapshot.mjs [url]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const url = process.argv[2] ?? 'https://afford.gjvrohros.cc/category/jrxw1/';
/** 输出文件名（写到 tests/fixtures/ 下）。多站点回归靠它。 */
const OUT_NAME = process.argv[3] ?? 'pilot-category.html';

const SCRATCH = new URL('../../_probe/', import.meta.url);
const FIXTURES = new URL('../../tests/fixtures/', import.meta.url);
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(FIXTURES, { recursive: true });

/** 人类可读属性：值一律抹掉，因为测试不依赖它们。 */
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

// 1) 抹掉 script / style 正文
for (const el of document.querySelectorAll('script, style, noscript, template')) {
  el.textContent = el.tagName === 'SCRIPT' ? '/*elided*/' : '';
}

// 2) 抹掉所有文本节点与注释节点
//    注释也要清：站点在注释里写了中文说明（如「测试环境移动端控制台」），
//    只处理文本节点会漏掉它们。
const walker = document.createTreeWalker(
  document.documentElement,
  4 /* SHOW_TEXT */ | 128 /* SHOW_COMMENT */,
);
const texts = [];
while (walker.nextNode()) texts.push(walker.currentNode);
for (const t of texts) t.nodeValue = '';

// 3) 抹掉人类可读属性值；顺带清掉属性值里残留的 CJK
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

// 4) 自检：脱敏后不应再有任何 CJK 文案残留
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
