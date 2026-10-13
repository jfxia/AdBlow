/**
 * 诊断：用户浏览器里累积的自学习**选择器**是否在隐藏图片。
 *
 * 为什么需要：此前所有 E2E 都用全新 profile，没有累积的学习结果，
 * 因此「学到的选择器把图片藏了」这类问题在测试里永远不出现。
 * 本脚本连续访问若干次以累积学习结果，然后检查每条晋级选择器会命中多少张图片。
 *
 * 用法：node tools/e2e/diagnose-selectors.mjs <url> [visits]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const URL_UNDER_TEST = process.argv[2] ?? 'https://1024cg.com';
const VISITS = Number(process.argv[3] ?? 5);
const PORT = 9701;
const EXT = fileURLToPath(new URL(`../../${process.env.ADBLOW_DIST ?? 'dist'}`, import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));
const PROFILE = `${E2E_DIR}profile-diag`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
  }
  static async connect(wsUrl, attempts = 4) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await Cdp.connectOnce(wsUrl);
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastError ?? new Error('ws');
  }

  static async connectOnce(wsUrl) {
    const ws = new WebSocket(wsUrl);
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
      }
    });
    return c;
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

const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());

async function findSw() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ours = (await list())
      .filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))
      .find((t) => String(t.url).endsWith('background.js'));
    if (ours) return ours;
    await sleep(300);
  }
  return null;
}

async function readState(swWs) {
  const cdp = await Cdp.connect(swWs);
  await cdp.send('Runtime.enable');
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const all = await chrome.storage.local.get(null);
      const learned = {};
      const domains = [];
      for (const [k, v] of Object.entries(all)) {
        if (k.startsWith('learned:')) learned[k.slice(8)] = v;
        if (k.startsWith('adDomains:')) for (const e of Object.values(v ?? {})) {
          if (e.promoted) domains.push(e.host);
        }
      }
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      return {
        learned,
        promotedDomains: [...new Set(domains)].sort(),
        dnrTotal: rules.length,
        dnrLearned: rules.filter(r => r.id >= 30000).length,
        dnrLearnedTypes: [...new Set(rules.filter(r => r.id >= 30000).flatMap(r => r.condition.resourceTypes))].sort(),
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  cdp.close();
  return r.result?.value;
}

/** 在页面上检查每条晋级选择器会命中多少图片、以及那些图片是不是正文图。 */
const SELECTOR_IMPACT = (selectors) => `(() => {
  const sel = ${JSON.stringify(selectors)};
  const imgs = [...document.querySelectorAll('img')];
  const out = [];
  for (const s of sel) {
    let matchedImgs = 0;
    let matchedEls = 0;
    let hiddenNow = 0;
    try {
      const els = [...document.querySelectorAll(s)];
      matchedEls = els.length;
      for (const el of els) {
        matchedImgs += el.querySelectorAll('img').length + (el.tagName === 'IMG' ? 1 : 0);
      }
      matchedImgs = Math.min(matchedImgs, imgs.length);
      hiddenNow = imgs.filter((i) => i.closest(s) !== null).length;
    } catch (e) { /* 非法选择器 */ }
    out.push({ selector: s, matchedEls, imgsInside: hiddenNow });
  }
  return {
    totalImgs: imgs.length,
    loadedImgs: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
    hiddenImgs: imgs.filter((i) => i.closest('[data-adblow-hidden]') !== null).length,
    impact: out,
  };
})()`;

