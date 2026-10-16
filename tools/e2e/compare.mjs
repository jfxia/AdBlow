// Fair comparison: AdBlow vs Adblock Plus / uBlock Origin Lite / AdGuard / no
// extension. Neutrality is the whole point: one fixed metric set, taken from none
// of the extensions' own implementations -- (1) successful responses to a fixed
// third-party ad/tracking domain list, (2) content damage via visible text and
// links, (3) leftover ad slots via one neutral heuristic applied identically to
// every variant (cross-site iframe area, ad words in class names, adsbygoogle).
// Each variant gets a fresh browser profile, the same pages, waits and scrolling.
// Run: node tools/e2e/compare.mjs [--pages=a,b,c]
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROBE = `${ROOT}_probe/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fixed third-party ad / tracking domain list (neutral: taken from no tested
// extension's rules). Suffix matching only, so paths cause no bias.
const AD_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com',
  'adnxs.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com',
  'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com', 'scorecardresearch.com',
  'quantserve.com', 'adsrvr.org', '33across.com', 'smartadserver.com', 'adform.net',
  'mgid.com', 'propellerads.com', 'popads.net', 'exoclick.com', 'juicyads.com',
  'trafficjunky.net', 'adsterra.com', 'hilltopads.net', 'revcontent.com', 'sharethrough.com',
  'teads.tv', 'spotxchange.com', 'adcolony.com', 'applovin.com', 'unityads.unity3d.com',
  'yandex.ru/metrika', 'mc.yandex.ru', 'aizhantj.com', 'histats.com', 'statcounter.com',
  'clarity.ms', 'hotjar.com', 'mixpanel.com', 'segment.io', 'branch.io', 'adjust.com',
  'adsystem.com', 'amazon-adsystem.com', 'advertising.com', 'yieldmo.com', 'sovrn.com',
];

const isAdUrl = (u) => {
  const s = String(u).toLowerCase();
  return AD_DOMAINS.some((d) => s.includes(d));
};

const PAGES = (() => {
  const arg = process.argv.find((a) => a.startsWith('--pages='));
  if (arg) return arg.slice('--pages='.length).split(',').filter(Boolean);
  return [
    'https://javeve-2026085.dgav37.com/ja/list/44247.html',
    'https://1024cg.com/page/3/?ysclid=mv25k2xqsu241136248',
    'https://09s97k.dgav36.xyz/',
    'https://xchina.co/video/id-6abe6c167765f.html',
  ];
})();

/** Variants under test; AdBlow and the rivals are all loaded unpacked. */
const VARIANTS = [
  { key: 'none', label: '无扩展（基线）', dir: null },
  { key: 'adblow', label: 'AdBlow', dir: `${ROOT}dist` },
  { key: 'abp', label: 'Adblock Plus', dir: `${PROBE}exts/adblock-plus` },
  { key: 'ubol', label: 'uBlock Origin Lite', dir: `${PROBE}exts/ublock-origin-lite` },
  { key: 'adguard', label: 'AdGuard', dir: `${PROBE}exts/adguard` },
].filter((v) => v.dir === null || existsSync(`${v.dir}/manifest.json`));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = {};
  }
  static async connectOnce(u) {
    const ws = new WebSocket(u);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
    });
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        const { resolve, reject } = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (m.method) {
        (c.events[m.method] ??= []).push(m.params);
      }
    });
    return c;
  }
  static async connect(u, n = 5) {
    let last = null;
    for (let i = 0; i < n; i += 1) {
      try {
        return await Cdp.connectOnce(u);
      } catch (e) {
        last = e;
        await sleep(400);
      }
    }
    throw last ?? new Error('ws');
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Neutral leftover-ad-slot heuristic, applied identically to every variant. */
const DOM_PROBE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const vis = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 60 && r.height >= 30;
  };
  const AD_WORDS = /(^|[-_ ])(ad|ads|adv|advert|advertisement|banner|sponsor|sponsored|promo|popup|popunder|guanggao|gg)([-_ ]|$)/i;

  let adLikeVisible = 0;
  const samples = [];
  // (1) Cross-site iframes of a decent size
  for (const f of document.querySelectorAll('iframe[src]')) {
    if (!vis(f)) continue;
    const src = f.getAttribute('src') || '';
    let cross = false;
    try { cross = new URL(src, location.href).hostname.replace(/^www\\./,'') !== location.hostname.replace(/^www\\./,''); } catch (e) {}
    if (!cross) continue;
    const r = f.getBoundingClientRect();
    if (r.width * r.height < 100 * 50) continue;
    adLikeVisible += 1;
    if (samples.length < 4) samples.push('iframe ' + src.slice(0, 50));
  }
  // (2) Visible elements whose class/id carries an ad word and that are large enough
  for (const el of document.querySelectorAll('[class],[id]')) {
    const sig = ((el.getAttribute('class') || '') + ' ' + (el.id || ''));
    if (!AD_WORDS.test(sig)) continue;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 100 * 50) continue;
    adLikeVisible += 1;
    if (samples.length < 8) samples.push(el.tagName.toLowerCase() + '.' + sig.trim().split(/\\s+/).slice(0,2).join('.'));
  }
  // (3) Known ad containers
  for (const sel of ['ins.adsbygoogle', '[id*="google_ads"]', '[data-ad-slot]', '[data-ad-client]']) {
    for (const el of document.querySelectorAll(sel)) {
      if (vis(el)) adLikeVisible += 1;
    }
  }

  const texts = [...document.querySelectorAll('article,main,.content,.post,.entry,.article-body')];
  const contentText = texts.map((e) => (e.innerText || '').trim().length).sort((a,b)=>b-a)[0] || 0;
  const navText = [...document.querySelectorAll('nav,[role="navigation"],.nav,.menu,.navbar')]
    .map((e) => (e.innerText || '').trim().length).sort((a,b)=>b-a)[0] || 0;
  const visibleLinks = [...document.querySelectorAll('a[href]')].filter((a) => {
    const r = a.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh) return false;
    const s = getComputedStyle(a);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }).length;

  return {
    url: location.href,
    bodyText: (document.body.innerText || '').trim().length,
    contentText, navText, visibleLinks,
    adLikeVisible,
    adSamples: samples.slice(0, 6),
  };
})()`;

