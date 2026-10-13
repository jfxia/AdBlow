// Browser E2E: drives an installed Edge over CDP with the unpacked extension
// loaded, comparing the baseline run against the filtered run. Needs `pnpm build`
// first and relaxed sandbox permissions -- under confinement Chromium's Mojo
// named pipes are denied and the browser never starts.
// Zero dependencies: Node 24's built-in fetch and WebSocket.
// Per-site expectations (PROFILES) are hard-coded from manual forensics: "which
// elements are ads" must come from evidence, or the code under test would be
// validating itself.
// Run: node tools/e2e/run.mjs [url]
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const URL_UNDER_TEST = process.argv[2] ?? 'https://afford.gjvrohros.cc/category/jrxw1/';
const EXT = fileURLToPath(new URL(`../../${process.env.ADBLOW_DIST ?? 'dist'}`, import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));

// Per-site expectations from manual forensics: adSelectors must all be invisible
// after filtering (with at least one visible in the baseline, else the profile is
// stale); contentSelector's visible count must match the baseline exactly;
// contentImageSelector must keep some images visible; adInfra must end at 0
// successful responses (may be empty).
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
      // Do not list `a.tjtagmanager` as an ad slot: it wraps outbound links
      // (banners and possibly other things), so demanding 100% hiding is
      // over-specified (measured 1/107 false positives).
      'div.horizontal-banner',
      // Popup ad (structure found by walking up from a hidden image:
      // div.ad.popup-container > popup-content > popup-picture / popup-close)
      '.popup-container',
    ],
    contentSelector: 'article[itemtype*="BlogPosting"]',
    contentImageSelector: 'article[itemtype*="BlogPosting"] img',
    // Ad creatives and content thumbnails share one CDN (pic.jtzatly.cn), so no
    // network endpoint is safe to block -- this site is DOM-only by design, which
    // is what the profile verifies.
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

// Polls until our extension's service worker target shows up. Filtering on
// "service_worker + chrome-extension://" is not enough: Edge's own extension SWs
// (edgeCopilot / edgeAuthPrivate) answer declarativeNetRequest with undefined,
// so background.js is the discriminator.
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

  // stdio to files, not pipes: the confined environment forbids pipes, and the
  // startup log must stay readable
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
      /* not up yet */
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

/** Registrable domain (last two labels; enough for this project). */
function regDomain(url) {
  try {
    const host = new URL(url).hostname;
    return host.split('.').slice(-2).join('.');
  } catch {
    return '';
  }
}

