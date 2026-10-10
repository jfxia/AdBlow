# AdBlow 设计文档

> 日期：2026-10-10 · 状态：待评审 · 试点：`https://afford.gjvrohros.cc/category/jrxw1/`

**目标一句话：** 做一个不依赖任何第三方过滤列表的 Edge (MV3) 广告过滤器，靠「运行时行为检测 + 自学习规则库」在名单型屏蔽器失效的站点上也能做到广告零残留、内容零误伤。

---

## 1. 为什么 AdBlock / AdBlock Plus 在这个站点失效

这不是"规则不够全"，是**范式不匹配**。以下为 2026-10-10 实测取证结论。

### 1.1 广告是第一方自研 SSP，不是第三方广告联盟

页面内联脚本里直接暴露了广告服务配置：

```js
sspConfig: {
  appKey: "TTbLqvit...",                    // 自建 SSP 的密钥
  baseUrl: "https://apiad01.cc",            // 自研广告服务端
  cdnDomain: "https://pic.wvxrrip.cn",      // 素材 CDN
  sdkUrl: "./ad-sdk-v0.0.4.10.js"           // SDK 由站点自己托管
}
```

SDK 实体位于站点自身目录：`/usr/themes/Mirages/js/7.10.0/ad-sdk-v0.0.4.10.js`（156,995 字节，6 行压缩）。
广告竞价接口只有两个：`POST /api/sdk/ad/available` 与 `/api/sdk/ad/request`。

**含义：** 域名黑名单挡不住第一方路径。整站广告流量里，只有 `apiad01.cc` 这一个第三方域名是必需的，其余全部同源。

### 1.2 广告卡片伪装成正文卡片

广告位在服务端 HTML 里就已经是**空的正文卡占位符**：

```html
<div data-ssp-container="ssp-list" data-el-ignore>
  <div class="post-card" id="ssp-card-0" data-ssp-slot-node></div>
  <div class="post-card" id="ssp-card-1" data-ssp-slot-node></div>
  ... 共 10 个
</div>
```

而**真内容 `<article>` 与这些空占位符交错在同一个容器里**。实测该容器内真 `<article>` 节点存在，且：

- 全站带 `.post-card` 类的元素：`div` 110 个、`h2` 20 个
- 真内容的标签是 `<article itemscope itemtype="http://schema.org/BlogPosting">`，**不带** `post-card` 类

**含义：** EasyList 一类的通用外观规则不可能命中——因为类名和真内容完全撞车。任何按 `.post-card` 或 `[data-ssp-container]` 下手的规则都会把正文列表一起抹掉。

### 1.3 真正的判别信号是「运行时注入」

服务端 HTML 与 SDK 运行后的 DOM 对比（实测计数）：

| 标记 | 服务端 HTML 中出现次数 | 来源 |
|---|---|---|
| `data-ssp-container` | 2（空占位容器） | 服务端 |
| `data-ssp-slot-node` | 10（空占位） | 服务端 |
| `data-ssp-slot-root` | **0** | SDK 注入 |
| `data-ssp-sdk-popup-overlay` | **0** | SDK 注入 |
| `data-ssp-sdk-fullscreen` | **0** | SDK 注入 |
| `data-ssp-marquee*` | **0** | SDK 注入 |

SDK 会创建这些广告组件（由 SDK 内 `setAttribute` 调用与 `ssp.css` 逆向得出）：

| 组件 class | 形态 |
|---|---|
| `.xqbj-component-ssp-float-icon` | 悬浮球 |
| `.xqbj-component-ssp-popup-icon-*` | 弹窗覆盖层（图标宫格） |
| `.xqbj-component-ssp-list-card` | 信息流原生卡（伪装成帖子） |
| `.xqbj-component-ssp-horizontal-banner` | 横向横幅 |
| `.xqbj-component-ssp-icon-grid` / `-text-grid` | 图标/文字宫格 |
| `data-ssp-marquee-*` | 跑马灯广告 |
| `data-ssp-sdk-popup-overlay` / `-fullscreen` | 注入式覆盖层 |

**含义：** 「服务端快照里没有、之后凭空长出来的节点」是一个比域名名单强大得多、且不依赖站点改版的通用信号。这是 AdBlow 引擎的地基。

### 1.4 弹窗状态被持久化，关掉会自动重开

页面内联脚本中有一段自称「本地降级体系（`__AI_OPENER__` 不可用时完整替代其全部功能）」的代码，注释明确写着：

