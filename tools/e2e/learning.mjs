// Browser verification of network-layer self-learning: visits the same site N
// times in one profile and checks whether "learned domains" graduate into DNR
// blocking rules.
// Needs relaxed sandbox permissions -- under confinement Chromium's Mojo named
// pipes are denied and the browser will not start.
// Run: node tools/e2e/learning.mjs <url> [visits]
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const URL_UNDER_TEST = process.argv[2] ?? 'https://1024cg.com';
const VISITS = Number(process.argv[3] ?? 3);
const PORT = 9601;
const EXT = fileURLToPath(new URL(`../../${process.env.ADBLOW_DIST ?? 'dist'}`, import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));
const PROFILE = `${E2E_DIR}profile-learning`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page diagnostic: recomputes every self-learning filter stage on the real
// page. Why: the first real run learned 0 domains while the same fixture learned
// fine in jsdom, and without per-stage numbers there is no telling "nothing was
// hidden" from "filtered as visible content" or "filtered as site-owned".
const DIAGNOSE_EXPRESSION = `(() => {
  const reg = (h) => { const p = h.split('.'); return p.length <= 2 ? h : p.slice(-2).join('.'); };
  const pageReg = reg(location.hostname);
  const isAbs = (u) => /^https?:/i.test(u) || u.startsWith('//');
  const RES = 'img,script,link,iframe,video,source,embed,object';
  const attrsOf = (el) => {
    const urls = [];
    if (el.matches(RES)) for (const a of ['src','data-src','href','poster','data']) {
      const v = el.getAttribute(a); if (v) urls.push(v);
    }
    return urls;
  };
  const domainsOf = (el, includeLinks) => {
    const out = new Set();
    const consider = (raw) => {
      if (!isAbs(raw)) return;
      let u; try { u = new URL(raw, location.href); } catch { return; }
      const r = reg(u.hostname);
      if (r && r !== pageReg) out.add(r);
    };
    for (const url of attrsOf(el)) consider(url);
    for (const c of el.querySelectorAll(RES)) for (const url of attrsOf(c)) consider(url);
    if (includeLinks) for (const a of el.querySelectorAll('a[href]')) {
      const v = a.getAttribute('href'); if (v) consider(v);
    }
    return [...out];
  };

  const hidden = [...document.querySelectorAll('[data-adblow-hidden]')];
  const adDomains = new Set();
  for (const el of hidden) for (const d of domainsOf(el, true)) adDomains.add(d);

  const visible = new Set();
  for (const el of document.querySelectorAll(RES)) {
    if (el.closest('[data-adblow-hidden]')) continue;
    for (const d of domainsOf(el, false)) visible.add(d);
  }

  const owned = new Set();
  const ownSel = 'link[rel~="canonical"],link[rel~="icon"],link[rel~="apple-touch-icon"],link[rel~="alternate"],meta[property="og:url"],meta[property="og:image"],meta[name="twitter:image"]';
  for (const n of document.querySelectorAll(ownSel)) {
    for (const raw of [n.getAttribute('href'), n.getAttribute('content')]) {
      if (!raw) continue;
      try { owned.add(reg(new URL(raw, location.href).hostname)); } catch {}
    }
  }

  const candidates = [...adDomains].filter((d) => !visible.has(d) && !owned.has(d));
  return {
    href: location.href,
    hasAdblowStyle: !!document.querySelector('style[data-adblow-cosmetic]'),
    hiddenCount: hidden.length,
    hiddenSample: hidden.slice(0, 6).map((e) => e.tagName.toLowerCase() + '.' + (e.getAttribute('class') || e.id || '')),
    adDomainCount: adDomains.size,
    adDomains: [...adDomains].slice(0, 15),
    visibleDomainCount: visible.size,
    visibleSample: [...visible].slice(0, 12),
    ownedDomains: [...owned],
    candidates: candidates.slice(0, 20),
  };
})()`;

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.console = [];
    this.exceptions = [];
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    const client = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && client.pending.has(msg.id)) {
        const { resolve, reject } = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        client.console.push(
          `${msg.params.type}: ${(msg.params.args ?? [])
            .map((a) => a.value ?? a.description ?? a.type)
            .join(' ')}`,
        );
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        client.exceptions.push(
          msg.params.exceptionDetails?.exception?.description ??
            msg.params.exceptionDetails?.text ??
            'unknown',
        );
      }
    });
    return client;
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

async function listTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function findServiceWorker(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ours = (await listTargets())
      .filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))
      .find((t) => String(t.url).endsWith('background.js'));
    if (ours) return ours;
    await sleep(250);
  }
  return null;
}

