/**
 * 试点站浏览器 E2E：CDP 驱动已装的 Edge，加载未打包扩展，对比基线与净化后。
 *
 * 前置：必须先 `pnpm build`（加载 dist/）。需要放宽沙箱权限——受限模式下
 * Chromium 的 Mojo 命名管道被拒，浏览器根本起不来：
 *   FATAL: mojo/public/cpp/platform/platform_channel.cc: Check failed: 拒绝访问 (0x5)
 *
 * 零依赖：只用 Node 24 内置的 fetch 与 WebSocket。
 *
 * 用法：node tools/e2e/run.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const URL_UNDER_TEST = process.argv[2] ?? 'https://afford.gjvrohros.cc/category/jrxw1/';
const EXT = fileURLToPath(new URL('../../dist', import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));

/** 广告基础设施：这些域名/路径的请求数在净化后必须为 0。 */
const AD_INFRA = [
  'apiad01.cc',
  'ads.zyudkkup.com',
  'api.zzlprxy.cc',
  'wj-api-abtest.yvyjdhr.com',
  '/ad-sdk-v',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('未找到 Edge/Chrome 可执行文件');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = {};
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
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (!msg.method) return;
      (client.events[msg.method] ??= []).push(msg.params);
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

async function listTargets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

/**
 * 轮询等待**我们扩展的** service worker 目标出现。
 *
 * 注意不能用「type==='service_worker' 且 chrome-extension:// 前缀」来筛：
 * Edge 自身就有一堆内置扩展 SW（实测会先命中的是 edgeCopilot / edgeAuthPrivate
 * 那一批），连上去读 declarativeNetRequest 只会得到 undefined。
 * 我们的 SW 由 manifest 指定为 background.js，用它当判别锚点。
 */
async function waitForServiceWorker(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let sawAny = 0;
  while (Date.now() < deadline) {
    const list = await listTargets(port);
    const all = list.filter(
      (t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'),
    );
    sawAny = Math.max(sawAny, all.length);
    const ours = all.find((t) => String(t.url).endsWith('background.js'));
    if (ours) return ours;
    await sleep(250);
  }
  return null;
}

/** 启动一次浏览器会话，可选择是否加载扩展。 */
async function launch({ port, profile, withExtension }) {
  mkdirSync(E2E_DIR, { recursive: true });
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const logFile = `${E2E_DIR}browser-${port}.log`;
  const errFile = `${E2E_DIR}browser-${port}.err.log`;
  const out = openSync(logFile, 'w');
  const err = openSync(errFile, 'w');

  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--window-size=1920,1080',
    '--headless=new',
  ];
  if (withExtension) args.push(`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`);
  args.push('about:blank');

  // stdio 用文件而不是管道：受限环境禁止管道，且这里也要能读到启动日志
  const child = spawn(findBrowser(), args, { stdio: ['ignore', out, err], detached: false });
  child.on('error', (e) => console.error('浏览器启动失败：', e.message));
  closeSync(out);
  closeSync(err);

  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        version = await res.json();
        break;
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!version) {
    child.kill();
    throw new Error(`CDP 端口 ${port} 未就绪（浏览器可能未能启动，见 _probe/e2e/ 日志）`);
  }

  return { child, version, logFile, errFile };
}