```
// 对齐：pending持久化 / 刷新重连 / 超时补偿 / beacon重试
// / pagehide beacon / visibilitychange / 充值页刷新
```

它使用 `localStorage` + `sessionStorage` + `window.name` 三处持久化弹窗状态，键名包括 `__ai_float_pending__`、`__ai_float_pending_winname__`、`__ai_float_beacon__`。

**含义：** 只拦 `window.open` 不够，状态还在，刷新就重开。必须同时清理持久化状态，并对 `pagehide` / `beforeunload` 上的 beacon 重挂做拦截。

### 1.5 站点多域名轮换 + 按访客 A/B 分流

- 实际访问域名 `afford.gjvrohros.cc`，而 canonical 指向 `https://cgw666.com/`
- JS 里存在模板占位符 `{share.aikjzz}`，说明存在域名生成机制
- A/B 实验接口 `https://api.zzlprxy.cc/api/ab-test/group` 与 `/upload`，另有 `fp.min.js`（浏览器指纹）、`ads.zyudkkup.com/api/eventTracking/report.json`（归因上报）、Yandex Metrica、Google Tag Manager

**含义：** A/B 分流意味着**同一个站在不同访客看到的 DOM 结构不同**。任何写死的选择器都会对一部分访客失效。这从另一个角度证明了必须做行为检测 + 自学习，而不是维护静态规则。

---

## 2. 两个必须锁死的误伤风险

误伤比漏拦更严重——漏拦只是有广告，误伤是网站不能用。

### 风险 A：`pic.wvxrrip.cn` 不是纯广告域名 ⛔

它同时是 SSP 的素材 CDN **和**正文缩略图 CDN。服务端 HTML 中有 31 处引用，由主题函数直接绑定到真实帖子：

```js
loadBannerDirect('https://pic.wvxrrip.cn/upload_01/xiao/20261008/2026100822150350723.jpeg',
                 '', document.querySelector('#post-card-137924'), '-1', ...)
```

**结论：禁止把 `pic.wvxrrip.cn` 加入网络拦截。** 正确做法是拦 `apiad01.cc` 的竞价接口并拦掉 SDK 本身——没有竞价就没有素材请求，素材域名自然不会被访问，无需冒险拉黑。

### 风险 B：`.post-card` 与 `[data-ssp-container]` 都不能直接隐藏 ⛔

见 1.2。可安全使用的判别锚点只有：

- `[data-ssp-slot-node]`（空占位符）
- `[id^="ssp-card-"]`
- `[data-ssp-slot-root]`、`[data-ssp-sdk-popup-overlay]`、`[data-ssp-sdk-fullscreen]`、`[data-ssp-marquee]`、`[data-ssp-landing]`（SDK 注入）
- `.xqbj-component-ssp-*`（SDK 组件）

**这两条风险都要写成自动化断言测试**，任何后续改动若违反就红。

---

## 3. 架构：四层引擎

```
                    ┌──────────────────────────────────────────┐
   document_start   │ L4 注入层 (MAIN world)                    │
                    │   window.open 守卫 / 持久化状态清理        │
                    │   pagehide·beforeunload beacon 拦截       │
                    ├──────────────────────────────────────────┤
                    │ L2 外观层 (ISOLATED world)                │
                    │   静态站点规则包 + 已学习规则（USER CSS）  │
                    ├──────────────────────────────────────────┤
                    │ L3 行为层 (ISOLATED world)                │
                    │   服务端快照 diff → 广告度打分 → 隐藏      │
                    │   → 选择器泛化 → 自学习入库                │
                    └──────────────────────────────────────────┘
                                     ↕ 消息
                    ┌──────────────────────────────────────────┐
                    │ Background Service Worker                │
                    │   站点规则包加载 / DNR 动态规则同步        │
                    │   规则库存储 / 统计                        │
                    └──────────────────────────────────────────┘
                                     ↕
                    ┌──────────────────────────────────────────┐
   network           │ L1 网络层  declarativeNetRequest          │
                    │   广告服务接口 + SDK 脚本 + 追踪端点       │
                    └──────────────────────────────────────────┘
```

### L1 网络层 —— declarativeNetRequest

MV3 已无阻塞式 `webRequest`，网络拦截只能走 DNR。规则两类：

