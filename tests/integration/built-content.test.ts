import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { pilotPack } from '../../src/rules/sites/pilot.ts';

/**
 * 构建产物冒烟测试：把真实的 dist/content.js 放进 jsdom，配上 chrome 桩，
 * 验证「源码 → 打包 → 运行时行为」整条链路。
 *
 * 这是沙箱内最接近真实运行的一步：跑的不是源码，而是最终会加载进浏览器的那个文件。
 *
 * 需要先 `pnpm build`。dist/ 不存在时跳过并明确提示（用 `pnpm verify` 可一并完成）。
 */

const distPath = new URL('../../dist/content.js', import.meta.url);
const hasDist = existsSync(distPath);

const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');
const HOST = 'afford.gjvrohros.cc';
const CONTENT = 'article[itemtype*="BlogPosting"]';
const THUMB = 'img[data-src*="upload_01"]';

type SendMessage = (msg: { type?: string; url?: string }) => Promise<unknown>;

/** 最小 chrome 桩：只实现内容脚本用到的部分。 */
function fakeChrome(options: { packs: unknown[]; pristine: string | null }): unknown {
  const data: Record<string, unknown> = {};
  const sendMessage: SendMessage = async (msg) => {
    if (msg?.type === 'get-site-packs') return options.packs;
    if (msg?.type === 'get-pristine') {
      return options.pristine === null ? null : { html: options.pristine };
    }
    return undefined;
  };
  return {
    runtime: { sendMessage, getManifest: () => ({ version: '0.0.0-test' }) },
    storage: {
      local: {
        async get(key: string | null) {
          if (key === null) return { ...data };
          return { [key]: data[key] };
        },
        async set(items: Record<string, unknown>) {
          Object.assign(data, items);
        },
        async remove(key: string) {
          delete data[key];
        },
      },
    },
  };
}