async function measureVariant(variant, port) {
  const profile = `${PROBE}profile-cmp-${variant.key}`;
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  const out = openSync(`${PROBE}cmp-${variant.key}.out.log`, 'w');
  const err = openSync(`${PROBE}cmp-${variant.key}.err.log`, 'w');

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-gpu',
    '--window-size=1600,900',
    '--headless=new',
    'about:blank',
  ];
  if (variant.dir) args.splice(3, 0, `--load-extension=${variant.dir}`, `--disable-extensions-except=${variant.dir}`);

  const child = spawn(EDGE, args, { stdio: ['ignore', out, err], detached: false });
  closeSync(out);
  closeSync(err);

  const dl = Date.now() + 40000;
  let up = false;
  while (Date.now() < dl) {
    await sleep(300);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* wait */
    }
  }
  if (!up) {
    child.kill();
    return { variant, error: 'CDP 未就绪' };
  }
  // give extensions (especially those with large rulesets) time to initialise,
  // so no variant is disadvantaged
  await sleep(variant.dir ? 6000 : 1500);

  const perPage = [];
  for (const url of PAGES) {
    const created = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' },
    );
    const page = await created.json();
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url });
    await sleep(9000);

    const h = (await cdp.send('Runtime.evaluate', { expression: 'document.body.scrollHeight', returnByValue: true })).result?.value ?? 0;
    for (let y = 0; y < Math.min(h, 5000); y += 900) {
      await cdp.send('Runtime.evaluate', { expression: `scrollTo(0, ${y})` });
      await sleep(300);
    }
    await cdp.send('Runtime.evaluate', { expression: 'scrollTo(0, 0)' });
    await sleep(2500);

    const dom = (await cdp.send('Runtime.evaluate', { expression: DOM_PROBE, returnByValue: true })).result?.value;

    const sent = cdp.events['Network.requestWillBeSent'] ?? [];
    const failed = cdp.events['Network.loadingFailed'] ?? [];
    const blockedIds = new Set(failed.filter((e) => e.blockedReason).map((e) => e.requestId));
    const finished = cdp.events['Network.loadingFinished'] ?? [];
    const bytesById = new Map(finished.map((e) => [e.requestId, e.encodedDataLength ?? 0]));

    const all = sent.filter((e) => e.type !== 'Preflight');
    const adReqs = all.filter((e) => isAdUrl(e.request.url));
    const adBlocked = adReqs.filter((e) => blockedIds.has(e.requestId));
    const adServed = adReqs.filter((e) => !blockedIds.has(e.requestId));
    const adBytes = adServed.reduce((n, e) => n + (bytesById.get(e.requestId) ?? 0), 0);

    perPage.push({
      url,
      totalRequests: all.length,
      adRequests: adReqs.length,
      adBlocked: adBlocked.length,
      adServed: adServed.length,
      adBytes,
      adServedSamples: adServed.slice(0, 5).map((e) => e.request.url.slice(0, 70)),
      ...dom,
    });

    cdp.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`);
    await sleep(400);
  }

  child.kill();
  await sleep(800);
  rmSync(profile, { recursive: true, force: true });
  return { variant, perPage };
}

mkdirSync(PROBE, { recursive: true });

const results = [];
let port = 10001;
for (const v of VARIANTS) {
  port += 1;
  process.stdout.write(`测量 ${v.label} …`);
  const r = await measureVariant(v, port);
  results.push(r);
  console.log(r.error ? ` ${r.error}` : ` 完成（${r.perPage.length} 个页面）`);
}

writeFileSync(`${PROBE}compare-result.json`, JSON.stringify(results, null, 2), 'utf8');

// report
const host = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return u;
  }
};

console.log('\n=== 广告域请求：成功拿到响应的数量（越少越好）===');
console.log(
  '页面'.padEnd(34) +
    VARIANTS.map((v) => v.label.slice(0, 12).padStart(14)).join(''),
);
for (let i = 0; i < PAGES.length; i += 1) {
  const row = [host(PAGES[i]).slice(0, 32).padEnd(34)];
  for (const r of results) {
    const p = r.perPage?.[i];
    row.push((p ? `${p.adServed}/${p.adRequests}` : '—').padStart(14));
  }
  console.log(row.join(''));
}

console.log('\n=== 广告位残留（中立启发式，越少越好）===');
for (let i = 0; i < PAGES.length; i += 1) {
  const row = [host(PAGES[i]).slice(0, 32).padEnd(34)];
  for (const r of results) {
    const p = r.perPage?.[i];
    row.push((p ? String(p.adLikeVisible) : '—').padStart(14));
  }
  console.log(row.join(''));
}

console.log('\n=== 页面内容量：正文文字 / 可见链接（越高越好，用于看误伤）===');
for (let i = 0; i < PAGES.length; i += 1) {
  const row = [host(PAGES[i]).slice(0, 32).padEnd(34)];
  for (const r of results) {
    const p = r.perPage?.[i];
    row.push((p ? `${p.contentText}/${p.visibleLinks}` : '—').padStart(14));
  }
  console.log(row.join(''));
}

console.log('\n=== 合计 ===');
for (const r of results) {
  if (r.error) {
    console.log(`  ${r.variant.label.padEnd(22)} ${r.error}`);
    continue;
  }
  const t = r.perPage.reduce(
    (a, p) => ({
      adServed: a.adServed + p.adServed,
      adReq: a.adReq + p.adRequests,
      adLike: a.adLike + p.adLikeVisible,
      text: a.text + p.contentText,
      links: a.links + p.visibleLinks,
      bytes: a.bytes + p.adBytes,
    }),
    { adServed: 0, adReq: 0, adLike: 0, text: 0, links: 0, bytes: 0 },
  );
  console.log(
    `  ${r.variant.label.padEnd(22)} 广告请求成功 ${String(t.adServed).padStart(3)}/${String(t.adReq).padStart(3)}` +
      `  广告位残留 ${String(t.adLike).padStart(3)}` +
      `  正文文字 ${String(t.text).padStart(6)}  链接 ${String(t.links).padStart(4)}` +
      `  广告字节 ${(t.bytes / 1024).toFixed(0)} KB`,
  );
}