/** 连上扩展 SW，读它的控制台与 DNR 动态规则。 */
async function inspectServiceWorker(port) {
  const sw = await waitForServiceWorker(port);
  if (!sw) return { found: false, url: '', console: [], exceptions: [], rules: null, error: null };

  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await sleep(1500); // 让 onInstalled 的日志与规则同步落地

  let rules = null;
  let error = null;
  try {
    const r = await cdp.send('Runtime.evaluate', {
      expression: `chrome.declarativeNetRequest.getDynamicRules().then(rs => ({
        count: rs.length,
        filters: rs.map(x => x.condition.urlFilter).slice(0, 50),
      }))`,
      returnByValue: true,
      awaitPromise: true,
    });
    rules = r.result?.value ?? null;
    if (!rules) error = JSON.stringify(r).slice(0, 200);
  } catch (e) {
    error = e.message;
  }

  const info = {
    found: true,
    url: String(sw.url).replace(/^chrome-extension:\/\//, '').slice(0, 40),
    console: cdp.console,
    exceptions: cdp.exceptions,
    rules,
    error,
  };
  cdp.close();
  return info;
}

/** 打开页面，采集指标。 */
async function measure({ port, withExtension }) {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  );
  const list = await listTargets(port);
  const page = created.ok ? await created.json() : list.find((t) => t.type === 'page');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  await cdp.send('Page.navigate', { url: URL_UNDER_TEST });
  await sleep(10000); // 让广告 SDK、A/B 分流与懒加载跑完

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面求值异常');
    return r.result?.value;
  };

  const dom = await evaluate(`(() => {
    const visible = (el) => {
      if (el.hasAttribute('data-adblow-hidden')) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      return el.offsetParent !== null || s.position === 'fixed';
    };
    const articles = [...document.querySelectorAll('article[itemtype*="BlogPosting"]')];
    const slots = [...document.querySelectorAll('[data-ssp-slot-node]')];
    const thumbs = [...document.querySelectorAll('img[data-src*="upload_01"]')];
    const injected = [...document.querySelectorAll('[data-ssp-slot-root],[data-ssp-sdk-popup-overlay],[data-ssp-marquee],[data-ssp-landing]')];
    return {
      totalArticles: articles.length,
      visibleArticles: articles.filter(visible).length,
      totalSlots: slots.length,
      slotsWithAdContent: slots.filter((s) => s.childElementCount > 0).length,
      hiddenSlots: slots.filter((s) => s.hasAttribute('data-adblow-hidden')).length,
      thumbsLoaded: thumbs.filter((t) => t.complete && t.naturalWidth > 0).length,
      injectedNodesTotal: injected.length,
      injectedNodesVisible: injected.filter(visible).length,
      hasAdblowStyle: !!document.querySelector('style[data-adblow-cosmetic]'),
      adblowHiddenTotal: document.querySelectorAll('[data-adblow-hidden]').length,
    };
  })()`);

  const sent = cdp.events['Network.requestWillBeSent'] ?? [];
  const urlById = new Map(sent.map((e) => [e.requestId, e.request.url]));
  const requests = sent.map((e) => e.request.url);

  // ⚠️ 关键：Network.requestWillBeSent 在**拦截之前**就会触发，所以广告请求的
  // requestWillBeSent 数量永远不为 0（实测踩过这个坑）。真正要断言的是
  // 「成功拿到响应」的广告请求数为 0 —— 即发起数减去被扩展拦截的数。
  const blockedIds = new Set(
    (cdp.events['Network.loadingFailed'] ?? [])
      .filter((e) => e.blockedReason)
      .map((e) => e.requestId),
  );
  const succeeded = (e) => !blockedIds.has(e.requestId);

  const adSent = sent.filter((e) => AD_INFRA.some((p) => e.request.url.includes(p)));
  const adBlocked = adSent.filter((e) => blockedIds.has(e.requestId));
  const adServed = adSent.filter(succeeded);

  const blocked = blockedIds.size;

  const popups = (cdp.events['Target.targetCreated'] ?? []).filter(
    (e) => e.targetInfo?.type === 'page' && e.targetInfo?.url && e.targetInfo.url !== 'about:blank',
  ).length;

  const pageConsole = [...cdp.console];
  cdp.close();

  return {
    dom,
    requestCount: requests.length,
    adSent: adSent.length,
    adBlocked: adBlocked.length,
    adServed: adServed.length,
    adServedSamples: [...new Set(adServed.map((e) => e.request.url))],
    adBlockedSamples: [...new Set(adBlocked.map((e) => e.request.url))],
    /** 兼容旧字段名以便日志可读 */
    adRequests: adServed.length,
    blocked,
    popups,
    pageConsole,
  };
}

const results = [];
let failures = 0;

function check(name, ok, detail) {
  if (!ok) failures++;
  results.push({ name, ok, detail });
}