1. **广告基础设施**（高风险，需逐条取证后加入）
   - `||apiad01.cc^`（竞价接口，这是唯一必需的第三方域名）
   - `*/ad-sdk-v*.js`（**单条收益最高的规则**：SDK 不加载则广告组件根本不生成）
   - `||ads.zyudkkup.com^`、`||api.zzlprxy.cc^`、`||wj-api-abtest.yvyjdhr.com^`（归因与 A/B）
   - `||mc.yandex.ru^`、`||googletagmanager.com^`（第三方统计）
2. **第一方路径规则**（不拉黑域名，只拦路径，避免风险 A）

静态规则集写进 manifest，站点级学习规则用 `updateDynamicRules` 热更新。所有规则带 `priority`，并给用户站点级开关留 `allowAllRequests` 白名单出口。

### L2 外观层 —— 精准隐藏，绝不碰容器

- 用 `chrome.scripting.insertCSS({ origin: 'USER' })`：USER 源样式**天然压过作者样式**，不必靠 `!important` 打价格战，也不容易被站点用 `!important` 反制。
- 静态 CSS 在 manifest 的 `content_scripts.css` 里声明，保证 `document_start` 就位，无闪白。
- 空占位符要**塌陷**而不只是隐藏：`[data-ssp-slot-node]:empty { display:none; height:0; margin:0; padding:0; }`，否则拦了 SDK 会在列表里留一排空洞。
- 硬约束（写成测试）：规则集内**禁止**出现 `[data-ssp-container]`、裸 `.post-card`、`pic.wvxrrip.cn`。

### L3 行为层 —— 通用性的来源

这是「不用第三方列表也能通吃」的关键。

**a. 服务端快照 diff.** `document_start` 时遍历 DOM，记录每个节点的「标签 + 稳定属性哈希」，得到 `PristineIndex`。之后任何 MutationObserver 捕捉到的新增节点，若不在索引里，即候选注入节点。

**b. 广告度打分.** 对候选节点算 `score` 与 `reasons[]`，特征全部自研：

| 特征 | 权重 | 说明 |
|---|---|---|
| 自研广告词库命中（class/id/属性） | 高 | `ssp`/`advert`/`ad-slot`/`guanggao`/`sponsor`/`popunder` 等，词库自己维护 |
| 出站链接指向**不同可注册域名** | 高 | 正文不会把主链接指向别的站 |
| 链接带推广参数 | 中 | `utm_`/`click_id`/`aff`/`invite`/`channel` |
| `position:fixed/absolute` + 高 `z-index` + 覆盖视口比例 | 高 | 悬浮球/覆盖层 |
| 媒体资源跨可注册域名 | 中 | 正文图通常同源或已知 CDN |
| 无 `<article>`/长文本，但占位面积大 | 中 | 空壳大盒子 |
| 同构兄弟节点重复出现 | 中 | 宫格/跑马灯 |
| **跨页面重复出现** | 高 | 正文不会在每个页面都冒出来，广告会 |

**c. 选择器泛化.** 命中后把节点选择器「去易变化」：`id="ssp-card-3"` → `[id^="ssp-card-"]`；丢掉随机哈希类名；优先稳定属性路径；正确转义。产出可复用规则而非一次性指纹。

**d. 自学习闭环.** 泛化后的规则按站点存入 `chrome.storage.local`，下次访问在 `document_start` 直接应用（无闪烁）。这是「完全自研不用第三方列表」路线下规则库的增长方式——**规则由引擎自己长出来**，并且可在选项页人工审阅/导出/回滚。为了避免自学习污染，规则入库需连续 N 次命中同一泛化选择器才提升为持久规则，且提供一键撤销。

### L4 注入层 —— 激进对抗

在 MAIN world 于 `document_start` 注入：

- **`window.open` 守卫**：`Object.defineProperty` 包裹，只放行同可注册域名且用户手势触发的调用。
- **持久化状态清理**：按模式清理 `localStorage`/`sessionStorage`/`window.name` 中的 `__ai_float_pending__`、`__ai_float_beacon__` 等键。
- **beacon 重挂拦截**：`EventTarget.prototype.addEventListener` 守卫，阻断 `pagehide`/`beforeunload` 上注册的广告 beacon。
- **反屏蔽诱饵中和**：自研的少量 scriptlet（不引入第三方脚本库）。

---

