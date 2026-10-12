/**
 * 浏览器 E2E：CDP 驱动已装的 Edge，加载未打包扩展，对比基线与净化后。
 *
 * 前置：必须先 `pnpm build`（加载 dist/）。需要放宽沙箱权限——受限模式下
 * Chromium 的 Mojo 命名管道被拒，浏览器根本起不来：
 *   FATAL: mojo/public/cpp/platform/platform_channel.cc: Check failed: 拒绝访问 (0x5)
 *
 * 零依赖：只用 Node 24 内置的 fetch 与 WebSocket。
 *
 * ⚠️ 站点期望值是**逐站点手工取证后写死的**（PROFILES）。被验证的机制是通用的，
 * 但「哪些元素是广告」必须由取证决定，不能让脚本自己猜——否则就是拿被测代码
 * 验证被测代码。
 *
 * 用法：node tools/e2e/run.mjs [url]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const URL_UNDER_TEST = process.argv[2] ?? 'https://afford.gjvrohros.cc/category/jrxw1/';
const EXT = fileURLToPath(new URL('../../dist', import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));

/**
 * 逐站点期望值（手工取证）。
 *
 * - adSelectors：取证确认是广告的元素。净化后**必须全部不可见**；基线里**必须有可见的**，
 *   否则说明这个 profile 已经过期、断言失去意义。
 * - contentSelector：真内容。净化后可见数量必须与基线**完全一致**。
 * - contentImageSelector：真内容里的图片，净化后必须仍有可见的。
 * - adInfra：广告基础设施请求。净化后**成功响应数必须为 0**。可为空。
 */
const PROFILES = {
  'afford.gjvrohros.cc': {
    label: '试点站（自研 SSP，广告由 SDK 运行时注入）',
    adSelectors: [
      '[data-ssp-slot-node]',
      '[data-ssp-sdk-popup-overlay]',
      '[data-ssp-marquee]',
      '.xqbj-recommand-item-banner',
      '.xqbj-component-ssp-horizontal-banner-widget',
    ],
    contentSelector: 'article[itemtype*="BlogPosting"]',
    contentImageSelector: 'img[src*="pic.wvxrrip.cn"], img[data-src*="pic.wvxrrip.cn"]',
    adInfra: [
      'apiad01.cc',
      'ads.zyudkkup.com',
      'api.zzlprxy.cc',
      'wj-api-abtest.yvyjdhr.com',
      '/ad-sdk-v',
    ],
  },
  '1024cg.com': {
    label: '第二站点（服务端直接渲染广告，无规则包，全靠通用路径）',
    adSelectors: [
      'article.ad-item',
      'div.post-card[id^="ad-card-"]',
      '.ads-title',
      '.post-card-ads',
    ],
    contentSelector: 'article[itemtype*="BlogPosting"]',
    contentImageSelector: 'article[itemtype*="BlogPosting"] img',
    // 该站广告素材与正文缩略图共用同一 CDN（pic.jtzatly.cn），
    // 因此**没有**可安全拉黑的网络端点 —— 全靠 DOM 层。这正是要验证的点。
    adInfra: [],
  },
};

function profileFor(url) {
  const host = new URL(url).hostname;
  for (const [key, value] of Object.entries(PROFILES)) {
    if (host === key || host.endsWith(`.${key}`)) return { host, ...value };
  }
  throw new Error(`没有 ${host} 的取证 profile，无法断言。请先取证并加入 PROFILES。`);
}

const profile = profileFor(URL_UNDER_TEST);

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
 * 不能用「type==='service_worker' 且 chrome-extension:// 前缀」来筛：
 * Edge 自身就有一堆内置扩展 SW（实测先命中的是 edgeCopilot / edgeAuthPrivate
 * 那一批），连上去读 declarativeNetRequest 只会得到 undefined。
 * 我们的 SW 由 manifest 指定为 background.js，用它当判别锚点。
 */
async function waitForServiceWorker(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await listTargets(port);
    const ours = list
      .filter((t) => t.type === 'service_worker' && String(t.url).startsWith('chrome-extension://'))
      .find((t) => String(t.url).endsWith('background.js'));
    if (ours) return ours;
    await sleep(250);
  }
  return null;
}

