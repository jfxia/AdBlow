# AdBlow 实施计划

> **给执行者：** 本计划按 TDD 拆成小步，每步 2–5 分钟。**每一步都要先写失败的测试、跑它、再写实现、再跑它、再提交。** 不要跳过"确认失败"这一步。
>
> 设计依据见 [2026-10-10-adblow-design.md](./2026-10-10-adblow-design.md)。执行前先读那份文档的 §1 与 §2——**§2 的两条误伤风险决定了后面一半的测试为什么存在。**

**目标：** 交付 AdBlow —— 一个完全自研、不依赖第三方过滤列表的 Edge (MV3) 广告过滤器，在试点站 `https://afford.gjvrohros.cc/category/jrxw1/` 上做到广告零残留、内容零误伤。

**架构：** 四层引擎。L1 DNR 网络拦截、L2 USER 源 CSS 精准隐藏、L3 服务端快照 diff + 广告度打分 + 选择器泛化 + 自学习、L4 MAIN world 注入对抗弹窗与反屏蔽。纯逻辑全部下沉到 `src/engine/`，零浏览器依赖，因此可在当前受限沙箱内充分单测。

**技术栈（已按实测修订）：** TypeScript · **Rollup + 自研 15 行 TS 转换插件** · **`node:test` + jsdom** · Edge 155 (MV3) · 零依赖 CDP 做 E2E

**环境事实（已实测，不要质疑）：**
- 工作区 `D:\test\ad-blow`；Node v24.15.0；pnpm 10.33.0
- npm 源可达（`registry.npmjs.org` 200 / 2.0s，`registry.npmmirror.com` 200 / 0.6s）——**装包时用 npmmirror 更快**
- Edge 在 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`（155.0.4283.45）
- **受限沙箱下无法启动 Chromium**（Mojo 命名管道被拒）：`FATAL: platform_channel.cc: Check failed: 拒绝访问 (0x5)`

---

## ⚠️ 工具链修订（已生效，优先级高于下文 Task 0 的原始写法）

实测发现受限沙箱禁止**子进程管道**，直接推翻了原计划的工具链。执行者请以本节为准：

| 原计划 | 实际采用 | 原因（实测） |
|---|---|---|
| Vitest | `node tests/run-all.ts`（进程内） | Vite 在 Windows 下调 `exec('net use')` 探测网络驱动器，管道受限抛 `spawn EPERM`，且发生在**配置加载阶段**，`vitest run` 与 `vite build` 均无法启动，无法绕过 |
| `node --test` | 同上 | `node --test` 会为每个测试文件 spawn 子进程，同样 `EPERM` |
| Vite 构建 | Rollup + 自研 `transpileModule` 插件 | Rollup 是纯 JS + 原生 addon，**受限的是管道而非原生加载**，已实测可用 |
| `@rollup/plugin-typescript` | 自研插件 | 该插件按 tsconfig 的 `include` 过滤文件，会静默跳过未包含的文件，rollup 随后把 TS 当 JS 解析报 `Expected '{', got ':'` |
| pnpm 默认符号链接布局 | `.npmrc` 加 `node-linker=hoisted` | 符号链接农场被文件锁打断：`ERR_PNPM_EBUSY on native bindings` |
| 三方列表转换器 | 不适用 | 用户决定完全自研 |

**两条影响全部代码示例的约定：**
1. 源码导入一律写显式 `.ts` 后缀（Node ESM 要求显式扩展名），tsconfig 已开 `allowImportingTsExtensions`。
2. 下文所有 `import { describe, it, expect } from 'vitest'` 与 `expect(...)` 断言，一律改写成
   `import { describe, it } from 'node:test'` + `import assert from 'node:assert/strict'`
   （`toBe`→`assert.equal`，`toEqual`→`assert.deepEqual`，`toBeGreaterThan`→`assert.ok(a>b)`，
   `toMatch`→`assert.match`，`not.toThrow`→`assert.doesNotThrow`，`not.toContain`→`assert.ok(!s.includes(x))`）。

## ✅ 进度（截至 2026-10-10）

| 任务 | 状态 | 证据 |
|---|---|---|
| Task 0 脚手架 | **完成** | `pnpm typecheck` 通过 |
| Task 1 广告词库 | **完成** | `tests/unit/lexicon.test.ts` 6 用例 |
| Task 2 快照 diff | **完成** | `tests/unit/pristine.test.ts` 3 用例 |
| Task 3 广告度打分 | **完成** | `tests/unit/score.test.ts` 6 用例 |
| Task 4 选择器泛化 | **完成** | `tests/unit/selector.test.ts` 5 用例 |
| Task 5 规则模型 + DNR | **完成** | `tests/unit/rules.test.ts` 7 用例 |
| Task 6 状态清理 | **完成** | `tests/unit/scrub.test.ts` 5 用例 |
| Task 7 fixture + 站点规则包 | **完成** | `tests/unit/pilot-pack.test.ts` 15 用例，含误伤护栏 |
| Task 8 manifest + 构建 | **完成** | `node tools/build/build.mjs` → `dist/` 4 个文件，manifest 声明项自检通过 |
| Task 9 内容脚本 | **完成** | `tests/integration/content.test.ts` 22 用例 |
| Task 10 MAIN world 注入对抗 | **完成** | `tests/unit/guards.test.ts` 13 用例 |
| Task 11 Background（DNR 同步 / 规则分发 / 快照回填） | **完成** | `tests/unit/match.test.ts` 6 用例 |
| Task 12 popup + options UI | 待办 | — |
| Task 13 CDP E2E | 待办（需一次性完全权限） | — |

**当前状态：108/108 测试通过，`tsc --noEmit` 干净，`dist/` 可加载。**
构建路径已端到端验证：Rollup 产物在 jsdom 中加载并执行，`[data-ssp-slot-root]` 得分 6、
正文 `article` 得分 0、跨站推广链接（**不出现在词库中**）得分 6 —— 最后一项正是
「不依赖第三方列表也能通用」的机制证据。

### ⚠️ 实施期间发现并修正的三个设计缺陷（比原计划的对应步骤更重要）

1. **打分器的聚合结构是错的。** 原计划对整棵子树聚合跨站链接，实测导致
   `<html>`/`<body>` 各得 **20 分**——过阈值即整页消失。已改为「后代信号仅在元素
   紧凑（后代 ≤ 12 个元素）时计入」，`<html>`/`<body>` 降到 0 分。
   标定数据见设计文档 §2.5。
2. **泛化器会产出裸标签名。** 一个没有 class/id 的推广链接会被泛化成 `a`，
   一旦入库，静态规则将隐藏页面上**所有链接**。已改为返回 `null`（只隐藏、不建规则），
   并增加入库前的选择器宽度检查 `isSelectorSafe`。
3. **启发式需要完整的服务端快照才能启用。** 修好聚合后，服务端渲染的
   `.contact-link` / `footer#footer` / `div.container` 仍得 8 分（跨站社交链接），
   阈值 6 会误伤它们；抬到 10 又会丢掉「跨站 + 推广参数 = 6」这条核心检测。
   因此新增了 service worker 回填通道（`get-pristine`），并且**快照不可信时
   启发式整体关闭**。

### E2E 的补充验收项（Task 13）

除「广告消失 / 正文不变」外，还需验证：

- 回填请求**只对没有匹配到规则包的站点**发起（试点站命中规则包，应当不发）
- 回填失败时退化为仅静态规则，且**不产生任何假阳性**

---

## 阶段 0：脚手架

### Task 0：初始化工程与测试环境 ✅ 已完成

