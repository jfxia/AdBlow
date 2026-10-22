import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { pilotPack } from '../../src/rules/sites/pilot.ts';

/**
 * Smoke test for the real build output: dist/content.js runs in jsdom behind a chrome stub,
 * covering source → bundle → runtime behaviour. This is the closest the sandbox gets to a
 * real run — the file under test is the one the browser loads. Requires `pnpm build`;
 * without dist/ the group skips with a message (`pnpm verify` covers both).
 */

// ADBLOW_DIST picks an alternate output dir for when the browser holds dist/ open on
// Windows; otherwise the whole group skips — silently, visible only as a lower test total.
const distPath = new URL(
  `../../${process.env.ADBLOW_DIST ?? 'dist'}/content.js`,
  import.meta.url,
);
const hasDist = existsSync(distPath);

const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');
const HOST = 'afford.gjvrohros.cc';
const CONTENT = 'article[itemtype*="BlogPosting"]';
/**
 * Server-rendered recommendation ad images (`xqbj-recommand-item-banner-1-N`, 20 of them),
 * not content thumbnails, so hiding them is correct. The pilot site's content thumbnails
 * load dynamically from pic.wvxrrip.cn — see the hand-built case below.
 */
const RECOMMEND_IMG = 'img[data-src*="upload_01"]';

/** Inserts a cross-site CDN content image into the first article, guarding risk A. */
function fixtureWithContentThumb(): string {
  // The sanitised fixture was serialised by jsdom, which rewrites boolean attributes to
  // itemscope="", so match on structure instead of the original HTML literal.
  const marker = /(<article[^>]*itemtype="http:\/\/schema\.org\/BlogPosting"[^>]*>)/;
  const out = fixture.replace(
    marker,
    '$1<img id="content-thumb" src="/x.png" data-src="https://pic.wvxrrip.cn/upload_01/xiao/a.jpeg">',
  );
  if (out === fixture) throw new Error('未能插入正文缩略图，fixture 结构可能已变');
  return out;
}

type SendMessage = (msg: { type?: string; url?: string }) => Promise<unknown>;