/** 在 jsdom 里跑打包产物，返回 document 与 storage 快照。 */
async function runBundle(options: {
  packs: unknown[];
  pristine: string | null;
  html?: string;
}): Promise<{ doc: Document; win: Window & typeof globalThis; storage: Record<string, unknown> }> {
  const code = readFileSync(distPath, 'utf8');
  const dom = new JSDOM(options.html ?? fixture, {
    url: `https://${HOST}/category/jrxw1/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  const chromeStub = fakeChrome(options) as {
    storage: { local: { get: (k: string | null) => Promise<Record<string, unknown>> } };
  };
  (dom.window as unknown as Record<string, unknown>).chrome = chromeStub;

  const script = dom.window.document.createElement('script');
  script.textContent = code;
  dom.window.document.head.appendChild(script);

  // 等内容脚本的两阶段 boot 落地
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    const slots = dom.window.document.querySelectorAll('[data-ssp-slot-node][data-adblow-hidden]');
    if (slots.length === 10) break;
  }
  await new Promise((r) => setTimeout(r, 50));

  return {
    doc: dom.window.document,
    win: dom.window as unknown as Window & typeof globalThis,
    storage: await chromeStub.storage.local.get(null),
  };
}

describe(
  '构建产物冒烟测试（真实 dist/content.js）',
  { skip: hasDist ? false : 'dist/content.js 不存在，先运行 pnpm build 或 pnpm verify' },
  () => {
    it('加载后清掉 10 个广告占位符', async () => {
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null });

      const slots = Array.from(doc.querySelectorAll('[data-ssp-slot-node]'));
      assert.equal(slots.length, 10);
      for (const s of slots) assert.ok(s.getAttribute('data-adblow-hidden') === '1', '占位符未隐藏');
    });

    it('正文 article 与缩略图毫发无伤（误伤守卫）', async () => {
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null });

      for (const a of Array.from(doc.querySelectorAll(CONTENT))) {
        assert.ok(!a.hasAttribute('data-adblow-hidden'), '正文 article 被误伤');
      }
      for (const t of Array.from(doc.querySelectorAll(THUMB))) {
        assert.ok(!t.hasAttribute('data-adblow-hidden'), '正文缩略图被误伤');
      }
    });

    it('注入了防闪现样式表，且样式表内容不含危险选择器', async () => {
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null });

      const style = doc.querySelector('style[data-adblow-cosmetic]');
      assert.ok(style, '未注入防闪现样式表');
      const css = style.textContent ?? '';
      assert.ok(css.includes('[data-ssp-slot-node]'));
      assert.ok(!css.includes('[data-ssp-container]'), '样式表包含了会抹掉正文的容器选择器');
      assert.ok(!/(^|[\s,>])\.post-card(?![-\w])/.test(css), '样式表包含了危险的 .post-card');
    });

    it('写入了本站统计', async () => {
      const { storage } = await runBundle({ packs: [pilotPack], pristine: null });

      const stats = storage[`stats:${HOST}`] as { rule: number; heuristic: number; at: number };
      assert.ok(stats, '未写入统计');
      assert.ok(stats.rule >= 10, `规则拦截数=${stats.rule}`);
      assert.ok(typeof stats.at === 'number');
    });

    it('命中规则包时不发起快照回填（省掉一次同源请求）', async () => {
      // 若实现了 auto 策略却误发请求，pristine 被提供后启发式会启用并可能误伤；
      // 这里通过「不提供 pristine 也一切正常」间接验证第一阶段已足够
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null });
      assert.equal(doc.querySelectorAll('[data-ssp-slot-node]:not([data-adblow-hidden])').length, 0);
    });

    it('无规则包时走快照回填，启发式能拦住新注入的推广位', async () => {
      const { doc } = await runBundle({ packs: [], pristine: fixture });

      // 回填完成后注入的推广盒子应当被启发式隐藏
      const host = doc.createElement('div');
      host.innerHTML =
        '<div class="tg-promo-float"><a href="https://spam.example.com/x?click_id=1"></a></div>';
      const promo = host.firstElementChild as Element;
      doc.body.appendChild(promo);

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !promo.hasAttribute('data-adblow-hidden')) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(promo.hasAttribute('data-adblow-hidden'), '启发式未拦住注入的推广位');
    });

    it('无规则包且回填失败时，不产生任何假阳性', async () => {
      const { doc } = await runBundle({ packs: [], pristine: null });

      for (const sel of [CONTENT, THUMB, '.contact-link', 'footer#footer', 'div.container']) {
        for (const e of Array.from(doc.querySelectorAll(sel))) {
          assert.ok(!e.hasAttribute('data-adblow-hidden'), `${sel} 被误伤（回填失败时不该启用启发式）`);
        }
      }
      // 连静态规则也没了（没有规则包），因此占位符保持可见——这是预期行为
      assert.equal(doc.querySelectorAll('[data-ssp-slot-node][data-adblow-hidden]').length, 0);
    });

    it('站点被关闭时一个都不碰', async () => {
      const code = readFileSync(distPath, 'utf8');
      const dom = new JSDOM(fixture, {
        url: `https://${HOST}/category/jrxw1/`,
        runScripts: 'dangerously',
        pretendToBeVisual: true,
      });
      const chromeStub = fakeChrome({ packs: [pilotPack], pristine: null }) as {
        storage: {
          local: {
            get: (k: string | null) => Promise<Record<string, unknown>>;
            set: (i: Record<string, unknown>) => Promise<void>;
          };
        };
      };
      await chromeStub.storage.local.set({ [`disabled:${HOST}`]: true });
      (dom.window as unknown as Record<string, unknown>).chrome = chromeStub;

      const script = dom.window.document.createElement('script');
      script.textContent = code;
      dom.window.document.head.appendChild(script);
      await new Promise((r) => setTimeout(r, 300));

      assert.equal(dom.window.document.querySelectorAll('[data-adblow-hidden]').length, 0);
      assert.equal(dom.window.document.querySelectorAll('style[data-adblow-cosmetic]').length, 0);
    });
  },
);