> 原始写法（Vitest/Vite）已被上文「工具链修订」推翻，下面已是实际采用的版本。

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.npmrc`, `tests/setup.ts`, `tests/run-all.ts`

**Step 1: 初始化 git 与包管理**

```powershell
git init
```

**Step 2: 写 `.npmrc`（镜像加速 + 扁平布局）**

```ini
registry=https://registry.npmmirror.com

# 沙箱环境下 pnpm 的符号链接农场会被文件锁打断（EBUSY on native bindings），
# 改用扁平布局，代价是 node_modules 稍大。
node-linker=hoisted
```

**Step 3: 写 `package.json`**

```json
{
  "name": "adblow",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "description": "自研通用 Edge (MV3) 广告过滤器：行为检测 + 自学习规则，不依赖第三方过滤列表。",
  "scripts": {
    "test": "node tests/run-all.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@rollup/plugin-node-resolve": "^16.0.3",
    "@types/chrome": "^0.3.5",
    "@types/jsdom": "^30.0.0",
    "@types/node": "^22.10.2",
    "jsdom": "^30.1.2",
    "rollup": "^4.64.4",
    "tslib": "^2.8.1",
    "typescript": "^5.9.3"
  }
}
```

**Step 4: 写 `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "types": ["node", "chrome"]
  },
  "include": ["src", "tests", "tools"]
}
```

> `allowImportingTsExtensions` 要求 `noEmit`，所以 `tsc` 只做类型检查、不产物；
> 打包交给 Rollup（见修订表）。

**Step 5: 写 `tests/setup.ts`（把 jsdom 的 DOM 挂到 Node 全局）**

```ts
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://afford.gjvrohros.cc/',
  pretendToBeVisual: true,
});

const target = globalThis as unknown as Record<string, unknown>;
const source = dom.window as unknown as Record<string, unknown>;

for (const key of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'NodeList',
  'MutationObserver', 'DOMParser', 'CSS', 'getComputedStyle', 'location', 'navigator']) {
  const value = source[key];
  if (value === undefined) continue;
  try {
    target[key] = value;
  } catch {
    // Node 24 的 navigator/location 是只读 getter，跳过即可
  }
}
```

**Step 5b: 写 `tests/run-all.ts`（单进程测试入口，零 spawn）**

```ts
import './setup.ts';          // 静态导入保证 setup 先于测试求值
import { readdirSync } from 'node:fs';