/** Minimal chrome stub: only the parts the content script uses. */
function fakeChrome(options: {
  packs: unknown[];
  pristine: string | null;
  /** `$popup` list handed to the page; null/undefined = worker could not read it. */
  popupDeny?: string[] | null;
  /** Per-site popup switch answer; undefined = worker could not tell. */
  popupAllowed?: boolean | null;
}): unknown {
  const data: Record<string, unknown> = {};
  const sendMessage: SendMessage = async (msg) => {
    if (msg?.type === 'get-site-packs') return options.packs;
    if (msg?.type === 'get-pristine') {
      return options.pristine === null ? null : { html: options.pristine };
    }
    if (msg?.type === 'get-popup-deny') {
      return { domains: Array.isArray(options.popupDeny) ? options.popupDeny : null };
    }
    if (msg?.type === 'get-popup-allow') {
      return { allowed: typeof options.popupAllowed === 'boolean' ? options.popupAllowed : null };
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

/** Runs the bundle in jsdom; returns the document and a storage snapshot. */
async function runBundle(options: {
  packs: unknown[];
  pristine: string | null;
  html?: string;
  host?: string;
  popupDeny?: string[] | null;
  popupAllowed?: boolean | null;
}): Promise<{ doc: Document; win: Window & typeof globalThis; storage: Record<string, unknown> }> {
  const code = readFileSync(distPath, 'utf8');
  const host = options.host ?? HOST;
  const dom = new JSDOM(options.html ?? fixture, {
    url: `https://${host}/category/jrxw1/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  // An exception during boot would otherwise surface only as an unhandled rejection and
  // fail the count assertions opaquely. Capture it explicitly.
  const errors: string[] = [];
  dom.window.addEventListener('unhandledrejection', (e) => {
    errors.push(String((e as PromiseRejectionEvent).reason));
  });
  dom.window.addEventListener('error', (e) => {
    errors.push(String((e as ErrorEvent).message));
  });
  (dom.window as unknown as Record<string, unknown>).__adblowErrors = errors;

  const chromeStub = fakeChrome(options) as {
    storage: { local: { get: (k: string | null) => Promise<Record<string, unknown>> } };
  };
  (dom.window as unknown as Record<string, unknown>).chrome = chromeStub;

  const script = dom.window.document.createElement('script');
  script.textContent = code;
  dom.window.document.head.appendChild(script);

  // Wait for the content script's two-phase boot to settle.
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

    it('正文 article 与正文缩略图毫发无伤（误伤守卫）', async () => {
      // Hand-inject a pic.wvxrrip.cn image into the article: that is risk A — the domain
      // serves both SSP creatives and content thumbnails, so it must never be blocked wholesale.
      const { doc } = await runBundle({
        packs: [pilotPack],
        pristine: null,
        html: fixtureWithContentThumb(),
      });

      for (const a of Array.from(doc.querySelectorAll(CONTENT))) {
        assert.ok(!a.hasAttribute('data-adblow-hidden'), '正文 article 被误伤');
      }
      const thumb = doc.querySelector('#content-thumb');
      assert.ok(thumb, '正文缩略图未被插入，测试无效');
      assert.ok(!thumb.hasAttribute('data-adblow-hidden'), 'pic.wvxrrip.cn 的正文缩略图被误伤（风险 A）');
    });

    it('服务端推荐位广告图被隐藏（它们是广告位，不是正文）', async () => {
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null });

      const imgs = Array.from(doc.querySelectorAll(RECOMMEND_IMG));
      assert.ok(imgs.length > 0, 'fixture 里应当有推荐位图片');
      for (const i of imgs) {
        assert.ok(i.hasAttribute('data-adblow-hidden'), '推荐位广告图未被隐藏');
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
      // With an auto policy a supplied pristine snapshot would enable heuristics and risk
      // false positives; "everything still works without pristine" shows phase one suffices.
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null });
      assert.equal(doc.querySelectorAll('[data-ssp-slot-node]:not([data-adblow-hidden])').length, 0);
    });

    it('无规则包时走快照回填，启发式能拦住新注入的推广位', async () => {
      const { doc } = await runBundle({ packs: [], pristine: fixture });

      // A promo box injected after the backfill completes should be hidden by the heuristics.
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

    it('无规则包且回填失败时，正文零误伤（但命名档照样拦广告）', async () => {
      const { doc } = await runBundle({ packs: [], pristine: null });

      for (const sel of [CONTENT, '.contact-link', 'footer#footer', 'div.container']) {
        for (const e of Array.from(doc.querySelectorAll(sel))) {
          assert.ok(!e.hasAttribute('data-adblow-hidden'), `${sel} 被误伤`);
        }
      }

      // Improvement: with no rule pack and a failed backfill the placeholders used to stay on
      // the page; the naming tier (data-ssp- attribute in the name) needs neither to block them.
      const slots = Array.from(doc.querySelectorAll('[data-ssp-slot-node]'));
      assert.ok(slots.length > 0);
      for (const s of slots) {
        assert.ok(s.hasAttribute('data-adblow-hidden'), '占位符应被命名档拦住');
      }

      // The container must still never be hidden — it holds the content.
      const container = doc.querySelector('[data-ssp-container="ssp-list"]');
      assert.ok(container, '未找到 ssp-list 容器');
      assert.ok(!container.hasAttribute('data-adblow-hidden'), '装着正文的容器被隐藏了');
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

    it('把 $popup 名单发布成 inert JSON 元素（MAIN world 的读取源）', async () => {
      const { doc } = await runBundle({
        packs: [pilotPack],
        pristine: null,
        popupDeny: ['ads.example', 'popunder.example'],
      });

      const el = doc.getElementById('adblow-popup-deny');
      assert.ok(el, '未发布 adblow-popup-deny 元素');
      assert.equal(el!.tagName, 'SCRIPT');
      // A non-JavaScript type is what keeps the element inert; anything else would execute.
      assert.equal(el!.getAttribute('type'), 'application/json');
      assert.deepEqual(JSON.parse(el!.textContent!), ['ads.example', 'popunder.example']);
    });

    it('名单读不到时不发布元素（MAIN world 不会据此拒绝任何窗口）', async () => {
      const { doc } = await runBundle({ packs: [pilotPack], pristine: null, popupDeny: null });
      assert.equal(doc.getElementById('adblow-popup-deny'), null);
    });

    it('站点开关打开时在 <html> 上发布允许标记', async () => {
      const { doc } = await runBundle({
        packs: [pilotPack],
        pristine: null,
        popupAllowed: true,
      });
      assert.equal(doc.documentElement.getAttribute('data-adblow-popup-allow'), '1');
    });

    it('内容脚本执行期间没有未捕获异常（定位 boot 静默失败）', async () => {
      const { win } = await runBundle({ packs: [pilotPack], pristine: null });
      const errors = (win as unknown as Record<string, unknown>).__adblowErrors as string[];
      assert.deepEqual(errors, [], `内容脚本抛出异常：${errors?.join(' | ')}`);
    });

    it('网络层自学习：在第二站点上把广告域名写进存储', async () => {
      // No rule pack for the second site on purpose: learning is its only network-layer defence.
      const secondSite = readFileSync(
        new URL('../fixtures/1024cg-home.html', import.meta.url),
        'utf8',
      );
      const { storage, win } = await runBundle({
        packs: [],
        pristine: null,
        html: secondSite,
        host: '1024cg.com',
      });

      const errors = (win as unknown as Record<string, unknown>).__adblowErrors as string[];
      assert.deepEqual(errors, [], `内容脚本抛出异常：${errors?.join(' | ')}`);

      const key = 'adDomains:1024cg.com';
      const domains = storage[key] as Record<string, { host: string; hits: number }> | undefined;
      assert.ok(domains, `未写入自学习域名。已有键：${Object.keys(storage).join(', ')}`);
      const hosts = Object.keys(domains);
      assert.ok(hosts.length > 0, '学到的域名列表为空');
      // The site's own domain must never be learned as a domain to block.
      assert.ok(!hosts.includes('1024cg.com'), `学到了站点自己的域名：${hosts.join(', ')}`);
      // Bare IPs are never learned: shared infrastructure, imprecise to block.
      assert.ok(
        hosts.every((h) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(h)),
        `学到了裸 IP：${hosts.join(', ')}`,
      );
    });

    it('网络层自学习：试点站不学镜像域名与素材 CDN（风险 A）', async () => {
      const { storage } = await runBundle({ packs: [pilotPack], pristine: null });
      const domains = storage[`adDomains:${HOST}`] as
        | Record<string, { host: string }>
        | undefined;
      const hosts = domains ? Object.keys(domains) : [];
      for (const forbidden of ['cgw666.com', 'wvxrrip.cn']) {
        assert.ok(!hosts.includes(forbidden), `学到了不该学的域名 ${forbidden}`);
      }
    });
  },
);
