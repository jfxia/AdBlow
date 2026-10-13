// Browser verification of clickjacking interception.
// No argument: a local HTTP server with fixtures for three real clickjacking
// techniques -- baseline first (no extension, proving the fixtures do navigate
// away), then with the extension, which must block all three.
// With a URL: the same "does a click navigate away" check, baseline included.
// Clicks go through CDP Input.dispatchMouseEvent, so they are trusted
// (isTrusted === true) and equal real user clicks; JS events do not reproduce it.
// Run: node tools/e2e/clickjack.mjs [url]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const EXT = fileURLToPath(new URL(`../../${process.env.ADBLOW_DIST ?? 'dist'}`, import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));
const EXT_PORT = 9811;
const LAND_PORT = 9812;
const TARGET_URL = process.argv[2] ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LAND = `http://localhost:${LAND_PORT}/landed`;

const PAGES = {
  '/landed': `<!doctype html><html><head><title>LANDED-AD-PAGE</title></head>
<body><h1 id="landed">你被带到广告页了</h1></body></html>`,

  // invisible full-screen layer: every click lands on it (the classic technique)
  '/overlay': `<!doctype html><html><head><title>hijack-overlay</title>
<style>body{margin:0;font:16px sans-serif}#content{padding:60px}</style></head>
<body>
<div id="content"><h1>正常内容</h1><p>点这里不应该跳走</p><button id="btn">按钮</button></div>
<a id="hijack" href="${LAND}"
   style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;opacity:0"></a>
</body></html>`,

  // document-level capture handler rewrites location directly
  '/capture': `<!doctype html><html><head><title>hijack-capture</title>
<style>body{margin:0;font:16px sans-serif}#content{padding:60px}</style></head>
<body>
<div id="content"><h1>正常内容</h1><p>点这里不应该跳走</p><button id="btn">按钮</button></div>
<script>
document.addEventListener('click', function () { location.href = ${JSON.stringify(LAND)}; }, true);
</script>
</body></html>`,

  // script synthesises a hidden cross-site <a> and clicks it (isTrusted === false)
  '/synthetic': `<!doctype html><html><head><title>hijack-synthetic</title>
<style>body{margin:0;font:16px sans-serif}#content{padding:60px}</style></head>
<body>
<div id="content"><h1>正常内容</h1><p>点这里不应该跳走</p><button id="btn">按钮</button></div>
<script>
document.addEventListener('click', function () {
  var a = document.createElement('a');
  a.href = ${JSON.stringify(LAND)};
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
});
</script>
</body></html>`,
};

const VARIANTS = ['/overlay', '/capture', '/synthetic'];

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    this.console = [];
  }
  static async connect(wsUrl, attempts = 4) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await Cdp.connectOnce(wsUrl);
      } catch (e) {
        last = e;
        await sleep(400);
      }
    }
    throw last ?? new Error('ws');
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
        return;
      }
      if (m.method) {
        c.events.push(m);
        if (m.method === 'Runtime.consoleAPICalled') {
          c.console.push(
            (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '),
          );
        }
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

const list = (port) => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());

async function launch({ port, profileDir, withExtension }) {
  mkdirSync(E2E_DIR, { recursive: true });
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  const out = openSync(`${E2E_DIR}cj-${port}.log`, 'w');
  const err = openSync(`${E2E_DIR}cj-${port}.err.log`, 'w');
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-gpu',
    '--window-size=1280,900',
    '--headless=new',
  ];
  if (withExtension) args.push(`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`);
  args.push('about:blank');

  const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!browser) throw new Error('未找到 Edge');
  const child = spawn(browser, args, { stdio: ['ignore', out, err], detached: false });
  closeSync(out);
  closeSync(err);

  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* waiting */
    }
  }
  if (!up) {
    child.kill();
    throw new Error(`CDP ${port} 未就绪`);
  }
  return child;
}

async function waitForExtension(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const sw = (await list(port))
      .filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))
      .find((t) => String(t.url).endsWith('background.js'));
    if (sw) {
      await sleep(2500);
      return true;
    }
    await sleep(300);
  }
  return false;
}