const dir = new URL('./unit/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
if (files.length === 0) { console.error('没有发现任何测试文件'); process.exit(1); }
for (const f of files) await import(new URL(f, dir).href);
```

**Step 6: 写 `.gitignore`**

```gitignore
node_modules/
dist/
coverage/
.pnpm-store/     # pnpm 把内容寻址存储建在了工程根目录，绝不能入库
_probe/          # 侦察临时区：原始页面、日志、浏览器 profile
```

**Step 7: 安装并验证**

Run: `pnpm install`
Run: `pnpm typecheck`
Expected: 无错误

Run: `pnpm test`
Expected: 此时应为 `没有发现任何测试文件` 且退出码 1（正常，下一步才写第一个测试）

**Step 8: 提交**

```powershell
git add -A; git commit -m "chore: scaffold AdBlow with rollup + node:test + jsdom"
```

> **踩坑记录：** `git add -A` 会把 `.pnpm-store/`（3183 个文件）一起暂存。
> 先确认 `.gitignore` 生效：`git add -A --dry-run | Select-String pnpm-store` 应为空。

---

## 阶段 1：纯引擎（T1，沙箱内可全部完成）

> 这一阶段是整个项目的地基。**全部任务都不需要浏览器**，因此可以在当前沙箱里一路做完。

### Task 1：自研广告词库

**Files:**
- Create: `src/engine/lexicon.ts`
- Test: `tests/unit/lexicon.test.ts`

这是「完全自研不用第三方列表」路线下的自有词库。不要抄第三方列表文件，按设计文档 §1.3 的实测证据自己写。

**Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { adSignalStrength, AD_TOKEN } from '../../src/engine/lexicon.js';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('adSignalStrength', () => {
  it('识别试点站的 SSP 属性', () => {
    expect(adSignalStrength(el('<div data-ssp-slot-root></div>'))).toBeGreaterThan(0);
    expect(adSignalStrength(el('<div data-ssp-sdk-popup-overlay></div>'))).toBeGreaterThan(0);
  });

  it('识别 xqbj SSP 组件类', () => {
    expect(adSignalStrength(el('<div class="xqbj-component-ssp-float-icon"></div>'))).toBeGreaterThan(0);
  });

  it('识别通用广告词', () => {
    for (const s of ['ad-slot', 'advert', 'guanggao', 'sponsor', 'popunder', 'adsbygoogle']) {
      expect(adSignalStrength(el(`<div class="${s}"></div>`)), s).toBeGreaterThan(0);
    }
  });

  it('不把正文卡片判成广告（误伤守卫）', () => {
    const real = el('<article itemscope itemtype="http://schema.org/BlogPosting" class=""><h2>标题</h2></article>');
    expect(adSignalStrength(real)).toBe(0);
  });

  it('不因为 id="post-card-1" 里的 "card" 而误判', () => {
    expect(adSignalStrength(el('<div id="post-card-137924" class="post-card"></div>'))).toBe(0);
  });

  it('AD_TOKEN 正则不含裸 post-card', () => {
    expect(AD_TOKEN.test('post-card')).toBe(false);
    expect(AD_TOKEN.test('ssp-card-0')).toBe(true);
  });
});
```

> 最后两个用例是**风险 B 的护栏**：`.post-card` 在全站有 110 个 `div` + 20 个 `h2`，绝不能进广告词库。

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/lexicon.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/engine/lexicon.js"`

**Step 3: 写最小实现**

`src/engine/lexicon.ts`：

```ts
/**
 * 自研广告特征词库。
 *
 * 硬约束（见设计文档 §2 风险 B）：
 *   - 不得包含裸 "post-card"：全站 110 个 div + 20 个 h2 使用该类名。
 *   - 不得包含 "article" / "BlogPosting"：那是真内容的标记。
 * 任何新增词条都必须先在 tests/unit/lexicon.test.ts 里加一条误伤守卫用例。
 */

/** 与站点无关的通用广告词根。 */
const GENERIC = [
  'advert', 'ad-slot', 'ad_slot', 'adslot', 'adbox', 'ad-box', 'adbanner',
  'guanggao', 'sponsor', 'promoted', 'popunder', 'pop-under', 'interstitial',
  'adsbygoogle', 'doubleclick', 'preroll', 'pre-roll',
];

/** 试点站自研 SSP 的专属标记（取证自 2026-10-10）。 */
const SSP_MARKERS = [
  'xqbj-component-ssp', 'xqbj-recommand-item-banner',
  'ssp-slot', 'ssp-card', 'ssp-container', 'ssp-banner',
];

export const AD_TOKEN = new RegExp(
  [
    ...GENERIC,
    ...SSP_MARKERS,
    'data-ssp-[a-z-]+',
  ].join('|'),
  'i',
);

export function adSignalStrength(el: Element): number {
  const hay = [
    el.getAttribute('class') ?? '',
    el.getAttribute('id') ?? '',
    [...el.attributes].map((a) => a.name).join(' '),
  ].join(' ');

  let score = 0;
  if (/data-ssp-|xqbj-component-ssp/.test(hay)) score += 3; // 强信号：SDK 注入标记
  else if (AD_TOKEN.test(hay)) score += 1;
  return score;
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/lexicon.test.ts`
Expected: PASS（6 个用例全绿）

**Step 5: 提交**

```powershell
git add src/engine/lexicon.ts tests/unit/lexicon.test.ts; git commit -m "feat(engine): self-authored ad lexicon with false-positive guards"
```

---

### Task 2：服务端快照索引与 diff

**Files:**
- Create: `src/engine/pristine.ts`
- Test: `tests/unit/pristine.test.ts`

这是 L3 的地基：`document_start` 时记录「服务端发来的 DOM 长什么样」，之后新增的节点即注入内容。

**Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { buildPristineIndex, isInjected, nodeSignature } from '../../src/engine/pristine.js';

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('buildPristineIndex / isInjected', () => {
  it('服务端已有节点不算注入', () => {
    const r = root('<div class="post-card" id="ssp-card-0" data-ssp-slot-node></div>');
    const idx = buildPristineIndex(r);
    expect(isInjected(r.querySelector('[data-ssp-slot-node]')!, idx)).toBe(false);
  });

  it('之后新增的 SDK 节点算注入', () => {
    const r = root('<div class="post-card" id="ssp-card-0" data-ssp-slot-node></div>');
    const idx = buildPristineIndex(r);
    const born = document.createElement('div');
    born.setAttribute('data-ssp-slot-root', '');
    r.appendChild(born);
    expect(isInjected(born, idx)).toBe(true);
  });

  it('签名忽略易变属性，因此 SDK 填充已有占位符不算注入', () => {
    const a = document.createElement('div');
    a.className = 'post-card';
    a.id = 'ssp-card-0';
    a.setAttribute('data-ssp-slot-node', '');

    const b = a.cloneNode() as HTMLElement;
    b.innerHTML = '<img src="//pic.wvxrrip.cn/x.jpeg"><p>广告文案</p>';

    expect(nodeSignature(b)).toBe(nodeSignature(a));
  });
});
```

> 第三条很关键：SDK 会**填充已有的空占位符**，而不是新建它。如果签名包含子节点，就会把「填充」误判成「注入」，逻辑就崩了。签名必须只看节点自身的稳定属性。

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/pristine.test.ts`
Expected: FAIL —— 无法解析 `../../src/engine/pristine.js`

**Step 3: 写最小实现**

`src/engine/pristine.ts`：

```ts
/**
 * 服务端快照索引。
 *
 * 设计依据（设计文档 §1.3，实测）：
 *   data-ssp-slot-root / data-ssp-sdk-popup-overlay / data-ssp-marquee*
 *   在服务端 HTML 中出现次数均为 0，全部由 SDK 运行时创建。
 *   而 data-ssp-container / data-ssp-slot-node 在服务端就存在（空占位）。
 *
 * 因此「不在快照里」是可靠的注入信号，但必须只比对节点自身属性——
 * SDK 会填充既有占位符，若把子节点算进签名会把填充误判成注入。
 */

const VOLATILE_ATTRS = new Set(['style', 'src', 'srcset', 'data-src', 'width', 'height']);

export function nodeSignature(el: Element): string {
  const attrs = [...el.attributes]
    .filter((a) => !VOLATILE_ATTRS.has(a.name) && !a.name.startsWith('data-v-'))
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(';');
  return `${el.tagName.toLowerCase()}|${attrs}`;
}

export type PristineIndex = {
  /** 签名 → 出现次数 */
  counts: Map<string, number>;
  builtAt: number;
};

export function buildPristineIndex(root: ParentNode): PristineIndex {
  const counts = new Map<string, number>();
  const walk = (n: ParentNode) => {
    for (const child of Array.from(n.children)) {
      const sig = nodeSignature(child);
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
      walk(child);
    }
  };
  walk(root);
  return { counts, builtAt: Date.now() };
}

/**
 * 判断节点是否为运行时注入。
 *
 * 注意：因为索引按签名计数，服务端存在 10 个同样的空占位符时，
 * 第 11 个同签名节点会被判为注入——这正是我们要的行为（占位符不会被复制）。
 */
export function isInjected(el: Element, index: PristineIndex): boolean {
  return (index.counts.get(nodeSignature(el)) ?? 0) === 0;
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/pristine.test.ts`
Expected: PASS

**Step 5: 提交**

```powershell
git add src/engine/pristine.ts tests/unit/pristine.test.ts; git commit -m "feat(engine): pristine snapshot index for runtime-injection detection"
```

---

### Task 3：广告度打分器

**Files:**
- Create: `src/engine/score.ts`
- Test: `tests/unit/score.test.ts`

**Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { scoreNode } from '../../src/engine/score.js';

const ctx = { pageHost: 'afford.gjvrohros.cc', viewportArea: 1920 * 1080 };

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('scoreNode', () => {
  it('SSP 注入标记直接高分', () => {
    const r = scoreNode(el('<div data-ssp-sdk-popup-overlay></div>'), ctx);
    expect(r.score).toBeGreaterThanOrEqual(6);
    expect(r.reasons).toContain('ssp-marker');
  });

  it('跨可注册域名的出站链接加分', () => {
    const r = scoreNode(
      el('<a href="https://spam.example.com/landing?click_id=1"><img src="/a.png"></a>'),
      ctx,
    );
    expect(r.reasons).toContain('cross-site-link');
  });

  it('推广参数加分', () => {
    const r = scoreNode(el('<a href="https://afford.gjvrohros.cc/x?utm_source=ad&channel=tg"></a>'), ctx);
    expect(r.reasons).toContain('promo-params');
  });

  it('同源普通正文链接不加分', () => {
    const r = scoreNode(el('<a href="/archives/137924/"><h2>帖子标题</h2></a>'), ctx);
    expect(r.score).toBe(0);
  });

  it('跨站图片加分', () => {
    const r = scoreNode(el('<img src="https://pic.wvxrrip.cn/upload_01/xiao/a.jpeg">'), ctx);
    expect(r.reasons).toContain('cross-site-media');
  });
});
```

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/score.test.ts`
Expected: FAIL

**Step 3: 写最小实现**

`src/engine/score.ts`：

```ts
import { adSignalStrength } from './lexicon.js';

export type ScoreContext = {
  pageHost: string;
  viewportArea: number;
  /** 由调用方注入，便于测试。默认取 getComputedStyle。 */
  styleOf?: (el: Element) => CSSStyleDeclaration;
};

export type ScoreResult = { score: number; reasons: string[] };

const PROMO_PARAMS = ['utm_', 'click_id', 'clickid', 'aff', 'affid', 'invite', 'channel', 'tg_id', 'from='];

/** 粗略取可注册域名：末两段。对 .com.cn 之类会不准，v1 接受。 */
export function registrableDomain(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

export function scoreNode(el: Element, ctx: ScoreContext): ScoreResult {
  const reasons: string[] = [];
  let score = 0;

  const lex = adSignalStrength(el);
  if (lex >= 3) { score += 6; reasons.push('ssp-marker'); }
  else if (lex > 0) { score += 2; reasons.push('ad-token'); }

  const pageReg = registrableDomain(ctx.pageHost);

  for (const a of Array.from(el.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (!/^https?:/i.test(href) && !href.startsWith('//')) continue;
    try {
      const u = new URL(href, `https://${ctx.pageHost}`);
      if (registrableDomain(u.hostname) !== pageReg) {
        score += 4;
        reasons.push('cross-site-link');
      }
      if (PROMO_PARAMS.some((p) => u.search.toLowerCase().includes(p))) {
        score += 2;
        reasons.push('promo-params');
      }
    } catch { /* 非法 URL 忽略 */ }
  }

  for (const m of Array.from(el.querySelectorAll('img[src],video[src],source[src]'))) {
    const src = m.getAttribute('src') ?? '';
    if (!/^(https?:)?\/\//i.test(src)) continue;
    try {
      const u = new URL(src, `https://${ctx.pageHost}`);
      if (registrableDomain(u.hostname) !== pageReg) {
        score += 3;
        reasons.push('cross-site-media');
      }
    } catch { /* ignore */ }
  }

  return { score, reasons: [...new Set(reasons)] };
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/score.test.ts`
Expected: PASS

**Step 5: 提交**

```powershell
git add src/engine/score.ts tests/unit/score.test.ts; git commit -m "feat(engine): ad-likeness scorer"
```

---

### Task 4：选择器泛化

**Files:**
- Create: `src/engine/selector.ts`
- Test: `tests/unit/selector.test.ts`

自学习的核心：把一次性指纹变成可复用规则。

**Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { generalizeSelector } from '../../src/engine/selector.js';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('generalizeSelector', () => {
  it('把数字后缀的 id 泛化为前缀匹配', () => {
    expect(generalizeSelector(el('<div class="post-card" id="ssp-card-3" data-ssp-slot-node></div>')))
      .toBe('[data-ssp-slot-node]');
  });

  it('优先使用稳定数据属性而不是易变类名', () => {
    expect(generalizeSelector(el('<div class="a1b2c3" data-ssp-slot-root=""></div>')))
      .toBe('[data-ssp-slot-root]');
  });

  it('丢弃看起来随机的哈希类名', () => {
    const s = generalizeSelector(el('<div class="xqbj-component-ssp-float-icon css-1x9f2kd"></div>'));
    expect(s).not.toContain('css-1x9f2kd');
    expect(s).toContain('xqbj-component-ssp-float-icon');
  });

  it('输出可用于 querySelector 的合法选择器', () => {
    const target = el('<div class="post-card" id="ssp-card-7" data-ssp-slot-node></div>');
    document.body.appendChild(target);
    const s = generalizeSelector(target);
    expect(() => document.querySelector(s)).not.toThrow();
    expect(document.querySelector(s)).toBe(target);
    target.remove();
  });
});
```

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/selector.test.ts`
Expected: FAIL

**Step 3: 写最小实现**

`src/engine/selector.ts`：

```ts
/**
 * 选择器泛化：把一次性节点指纹变成可复用规则。
 *
 * 优先序（越靠前越稳定）：
 *   1. 语义化 data-* 属性（data-ssp-* 等）—— 站点改版才会变
 *   2. 以分隔符结尾的稳定类名（丢弃 css-1x9f2kd 这类哈希类）
 *   3. id 前缀（把 -3 / -7 这类序号去掉）
 *   4. 兜底：标签名
 */

const HASHY = /^(?:css-|jsx-|sc-|[a-z]?\d[0-9a-f]{5,})/i;
const SEMANTIC_ATTRS = ['data-ssp-slot-root', 'data-ssp-sdk-popup-overlay', 'data-ssp-sdk-fullscreen',
  'data-ssp-marquee', 'data-ssp-slot-node', 'data-ssp-container', 'data-ssp-landing'];

export function generalizeSelector(el: Element): string {
  for (const attr of SEMANTIC_ATTRS) {
    if (el.hasAttribute(attr)) return `[${attr}]`;
  }

  for (const a of Array.from(el.attributes)) {
    if (a.name.startsWith('data-ssp-')) return `[${a.name}]`;
  }

  const classes = (el.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter((c) => c && !HASHY.test(c));
  const stable = classes.find((c) => /(?:^|[-_])(?:ssp|ad|ads|advert|banner|float|popup|sponsor)/i.test(c))
    ?? classes[0];
  if (stable) return `.${CSS.escape(stable)}`;

  const id = el.getAttribute('id');
  if (id) {
    const prefix = id.replace(/[-_]?\d+$/, '');
    if (prefix && prefix !== id) return `[id^="${CSS.escape(prefix)}"]`;
    return `#${CSS.escape(id)}`;
  }

  return el.tagName.toLowerCase();
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/selector.test.ts`
Expected: PASS

**Step 5: 提交**

```powershell
git add src/engine/selector.ts tests/unit/selector.test.ts; git commit -m "feat(engine): selector generalization for self-learning rules"
```

---

### Task 5：规则模型与 DNR 编译

**Files:**
- Create: `src/engine/rules.ts`, `src/engine/dnr.ts`
- Test: `tests/unit/rules.test.ts`

**Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { validateSitePack, type SitePack } from '../../src/engine/rules.js';
import { toDnrRules } from '../../src/engine/dnr.js';

const good: SitePack = {
  id: 'pilot',
  matches: ['*://afford.gjvrohros.cc/*', '*://cgw666.com/*'],
  network: [
    { kind: 'domain', value: 'apiad01.cc', resourceTypes: ['xmlhttprequest'] },
    { kind: 'path', value: '/ad-sdk-v', resourceTypes: ['script'] },
  ],
  cosmetic: ['[data-ssp-slot-node]', '[data-ssp-slot-root]', '.xqbj-component-ssp-float-icon'],
};

describe('validateSitePack', () => {
  it('接受合法规则包', () => {
    expect(validateSitePack(good)).toEqual([]);
  });

  it('拒绝隐藏广告容器的规则（会抹掉正文列表）', () => {
    const bad = { ...good, cosmetic: ['[data-ssp-container]'] };
    expect(validateSitePack(bad).join()).toMatch(/data-ssp-container/);
  });

  it('拒绝裸 .post-card 规则（全站 110 个 div 在用）', () => {
    const bad = { ...good, cosmetic: ['.post-card'] };
    expect(validateSitePack(bad).join()).toMatch(/post-card/);
  });

  it('拒绝拉黑素材 CDN（同时承载正文缩略图）', () => {
    const bad = { ...good, network: [{ kind: 'domain' as const, value: 'pic.wvxrrip.cn', resourceTypes: ['image' as const] }] };
    expect(validateSitePack(bad).join()).toMatch(/pic\.wvxrrip\.cn/);
  });
});

describe('toDnrRules', () => {
  it('把 domain 规则编译成 DNR 条件', () => {
    const rules = toDnrRules([{ kind: 'domain', value: 'apiad01.cc', resourceTypes: ['xmlhttprequest'] }], 1000);
    expect(rules[0].action).toEqual({ type: 'block' });
    expect(rules[0].condition.urlFilter).toBe('||apiad01.cc^');
    expect(rules[0].priority).toBeGreaterThan(0);
  });

  it('把 path 规则编译成不绑域名的 urlFilter', () => {
    const rules = toDnrRules([{ kind: 'path', value: '/ad-sdk-v', resourceTypes: ['script'] }], 2000);
    expect(rules[0].condition.urlFilter).toBe('/ad-sdk-v');
    expect(rules[0].condition.resourceTypes).toEqual(['script']);
  });

  it('id 连续且不重复', () => {
    const rules = toDnrRules(good.network, 500);
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/rules.test.ts`
Expected: FAIL

**Step 3: 写最小实现**

`src/engine/rules.ts`：

```ts
/** 自研规则模型。不兼容 ABP 语法（本项目刻意不引入第三方列表）。 */

export type ResourceType = chrome.declarativeNetRequest.ResourceType;

export type NetworkRule = {
  kind: 'domain' | 'path' | 'regex';
  value: string;
  resourceTypes: ResourceType[];
};

export type SitePack = {
  id: string;
  matches: string[];
  network: NetworkRule[];
  cosmetic: string[];
};

/**
 * 误伤护栏（设计文档 §2 实测取证）。
 * 任何命中此列表的内置站点规则包都视为非法——这些改动会让网站不可用。
 */
const FORBIDDEN_COSMETIC = [
  { re: /^\[data-ssp-container\]$/, why: 'data-ssp-container 内部承载真实 <article> 正文列表，隐藏它会抹掉正文' },
  { re: /(^|[\s,>])\.post-card(?![-\w])/, why: '.post-card 全站有 110 个 div + 20 个 h2 在用，裸选择器会误伤正文' },
];

const FORBIDDEN_NETWORK = [
  { re: /pic\.wvxrrip\.cn/, why: 'pic.wvxrrip.cn 同时承载正文缩略图（loadBannerDirect 直接绑定到 #post-card-*）' },
];

export function validateSitePack(pack: SitePack): string[] {
  const problems: string[] = [];

  for (const sel of pack.cosmetic) {
    for (const f of FORBIDDEN_COSMETIC) {
      if (f.re.test(sel.trim())) problems.push(`cosmetic "${sel}" 被拒绝：${f.why}`);
    }
  }
  for (const r of pack.network) {
    for (const f of FORBIDDEN_NETWORK) {
      if (f.re.test(r.value)) problems.push(`network "${r.value}" 被拒绝：${f.why}`);
    }
  }
  return problems;
}
```

`src/engine/dnr.ts`：

```ts
import type { NetworkRule } from './rules.js';

/** 把自研网络规则编译成 declarativeNetRequest 规则。 */
export function toDnrRules(
  rules: NetworkRule[],
  idBase: number,
): chrome.declarativeNetRequest.Rule[] {
  return rules.map((r, i) => ({
    id: idBase + i,
    priority: 1,
    action: { type: 'block' as chrome.declarativeNetRequest.RuleActionType },
    condition: {
      ...(r.kind === 'domain'
        ? { urlFilter: `||${r.value}^` }
        : r.kind === 'path'
          ? { urlFilter: r.value }
          : { regexFilter: r.value }),
      resourceTypes: r.resourceTypes as chrome.declarativeNetRequest.ResourceType[],
    },
  }));
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/rules.test.ts`
Expected: PASS

**Step 5: 提交**

```powershell
git add src/engine/rules.ts src/engine/dnr.ts tests/unit/rules.test.ts
git commit -m "feat(engine): rule model, DNR compiler, and false-positive guardrails"
```

---

### Task 6：持久化状态清理规划

**Files:**
- Create: `src/engine/scrub.ts`
- Test: `tests/unit/scrub.test.ts`

对应设计文档 §1.4：站点的「本地降级体系」把弹窗状态存在 `localStorage` / `sessionStorage` / `window.name` 三处。

**Step 1: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { keysToScrub, scrubWindowName } from '../../src/engine/scrub.js';

describe('keysToScrub', () => {
  it('命中试点站实测的弹窗状态键', () => {
    const keys = ['__ai_float_pending__', '__ai_float_pending_winname__', '__ai_float_beacon__', 'unrelated'];
    expect(keysToScrub(keys)).toEqual([
      '__ai_float_pending__', '__ai_float_pending_winname__', '__ai_float_beacon__',
    ]);
  });

  it('不误删普通站点数据', () => {
    expect(keysToScrub(['theme', 'token', 'cart'])).toEqual([]);
  });
});

describe('scrubWindowName', () => {
  it('移除 window.name 里的弹窗状态键但保留其他字段', () => {
    const name = JSON.stringify({ keep: 1, __ai_float_pending_winname__: { id: 9 } });
    expect(JSON.parse(scrubWindowName(name))).toEqual({ keep: 1 });
  });

  it('非 JSON 的 window.name 原样返回', () => {
    expect(scrubWindowName('plain-name')).toBe('plain-name');
  });
});
```

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/scrub.test.ts`
Expected: FAIL

**Step 3: 写最小实现**

`src/engine/scrub.ts`：

```ts
/**
 * 持久化弹窗状态清理。
 *
 * 依据（设计文档 §1.4）：页面内联脚本自称「本地降级体系」，
 * 用 localStorage + sessionStorage + window.name 三处持久化弹窗状态，
 * 并在 pagehide 挂 beacon 重试。只拦 window.open 会被刷新后自动重开绕过。
 */

const SCRUB_PATTERNS = [
  /^__ai_float_pending/,
  /^__ai_float_beacon/,
  /^__ai_float_popup/,
];

export function keysToScrub(keys: string[]): string[] {
  return keys.filter((k) => SCRUB_PATTERNS.some((re) => re.test(k)));
}

export function scrubWindowName(name: string): string {
  if (!name) return name;
  let parsed: unknown;
  try {
    parsed = JSON.parse(name);
  } catch {
    return name;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return name;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SCRUB_PATTERNS.some((re) => re.test(k))) out[k] = v;
  }
  return JSON.stringify(out);
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/scrub.test.ts`
Expected: PASS

**Step 5: 提交**

```powershell
git add src/engine/scrub.ts tests/unit/scrub.test.ts; git commit -m "feat(engine): popup-state scrub planner"
```

---

## 阶段 2：试点站规则包

### Task 7：建立 fixture 与站点规则包

**Files:**
- Create: `tools/recon/fetch.mjs`（从 `_probe/fetch.mjs` 整理而来）
- Create: `tests/fixtures/pilot-category.html`（真实抓取，172KB）
- Create: `src/rules/sites/pilot.json`
- Test: `tests/unit/pilot-pack.test.ts`

**Step 1: 把侦察脚本正规化**

```powershell
New-Item -ItemType Directory -Force tools\recon | Out-Null
Copy-Item _probe\fetch.mjs tools\recon\fetch.mjs
Copy-Item _probe\fetch-sdk.mjs tools\recon\fetch-sdk.mjs
Copy-Item _probe\page.html tests\fixtures\pilot-category.html 2>$null
New-Item -ItemType Directory -Force tests\fixtures | Out-Null
```

**Step 2: 写站点规则包 `src/rules/sites/pilot.json`**

```json
{
  "id": "pilot-cgw",
  "matches": [
    "*://afford.gjvrohros.cc/*",
    "*://cgw666.com/*",
    "*://*.gjvrohros.cc/*"
  ],
  "network": [
    { "kind": "path",   "value": "/ad-sdk-v",             "resourceTypes": ["script"] },
    { "kind": "domain", "value": "apiad01.cc",            "resourceTypes": ["xmlhttprequest"] },
    { "kind": "domain", "value": "ads.zyudkkup.com",      "resourceTypes": ["xmlhttprequest", "ping", "image"] },
    { "kind": "domain", "value": "api.zzlprxy.cc",        "resourceTypes": ["xmlhttprequest"] },
    { "kind": "domain", "value": "wj-api-abtest.yvyjdhr.com", "resourceTypes": ["xmlhttprequest"] },
    { "kind": "domain", "value": "mc.yandex.ru",          "resourceTypes": ["script", "image", "ping"] },
    { "kind": "domain", "value": "googletagmanager.com",  "resourceTypes": ["script"] }
  ],
  "cosmetic": [
    "[data-ssp-slot-node]",
    "[id^=\"ssp-card-\"]",
    "[data-ssp-slot-root]",
    "[data-ssp-sdk-popup-overlay]",
    "[data-ssp-sdk-fullscreen]",
    "[data-ssp-marquee]",
    "[data-ssp-marquee-viewport]",
    "[data-ssp-landing]",
    ".xqbj-component-ssp-float-icon",
    ".xqbj-component-ssp-popup-icon-container",
    ".xqbj-component-ssp-horizontal-banner-widget",
    ".xqbj-component-ssp-icon-grid",
    ".xqbj-component-ssp-text-grid",
    ".xqbj-recommand-item-banner",
    ".xqbj-recommand-item-banner-mesosphere"
  ]
}
```

> **注意这里没有的东西，比有的东西更重要：** 没有 `[data-ssp-container]`、没有 `.post-card`、没有 `pic.wvxrrip.cn`。下一条测试就是守住这三点。

**Step 3: 写失败的测试**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateSitePack, type SitePack } from '../../src/engine/rules.js';

const pack = JSON.parse(
  readFileSync(new URL('../../src/rules/sites/pilot.json', import.meta.url), 'utf8'),
) as SitePack;

describe('pilot 站点规则包', () => {
  it('通过误伤护栏校验', () => {
    expect(validateSitePack(pack)).toEqual([]);
  });

  it('包含拦 SDK 脚本这条最高收益规则', () => {
    expect(pack.network.some((r) => r.kind === 'path' && r.value === '/ad-sdk-v')).toBe(true);
  });

  it('不包含任何会隐藏正文的选择器', () => {
    const joined = pack.cosmetic.join(' ');
    expect(joined).not.toContain('[data-ssp-container]');
    expect(joined).not.toMatch(/(^|\s)\.post-card(\s|$)/);
    expect(joined).not.toContain('.post-card');
  });

  it('不包含素材 CDN（同时承载正文缩略图）', () => {
    const joined = pack.network.map((r) => r.value).join(' ');
    expect(joined).not.toContain('pic.wvxrrip.cn');
  });
});

describe('fixture 与规则的一致性', () => {
  const html = readFileSync(
    new URL('../fixtures/pilot-category.html', import.meta.url),
    'utf8',
  ).toString();

  it('fixture 里确实存在空广告占位符', () => {
    expect(html).toMatch(/data-ssp-slot-node/);
    expect((html.match(/data-ssp-slot-node/g) ?? []).length).toBeGreaterThan(0);
  });

  it('fixture 里确实不存在 SDK 注入标记（验证 diff 思路成立）', () => {
    expect(html).not.toContain('data-ssp-slot-root');
    expect(html).not.toContain('data-ssp-sdk-popup-overlay');
  });

  it('fixture 里 .post-card 同时被 div 使用，证明裸选择器危险', () => {
    const divs = (html.match(/<div[^>]*class="[^"]*\bpost-card\b[^"]*"/g) ?? []).length;
    expect(divs).toBeGreaterThan(50);
  });
});
```

**Step 4: 运行验证**

Run: `pnpm vitest run tests/unit/pilot-pack.test.ts`
Expected: 全绿。**如果有任何一条红，不要改测试，改规则包。**

**Step 5: 提交**

```powershell
git add src/rules/sites/pilot.json tests/fixtures/pilot-category.html tests/unit/pilot-pack.test.ts tools/recon
git commit -m "feat(rules): pilot site pack with evidence-backed false-positive guards"
```

---

## 阶段 3：运行时（T2 仿真可覆盖大部分）

### Task 8：manifest 与构建

**Files:**
- Create: `public/manifest.json`, `vite.config.ts`, `src/background/index.ts`

**Step 1: 写 `public/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "AdBlow",
  "version": "0.1.0",
  "description": "自研通用广告过滤器：行为检测 + 自学习规则，不依赖第三方列表。",
  "minimum_chrome_version": "120",
  "permissions": [
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "scripting",
    "storage",
    "tabs"
  ],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["cosmetic.css"],
      "run_at": "document_start",
      "all_frames": true
    }
  ],
  "web_accessible_resources": [
    { "resources": ["inject.js"], "matches": ["<all_urls>"] }
  ]
}
```

**Step 2: 写 `vite.config.ts`（多入口，扩展场景不能用 SPA 默认配置）**

```ts
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        inject: resolve(__dirname, 'src/inject/index.ts'),
        popup: resolve(__dirname, 'src/ui/popup.html'),
        options: resolve(__dirname, 'src/ui/options.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
  publicDir: 'public',
});
```

**Step 3: 验证构建通过**

Run: `pnpm build`
Expected: `dist/manifest.json`、`dist/background.js`、`dist/content.js` 均生成

**Step 4: 提交**

```powershell
git add public/manifest.json vite.config.ts; git commit -m "feat: MV3 manifest and multi-entry vite build"
```

---

### Task 9：内容脚本 —— 应用规则、观察注入、自学习

**Files:**
- Create: `src/content/index.ts`, `src/content/apply.ts`, `src/content/learn.ts`, `public/cosmetic.css`
- Test: `tests/integration/content.test.ts`（jsdom 回放 fixture）

**Step 1: 写失败的集成测试**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildPristineIndex, isInjected } from '../../src/engine/pristine.js';
import { scoreNode } from '../../src/engine/score.js';
import { generalizeSelector } from '../../src/engine/selector.js';

const html = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');

describe('jsdom 回放：注入识别与误伤守卫', () => {
  it('服务端占位符不被判为注入，模拟 SDK 注入的节点被判为注入', () => {
    document.documentElement.innerHTML = html;
    const idx = buildPristineIndex(document.documentElement);

    const slot = document.querySelector('[data-ssp-slot-node]')!;
    expect(isInjected(slot, idx)).toBe(false);

    // 模拟 SDK 运行时注入
    const born = document.createElement('div');
    born.setAttribute('data-ssp-sdk-popup-overlay', '');
    document.body.appendChild(born);
    expect(isInjected(born, idx)).toBe(true);
    expect(scoreNode(born, { pageHost: 'afford.gjvrohros.cc', viewportArea: 1920 * 1080 }).score)
      .toBeGreaterThanOrEqual(6);
    expect(generalizeSelector(born)).toBe('[data-ssp-sdk-popup-overlay]');
  });

  it('正文 <article> 全部不被判为注入', () => {
    document.documentElement.innerHTML = html;
    const idx = buildPristineIndex(document.documentElement);
    const articles = Array.from(document.querySelectorAll('article[itemtype*="BlogPosting"]'));
    expect(articles.length).toBeGreaterThan(0);
    for (const a of articles) expect(isInjected(a, idx)).toBe(false);
  });

  it('站内正文链接不会被判成跨站广告', () => {
    document.documentElement.innerHTML = html;
    const links = Array.from(document.querySelectorAll('a[href^="/archives/"]')).slice(0, 20);
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const r = scoreNode(a, { pageHost: 'afford.gjvrohros.cc', viewportArea: 1920 * 1080 });
      expect(r.reasons).not.toContain('cross-site-link');
    }
  });
});
```

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/integration/content.test.ts`
Expected: FAIL（`tests/fixtures/pilot-category.html` 不存在时先补 —— 见 Task 7 Step 1；若 html 太大导致 jsdom 慢，可裁剪为前 3000 行并另存 `pilot-head.html`）

**Step 3: 实现内容脚本**

`src/content/apply.ts`：

```ts
/** 应用外观规则。使用 USER 源样式，天然压制作者样式（设计文档 §4）。 */