try {
  console.log(`被测地址：${URL_UNDER_TEST}`);
  console.log(`扩展目录：${EXT}\n`);

  // ── 基线：不加载扩展 ──────────────────────────────────────────
  console.log('【1/2】基线测量（不加载扩展）…');
  const base = await launch({ port: 9501, profile: `${E2E_DIR}profile-base`, withExtension: false });
  const baseline = await measure({ port: 9501, withExtension: false });
  base.child.kill();
  await sleep(1200);
  console.log(
    `  正文可见 ${baseline.dom.visibleArticles}/${baseline.dom.totalArticles}  ` +
      `广告位有内容 ${baseline.dom.slotsWithAdContent}/${baseline.dom.totalSlots}  ` +
      `广告请求成功 ${baseline.adServed}  缩略图 ${baseline.dom.thumbsLoaded}  ` +
      `注入节点 ${baseline.dom.injectedNodesTotal}\n`,
  );
  console.log(`  基线广告请求成功样本：\n    ${baseline.adServedSamples.join('\n    ') || '（无）'}\n`);

  // ── 净化后：加载扩展 ─────────────────────────────────────────
  console.log('【2/2】加载 AdBlow（dist/）后测量…');
  const filt = await launch({ port: 9502, profile: `${E2E_DIR}profile-ext`, withExtension: true });

  const swInfo = await inspectServiceWorker(9502);
  console.log(`  扩展 SW 目标：${swInfo.found ? `已找到 ${swInfo.url}` : '未找到'}`);
  if (swInfo.found) {
    console.log(
      `  DNR 动态规则：${swInfo.rules ? swInfo.rules.count + ' 条' : '读取失败: ' + swInfo.error}`,
    );
    if (swInfo.rules?.filters?.length) {
      console.log(`    过滤器：${swInfo.rules.filters.join(' | ')}`);
    }
    if (swInfo.console.length) console.log(`  SW 控制台：\n    ${swInfo.console.join('\n    ')}`);
    if (swInfo.exceptions.length) {
      console.log(`  SW 异常：\n    ${swInfo.exceptions.join('\n    ')}`);
    }
  }

  const filtered = await measure({ port: 9502, withExtension: true });
  filt.child.kill();
  await sleep(800);

  console.log(
    `\n  正文可见 ${filtered.dom.visibleArticles}/${filtered.dom.totalArticles}  ` +
      `广告位有内容 ${filtered.dom.slotsWithAdContent}/${filtered.dom.totalSlots}  ` +
      `（其中被隐藏 ${filtered.dom.hiddenSlots}）  ` +
      `广告请求成功 ${filtered.adServed}（发起 ${filtered.adSent}，被拦 ${filtered.adBlocked}）  ` +
      `缩略图 ${filtered.dom.thumbsLoaded}  ` +
      `注入节点 ${filtered.dom.injectedNodesVisible}/${filtered.dom.injectedNodesTotal} 可见  ` +
      `本站隐藏元素合计 ${filtered.dom.adblowHiddenTotal}\n`,
  );
  console.log(
    `  被拦下的广告请求：\n    ${filtered.adBlockedSamples.join('\n    ') || '（无）'}\n`,
  );
  if (filtered.pageConsole.length) {
    console.log(`  页面内 AdBlow 日志：\n    ${filtered.pageConsole.slice(0, 12).join('\n    ')}\n`);
  }

  // ── 断言 ─────────────────────────────────────────────────────
  check('扩展已加载（SW 存在）', swInfo.found, swInfo.found ? 'ok' : '未找到 SW 目标');
  check(
    'DNR 动态规则已同步',
    (swInfo.rules?.count ?? 0) > 0,
    swInfo.rules ? `${swInfo.rules.count} 条` : `读取失败（可能未注册该 API 作用域）：${swInfo.error}`,
  );
  check('内容脚本已注入', filtered.dom.hasAdblowStyle === true, String(filtered.dom.hasAdblowStyle));
  check(
    '广告基础设施请求成功数清零',
    filtered.adServed === 0,
    `基线 ${baseline.adServed} → 净化后 ${filtered.adServed}（发起 ${filtered.adSent}，拦截 ${filtered.adBlocked}）`,
  );
  check(
    '广告位不再渲染内容',
    filtered.dom.slotsWithAdContent === 0,
    `基线 ${baseline.dom.slotsWithAdContent} → ${filtered.dom.slotsWithAdContent}`,
  );
  check(
    '站内静态规则确实作用于服务端占位符',
    filtered.dom.hiddenSlots === filtered.dom.totalSlots && filtered.dom.totalSlots > 0,
    `隐藏 ${filtered.dom.hiddenSlots}/${filtered.dom.totalSlots}`,
  );
  check(
    '注入式覆盖层/跑马灯全部不可见',
    filtered.dom.injectedNodesVisible === 0,
    `${filtered.dom.injectedNodesVisible} 个可见`,
  );
  check(
    '误伤守卫：正文可见数量与基线一致',
    filtered.dom.visibleArticles === baseline.dom.visibleArticles,
    `基线 ${baseline.dom.visibleArticles} → 净化后 ${filtered.dom.visibleArticles}`,
  );
  check(
    '误伤守卫：正文缩略图仍能加载',
    filtered.dom.thumbsLoaded >= baseline.dom.thumbsLoaded && filtered.dom.thumbsLoaded > 0,
    `基线 ${baseline.dom.thumbsLoaded} → 净化后 ${filtered.dom.thumbsLoaded}`,
  );
  check('未产生弹窗', filtered.popups === 0, `${filtered.popups} 个新页面目标`);
} catch (error) {
  failures++;
  results.push({ name: 'E2E 执行', ok: false, detail: error.message });
}

console.log('─'.repeat(74));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `   (${r.detail})` : ''}`);
}
console.log('─'.repeat(74));
console.log(failures === 0 ? 'E2E 全部通过' : `E2E 失败 ${failures} 项`);
process.exit(failures === 0 ? 0 : 1);
