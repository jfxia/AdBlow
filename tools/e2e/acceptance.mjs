/**
 * 21 类干扰视线广告的**验收实测**。
 *
 * 目的：把评估表变成可执行的验收标准，而不是文字结论。
 * 每一类都有一个真实形态的测试页，先在**不装扩展**的基线下确认它确实在干扰
 * （否则这个夹具没有意义），再装扩展测它是否被处理。
 *
 * 三种测量模式：
 *   dom    —— 探针元素是否被我们隐藏（内联隐藏会打 data-adblow-hidden）
 *   hover  —— 先派发可信的鼠标移入（触发"随动伸缩/展开"），再按 dom 判定
 *   click  —— 派发可信点击，检查是否跳转 / 是否新开标签
 *   popup  —— 页面加载即尝试 window.open（无手势），检查是否新开标签
 *
 * 用 CDP 的 Input.dispatchMouseEvent 派发 —— 产生的是**可信事件**，
 * 与真实用户操作等价；用 JS 造事件测不出真实行为。
 *
 * 用法：node tools/e2e/acceptance.mjs [只测某个 id]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const EXT = fileURLToPath(new URL('../../dist', import.meta.url));
const E2E_DIR = fileURLToPath(new URL('../../_probe/e2e/', import.meta.url));
const SITE_PORT = 9821;
const AD_PORT = 9822;
const BASE = `http://127.0.0.1:${SITE_PORT}`;
const AD = `http://localhost:${AD_PORT}`;
const IMG = `${AD}/banner.png`;
const VID = `${AD}/v.mp4`;
const ONLY = process.argv[2] ? Number(process.argv[2]) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1×1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** 每个夹具都带一段正常正文，模拟真实页面。 */
const CONTENT = `<div id="content" style="max-width:760px;margin:0 auto;padding:24px;font:16px/1.7 sans-serif">
  <h1>正常文章标题</h1>
  <p>这是一段正常正文，用来确认页面本身有内容。正文区域不应该被隐藏。</p>
  <p>第二段正文，继续填充一些字数以便观察布局。</p>
  <article itemtype="http://schema.org/BlogPosting"><h2>带标记的正文</h2><p>正文段落。</p></article>
</div>`;