/** Open a page and run the click test; returns the result. */
async function clickTest({ port, url, label }) {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  );
  const page = created.ok ? await created.json() : null;
  if (!page) return { label, navigated: null, error: '无法创建页面' };

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Page.navigate', { url });
  await sleep(8000);

  const targetsBefore = (await list(port)).length;

  // dispatch trusted clicks at several points on the page
  const points = [
    { x: 640, y: 300 },
    { x: 200, y: 120 },
    { x: 1000, y: 700 },
  ];
  for (const p of points) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await sleep(700);
  }
  await sleep(2500);

  const finalUrl = (await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }))
    .result?.value;
  const targetsAfter = (await list(port)).length;
  const blockedLogs = cdp.console.filter(
    (l) => l.includes('[adblow] 已拦截'),
  );

  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${page.id}`);

  return {
    label,
    startUrl: url,
    finalUrl,
    navigated: finalUrl !== url,
    newTargets: targetsAfter - targetsBefore,
    blockedLogs,
  };
}

let failures = 0;
const rows = [];
let servers = [];

try {
  if (!TARGET_URL) {
    // local fixture mode
    const ext = createServer((req, res) => {
      const body = PAGES[req.url ?? ''] ?? '<!doctype html><title>404</title>404';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    await new Promise((r) => ext.listen(EXT_PORT, '127.0.0.1', r));
    const land = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES['/landed']);
    });
    await new Promise((r) => land.listen(LAND_PORT, '127.0.0.1', r));
    servers = [ext, land];
    console.log(`本地夹具已启动：http://127.0.0.1:${EXT_PORT}/  广告落地页：${LAND}\n`);

    // baseline: no extension -- navigation must reproduce, else the test is void
    const baseBrowser = await launch({
      port: 9801,
      profileDir: `${E2E_DIR}cj-base`,
      withExtension: false,
    });
    for (const v of VARIANTS) {
      const r = await clickTest({
        port: 9801,
        url: `http://127.0.0.1:${EXT_PORT}${v}`,
        label: `基线 ${v}`,
      });
      rows.push({ ...r, phase: 'baseline' });
      console.log(`  基线 ${v.padEnd(11)} 点击后跳转：${r.navigated ? '是（符合预期）' : '否 ⚠️ 夹具无效'} → ${r.finalUrl}`);
    }
    baseBrowser.kill();
    await sleep(1000);

    // with the extension: all three must be blocked
    const extBrowser = await launch({
      port: 9802,
      profileDir: `${E2E_DIR}cj-ext`,
      withExtension: true,
    });
    const ready = await waitForExtension(9802);
    console.log(`\n  扩展就绪：${ready ? '是' : '否'}`);
    for (const v of VARIANTS) {
      const r = await clickTest({
        port: 9802,
        url: `http://127.0.0.1:${EXT_PORT}${v}`,
        label: `装扩展 ${v}`,
      });
      rows.push({ ...r, phase: 'extension' });
      console.log(
        `  装扩展 ${v.padEnd(11)} 点击后跳转：${r.navigated ? '❗是（未拦住）' : '否'} ` +
          `新开标签 ${r.newTargets}｜拦截 ${r.blockedLogs.length} 次 → ${r.finalUrl}`,
      );
      if (r.blockedLogs.length) console.log(`      ${r.blockedLogs.slice(0, 2).join(' | ')}`);
    }
    extBrowser.kill();
  } else {
    // Site mode: run the baseline (no extension) first, otherwise "it did not
    // navigate" may just mean this site never navigates here -- not proof.
    const baseBrowser = await launch({
      port: 9803,
      profileDir: `${E2E_DIR}cj-site-base`,
      withExtension: false,
    });
    const baseResult = await clickTest({ port: 9803, url: TARGET_URL, label: `基线 ${TARGET_URL}` });
    rows.push({ ...baseResult, phase: 'baseline' });
    console.log(
      `  基线（不装扩展）   点击后跳转：${baseResult.navigated ? '是' : '否'}｜新开标签 ${baseResult.newTargets} → ${baseResult.finalUrl}`,
    );
    baseBrowser.kill();
    await sleep(1200);

    const browser = await launch({
      port: 9804,
      profileDir: `${E2E_DIR}cj-site-ext`,
      withExtension: true,
    });
    await waitForExtension(9804);
    const r = await clickTest({ port: 9804, url: TARGET_URL, label: TARGET_URL });
    rows.push({ ...r, phase: 'extension' });
    console.log(
      `  装扩展后           点击后跳转：${r.navigated ? '❗是' : '否'}｜新开标签 ${r.newTargets} → ${r.finalUrl}`,
    );
    if (r.blockedLogs.length) console.log(`  拦截记录：${r.blockedLogs.slice(0, 4).join(' | ')}`);
    browser.kill();
  }

  console.log('\n' + '─'.repeat(72));
  const baseline = rows.filter((r) => r.phase === 'baseline');
  const withExt = rows.filter((r) => r.phase === 'extension' || r.phase === 'site');

  if (baseline.length) {
    const repro = baseline.filter((r) => r.navigated).length;
    if (TARGET_URL) {
      // Real site: a non-reproducing baseline only means "this environment cannot
      // trigger it", which says nothing about the extension, so report SKIP rather
      // than a failure -- it is not the extension's fault.
      if (repro === 0) {
        console.log(
          `SKIP  基线未复现点击劫持   (0/${baseline.length} —— 该站点在此测试环境下不触发，` +
            '无法据此判断扩展是否起了作用)',
        );
      } else {
        console.log(`PASS  基线能复现点击劫持   (${repro}/${baseline.length})`);
      }
    } else {
      // local fixtures: the baseline must reproduce, else the fixture is void
      const ok = repro === baseline.length;
      if (!ok) failures = 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  夹具能复现点击劫持   (${repro}/${baseline.length} 个变体跳转)`);
    }
  }

  const stillNavigating = withExt.filter((r) => r.navigated);
  const ok2 = withExt.length > 0 && stillNavigating.length === 0;
  if (!ok2) failures = 1;
  console.log(
    `${ok2 ? 'PASS' : 'FAIL'}  装扩展后点击不再跳走   ` +
      `(${withExt.length - stillNavigating.length}/${withExt.length} 被拦住` +
      (stillNavigating.length ? `；仍跳走：${stillNavigating.map((r) => r.label).join(', ')}` : '') +
      ')',
  );

  const newTabs = withExt.reduce((n, r) => n + Math.max(0, r.newTargets), 0);
  const ok3 = newTabs === 0;
  if (!ok3) failures = 1;
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  没有因此开新标签   (${newTabs} 个)`);
  console.log('─'.repeat(72));
  console.log(failures === 0 ? '点击劫持拦截验证通过' : '点击劫持拦截验证失败');
} catch (e) {
  failures = 1;
  console.log(`执行失败：${e.message}`);
} finally {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}
process.exit(failures === 0 ? 0 : 1);