export async function applyStaticCosmetic(selectors: string[]): Promise<void> {
  if (!selectors.length) return;
  const css = selectors
    .map((s) => `${s}{display:none !important;height:0 !important;margin:0 !important;padding:0 !important;}`)
    .join('\n');

  await chrome.scripting.insertCSS({
    target: { tabId: (await currentTabId())!, allFrames: true },
    css,
    origin: 'USER',
  });
}

async function currentTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}
```

`src/content/learn.ts`：

```ts
/**
 * 自学习：泛化选择器按站点入库。
 *
 * 抗污染：同一泛化选择器需累计命中 PROMOTE_AFTER 次才提升为持久规则，
 * 否则只在本页面内即时生效。用户可在选项页一键撤销。
 */

const PROMOTE_AFTER = 3;

type LearnedStore = Record<string, { selector: string; hits: number; promoted: boolean }>;

export async function recordHit(host: string, selector: string): Promise<void> {
  const key = `learned:${host}`;
  const cur = ((await chrome.storage.local.get(key))[key] ?? {}) as LearnedStore;
  const entry = cur[selector] ?? { selector, hits: 0, promoted: false };
  entry.hits += 1;
  if (entry.hits >= PROMOTE_AFTER) entry.promoted = true;
  cur[selector] = entry;
  await chrome.storage.local.set({ [key]: cur });
}

