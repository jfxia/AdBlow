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

// 支持 ADBLOW_DIST：浏览器正加载 dist/ 时（Windows 下目录被占用）改用备用产物目录，
// 否则这组冒烟测试会被整体跳过（跳过是静默的，只体现为总数变少，容易误判成"测试丢了"）。
const distPath = new URL(
  `../../${process.env.ADBLOW_DIST ?? 'dist'}/content.js`,
  import.meta.url,
);
const hasDist = existsSync(distPath);

const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');
const HOST = 'afford.gjvrohros.cc';
const CONTENT = 'article[itemtype*="BlogPosting"]';
/**
 * ⚠️ 这不是正文缩略图，而是**服务端推荐位广告图**（20 个推荐位，id 形如
 * `xqbj-recommand-item-banner-1-N`）。隐藏它们是正确行为。
 * 试点站的正文缩略图由内联脚本从 pic.wvxrrip.cn 动态加载，见下面手工构造的用例。
 */
const RECOMMEND_IMG = 'img[data-src*="upload_01"]';

/** 在第一篇正文 article 里塞一张跨站 CDN 的正文图，用来守「风险 A」。 */
function fixtureWithContentThumb(): string {
  // 注意：脱敏后的 fixture 由 jsdom 序列化，布尔属性会变成 itemscope=""，
  // 所以这里不能按原始 HTML 的字面量匹配。
  const marker = /(<article[^>]*itemtype="http:\/\/schema\.org\/BlogPosting"[^>]*>)/;
  const out = fixture.replace(
    marker,
    '$1<img id="content-thumb" src="/x.png" data-src="https://pic.wvxrrip.cn/upload_01/xiao/a.jpeg">',
  );
  if (out === fixture) throw new Error('未能插入正文缩略图，fixture 结构可能已变');
  return out;
}

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
  host?: string;
}): Promise<{ doc: Document; win: Window & typeof globalThis; storage: Record<string, unknown> }> {
  const code = readFileSync(distPath, 'utf8');
  const host = options.host ?? HOST;
  const dom = new JSDOM(options.html ?? fixture, {
    url: `https://${host}/category/jrxw1/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });

  // 内容脚本 boot 里的异常若不捕获只会变成 unhandled rejection，
  // 计数断言会以「什么都没发生」的形式失败，很难定位。这里显式抓下来。
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

    it('正文 article 与正文缩略图毫发无伤（误伤守卫）', async () => {
      // 手工在正文里塞一张 pic.wvxrrip.cn 的图 —— 那是**风险 A**：
      // 该域名既是 SSP 素材 CDN 又是正文缩略图 CDN，绝不能整体拉黑。
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

    it('无规则包且回填失败时，正文零误伤（但命名档照样拦广告）', async () => {
      const { doc } = await runBundle({ packs: [], pristine: null });

      for (const sel of [CONTENT, '.contact-link', 'footer#footer', 'div.container']) {
        for (const e of Array.from(doc.querySelectorAll(sel))) {
          assert.ok(!e.hasAttribute('data-adblow-hidden'), `${sel} 被误伤`);
        }
      }

      // 改进点：以前没有规则包又回填失败时，占位符会留在页面上；
      // 现在命名档（属性名含 data-ssp-）不依赖规则包也不依赖快照，能直接拦住它们。
      const slots = Array.from(doc.querySelectorAll('[data-ssp-slot-node]'));
      assert.ok(slots.length > 0);
      for (const s of slots) {
        assert.ok(s.hasAttribute('data-adblow-hidden'), '占位符应被命名档拦住');
      }

      // 容器仍然绝不能被隐藏（里面装着正文）
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

    it('内容脚本执行期间没有未捕获异常（定位 boot 静默失败）', async () => {
      const { win } = await runBundle({ packs: [pilotPack], pristine: null });
      const errors = (win as unknown as Record<string, unknown>).__adblowErrors as string[];
      assert.deepEqual(errors, [], `内容脚本抛出异常：${errors?.join(' | ')}`);
    });

    it('网络层自学习：在第二站点上把广告域名写进存储', async () => {
      // 第二站点刻意不给规则包 —— 网络层自学习是它唯一能获得网络层保护的途径
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
      // 站点自己的域名绝不能被学成要拦截的广告域名
      assert.ok(!hosts.includes('1024cg.com'), `学到了站点自己的域名：${hosts.join(', ')}`);
      // 裸 IP 不学（共享基础设施，拦截不精确）
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