/** Read the current self-learning state from the SW. */
async function readLearning(swWsUrl) {
  const cdp = await Cdp.connect(swWsUrl);
  await cdp.send('Runtime.enable');
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const all = await chrome.storage.local.get(null);
      const domainKeys = Object.keys(all).filter(k => k.startsWith('adDomains:'));
      let entries = [];
      for (const k of domainKeys) {
        for (const e of Object.values(all[k] ?? {})) {
          entries.push({ page: k.slice('adDomains:'.length), host: e.host, hits: e.hits, promoted: e.promoted });
        }
      }
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const learnedRules = rules.filter(r => r.id >= 30000);
      return {
        entries,
        promoted: entries.filter(e => e.promoted).map(e => e.host).sort(),
        dnrTotal: rules.length,
        dnrLearned: learnedRules.length,
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  cdp.close();
  return r.result?.value ?? null;
}

let failures = 0;
const rows = [];
const imageRows = [];

try {
  mkdirSync(E2E_DIR, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome');

  const out = openSync(`${E2E_DIR}learning.log`, 'w');
  const err = openSync(`${E2E_DIR}learning.err.log`, 'w');
  const child = spawn(
    browser,
    [
      `--remote-debugging-port=${PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE}`,
      `--load-extension=${EXT}`,
      `--disable-extensions-except=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-gpu',
      '--headless=new',
      'about:blank',
    ],
    { stdio: ['ignore', out, err], detached: false },
  );
  closeSync(out);
  closeSync(err);

  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* not up yet */
    }
  }
  if (!up) throw new Error('CDP 未就绪');

  const sw = await findServiceWorker();
  if (!sw) throw new Error('未找到扩展 service worker');
  const swWs = sw.webSocketDebuggerUrl;

  // Navigation must wait until the extension is really ready (DNR rules synced).
  // Pitfall: navigating as soon as the SW appears, before onInstalled has run,
  // means the content script is never injected -- no elements hidden, no ready
  // log, not one learned domain -- and it is intermittent, so very hard to pin.
  const readyDeadline = Date.now() + 20000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    const probe = await readLearning(swWs);
    if (probe && probe.dnrTotal > 0) {
      ready = true;
      break;
    }
    await sleep(400);
  }
  if (!ready) console.log('  ⚠️ 扩展在 20s 内未完成规则同步，继续尝试（结果可能不可信）');
  else console.log('  扩展已就绪（DNR 规则已同步）\n');

  console.log(`站点：${URL_UNDER_TEST}`);
  console.log(`连续访问 ${VISITS} 次，观察域名自学习是否晋级为 DNR 规则\n`);

  for (let visit = 1; visit <= VISITS; visit++) {
    // Navigate the way run.mjs does: about:blank first, then Page.navigate with a
    // retry. Opening the target directly via /json/new?<url> is unreliable.
    const created = await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' },
    );
    const page = created.ok ? await created.json() : null;
    if (page) {
      const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', { url: URL_UNDER_TEST });
      // One content-script pass runs at DOMContentLoaded + 12s; closing the tab
      // before that loses a round of domain hits (measured as a 0-promoted miss).
      await sleep(15000);

      const countElements = async () => {
        const r = await cdp.send('Runtime.evaluate', {
          expression: 'document.querySelectorAll("*").length',
          returnByValue: true,
        });
        return typeof r.result?.value === 'number' ? r.result.value : 0;
      };
      if ((await countElements()) < 100) {
        console.log('  （首次导航未加载出内容，重试一次…）');
        await cdp.send('Page.navigate', { url: URL_UNDER_TEST, transitionType: 'reload' });
        await sleep(10000);
      }

      // dump the self-learning stage counters on the first visit
      let diagnostic = null;
      if (visit === 1) {
        const r = await cdp.send('Runtime.evaluate', {
          expression: DIAGNOSE_EXPRESSION,
          returnByValue: true,
        });
        diagnostic = r.result?.value ?? null;
        console.log('  首访诊断：', JSON.stringify(diagnostic, null, 2).replace(/\n/g, '\n  '));

        // A half-rendered (or unrendered) page masquerades as "nothing to learn"
        // (seen twice), so hiddenCount decides whether the visit counts; retry if not.
        if (diagnostic && diagnostic.hiddenCount === 0) {
          console.log('  ⚠️ 本次页面没有可隐藏的广告（可能未完整渲染），再等一轮重试…');
          await sleep(8000);
          const r2 = await cdp.send('Runtime.evaluate', {
            expression: DIAGNOSE_EXPRESSION,
            returnByValue: true,
          });
          diagnostic = r2.result?.value ?? diagnostic;
          console.log('  重试后诊断：', JSON.stringify(diagnostic, null, 2).replace(/\n/g, '\n  '));
        }
      }

      const adblowLogs = cdp.console.filter((l) => l.includes('adblow'));
      if (adblowLogs.length) console.log(`  页面 AdBlow 日志：\n    ${adblowLogs.join('\n    ')}`);
      if (cdp.exceptions.length) {
        console.log(`  ❗页面异常：\n    ${cdp.exceptions.join('\n    ')}`);
      }

      // Image health: the direct measure of "are images still fine after
      // learning". Learned network rules deliberately exclude image/media, so this
      // must not drop.
      const imgRes = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const imgs = [...document.querySelectorAll('img')];
          const hidden = (el) => el.hasAttribute('data-adblow-hidden') ||
            el.closest('[data-adblow-hidden]') !== null;
          const broken = imgs.filter(i => !(i.complete && i.naturalWidth > 0));
          return {
            total: imgs.length,
            loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
            hiddenByUs: imgs.filter(hidden).length,
            brokenSample: broken.slice(0, 5).map(i => (i.getAttribute('src') || i.getAttribute('data-src') || '').slice(0, 70)),
          };
        })()`,
        returnByValue: true,
      });
      const img = imgRes.result?.value;
      if (img) {
        imageRows.push(img);
        console.log(
          `  图片：加载成功 ${img.loaded}/${img.total}，被我们隐藏 ${img.hiddenByUs}` +
            (img.brokenSample.length ? `\n    未加载样本：\n      ${img.brokenSample.join('\n      ')}` : ''),
        );
      }

      cdp.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`);
    }
    await sleep(1500);

    const state = await readLearning(swWs);
    rows.push({ visit, ...state });
    console.log(
      `第 ${visit} 次访问：候选域名 ${state.entries.length} 个，` +
        `已晋级 ${state.promoted.length} 个，DNR 规则 ${state.dnrTotal} 条（其中自学习 ${state.dnrLearned} 条）`,
    );
    if (state.promoted.length) {
      console.log(`    已拦截域名：${state.promoted.slice(0, 8).join(', ')}${state.promoted.length > 8 ? ' …' : ''}`);
    }
  }

  child.kill();
  await sleep(800);

  console.log('\n' + '─'.repeat(70));
  const first = rows[0];
  const last = rows[rows.length - 1];

  const okEntries = last.entries.length > 0;
  const okPromoted = last.promoted.length > 0;
  const okRules = last.dnrLearned > 0 && last.dnrLearned >= first.dnrLearned;

  // Image health: images must not stop loading once domains are learned. Note it
  // does **not** assert "no image is hidden" -- hiding banner/popup creatives in
  // ad slots is correct, and that assertion caused false positives on two sites.
  // What matters is that images do not break.
  const firstImg = imageRows[0];
  const lastImg = imageRows[imageRows.length - 1];
  const okImagesLoaded =
    firstImg && lastImg
      ? lastImg.loaded >= Math.floor(firstImg.loaded * 0.9) && lastImg.loaded > 0
      : false;

  console.log(`${okEntries ? 'PASS' : 'FAIL'}  学到了候选广告域名   (${last.entries.length} 个)`);
  console.log(`${okPromoted ? 'PASS' : 'FAIL'}  域名晋级为持久拦截   (${last.promoted.length} 个)`);
  console.log(
    `${okRules ? 'PASS' : 'FAIL'}  自学习域名已注册为 DNR 规则   (${first.dnrLearned} → ${last.dnrLearned} 条)`,
  );
  console.log(
    `${okImagesLoaded ? 'PASS' : 'FAIL'}  ❗学会域名后图片仍正常加载   ` +
      `(${imageRows.map((r) => `${r.loaded}/${r.total}`).join(' → ')})`,
  );
  console.log(`  （被我们隐藏的图片是广告位素材，属预期：${lastImg ? lastImg.hiddenByUs : '?'} 张）`);
  console.log('─'.repeat(70));

  if (!okEntries || !okPromoted || !okRules || !okImagesLoaded) failures = 1;
  console.log(failures === 0 ? '网络层自学习验证通过（且未损伤图片）' : '网络层自学习验证失败');
} catch (error) {
  failures = 1;
  console.log(`\n执行失败：${error.message}`);
}

process.exit(failures === 0 ? 0 : 1);