export async function promotedSelectors(host: string): Promise<string[]> {
  const key = `learned:${host}`;
  const cur = ((await chrome.storage.local.get(key))[key] ?? {}) as LearnedStore;
  return Object.values(cur).filter((e) => e.promoted).map((e) => e.selector);
}
```

`src/content/index.ts`：

```ts
import { buildPristineIndex, isInjected } from '../engine/pristine.js';
import { scoreNode } from '../engine/score.js';
import { generalizeSelector } from '../engine/selector.js';
import { validateSitePack, type SitePack } from '../engine/rules.js';
import { recordHit, promotedSelectors } from './learn.js';
import { applyStaticCosmetic } from './apply.js';

const SCORE_THRESHOLD = 6;

async function boot(): Promise<void> {
  const host = location.hostname;
  const index = buildPristineIndex(document.documentElement);

  const packs = (await chrome.runtime.sendMessage({ type: 'get-site-packs', host })) as SitePack[];
  const cosmetics = packs.flatMap((p) => {
    const problems = validateSitePack(p);
    if (problems.length) console.warn('[adblow] 规则包被护栏拒绝', p.id, problems);
    return problems.length ? [] : p.cosmetic;
  });

  await applyStaticCosmetic([...cosmetics, ...(await promotedSelectors(host))]);

  const hide = (el: Element) => {
    el.setAttribute('data-adblow-hidden', '1');
    (el as HTMLElement).style.setProperty('display', 'none', 'important');
  };

  const judge = (el: Element) => {
    if (!isInjected(el, index)) return;
    const { score, reasons } = scoreNode(el, {
      pageHost: host,
      viewportArea: innerWidth * innerHeight,
    });
    if (score < SCORE_THRESHOLD) return;
    hide(el);
    void recordHit(host, generalizeSelector(el));
    console.debug('[adblow] hidden', generalizeSelector(el), score, reasons);
  };

  new MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (n.nodeType === 1) judge(n as Element);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 兜底：已存在的节点也判一次（SDK 可能在 observer 挂上之前就跑了）
  for (const el of Array.from(document.querySelectorAll('body *'))) judge(el);
}

