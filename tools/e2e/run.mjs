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
      // 服务端渲染的横幅广告位。
      // 注意不要把 `a.tjtagmanager` 也列成广告位：它是站点的**外链追踪包装**，
      // 既包横幅广告也可能包别的东西，要求它 100% 被隐藏属于过度指定
      // （实测因此误报过 1/107）。广告位的判定应该落在真正的容器上。
      'div.horizontal-banner',
      // 弹窗广告（实测从被隐藏图片的祖先链里发现的真实结构：
      // div.ad.popup-container > popup-content > popup-picture / popup-close
      // 关闭按钮图 /usr/themes/ads-close.png 也印证了它是广告弹窗）
      '.popup-container',
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
  // 实测踩过多次（1024cg 首轮、试点站某一轮），所以这里显式重试一次。
  // 判据要同时看「元素数」和「正文数」：有一次元素数够但没有正文，
  // 单看元素数不会触发重试。
  const probe = async () => {
    const r = await evaluate(`({
      elements: document.querySelectorAll('*').length,
      content: document.querySelectorAll(${JSON.stringify(profile.contentSelector)}).length,
    })`);
    return r && typeof r.elements === 'number' ? r : { elements: 0, content: 0 };
  };
  let seen = await probe();
  if (seen.elements < 100 || seen.content === 0) {
    console.log(`  （首次导航未渲染出正文：元素 ${seen.elements}、正文 ${seen.content}，重试一次…）`);
    await cdp.send('Page.navigate', { url: URL_UNDER_TEST, transitionType: 'reload' });
    await sleep(11000);
  }

  // 等页面渲染稳定：站点响应会波动（连续访问尤其明显），
  // 若在图片还没加载完时测量，「图片加载数」会剧烈跳动并造成误报。
  const settled = await evaluate(`(async () => {
    const loaded = () => [...document.querySelectorAll('img')]
      .filter((i) => i.complete && i.naturalWidth > 0).length;
    let last = -1;
    let stable = 0;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const now = loaded();
      if (now === last) stable += 1; else stable = 0;
      last = now;
      if (stable >= 3 && document.readyState === 'complete') break;
    }
    return { loaded: last, readyState: document.readyState };
  })()`);
  if (settled && settled.loaded === 0) {
    console.log('  （等待后仍无图片加载完成，可能是站点响应慢）');
  }

  const dom = await evaluate(`(() => {
    /**
     * 是否真的可见。
     *
     * ⚠️ 必须沿祖先链检查 display/visibility。早先只检查元素自身，于是
     * 「位于已被隐藏容器内部、且自身是 fixed/absolute」的元素会被误判为可见
     * （因为它们的 offsetParent 本来就是 null）—— 实测因此误报过
     * 「广告内容仍可见」。
     */
    const visible = (el) => {
      if (el.closest('[data-adblow-hidden]') !== null) return false;
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
      }
      return true;
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

    // ⚠️ 站点无关的图片守卫（不依赖任何选择器）。
    // 起因：曾经用 'article[...] img' 作正文图选择器，而 1024cg 的图片根本不在
    // article 里 → 匹配数为 0 → 断言被 total===0 跳过 → 等于没测，
    // 结果自学习把内容图 CDN 拦掉、「所有图片都不显示」这类事故没被拦住。
    const imgs = [...document.querySelectorAll('img')];
    const chain = (el) => {
      const parts = [];
      let p = el.parentElement;
      for (let i = 0; i < 4 && p; i++) {
        const cls = p.getAttribute('class') ?? '';
        const id = p.getAttribute('id') ?? '';
        parts.push(p.tagName.toLowerCase() + (id ? '#' + id : '') +
          (cls ? '.' + cls.trim().split(/\s+/).slice(0, 2).join('.') : ''));
        p = p.parentElement;
      }
      return parts.join(' < ');
    };
    const hiddenImgs = imgs.filter(hiddenAttr);
    const inAd = (el) => adSel.some((s) => {
      try { return el.closest(s) !== null; } catch { return false; }
    });
    const hiddenOutsideAds = hiddenImgs.filter((i) => !inAd(i));

    /** 广告位里**还显示着东西**吗：有可见文字，或有加载成功的图片。 */
    const showsSomething = (el) => {
      if (!visible(el)) return false;
      if ((el.innerText ?? '').trim().length > 0) return true;
      return [...el.querySelectorAll('img')].some(
        (i) => visible(i) && i.complete && i.naturalWidth > 0,
      );
    };
    const visibleAds = uniqAds.filter(visible);
    const visibleAdsWithContent = visibleAds.filter(showsSomething);
    return {
      adTotal: uniqAds.length,
      adVisible: visibleAds.length,
      adVisibleWithContent: visibleAdsWithContent.length,
      emptyAdShells: visibleAds.length - visibleAdsWithContent.length,
      visibleAdSamples: visibleAdsWithContent.slice(0, 5).map((el) => ({
        sel: adSel.find((s) => {
          try { return el.matches(s); } catch { return false; }
        }),
        cls: (el.getAttribute('class') ?? '').slice(0, 40),
        chain: chain(el),
      })),
      adHiddenByUs: uniqAds.filter(hiddenAttr).length,
      contentTotal: contents.length,
      contentVisible: contents.filter(visible).length,
      contentHiddenByUs: contents.filter(hiddenAttr).length,
      contentImgsTotal: cImgs.length,
      contentImgsVisible: cImgs.filter(visible).length,
      contentImgsHiddenByUs: cImgs.filter(hiddenAttr).length,
      imagesTotal: imgs.length,
      imagesLoaded: imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
      imagesHiddenByUs: hiddenImgs.length,
      imagesHiddenOutsideAds: hiddenOutsideAds.length,
      imagesHiddenOutsideAdSamples: hiddenOutsideAds.slice(0, 6).map((i) => ({
        src: (i.getAttribute('src') ?? i.getAttribute('data-src') ?? '').slice(-46),
        chain: chain(i),
      })),
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

  /**
   * 被拦掉的图片请求数。
   *
   * 这是「整站图片不显示」这类事故的直接度量：它不该发生 ——
   * 自学习来的网络规则刻意不含 image/media 类型。
   */
  const imageSent = sent.filter((e) => (e.type ?? '').toLowerCase() === 'image');
  const imageBlocked = imageSent.filter((e) => blockedIds.has(e.requestId));

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
    imageSent: imageSent.length,
    imageBlocked: imageBlocked.length,
    imageBlockedSamples: [...new Set(imageBlocked.map((e) => e.request.url))].slice(0, 5),
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
    '广告内容全部不可见',
    filtered.dom.adTotal > 0 && filtered.dom.adVisibleWithContent === 0,
    `基线 ${baseline.dom.adVisibleWithContent}/${baseline.dom.adTotal} 有内容可见 → ` +
      `净化后 ${filtered.dom.adVisibleWithContent}/${filtered.dom.adTotal}` +
      (filtered.dom.emptyAdShells > 0
        ? `（另有 ${filtered.dom.emptyAdShells} 个不影响观感的空壳容器未隐藏：无文字、无已加载图片）`
        : '') +
      (filtered.dom.visibleAdSamples.length
        ? ` —— 仍可见内容：${filtered.dom.visibleAdSamples
            .map((s) => `${s.sel}|class=${s.cls}|@${s.chain}`)
            .join(' ; ')}`
        : ''),
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

  // ── 图片守卫（站点无关，不依赖选择器）─────────────────────────
  // 注意：隐藏**广告位里的图片**是正确的（横幅广告、推荐位素材），
  // 所以这里断言的是「被隐藏的图片必须都在广告位里」+「图片照常加载」，
  // 而不是「一张图都不能隐藏」。
  check(
    '❗误伤守卫：被隐藏的图片全部位于取证确认的广告位内',
    filtered.dom.imagesHiddenOutsideAds === 0,
    `被隐藏 ${filtered.dom.imagesHiddenByUs}/${filtered.dom.imagesTotal} 张，` +
      `其中不在广告位内的 ${filtered.dom.imagesHiddenOutsideAds} 张` +
      (filtered.dom.imagesHiddenOutsideAdSamples.length
        ? ` —— ${filtered.dom.imagesHiddenOutsideAdSamples
            .map((s) => `${s.src} @ ${s.chain}`)
            .join(' | ')}`
        : ''),
  );
  check(
    '❗误伤守卫：图片加载率不低于基线（防「整站图片不显示」）',
    baseline.dom.imagesTotal === 0 ||
      baseline.dom.imagesLoaded === 0 ||
      filtered.dom.imagesLoaded / Math.max(filtered.dom.imagesTotal, 1) >=
        baseline.dom.imagesLoaded / baseline.dom.imagesTotal - 0.1,
    `基线 ${baseline.dom.imagesLoaded}/${baseline.dom.imagesTotal} → ` +
      `净化后 ${filtered.dom.imagesLoaded}/${filtered.dom.imagesTotal}` +
      `（比加载率而非绝对数：站点每次渲染的条目数会波动）`,
  );
  check(
    '❗误伤守卫：没有任何图片请求被拦（自学习规则刻意不含 image 类型）',
    filtered.imageBlocked === 0,
    `图片请求 ${filtered.imageSent} 个，被拦 ${filtered.imageBlocked} 个` +
      (filtered.imageBlocked ? ` —— ${filtered.imageBlockedSamples.join(', ')}` : ''),
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