async function launch({ port, profileDir, withExtension }) {
  mkdirSync(E2E_DIR, { recursive: true });
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  const out = openSync(`${E2E_DIR}browser-${port}.log`, 'w');
  const err = openSync(`${E2E_DIR}browser-${port}.err.log`, 'w');

  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${profileDir}`,
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
    throw new Error(`CDP 端口 ${port} 未就绪（见 _probe/e2e/ 日志）`);
  }
  return { child, version };
}

async function inspectServiceWorker(port) {
  const sw = await waitForServiceWorker(port);
  if (!sw) return { found: false, url: '', console: [], exceptions: [], rules: null, error: null };

  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await sleep(1500);

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
    url: String(sw.url).replace('chrome-extension://', '').slice(0, 44),
    console: cdp.console,
    exceptions: cdp.exceptions,
    rules,
    error,
  };
  cdp.close();
  return info;
}

async function measure({ port }) {
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

  // 站点偶发加载失败会伪装成「广告为零、正文为零」，从而误报成拦截失败。
  // 实测踩过一次（1024cg.com 首轮），所以这里显式重试一次。
  const countElements = async () => {
    const r = await evaluate('document.querySelectorAll("*").length');
    return typeof r === 'number' ? r : 0;
  };
  if ((await countElements()) < 100) {
    console.log('  （首次导航未加载出内容，重试一次…）');
    await cdp.send('Page.navigate', { url: URL_UNDER_TEST, transitionType: 'reload' });
    await sleep(11000);
  }

  const dom = await evaluate(`(() => {
    const visible = (el) => {
      if (el.hasAttribute('data-adblow-hidden')) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      return el.offsetParent !== null || s.position === 'fixed' || s.position === 'absolute';
    };
    const adSel = ${JSON.stringify(profile.adSelectors)};
    const ads = adSel.flatMap((s) => {
      try { return [...document.querySelectorAll(s)]; } catch { return []; }
    });
    const uniqAds = [...new Set(ads)];
    const contents = [...document.querySelectorAll(${JSON.stringify(profile.contentSelector)})];
    const cImgs = [...document.querySelectorAll(${JSON.stringify(profile.contentImageSelector)})];
    const hiddenAttr = (el) => el.hasAttribute('data-adblow-hidden') ||
      el.closest('[data-adblow-hidden]') !== null;
    return {
      adTotal: uniqAds.length,
      adVisible: uniqAds.filter(visible).length,
      adHiddenByUs: uniqAds.filter(hiddenAttr).length,
      contentTotal: contents.length,
      contentVisible: contents.filter(visible).length,
      contentHiddenByUs: contents.filter(hiddenAttr).length,
      contentImgsTotal: cImgs.length,
      contentImgsVisible: cImgs.filter(visible).length,
      contentImgsHiddenByUs: cImgs.filter(hiddenAttr).length,
      adblowHiddenTotal: document.querySelectorAll('[data-adblow-hidden]').length,
      hasAdblowStyle: !!document.querySelector('style[data-adblow-cosmetic]'),
    };
  })()`);

  const sent = cdp.events['Network.requestWillBeSent'] ?? [];
  const urlById = new Map(sent.map((e) => [e.requestId, e.request.url]));

  // ⚠️ requestWillBeSent 在拦截之前就触发，所以数量永远不为 0。
  // 真正要断言的是「成功拿到响应」的广告请求数为 0 = 发起数 − 被拦数。
  const allFailed = cdp.events['Network.loadingFailed'] ?? [];
  const blockedIds = new Set(allFailed.filter((e) => e.blockedReason).map((e) => e.requestId));
  const infra = sent.filter((e) => profile.adInfra.some((p) => e.request.url.includes(p)));
  const infraServed = infra.filter((e) => !blockedIds.has(e.requestId));

  const popups = (cdp.events['Target.targetCreated'] ?? []).filter(
    (e) => e.targetInfo?.type === 'page' && e.targetInfo?.url && e.targetInfo.url !== 'about:blank',
  ).length;

  // 导航诊断：站点 2 曾出现「0 个元素、内容脚本未注入」的情况，
  // 光看计数无法区分「页面没加载」与「选择器不对」，所以把原始事实带出来。
  const nav = await evaluate(`({
    href: location.href,
    title: document.title,
    ready: document.readyState,
    elementCount: document.querySelectorAll('*').length,
  })`);

  const failedRequests = allFailed
    .slice(0, 8)
    .map((e) => `${e.errorText ?? e.blockedReason ?? '?'} <- ${urlById.get(e.requestId) ?? e.requestId}`);

  const mainDoc = sent.find((e) => e.type === 'Document');

  const pageConsole = [...cdp.console];
  cdp.close();

  return {
    dom,
    nav,
    mainDocUrl: mainDoc?.request?.url ?? null,
    mainDocStatus: mainDoc ? (mainDoc.redirectResponse?.status ?? null) : null,
    failedRequests,
    infraSent: infra.length,
    infraBlocked: infra.length - infraServed.length,
    infraServed: infraServed.length,
    infraServedSamples: [...new Set(infraServed.map((e) => e.request.url))],
    blockedTotal: blockedIds.size,
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
  console.log(`站点画像：${profile.host} —— ${profile.label}`);
  console.log(`扩展目录：${EXT}\n`);

  console.log('【1/2】基线测量（不加载扩展）…');
  const base = await launch({
    port: 9501,
    profileDir: `${E2E_DIR}profile-base`,
    withExtension: false,
  });
  const baseline = await measure({ port: 9501 });
  base.child.kill();
  await sleep(1200);
  console.log(`  导航: ${baseline.nav?.href ?? '?'}  「${baseline.nav?.title ?? ''}」`);
  console.log(`  主文档: ${baseline.mainDocUrl ?? '(未捕获)'}`);
  if (baseline.failedRequests.length) {
    console.log(`  失败请求:\n    ${baseline.failedRequests.join('\n    ')}`);
  }
  console.log(
    `  广告元素 ${baseline.dom.adVisible}/${baseline.dom.adTotal} 可见  ` +
      `正文 ${baseline.dom.contentVisible}/${baseline.dom.contentTotal} 可见  ` +
      `正文图 ${baseline.dom.contentImgsVisible}/${baseline.dom.contentImgsTotal} 可见  ` +
      `广告请求成功 ${baseline.infraServed}\n`,
  );

  console.log('【2/2】加载 AdBlow（dist/）后测量…');
  const filt = await launch({
    port: 9502,
    profileDir: `${E2E_DIR}profile-ext`,
    withExtension: true,
  });
  const swInfo = await inspectServiceWorker(9502);
  console.log(`  扩展 SW：${swInfo.found ? swInfo.url : '未找到'}`);
  if (swInfo.found) {
    console.log(
      `  DNR 动态规则：${swInfo.rules ? swInfo.rules.count + ' 条' : '读取失败: ' + swInfo.error}`,
    );
    if (swInfo.console.length) console.log(`  SW 控制台：${swInfo.console.join(' | ')}`);
    if (swInfo.exceptions.length) console.log(`  SW 异常：${swInfo.exceptions.join(' | ')}`);
  }

  const filtered = await measure({ port: 9502 });
  filt.child.kill();
  await sleep(800);

  console.log(
    `\n  广告元素 ${filtered.dom.adVisible}/${filtered.dom.adTotal} 可见` +
      `（本站被隐藏元素合计 ${filtered.dom.adblowHiddenTotal}）\n` +
      `  正文 ${filtered.dom.contentVisible}/${filtered.dom.contentTotal} 可见  ` +
      `正文图 ${filtered.dom.contentImgsVisible}/${filtered.dom.contentImgsTotal} 可见  ` +
      `广告请求成功 ${filtered.infraServed}（发起 ${filtered.infraSent}，拦截 ${filtered.infraBlocked}）\n`,
  );
  const adblowLogs = filtered.pageConsole.filter((l) => l.includes('adblow'));
  if (adblowLogs.length) console.log(`  页面内 AdBlow 日志：\n    ${adblowLogs.join('\n    ')}\n`);

  // ── 断言 ─────────────────────────────────────────────────────
  check('扩展已加载（SW 存在）', swInfo.found, swInfo.found ? 'ok' : '未找到 SW 目标');
  check(
    'DNR 动态规则已同步',
    (swInfo.rules?.count ?? 0) > 0,
    swInfo.rules ? `${swInfo.rules.count} 条` : String(swInfo.error),
  );
  check('内容脚本已注入', filtered.dom.hasAdblowStyle === true, String(filtered.dom.hasAdblowStyle));

  check(
    '基线有效性：取证标记的广告在基线下确实可见',
    baseline.dom.adVisible > 0,
    `基线 ${baseline.dom.adVisible}/${baseline.dom.adTotal} 可见 —— 若为 0 说明画像已过期`,
  );
  check(
    '广告元素全部不可见',
    filtered.dom.adTotal > 0 && filtered.dom.adVisible === 0,
    `基线 ${baseline.dom.adVisible}/${baseline.dom.adTotal} → 净化后 ${filtered.dom.adVisible}/${filtered.dom.adTotal}`,
  );
  check(
    '误伤守卫：正文元素一个都没被我们隐藏',
    filtered.dom.contentTotal > 0 && filtered.dom.contentHiddenByUs === 0,
    `正文 ${filtered.dom.contentTotal} 个，被我们隐藏 ${filtered.dom.contentHiddenByUs} 个`,
  );
  check(
    '误伤守卫：正文全部可见（可见数 == 总数）',
    filtered.dom.contentVisible === filtered.dom.contentTotal && filtered.dom.contentTotal > 0,
    `${filtered.dom.contentVisible}/${filtered.dom.contentTotal}`,
  );
  check(
    '页面渲染量正常（防止把"页面只渲了一半"误判成成功）',
    filtered.dom.contentTotal >= baseline.dom.contentTotal * 0.5,
    `基线 ${baseline.dom.contentTotal} → 净化后 ${filtered.dom.contentTotal}`,
  );
  check(
    '误伤守卫：正文图片一个都没被我们隐藏',
    filtered.dom.contentImgsHiddenByUs === 0,
    `正文图 ${filtered.dom.contentImgsTotal} 个，被隐藏 ${filtered.dom.contentImgsHiddenByUs} 个`,
  );
  check(
    '误伤守卫：正文图片仍可见',
    filtered.dom.contentImgsTotal === 0 ||
      (filtered.dom.contentImgsVisible >= Math.min(baseline.dom.contentImgsVisible, filtered.dom.contentImgsTotal) &&
        filtered.dom.contentImgsVisible > 0),
    `基线 ${baseline.dom.contentImgsVisible}/${baseline.dom.contentImgsTotal} → 净化后 ${filtered.dom.contentImgsVisible}/${filtered.dom.contentImgsTotal}`,
  );
  check('未产生弹窗', filtered.popups === 0, `${filtered.popups} 个新页面目标`);

  if (profile.adInfra.length > 0) {
    check(
      '广告基础设施请求成功数清零',
      filtered.infraServed === 0,
      `基线 ${baseline.infraServed} → 净化后 ${filtered.infraServed}（拦截 ${filtered.infraBlocked}）`,
    );
  } else {
    results.push({
      name: '广告基础设施请求',
      ok: true,
      detail: '该站无可安全拉黑的网络端点（广告与正文共用 CDN），跳过 —— 全靠 DOM 层',
    });
  }
} catch (error) {
  failures++;
  results.push({ name: 'E2E 执行', ok: false, detail: error.message });
}

console.log('─'.repeat(78));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `   (${r.detail})` : ''}`);
}
console.log('─'.repeat(78));
console.log(
  failures === 0 ? `E2E 全部通过（${profile.host}）` : `E2E 失败 ${failures} 项（${profile.host}）`,
);
process.exit(failures === 0 ? 0 : 1);