void boot();
```

`public/cosmetic.css`（静态 CSS，保证 document_start 就位、无闪白）：

```css
/* 空占位符必须塌陷，否则拦掉 SDK 后列表里会留一排空洞 */
[data-ssp-slot-node]:empty,
[data-ssp-slot-root]:empty {
  display: none !important;
  height: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
}
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run`
Run: `pnpm typecheck`
Expected: 全绿、无类型错误

**Step 5: 提交**

```powershell
git add src/content public/cosmetic.css tests/integration
git commit -m "feat(content): pristine-diff injection detector with self-learning rules"
```

---

### Task 10：MAIN world 注入对抗

**Files:**
- Create: `src/inject/index.ts`, `src/inject/guards.ts`
- Test: `tests/unit/guards.test.ts`

**Step 1: 写失败的测试（纯逻辑部分）**

```ts
import { describe, it, expect } from 'vitest';
import { shouldAllowOpen } from '../../src/inject/guards.js';

describe('shouldAllowOpen', () => {
  it('拦截跨站无手势弹窗', () => {
    expect(shouldAllowOpen('https://spam.example.com/x', 'afford.gjvrohros.cc', false)).toBe(false);
  });

  it('放行同站弹窗', () => {
    expect(shouldAllowOpen('/archives/1/', 'afford.gjvrohros.cc', true)).toBe(true);
  });

  it('放行用户手势触发的跨站链接', () => {
    expect(shouldAllowOpen('https://twitter.com/x', 'afford.gjvrohros.cc', true)).toBe(true);
  });

  it('拦截 about:blank 与空目标的无手势弹窗', () => {
    expect(shouldAllowOpen('about:blank', 'afford.gjvrohros.cc', false)).toBe(false);
  });
});
```

**Step 2: 运行验证失败**

Run: `pnpm vitest run tests/unit/guards.test.ts`
Expected: FAIL

**Step 3: 写实现**

`src/inject/guards.ts`：

```ts
import { registrableDomain } from '../engine/score.js';

