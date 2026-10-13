// Generic ad-mechanism recon for a site: lists scripts, iframes, external domains
// and ad-signature markers. Structural analysis only -- page scripts are never run
// and page content is never stored.
// Run: node tools/recon/inspect.mjs <url>
import { writeFileSync, mkdirSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const url = process.argv[2];
if (!url) {
  console.error('用法：node tools/recon/inspect.mjs <url>');
  process.exit(1);
}

const SCRATCH = new URL('../../_probe/', import.meta.url);
mkdirSync(SCRATCH, { recursive: true });

const res = await fetch(url, {
  headers: {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  redirect: 'follow',
});
const html = await res.text();
writeFileSync(new URL('inspect.html', SCRATCH), html, 'utf8');

const page = new URL(url);
const pageReg = (() => {
  const p = page.hostname.split('.');
  return p.length <= 2 ? page.hostname : p.slice(-2).join('.');
})();
const reg = (h) => {
  const p = h.split('.');
  return p.length <= 2 ? h : p.slice(-2).join('.');
};
const uniq = (a) => [...new Set(a)].sort();

console.log(`URL      : ${url}`);
console.log(`状态     : HTTP ${res.status}`);
console.log(`页面宿主 : ${page.hostname}   可注册域名: ${pageReg}`);
console.log(`HTML     : ${html.length} 字节`);
console.log(`最终地址 : ${res.url}`);
if (res.url !== url) console.log(`  ⚠️ 发生了跳转`);

const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]);
console.log(`\n=== IFRAME：${iframes.length} 个 ===`);
for (const tag of iframes.slice(0, 20)) {
  const src = /src=["']([^"']+)["']/i.exec(tag)?.[1] ?? '(无 src)';
  let host = '?';
  try {
    host = src.startsWith('//') || /^https?:/i.test(src) ? new URL(src, url).hostname : page.hostname;
  } catch {
    host = '解析失败';
  }
  const cross = reg(host) !== pageReg;
  console.log(`  ${cross ? '[跨站]' : '[同站]'} ${host}  ${src.slice(0, 100)}`);
}

console.log('\n=== 内联脚本里的 iframe / document.write / insertAdjacent ===');
let n = 0;
for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
  const body = m[1];
  if (/iframe|document\.write|insertAdjacentHTML|createElement\(['"]script/i.test(body)) {
    if (n++ < 6) console.log(`  --- inline[${n}] ---\n    ${body.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
}
console.log(`  （共 ${n} 段可疑内联脚本）`);

const scripts = uniq([...html.matchAll(/<script[^>]*?\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]));
console.log(`\n=== 外部脚本：${scripts.length} 个 ===`);
for (const s of scripts.slice(0, 40)) {
  let host = '?';
  try {
    host = /^(https?:)?\/\//i.test(s) ? new URL(s, url).hostname : page.hostname;
  } catch {
    host = '解析失败';
  }
  console.log(`  ${reg(host) !== pageReg ? '[跨站]' : '[同站]'} ${s.slice(0, 120)}`);
}

const hosts = {};
for (const m of html.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
  hosts[m[1]] = (hosts[m[1]] ?? 0) + 1;
}
console.log('\n=== 引用最多的域名（前 25） ===');
for (const [h, c] of Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${reg(h) !== pageReg ? '[跨站]' : '[同站]'} ${String(c).padStart(4)}  ${h}`);
}

const adish = uniq(
  [...html.matchAll(/(?:class|id)=["']([^"']*)["']/gi)]
    .map((m) => m[1])
    .filter((c) =>
      /(^|[\s_-])(ad|ads|adv|advert|gg|guanggao|banner|pop|float|sponsor|promo|tj|ssp|ppc|union)/i.test(
        c,
      ),
    ),
);
console.log(`\n=== 广告特征 class/id：${adish.length} 个 ===`);
console.log('  ' + adish.slice(0, 50).join('\n  '));

console.log('\n=== AdBlow 覆盖情况 ===');
console.log(`  站点规则包：${/gjvrohros|cgw666/.test(page.hostname) ? '有' : '无 —— 网络层完全不生效'}`);
console.log(`  广告特征词库命中 SS P/已知标记：${
  adish.filter((c) => /ssp|tj|union/i.test(c)).length
} 个（词库只认我们自己取证过的标记）`);