let failures = 0;
try {
  mkdirSync(E2E_DIR, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  mkdirSync(PROFILE, { recursive: true });

  const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!browser) throw new Error('未找到 Edge');

  const out = openSync(`${E2E_DIR}diag.log`, 'w');
  const err = openSync(`${E2E_DIR}diag.err.log`, 'w');
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
      if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) { up = true; break; }
    } catch { /* waiting */ }
  }
  if (!up) throw new Error('CDP 未就绪');

  const sw = await findSw();
  if (!sw) throw new Error('未找到扩展 SW');
  const swWs = sw.webSocketDebuggerUrl;

  // 不要在这里反复读写 SW（会反复建连，SW 休眠时容易失败）。
  // 等目标出现后再连一次，并带重试。
  await sleep(2500);
  let ready = false;
  for (let i = 0; i < 10 && !ready; i++) {
    try {
      const s = await readState(swWs);
      if (s && s.dnrTotal > 0) ready = true;
    } catch {
      /* 重试 */
    }
    if (!ready) await sleep(600);
  }
  console.log(ready ? '扩展已就绪\n' : '⚠️ 未确认扩展就绪，继续尝试\n');

  let lastState = null;
  for (let v = 1; v <= VISITS; v++) {
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
      await sleep(9000);
      cdp.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${page.id}`);
    }
    await sleep(1200);
    lastState = await readState(swWs);
    const promoted = Object.values(lastState.learned ?? {})
      .flatMap((m) => Object.values(m ?? {}))
      .filter((e) => e.promoted)
      .map((e) => e.selector);
    console.log(
      `第 ${v} 次：晋级选择器 ${promoted.length} 条 ${JSON.stringify(promoted)}，` +
        `已拦截域名 ${lastState.promotedDomains.length} 个，DNR ${lastState.dnrTotal} 条`,
    );
  }

  console.log(`\n自学习 DNR 规则用到的资源类型：${JSON.stringify(lastState.dnrLearnedTypes)}`);

  // 最后再开一页，检查每条晋级选择器的图片影响
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
    await sleep(9000);

    const promoted = Object.values(lastState.learned ?? {})
      .flatMap((m) => Object.values(m ?? {}))
      .filter((e) => e.promoted)
      .map((e) => e.selector);

    const r = await cdp.send('Runtime.evaluate', {
      expression: SELECTOR_IMPACT(promoted),
      returnByValue: true,
    });
    const impact = r.result?.value;
    console.log('\n=== 晋级选择器对图片的影响（最后一页）===');
    console.log(`  页面图片 ${impact.totalImgs} 张，加载成功 ${impact.loadedImgs}，被隐藏 ${impact.hiddenImgs}`);
    for (const row of impact.impact) {
      const flag = row.imgsInside > 0 ? '  （命中图片，需看下面是否属于广告位）' : '';
      console.log(`  ${row.selector.padEnd(34)} 匹配元素 ${String(row.matchedEls).padStart(3)}，其中含图片 ${row.imgsInside}${flag}`);
    }

    // 被隐藏图片的来源与归属 + **内容卡片与其背景图是否还在**。
    // 关键认知：该站的内容缩略图不是 <img>，而是设在帖子卡片上的 CSS 背景图
    // （与试点站 loadBannerDirect 同一手法）。用户说的「图片不显示」，
    // 实际是内容卡片被自学习出的 .post-card 规则整片隐藏。
    const detail = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const hiddenOf = (el) => el.closest('[data-adblow-hidden]') !== null;
        const chain = (el) => { const p=[]; let n=el.parentElement;
          for (let i=0;i<3&&n;i++){const c=n.getAttribute('class')||'';const id=n.getAttribute('id')||'';
          p.push(n.tagName.toLowerCase()+(id?'#'+id:'')+(c?'.'+c.trim().split(/\\s+/).slice(0,2).join('.'):''));n=n.parentElement;}
          return p.join(' < '); };

        const imgs = [...document.querySelectorAll('img')];
        const hiddenImgs = imgs.filter(hiddenOf);

        // 内容卡片：服务端渲染的帖子卡片（id 前缀 post-card-），缩略图是它的背景图
        const cards = [...document.querySelectorAll('div.post-card[id^="post-card-"]')];
        const cardBg = (el) => {
          try { return getComputedStyle(el).backgroundImage || 'none'; } catch { return 'none'; }
        };

        return {
          imgTotal: imgs.length,
          imgLoaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
          imgHidden: hiddenImgs.length,
          imgHiddenSamples: hiddenImgs.slice(0, 6).map(i => ({
            src: (i.getAttribute('src') || i.getAttribute('data-src') || '').slice(-48),
            chain: chain(i),
          })),
          cardTotal: cards.length,
          cardVisible: cards.filter(c => !hiddenOf(c)).length,
          cardHidden: cards.filter(hiddenOf).length,
          cardWithBg: cards.filter(c => {
            const bg = cardBg(c);
            return bg && bg !== 'none' && !/url\\(["']?\\s*\\)/.test(bg);
          }).length,
          cardVisibleWithBg: cards.filter(c => !hiddenOf(c) && cardBg(c) !== 'none').length,
          hiddenCardSamples: cards.filter(hiddenOf).slice(0, 4).map(c => chain(c)),
        };
      })()`,
      returnByValue: true,
    });
    const d = detail.result?.value;
    console.log('\n=== 被隐藏图片的来源与归属 ===');
    console.log(`  页面 <img> ${d?.imgTotal} 张，加载成功 ${d?.imgLoaded}，被隐藏 ${d?.imgHidden}`);
    for (const s of d?.imgHiddenSamples ?? []) {
      console.log(`  ${s.src}\n      @ ${s.chain}`);
    }
    console.log('\n=== 内容卡片（缩略图是卡片的 CSS 背景图）===');
    console.log(
      `  共 ${d?.cardTotal} 张，可见 ${d?.cardVisible}，被隐藏 ${d?.cardHidden}；` +
        `带背景图的可见卡片 ${d?.cardVisibleWithBg}`,
    );
    for (const s of d?.hiddenCardSamples ?? []) {
      console.log(`  ⚠️ 被隐藏的卡片 @ ${s}`);
    }

    const badCards = (d?.cardHidden ?? 0) > 0;
    if (badCards) {
      failures = 1;
      console.log(`\n❗ ${d.cardHidden} 张内容卡片被隐藏 —— 这正是用户看到「图片不显示」的原因`);
    } else {
      console.log('\n✅ 内容卡片一张都没被隐藏，卡片背景图（缩略图）完好');
    }
    cdp.close();
  }

  child.kill();
} catch (e) {
  failures = 1;
  console.log(`执行失败：${e.message}`);
}
process.exit(failures === 0 ? 0 : 1);