/**
 * window.open 放行策略。
 * 站点会用无手势的 window.open 开弹窗/充值页，并靠持久化状态在刷新后重开。
 * 策略：无用户手势时只允许同可注册域名且非 about:blank 的目标。
 */
export function shouldAllowOpen(
  url: string,
  pageHost: string,
  hadUserGesture: boolean,
): boolean {
  if (hadUserGesture) return true;
  if (!url || url === 'about:blank' || url === 'javascript:void(0)') return false;
  try {
    const u = new URL(url, `https://${pageHost}`);
    return registrableDomain(u.hostname) === registrableDomain(pageHost);
  } catch {
    return false;
  }
}
```

`src/inject/index.ts`：

```ts
import { keysToScrub, scrubWindowName } from '../engine/scrub.js';
import { shouldAllowOpen } from './guards.js';

/**
 * MAIN world 注入（必须在 MAIN：window.open 只能在页面自身上下文里改）。
 * 设计依据：设计文档 §1.4 与 §3-L4。
 */

let hadGesture = false;
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
  addEventListener(ev, () => { hadGesture = true; }, { capture: true, passive: true });
}

// 1) window.open 守卫
const rawOpen = window.open.bind(window);
Object.defineProperty(window, 'open', {
  configurable: false,
  writable: false,
  value: (url?: string | URL, target?: string, features?: string) => {
    const s = String(url ?? '');
    if (!shouldAllowOpen(s, location.hostname, hadGesture)) {
      console.debug('[adblow] blocked window.open', s, target);
      return null;
    }
    return rawOpen(url as string, target, features);
  },
});

// 2) 持久化弹窗状态清理
function scrub(): void {
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (const k of keysToScrub(Object.keys(store))) store.removeItem(k);
    } catch { /* 某些上下文禁用 storage */ }
  }
  try {
    window.name = scrubWindowName(window.name);
  } catch { /* ignore */ }
}
scrub();
setInterval(scrub, 2000);

