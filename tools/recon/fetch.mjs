import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';
const url = process.argv[2];

const res = await fetch(url, {
  headers: {
    'user-agent': UA,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  },
  redirect: 'follow',
});
const html = await res.text();
writeFileSync(new URL('./page.html', import.meta.url), html, 'utf8');

const uniq = (a) => [...new Set(a)].sort();
const scriptSrc = uniq([...html.matchAll(/<script[^>]*?\ssrc=["']([^"']+)["']/gi)].map((m) => m[1]));
const hosts = {};
for (const m of html.matchAll(/(?:https?:)?\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
  hosts[m[1]] = (hosts[m[1]] || 0) + 1;
}
const hostList = Object.entries(hosts).sort((a, b) => b[1] - a[1]);
const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map((m) => m[0]);
const adish = uniq([...html.matchAll(/(?:class|id)=["']([^"']*)["']/gi)]
  .map((m) => m[1])
  .filter((c) => /(^|[\s_-])(ad|ads|adv|gg|guanggao|banner|pop|float|tg|qq|kf|pay|vip|down|app)/i.test(c)));

const out = {
  status: res.status,
  bytes: html.length,
  title: (html.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].trim(),
  scriptSrc,
  inlineScriptCount: [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/gi)].length,
  styleSrc: uniq([...html.matchAll(/<link[^>]*rel=["']?stylesheet[^>]*href=["']([^"']+)["']/gi)].map((m) => m[1])),
  iframeCount: iframes.length,
  iframes: iframes.slice(0, 20),
  hosts: hostList,
  adish,
};
writeFileSync(new URL('./recon.json', import.meta.url), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify(out, null, 2));

// also dump every inline script body for local inspection
const inlineBodies = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
writeFileSync(new URL('./inline-scripts.txt', import.meta.url), inlineBodies.join('\n\n/* ---- NEXT INLINE SCRIPT ---- */\n\n'), 'utf8');