const page = (head, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>fixture</title>${head}</head><body>${CONTENT}${body}</body></html>`;

const FIXED = (extra = '') =>
  `position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;opacity:0;${extra}`;

export const FIXTURES = [
  // ── 一、弹窗类 ────────────────────────────────────────────────
  {
    id: 1,
    cat: '一、弹窗类',
    name: 'Pop-up 前置弹窗（新窗口）',
    mode: 'popup',
    html: page('', `<script>window.open('${AD}/landed','_blank');</script>`),
  },
  {
    id: 2,
    cat: '一、弹窗类',
    name: 'Pop-under 底层弹窗',
    mode: 'click',
    html: page(
      '',
      `<a id="hook" href="${AD}/landed" style="${FIXED()}"></a>
       <script>document.getElementById('hook').addEventListener('click',function(e){
         e.preventDefault(); window.open('${AD}/landed','_blank');
       });</script>`,
    ),
  },
  {
    id: 3,
    cat: '一、弹窗类',
    name: '页面浮层 Modal（网页内弹窗）',
    mode: 'dom',
    probe: '.ad-modal',
    html: page(
      '',
      `<div class="ad-modal" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:rgba(0,0,0,.65)">
         <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">
           <a href="${AD}/landed"><img src="${IMG}" width="600" height="400"></a>
         </div>
       </div>`,
    ),
  },
  {
    id: 4,
    cat: '一、弹窗类',
    name: '插屏广告（过渡全屏）',
    mode: 'dom',
    probe: '#interstitial',
    html: page(
      '',
      `<div id="interstitial" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#000">
         <img src="${IMG}" width="800" height="600" style="width:100%;height:100%">
         <div style="position:absolute;right:20px;top:20px;color:#fff">3 秒后可跳过</div>
       </div>`,
    ),
  },
  {
    id: 5,
    cat: '一、弹窗类',
    name: '二次连环弹窗',
    mode: 'dom',
    probe: '.ad-modal-a, .ad-modal-b',
    html: page(
      '',
      `<div class="ad-modal-a" style="position:fixed;top:0;left:0;width:100%;height:100%;z-index:9998;background:rgba(0,0,0,.6)">
         <a href="${AD}/landed"><img src="${IMG}" width="600" height="400"></a>
       </div>
       <script>setTimeout(function(){
         var d=document.createElement('div');
         d.className='ad-modal-b';
         d.setAttribute('style','position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:rgba(0,0,0,.7)');
         d.innerHTML='<a href="${AD}/landed2"><img src="${IMG}" width="600" height="400"></a>';
         document.body.appendChild(d);
       }, 1500);</script>`,
    ),
  },

  // ── 二、悬浮 / 漂浮 ──────────────────────────────────────────
  {
    id: 6,
    cat: '二、悬浮漂浮',
    name: '跟随滚动漂浮（Float）',
    mode: 'dom',
    probe: '.tg-promo-float',
    html: page(
      '',
      `<div class="tg-promo-float" style="position:fixed;right:12px;top:140px;z-index:9999;width:180px">
         <a href="${AD}/landed?from=float"><img src="${IMG}" width="180" height="240"></a>
       </div>`,
    ),
  },
  {
    id: 7,
    cat: '二、悬浮漂浮',
    name: '边角固定悬浮浮标',
    mode: 'dom',
    probe: '#corner-float-ad',
    html: page(
      '',
      `<div id="corner-float-ad" style="position:fixed;right:14px;bottom:14px;z-index:9999">
         <a href="${AD}/landed?from=corner"><img src="${IMG}" width="320" height="240"></a>
       </div>`,
    ),
  },
  {
    id: 8,
    cat: '二、悬浮漂浮',
    name: '随动伸缩广告（悬浮展开）',
    mode: 'hover',
    probe: '.tg-expand-box',
    html: page(
      '',
      `<div class="tg-expand-box" id="box" style="position:fixed;left:16px;top:200px;width:80px;height:60px;z-index:9000;overflow:hidden;background:#fff">
         <span style="font:12px sans-serif">.</span>
       </div>
       <script>var box=document.getElementById('box');
       box.addEventListener('mouseover',function(){
         box.style.width='640px'; box.style.height='440px';
         box.innerHTML='<a href="${AD}/landed?from=expand"><img src="${IMG}" width="640" height="440"></a>';
       });</script>`,
    ),
    hoverTarget: '#box',
  },
  {
    id: 9,
    cat: '二、悬浮漂浮',
    name: '底部固定横幅（Sticky Banner）',
    mode: 'dom',
    probe: '.sticky-bottom-banner',
    html: page(
      '',
      `<div class="sticky-bottom-banner" style="position:fixed;left:0;bottom:0;width:100%;height:110px;z-index:9998">
         <a href="${AD}/landed?from=sticky"><img src="${IMG}" width="1000" height="110"></a>
       </div>`,
    ),
  },

  // ── 三、视频类 ───────────────────────────────────────────────
  {
    id: 10,
    cat: '三、视频类',
    name: '页外流视频（Outstream，含命名）',
    mode: 'dom',
    probe: '.outstream-video',
    html: page(
      '',
      `<div class="outstream-video" style="width:480px;margin:20px auto">
         <video src="${VID}" autoplay muted loop width="480" height="270"></video>
       </div>`,
    ),
  },
  {
    id: 11,
    cat: '三、视频类',
    name: '视频前置贴片（IMA 容器）',
    mode: 'dom',
    probe: '.ima-ad-container',
    html: page(
      '',
      `<div class="player" style="position:relative;width:640px;height:360px;background:#000;margin:20px auto">
         <div class="ima-ad-container" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:1000">
           <a href="${AD}/landed?from=preroll"><img src="${IMG}" width="640" height="360"></a>
           <div style="position:absolute;right:10px;bottom:10px;color:#fff">跳过广告</div>
         </div>
       </div>`,
    ),
  },
  {
    id: 12,
    cat: '三、视频类',
    name: '视频中插广告',
    mode: 'dom',
    probe: '.video-ads',
    html: page(
      '',
      `<div class="player" id="pl" style="position:relative;width:640px;height:360px;background:#000;margin:20px auto"></div>
       <script>setTimeout(function(){
         var d=document.createElement('div');
         d.className='video-ads';
         d.setAttribute('style','position:absolute;top:0;left:0;width:100%;height:100%;z-index:1000');
         d.innerHTML='<a href="${AD}/landed?from=midroll"><img src="${IMG}" width="640" height="360"></a>';
         document.getElementById('pl').appendChild(d);
       }, 1500);</script>`,
    ),
  },
  {
    id: 13,
    cat: '三、视频类',
    name: '视频叠加浮层（播放器内，仅占播放器）',
    mode: 'dom',
    probe: '.video-layer',
    // 真实形态：播放器里有 <video>，广告是盖在它上面的一层。
    // 这一层只占播放器、占视口不到 40%，所以走「播放器内覆盖」判据。
    html: page(
      '',
      `<div class="player" style="position:relative;width:640px;height:360px;background:#000;margin:20px auto">
         <video src="${VID}" width="640" height="360"></video>
         <div class="video-layer" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:1000">
           <a href="${AD}/landed?from=voverlay"><img src="${IMG}" width="640" height="360"></a>
         </div>
       </div>`,
    ),
  },
  {
    id: 14,
    cat: '三、视频类',
    name: '自动展开全屏视频广告',
    mode: 'hover',
    probe: '.player-auto',
    html: page(
      '',
      `<div class="player-auto" id="pa" style="position:fixed;right:20px;bottom:20px;width:240px;height:135px;z-index:9000;background:#000;overflow:hidden">
         <span style="color:#fff;font:12px sans-serif">.</span>
       </div>
       <script>var pa=document.getElementById('pa');
       pa.addEventListener('mouseover',function(){
         pa.setAttribute('style','position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;background:#000');
         pa.innerHTML='<video src="${VID}" autoplay muted width="100%" height="100%"></video><a href="${AD}/landed?from=auto">立即观看</a>';
       });</script>`,
    ),
    hoverTarget: '#pa',
  },

  // ── 四、点击触发 / 强制跳转 ──────────────────────────────────
  {
    id: 15,
    cat: '四、点击跳转',
    name: '整页可点击广告',
    mode: 'dom',
    probe: '.ads-box',
    html: page(
      '',
      `<div class="ads-box" style="margin:20px auto;width:728px">
         <a href="${AD}/landed?from=whole"><img src="${IMG}" width="728" height="200" style="width:728px;height:200px"></a>
       </div>`,
    ),
  },
  {
    id: 16,
    cat: '四、点击跳转',
    name: '假关闭按钮跳转广告（小浮窗）',
    mode: 'dom',
    probe: '.fake-close-modal',
    html: page(
      '',
      `<div class="fake-close-modal" style="position:fixed;left:50%;top:30%;transform:translateX(-50%);width:420px;height:320px;z-index:9999;background:#fff;box-shadow:0 4px 24px rgba(0,0,0,.4)">
         <img src="${IMG}" width="420" height="280" style="width:420px;height:280px">
         <a class="close-btn" href="${AD}/landed?from=fakeclose" style="position:absolute;top:6px;right:8px;font:20px sans-serif;text-decoration:none">✕</a>
         <div style="text-align:center;font:14px sans-serif">关闭</div>
       </div>`,
    ),
  },
  {
    id: 17,
    cat: '四、点击跳转',
    name: '点击劫持（透明层）',
    mode: 'click',
    html: page('', `<a id="cj" href="${AD}/landed?from=cj" style="${FIXED()}"></a>`),
  },
  {
    id: 18,
    cat: '四、点击跳转',
    name: '区域展开跳转广告',
    mode: 'hover',
    probe: '.region-expand',
    html: page(
      '',
      `<div class="region-expand" id="re" style="position:fixed;left:16px;top:320px;width:90px;height:60px;z-index:9000;background:#fff;overflow:hidden">
         <span style="font:12px sans-serif">.</span>
       </div>
       <script>var re=document.getElementById('re');
       re.addEventListener('mouseover',function(){
         re.style.width='560px'; re.style.height='360px';
         re.innerHTML='<a href="${AD}/landed?from=region"><img src="${IMG}" width="560" height="360"></a>';
       });</script>`,
    ),
    hoverTarget: '#re',
  },
  {
    id: 19,
    cat: '四、点击跳转',
    name: '标签页劫持（Tab-under）',
    mode: 'click',
    html: page(
      '',
      `<script>document.addEventListener('click', function(){
         window.open('${AD}/landed?from=tabunder', '_blank');
       });</script>`,
    ),
  },

  // ── 五、富媒体动画 ──────────────────────────────────────────
  {
    id: 20,
    cat: '五、富媒体动画',
    name: '闪烁 GIF 广告',
    mode: 'dom',
    probe: '.ads-flash',
    html: page(
      '',
      `<a class="ads-flash" href="${AD}/landed?from=flash" style="display:block;width:300px;margin:20px auto">
         <img src="${IMG}" width="300" height="250" style="width:300px;height:250px">
       </a>`,
    ),
  },
  {
    id: 21,
    cat: '五、富媒体动画',
    name: 'HTML5 富媒体扩展广告',
    mode: 'hover',
    probe: '.richmedia-box',
    html: page(
      '',
      `<div class="richmedia-box" id="rb" style="position:fixed;right:16px;top:360px;width:100px;height:70px;z-index:9000;background:#fff;overflow:hidden">
         <span style="font:12px sans-serif">.</span>
       </div>
       <script>var rb=document.getElementById('rb');
       rb.addEventListener('mouseover',function(){
         rb.style.width='600px'; rb.style.height='420px';
         rb.innerHTML='<a href="${AD}/landed?from=rich"><img src="${IMG}" width="600" height="420"></a>';
       });</script>`,
    ),
    hoverTarget: '#rb',
  },
];

// ── 服务端 ───────────────────────────────────────────────────────
const LANDED = `<!doctype html><html><head><title>LANDED</title></head><body><h1 id="landed">广告落地页</h1></body></html>`;

function startServers() {
  const site = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/t')) {
      const id = Number(url.slice(2).split('?')[0]);
      const f = FIXTURES.find((x) => x.id === id);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(f ? f.html : '<!doctype html><title>404</title>');
      return;
    }
    res.writeHead(404).end('nope');
  });
  const ad = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/banner.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    if (url === '/v.mp4') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.alloc(0));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LANDED);
  });
  return [site, ad];
}

// ── CDP ─────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
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
      if (m.method) c.events.push(m);
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

/**
 * 浏览器级 CDP 会话：用来精确统计「这次夹具运行期间新开了几个页面」。
 * 用目标总数相减会出错（运行期间我们关掉旧页面，差值会出现负数）。
 */
let BROWSER_CDP = null;

async function openBrowserCdp(port) {
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await Cdp.connect(info.webSocketDebuggerUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await sleep(300);
  return cdp;
}

async function launch({ port, profileDir, withExtension }) {
  mkdirSync(E2E_DIR, { recursive: true });
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  const out = openSync(`${E2E_DIR}acc-${port}.log`, 'w');
  const err = openSync(`${E2E_DIR}acc-${port}.err.log`, 'w');
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-gpu',
    '--window-size=1280,900',
    '--autoplay-policy=no-user-gesture-required',
    // 必须关掉浏览器自带的弹窗拦截器：否则「无手势 window.open」是由浏览器挡的，
    // 而不是我们的守卫挡的 —— 基线就复现不了，对照失去意义。
    '--disable-popup-blocking',
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

const AD_HOST = new URL(AD).host;

/** 在页面上判定探针是否被隐藏（我们隐藏时会打 data-adblow-hidden）。 */
const PROBE_EXPR = (probe) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(probe)})];
  const hiddenOf = (el) => el.closest('[data-adblow-hidden]') !== null;
  return {
    total: els.length,
    hidden: els.filter(hiddenOf).length,
    sample: els.slice(0, 2).map((el) => ({
      cls: (el.getAttribute('class') || '') + '#' + (el.getAttribute('id') || ''),
      display: getComputedStyle(el).display,
    })),
  };
})()`;

const AD_EL_EXPR = `(() => {
  // 页面上任何指向广告域的元素是否还可见（作为"广告仍在干扰"的旁证）
  const els = [...document.querySelectorAll('a[href*="' + ${JSON.stringify(AD_HOST)} + '"], img[src*="' + ${JSON.stringify(AD_HOST)} + '"]')];
  const hiddenOf = (el) => el.closest('[data-adblow-hidden]') !== null;
  return { total: els.length, hidden: els.filter(hiddenOf).length };
})()`;

async function runFixture({ port, fixture }) {
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  );
  const target = created.ok ? await created.json() : null;
  if (!target) return { error: '无法创建页面' };

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 快照事件位置：此后新出现的 page 目标就是这次运行"新开的标签"
  const eventMark = BROWSER_CDP ? BROWSER_CDP.events.length : 0;
  const startUrl = `${BASE}/t${fixture.id}`;
  await cdp.send('Page.navigate', { url: startUrl });
  await sleep(7000); // 覆盖内容脚本的 4s 收尾

  let interaction = '无';
  if (fixture.mode === 'hover') {
    const rect = (
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(fixture.hoverTarget)});
          if (!el) return null; const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`,
        returnByValue: true,
      })
    ).result?.value;
    if (rect) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      // 再补一次，确保 mouseover 真的触发
      await sleep(300);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + 2, y: rect.y + 2 });
      interaction = `移入 (${rect.x},${rect.y})`;
    }
    await sleep(4000); // 等几何重判那一趟
  } else if (fixture.mode === 'click') {
    for (const p of [
      { x: 640, y: 300 },
      { x: 260, y: 160 },
      { x: 900, y: 620 },
    ]) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1,
      });
      await sleep(600);
    }
    interaction = '派发 3 次可信点击';
    await sleep(2500);
  }

  const finalUrl = (
    await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
  ).result?.value;

  const openedPages = BROWSER_CDP
    ? BROWSER_CDP.events
        .slice(eventMark)
        .filter((e) => e.method === 'Target.targetCreated' && e.params?.targetInfo?.type === 'page')
    : [];

  let dom = null;
  if (fixture.probe) {
    dom = (
      await cdp.send('Runtime.evaluate', { expression: PROBE_EXPR(fixture.probe), returnByValue: true })
    ).result?.value;
    const adEls = (
      await cdp.send('Runtime.evaluate', { expression: AD_EL_EXPR, returnByValue: true })
    ).result?.value;
    if (dom && adEls) dom.adElements = adEls;
  }

  cdp.close();
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);

  return {
    interaction,
    navigated: finalUrl !== startUrl,
    finalUrl,
    newTargets: openedPages.length,
    openedUrls: openedPages.map((e) => String(e.params?.targetInfo?.url ?? '').slice(0, 60)),
    dom,
  };
}

// ── 主流程 ───────────────────────────────────────────────────────
const targets = ONLY ? FIXTURES.filter((f) => f.id === ONLY) : FIXTURES;
let failures = 0;
const servers = startServers();
await new Promise((r) => servers[0].listen(SITE_PORT, '127.0.0.1', r));
await new Promise((r) => servers[1].listen(AD_PORT, '127.0.0.1', r));
console.log(`夹具站点 ${BASE} /t1..t21，广告域 ${AD}\n`);

let baseBrowser = null;
let extBrowser = null;
try {
  // ① 基线：不装扩展 —— 每一类都必须确实在干扰
  baseBrowser = await launch({ port: 9831, profileDir: `${E2E_DIR}acc-base`, withExtension: false });
  BROWSER_CDP = await openBrowserCdp(9831);
  console.log('=== 基线（不装扩展）：确认每个夹具确实在干扰 ===');
  for (const f of targets) {
    const r = await runFixture({ port: 9831, fixture: f });
    f._base = r;
    const interfering =
      f.mode === 'popup' || f.mode === 'click'
        ? r.navigated || r.newTargets > 0
        : (r.dom?.total ?? 0) > 0 && (r.dom?.hidden ?? 0) === 0;
    f._baseOk = interfering;
    console.log(
      `  ${String(f.id).padStart(2)}. ${f.name.padEnd(30)} ` +
        (f.mode === 'popup' || f.mode === 'click'
          ? `跳转=${r.navigated ? '是' : '否'} 新标签=${r.newTargets}`
          : `探针 ${r.dom?.total ?? 0} 个、被隐藏 ${r.dom?.hidden ?? 0}`) +
        `  ${interfering ? '' : '⚠️ 夹具未生效'}`,
    );
  }
  BROWSER_CDP.close();
  BROWSER_CDP = null;
  baseBrowser.kill();
  baseBrowser = null;
  await sleep(1200);

  // ② 装扩展
  extBrowser = await launch({ port: 9832, profileDir: `${E2E_DIR}acc-ext`, withExtension: true });
  const ready = await waitForExtension(9832);
  BROWSER_CDP = await openBrowserCdp(9832);
  console.log(`\n=== 装扩展后 ===（扩展就绪：${ready ? '是' : '否'}）`);
  const rows = [];
  for (const f of targets) {
    const r = await runFixture({ port: 9832, fixture: f });
    let handled;
    let detail;
    if (f.mode === 'popup' || f.mode === 'click') {
      handled = !r.navigated && r.newTargets <= 0;
      detail = `跳转=${r.navigated ? '是' : '否'} 新标签=${r.newTargets}`;
    } else {
      const total = r.dom?.total ?? 0;
      const hidden = r.dom?.hidden ?? 0;
      handled = total > 0 && hidden === total;
      detail = `探针 ${hidden}/${total} 被隐藏`;
    }
    rows.push({ f, r, handled, detail });
    console.log(
      `  ${String(f.id).padStart(2)}. ${f.name.padEnd(30)} ${handled ? 'PASS' : 'FAIL'}  ${detail}` +
        (f._baseOk ? '' : '  （基线未复现，结论仅供参考）'),
    );
  }

  // ③ 汇总
  console.log('\n' + '─'.repeat(78));
  const passed = rows.filter((x) => x.handled).length;
  console.log(`通过 ${passed}/${rows.length}`);
  const byCat = {};
  for (const x of rows) {
    byCat[x.f.cat] ??= { pass: 0, total: 0 };
    byCat[x.f.cat].total += 1;
    if (x.handled) byCat[x.f.cat].pass += 1;
  }
  for (const [cat, v] of Object.entries(byCat)) {
    console.log(`  ${cat.padEnd(14)} ${v.pass}/${v.total}`);
  }
  const failedIds = rows.filter((x) => !x.handled).map((x) => `${x.f.id} ${x.f.name}`);
  if (failedIds.length) console.log(`\n未通过：\n  ${failedIds.join('\n  ')}`);
  console.log('─'.repeat(78));
  // 注意：未通过不等于本次执行失败 —— 这是一把"尺子"，用来量命中率
  console.log(`验收命中率：${passed}/${rows.length}`);
} catch (e) {
  failures = 1;
  console.log(`执行失败：${e.message}`);
} finally {
  try {
    BROWSER_CDP?.close();
  } catch {
    /* ignore */
  }
  baseBrowser?.kill();
  extBrowser?.kill();
  for (const s of servers) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}
process.exit(failures);