## 4. 关键实现取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 过滤列表 | **完全自研**（用户决定） | 无订阅依赖；代价是普通站点初期覆盖弱，靠 L3 自学习补齐 |
| 隐藏样式来源 | `insertCSS` + `origin:'USER'` | 天然压制作者样式，避免 `!important` 拉锯 |
| 注入世界 | ISOLATED 做检测，MAIN 做对抗 | 检测逻辑需要隔离保护；对抗 `window.open` 必须在 MAIN |
| 框架 | Vite + TypeScript，UI 用原生 TS | 引擎是重点，UI 保持轻；避免 `@crxjs` 等框架的 MV3 兼容坑 |
| 交付形态 | 先开发者模式加载未打包 | 立即可用；代码结构保持上架 Edge 商店的合规性 |

**非目标（v1 不做）：** 第三方列表语法兼容、CNAME 反伪装、移动端、云同步规则、多浏览器（Firefox）适配。

---

## 5. 测试架构（受沙箱约束）

实测：当前沙箱**禁止命名管道**，Chromium 的 Mojo IPC 起不来，启动 Edge 直接
`FATAL: mojo/public/cpp/platform/platform_channel.cc: Check failed: 拒绝访问 (0x5)`。
因此浏览器 E2E 在本会话受限模式下**不可能**运行。

据此分三层，把绝大部分验证压进沙箱内：

| 层级 | 内容 | 是否需要放宽沙箱 |
|---|---|---|
| **T1 纯单元** | 快照 diff、打分器、选择器泛化、规则编译、状态清理规划 | 否，沙箱内 Vitest |
| **T2 仿真集成** | 用 jsdom + 真实抓取的页面 HTML / SDK 文件做 fixture 回放 | 否，沙箱内 Vitest + jsdom |
| **T3 浏览器 E2E** | CDP 驱动已装 Edge 155 加载未打包扩展，真实访问试点站 | **是**，申请一次性完全权限 |

T3 的骨架已在 `_probe/cdp-probe.mjs` 验证过连通方式（`--load-extension` + `/json/list` + WebSocket CDP，零依赖，Node 24 内置 `fetch`/`WebSocket`）。E2E 断言必须包含**误伤守卫**：

1. 对广告域名的请求数 = 0
2. `[data-ssp-slot-node]` 渲染出的广告内容 = 0
3. **真 `<article>` 可见数量 与 基线一致**（误伤守卫，最关键）
4. 未产生 `window.open` 弹窗
5. `pic.wvxrrip.cn` 的正文图片仍能正常加载（误伤守卫）

---

## 6. 目录结构

```
ad-blow/
├─ src/
│  ├─ engine/          # T1 纯逻辑，零浏览器依赖
│  │  ├─ pristine.ts   #   服务端快照索引与 diff
│  │  ├─ lexicon.ts    #   自研广告词库
│  │  ├─ score.ts      #   广告度打分
│  │  ├─ selector.ts   #   选择器泛化
│  │  ├─ rules.ts      #   规则模型与匹配
│  │  ├─ dnr.ts        #   规则 → DNR 编译
│  │  └─ scrub.ts      #   持久化键清理规划
│  ├─ content/         # ISOLATED world 运行时
│  ├─ inject/          # MAIN world scriptlets
│  ├─ background/      # service worker
│  ├─ ui/              # popup + options
│  └─ rules/sites/     # 站点规则包（含试点站）
├─ tests/
│  ├─ unit/            # T1
│  ├─ fixtures/        # 真实页面 HTML / SDK 快照
│  └─ integration/     # T2 jsdom 回放
├─ tools/
│  ├─ recon/           # 侦察脚本（由 _probe 整理而来）
│  └─ e2e/             # T3 CDP 驱动
└─ docs/plans/
```

---

## 7. 遗留待验证项

| # | 待验证 | 影响 |
|---|---|---|
| 1 | `apiad01.cc` 被拦后站点是否有降级广告（换了别的域名） | 决定是否需要第一方路径兜底规则 |
| 2 | 拦 SDK 脚本后空占位符是否塌陷干净 | 影响 L2 的塌陷规则是否够用 |
| 3 | 真实运行 DOM 里广告卡与正文卡的完整差异 | 决定 L3 打分阈值标定 |
| 4 | `data-ssp-container` 是否在别的页面形态里也承载正文 | 万一承载，规则要按页面形态细分 |
| 5 | 站点 A/B 分流下不同访客的 DOM 变体数量 | 决定自学习规则的收敛速度 |

以上 1–5 都需要 T3（一次性完全权限）才能取证。**建议 v1 的实现顺序是先把 T1/T2 全部做完，最后集中申请一次权限跑 T3 取证并标定阈值。**