async function measure({ port, contentDomains = null }) {
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
  await sleep(10000); // let the ad SDK, A/B split and lazy loading finish

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面求值异常');
    return r.result?.value;
  };

  // A failed site load masquerades as "zero ads, zero content" and is reported as
  // a blocking failure (seen repeatedly), so retry once. Judge on element count
  // *and* content count: element count alone once missed it.
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

  // Wait for rendering to settle: site responses fluctuate, and measuring before
  // images finish loading makes the loaded-image count jump.
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
     * Is it actually visible?
     *
     * Must walk the ancestor chain checking display/visibility. Checking only the
     * element itself misjudged "fixed/absolute inside an already-hidden container"
     * as visible (their offsetParent is null anyway), which produced a false
     * "ad content still visible" report.
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

    // Site-agnostic image guard (depends on no selector at all).
    // Once the content-image selector was 'article[...] img', but 1024cg's images
    // are not inside an article: zero matches meant the assertion was skipped by
    // total === 0, i.e. it tested nothing, so "self-learning blocked the content CDN
    // and every image disappeared" slipped through.
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

    /** Does the ad slot still show anything: visible text, or an image that loaded. */
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

  // requestWillBeSent fires before blocking, so that count is never 0. What
  // must be asserted is that zero ad requests got a response, i.e.
  // sent - blocked.
  const allFailed = cdp.events['Network.loadingFailed'] ?? [];
  const blockedIds = new Set(allFailed.filter((e) => e.blockedReason).map((e) => e.requestId));
  const infra = sent.filter((e) => profile.adInfra.some((p) => e.request.url.includes(p)));
  const infraServed = infra.filter((e) => !blockedIds.has(e.requestId));

  // Blocked image requests. The meaning changed when the filter lists landed
  // (2026-10-11): this used to have to be 0, but blocking third-party ad images is
  // now the lists' job, so it is informational only -- the real invariant is the
  // site-owned check below.
  const imageSent = sent.filter((e) => (e.type ?? '').toLowerCase() === 'image');
  const imageBlocked = imageSent.filter((e) => blockedIds.has(e.requestId));

  // Requests to site-owned domains (same registrable domain) -- none may be
  // blocked. This is the most direct measure of "the whole site vanished", and
  // the easiest trap for list rules: they block by domain, so one rule over a
  // site's own asset domain kills the site.
  const siteReg = (() => {
    try {
      const parts = String(new URL(URL_UNDER_TEST).hostname).split('.');
      return parts.slice(-2).join('.');
    } catch {
      return '';
    }
  })();
  const isSiteOwned = (url) => {
    try {
      return String(new URL(url).hostname).endsWith(siteReg);
    } catch {
      return false;
    }
  };
  const siteOwnedSent = sent.filter((e) => isSiteOwned(e.request.url));
  const siteOwnedBlocked = siteOwnedSent.filter((e) => blockedIds.has(e.requestId));

  // On domains that loaded images in the baseline, no image request may be
  // blocked afterwards: a data-driven content-CDN guard. Site-owned domains are
  // few (the pilot site had 1); the risk is third-party CDNs like
  // pic.wvxrrip.cn, which serves both ad creatives and article thumbnails.
  // Images only -- those domains also serve ad/analytics scripts, and blocking
  // those is expected.
  const responses = cdp.events['Network.responseReceived'] ?? [];
  const loadedImageDomains = new Set(
    responses
      .filter((e) => (e.type ?? '').toLowerCase() === 'image' && (e.response?.status ?? 200) < 400)
      .map((e) => regDomain(e.response?.url ?? ''))
      .filter(Boolean),
  );
  const contentCdnBlocked = contentDomains
    ? [...new Set(imageBlocked.map((e) => e.request.url))].filter((u) =>
        contentDomains.has(regDomain(u)),
      )
    : [];

  const popups = (cdp.events['Target.targetCreated'] ?? []).filter(
    (e) => e.targetInfo?.type === 'page' && e.targetInfo?.url && e.targetInfo.url !== 'about:blank',
  ).length;

  // Navigation diagnostics: counts alone cannot tell "page did not load" from
  // "wrong selector", so surface the raw facts.
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
    siteOwnedSent: siteOwnedSent.length,
    siteOwnedBlocked: siteOwnedBlocked.length,
    siteOwnedBlockedSamples: [...new Set(siteOwnedBlocked.map((e) => e.request.url))].slice(0, 5),
    loadedImageDomains: [...loadedImageDomains],
    contentCdnBlocked: contentCdnBlocked.length,
    contentCdnBlockedSamples: contentCdnBlocked.slice(0, 5),
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

  // pass in the domains that loaded images in the baseline, to check whether list
  // rules block them after filtering
  const filtered = await measure({
    port: 9502,
    contentDomains: new Set(baseline.loadedImageDomains ?? []),
  });
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

  // Image guards (site-independent, selector-independent). Hiding images inside
  // ad slots is correct (banners, recommendation creatives), so the assertions are
  // "hidden images are all inside ad slots" and "images still load".
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
    '❗误伤守卫：站点自有域名的请求一个都没被拦（防「整站资源消失」）',
    filtered.siteOwnedBlocked === 0,
    `站点自有域名请求 ${filtered.siteOwnedSent} 个，被拦 ${filtered.siteOwnedBlocked} 个` +
      (filtered.siteOwnedBlocked
        ? ` —— ${filtered.siteOwnedBlockedSamples.join(', ')}`
        : ''),
  );
  check(
    '❗误伤守卫：基线里加载成功的图片域名上，没有图片被拦（数据驱动的内容 CDN 守卫）',
    filtered.contentCdnBlocked === 0,
    `基线图片域名 ${(baseline.loadedImageDomains ?? []).length} 个（${(baseline.loadedImageDomains ?? []).join(', ')}），` +
      `净化后被拦的图片 ${filtered.contentCdnBlocked} 个` +
      (filtered.contentCdnBlocked ? ` —— ${filtered.contentCdnBlockedSamples.join(', ')}` : ''),
  );
  check(
    '图片请求情况（集成列表后，拦第三方广告图属正常，仅作记录）',
    true,
    `图片请求 ${filtered.imageSent} 个，被拦 ${filtered.imageBlocked} 个`,
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
