/**
 * 渲染 docs/diagrams/*.mmd 为 PNG。
 *
 * 为什么这么做：Mermaid 在受限网络下不显示，README 因此引用提交好的 PNG；而仓库不引入
 * mermaid / puppeteer 之类的依赖（会多出两百兆安装体积）。这里用已提交的 vendor 版 mermaid
 * （tools/docs/vendor/mermaid.min.js，UMD 单文件）在本地 Edge 里渲染，再用 CDP 截图。
 *
 * 用法：node tools/docs/render-diagrams.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIAGRAMS = `${ROOT}docs/diagrams/`;
const VENDOR = `${ROOT}tools/docs/vendor/mermaid.min.js`;
const PORT = 10611;
const PROFILE = `${ROOT}_probe/profile-diagrams`;

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

if (!EDGE) {
  console.log('  [!!] 找不到 Edge');
  process.exit(1);
}
if (!existsSync(VENDOR)) {
  console.log(`  [!!] 缺少 ${VENDOR}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid) => {
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    /* gone */
  }
};

/* 为每张图生成一个 HTML：mermaid 源内联，库走本地 file:// 引用 */
const sheets = readdirSync(DIAGRAMS).filter((f) => f.endsWith('.mmd'));
const pages = [];
for (const sheet of sheets) {
  const source = readFileSync(`${DIAGRAMS}${sheet}`, 'utf8');
  const html = `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; padding: 20px; background: #fff; font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; }
  .mermaid { display: inline-block; }
  .mermaid text { font-family: "Microsoft YaHei", "Segoe UI", system-ui, sans-serif !important; }
</style>
<script src="file:///${VENDOR.replace(/\\/g, '/')}"></script>
<div class="mermaid">${source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
<script>
  mermaid.initialize({
    startOnLoad: true,
    theme: 'neutral',
    flowchart: { htmlLabels: true, curve: 'basis', useMaxWidth: false },
    themeVariables: { fontSize: '15px' },
  });
</script>`;
  const htmlPath = `${DIAGRAMS}${sheet.replace(/\.mmd$/, '.html')}`;
  writeFileSync(htmlPath, html, 'utf8');
  pages.push({ sheet, htmlPath, png: `${DIAGRAMS}${sheet.replace(/\.mmd$/, '.png')}` });
}

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
const out = openSync(`${ROOT}_probe/diagrams.log`, 'w');
const child = spawn(
  EDGE,
  [
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--headless=new',
    '--allow-file-access-from-files',
    'about:blank',
  ],
  { stdio: ['ignore', out, out] },
);
closeSync(out);

const deadline = Date.now() + 40000;
let up = false;
while (Date.now() < deadline) {
  await sleep(400);
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) {
      up = true;
      break;
    }
  } catch {
    /* wait */
  }
}
if (!up) {
  killTree(child.pid);
  console.log('  [!!] CDP 未就绪');
  process.exit(1);
}

const openWs = async (url) => {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  return {
    send: (method, params = {}) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((r) => pending.set(id, r));
    },
    close: () => ws.close(),
  };
};

for (const page of pages) {
  const url = `file:///${page.htmlPath.replace(/\\/g, '/')}`;
  const tab = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
  const cdp = await openWs(tab.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  let box = null;
  for (let i = 0; i < 30 && !box; i += 1) {
    await sleep(400);
    const res = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const svg = document.querySelector('svg');
        if (!svg) return null;
        const r = svg.getBoundingClientRect();
        return { w: Math.ceil(r.width) + 40, h: Math.ceil(r.height) + 40 };
      })()`,
      returnByValue: true,
    });
    if (res.result?.value) box = res.result.value;
  }

  if (!box) {
    console.log(`  [!!] ${page.sheet}: 未渲染出 SVG`);
    cdp.close();
    continue;
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: box.w,
    height: box.h,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(600);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(page.png, Buffer.from(shot.data, 'base64'));
  console.log(`  [ok] ${page.sheet} -> ${box.w}x${box.h}`);
  cdp.close();
}

killTree(child.pid);
await sleep(300);
rmSync(PROFILE, { recursive: true, force: true });
console.log('  渲染完成');