// 3) 拦截挂在 pagehide / beforeunload 上的广告 beacon
const rawAdd = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (
  this: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) {
  if ((type === 'pagehide' || type === 'beforeunload') && this === window) {
    const src = typeof listener === 'function' ? listener.toString() : '';
    if (/beacon|report|track|pending/i.test(src)) {
      console.debug('[adblow] blocked beacon listener', type);
      return;
    }
  }
  return rawAdd.call(this, type, listener, options);
};
```

**Step 4: 运行验证通过**

Run: `pnpm vitest run tests/unit/guards.test.ts` 然后 `pnpm test`
Expected: 全绿

**Step 5: 提交**

```powershell
git add src/inject tests/unit/guards.test.ts; git commit -m "feat(inject): window.open guard, state scrub, beacon-listener block"
```

---

### Task 11：Background —— DNR 同步与站点规则分发

**Files:**
- Create: `src/background/index.ts`
- Create: `src/rules/sites/index.ts`（静态导入所有规则包，便于打包期收集）

**Step 1: 实现**

```ts
import { toDnrRules } from '../engine/dnr.js';
import { validateSitePack } from '../engine/rules.js';
import { SITE_PACKS } from '../rules/sites/index.js';

/**
 * 启动时把自研网络规则同步为 DNR 静态规则的补充动态规则。
 * MV3 无阻塞式 webRequest，网络拦截只能走 declarativeNetRequest。
 */

const ID_BASE = 10000;

async function syncDnr(): Promise<void> {
  const all = SITE_PACKS.flatMap((p) => (validateSitePack(p).length ? [] : p.network));
  const desired = toDnrRules(all, ID_BASE);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: desired,
  });
  console.log(`[adblow] synced ${desired.length} DNR rules`);
}

chrome.runtime.onInstalled.addListener(() => void syncDnr());
chrome.runtime.onStartup.addListener(() => void syncDnr());

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg?.type === 'get-site-packs') {
    const host: string = msg.host ?? '';
    respond(SITE_PACKS.filter((p) => p.matches.some((m) => matchPattern(m, host))));
    return true;
  }
  if (msg?.type === 'get-stats') {
    void chrome.declarativeNetRequest.getMatchedRules({}).then((r) => respond(r));
    return true;
  }
  return false;
});

function matchPattern(pattern: string, host: string): boolean {
  const m = pattern.match(/^\*:\/\/([^/]+)\//);
  if (!m) return false;
  const hostPat = m[1]!;
  if (hostPat.startsWith('*.')) return host.endsWith(hostPat.slice(2));
  return host === hostPat;
}
```

**Step 2: 提交**

```powershell
git add src/background src/rules/sites/index.ts; git commit -m "feat(background): DNR rule sync and site-pack dispatch"
```

---

## 阶段 4：UI

### Task 12：popup —— 开关、统计、元素拾取

**Files:** Create `src/ui/popup.html`, `src/ui/popup.ts`, `src/ui/options.html`, `src/ui/options.ts`

**功能清单（v1）：**
- 当前站点总开关（`chrome.storage.local` 的 `disabled:<host>`）
- 本次拦截计数（`declarativeNetRequest.getMatchedRules` + 内容脚本上报的隐藏数）
- 「元素拾取」按钮：向内容脚本发 `start-picker`，页面上悬浮高亮并显示将生成的泛化选择器，点击即入库
- 「临时移除」按钮（zap）：只隐藏不建规则
- 选项页：按站点列出已学习规则，支持删除/导出 JSON

**验收：** `pnpm build` 后 `dist/popup.html` 可打开且无控制台报错。

**提交：** `git commit -m "feat(ui): popup and options with element picker"`

---

## 阶段 5：浏览器 E2E（**需要一次性完全权限**）

> ⚠️ 前置条件：本阶段在受限沙箱下**必然失败**。已实测：`mojo/platform_channel.cc: Check failed: 拒绝访问 (0x5)`。
> 执行到这里时，先向用户申请一次性完全权限，再运行。**不要试图绕过或反复重试。**

### Task 13：CDP 驱动工具

**Files:**
- Create: `tools/e2e/launch.mjs`（整理自 `_probe/cdp-debug.mjs`，已验证的启动方式）
- Create: `tools/e2e/assert-pilot.mjs`

**启动参数（照抄，已实测可行的那一套）：**

```js
const args = [
  '--remote-debugging-port=9444',
  '--remote-allow-origins=*',
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-gpu', '--disable-dev-shm-usage',
  '--headless=new',
  'about:blank',
];
```

**关键实现细节（踩过的坑，别重犯）：**
- 用 `stdio: ['ignore', fd, fd]` 把输出重定向到**文件**。沙箱禁止管道，用 `pipe` 会 `EPERM`。
- 用 Node 24 内置的 `fetch` 与 `WebSocket`，零依赖。
- 扩展是否加载成功，靠 `/json/list` 里出现 `type === 'service_worker'` 且 url 以 `chrome-extension://` 开头的 target 来判断。

**Step 1: 写断言脚本**

必须先跑「基线」再跑「净化后」，否则无法证明没误伤。

```js
// 伪代码骨架，Task 13 中实现
const baseline = await measure(page, { extensionDisabled: true });
const filtered = await measure(page, { extensionDisabled: false });

assert.equal(countAdHostRequests(filtered), 0, '广告域名请求必须为 0');
assert.equal(await countRenderedAdSlots(filtered), 0, 'SSP 广告位渲染数必须为 0');
assert.equal(filtered.visibleArticles, baseline.visibleArticles, '正文数量必须与基线一致（误伤守卫）');
assert.equal(filtered.popupsOpened, 0, '不得产生弹窗');
assert.ok(filtered.contentImagesLoaded > 0, 'pic.wvxrrip.cn 的正文图片必须仍能加载（误伤守卫）');
```

**measure() 需要采集：**
- `Network.requestWillBeSent` 全部 URL（判广告域名请求数、正文图片数）
- `Runtime.evaluate` 统计 `document.querySelectorAll('article[itemtype*="BlogPosting"]')` 中**可见**数量（`offsetParent !== null` 且非 `display:none`）
- `Runtime.evaluate` 统计 `[data-ssp-slot-node]` 中**有内容**的数量
- 监听 `Page.windowOpen` 或 hook `window.open` 计数

**Step 2: 运行（需完全权限）**

Run: `node tools/e2e/assert-pilot.mjs`

**Step 3: 记录结果并据实标定**

把实测结果回写进设计文档 §7 的待验证项 1–5，并据此调整 `SCORE_THRESHOLD`（初始 6）。

**Step 4: 提交**

```powershell
git add tools/e2e; git commit -m "test(e2e): CDP harness with false-positive guards on pilot site"
```

---

## 完成判据

全部满足才算 v1 完成：

1. `pnpm test` 全绿，且 `tests/unit/lexicon.test.ts`、`tests/unit/rules.test.ts`、`tests/unit/pilot-pack.test.ts` 里的**误伤守卫用例**都在
2. `pnpm typecheck` 无错误
3. `pnpm build` 产出可加载的 `dist/`
4. 在 Edge 开发者模式加载 `dist/` 后访问试点站：**无广告位渲染、无弹窗、正文列表完整、缩略图正常**
5. E2E 三条误伤守卫断言全绿（正文数量、正文图片、无弹窗）
6. 设计文档 §7 的 5 项待验证项全部有实测结论

## 阶段依赖

```
Task 0 ─┬─ Task 1 ─┬─ Task 3 ─┬─ Task 5 ─┬─ Task 7 ─┬─ Task 8 ─┬─ Task 9 ─┬─ Task 10 ─┬─ Task 11 ─┬─ Task 12 ─┬─ Task 13
        │          │          │          │          │          │          │           │           │           │
        └─ Task 2 ─┘          └─ Task 4 ─┘          └─ Task 6 ─┘          └───────────┘           └───────────┘
                                                              （Task 6 可与 4/5 并行）
```

Task 1–7 全部在沙箱内完成，不会遇到权限问题。**只有 Task 13 需要申请完全权限。**
