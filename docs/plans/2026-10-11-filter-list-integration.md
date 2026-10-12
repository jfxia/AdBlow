# AdBlow 过滤列表集成方案

> 路线决定（2026-10-11，用户确认）：**完整集成 EasyList 系无白名单列表**，
> 作为网络层主力；现有引擎退为「长尾 + 反混淆层」。
> 这**推翻了项目最初「完全自研，不用第三方列表」的决定**，是有意识的转向。

## 为什么转向

第八轮结束时对三家成熟扩展做的对比暴露了一个结论：**覆盖面是根本差距**。
AdBlow 只有 2 个站点包，EasyList 覆盖上千个广告/追踪域名。在一个没被取证过的
新站点上，成熟扩展的网络层立刻开始拦截，而 AdBlow 的网络层几乎是空的。

集成列表后直接补上四个短板：

| 短板 | 集成后 |
|---|---|
| 覆盖面只有 2 个站点包 | 数万条规则、上千个域名，装完即生效 |
| 隐私防护弱（只学隐藏广告的域名） | EasyPrivacy 类列表覆盖整个追踪生态 |
| 广告图/视频照旧下载、页面慢 | 请求根本不发，带宽与加载速度立刻改善 |
| 未知站点只靠自学习 | 未知站点落地即有网络层保护 |

## 不变的底线

集成列表**不得放松**已经用两轮事故换来的安全纪律：

1. **自学习规则永不拦 `image` / `media`**（事故一的教训）——
   列表是人工审核过的，拦广告图是它的正常职责；**两者必须分开对待**。
2. **内容守卫**：任何来源的规则都不得隐藏装着正文的元素。
3. **自学习选择器不入 `document_start` 样式表**（事故二的教训）。
4. **只集成无付费白名单的列表**（用户明确反感「可接受广告」那套）。

架构上的落点：列表规则进 **静态规则集**（构建期生成），
我的站点规则包与自学习域名继续走 **动态规则**（优先级更高、可随时增删）。

## MV3 的硬约束（已核实，2026-10-11）

> 以下数字来自子代理对官方文档的逐条核实（附来源链接），**不是记忆**。
> ⚠️ 我原先凭印象写的两个常量名是错的，已更正。

| 事实 | 数值 | 对我们的影响 |
|---|---|---|
| `GUARANTEED_MINIMUM_STATIC_RULES` | **30,000**（**不存在** `MAX_NUMBER_OF_STATIC_RULES` 这个常量） | 保证额度就是 3 万；超出部分从全局共享池扣 |
| 全局静态规则共享池 | **300,000**（单扩展最佳情况 330,000，**不可依赖**） | 用户装了多个拦截扩展时会互相挤占，**不能按 330k 做预算** |
| `MAX_NUMBER_OF_STATIC_RULESETS` / 启用上限 | 100 / **50** | 我们 6 卷，远未触碰 |
| `MAX_NUMBER_OF_REGEX_RULES` | **1,000**（静态与动态分别计算；单条编译后须 < 2KB） | 实测列表里正则极少（33 条） |
| `MAX_NUMBER_OF_DISABLED_STATIC_RULES` | 5,000 | 将来做"按站点禁用规则集"时的约束 |
| `isUrlFilterCaseSensitive` 默认值 | **false**（Chrome 118 起；此前是 true） | 我们只在 `$match-case` 时显式设 true |
| 不写 `resourceTypes` / `excludedResourceTypes` 时 | **默认"除主文档外全部"** | 正好等于本项目的"默认不拦主文档"纪律，无需展开类型列表 |
| 二者**不能同时出现** | 硬约束 | 曾因此产出非法规则 → **整个扩展装不上** |
| `||*` 开头的 urlFilter | **明确禁止**（"Use `*` instead"） | 曾因此产出非法规则 → 整个扩展装不上 |
| 域名条件列表长度上限 | 无文档上限；uBOL 实测单规则 ~3,500 个域名 | 域名打包可行 |

### 最关键的发现：域名打包（`requestDomains`）

uBOL 的构建日志显示：Peter Lowe 列表 **3,552 条输入 → 1 条 DNR 规则**，
urlhaus **3,029 → 1 条** —— 靠的是把几千个域名塞进一条规则的 `requestDomains`。

我最初的实现是"一个域名一条规则"，于是被 3 万条预算砍掉 **80%** 的域名
（实测：域名锚点可用 120,049 条，只保住 23,876 条，正则一条都进不去）。

改用域名打包后（实测数据）：

| | 打包前 | 打包后 |
|---|---|---|
| 覆盖域名 | 23,876 | **105,675**（压进 **113 条**规则） |
| 路径/带作用域规则 | 全部丢弃 | **21,033 条全部保留** |
| 正则规则 | 0 | 33 |
| 因预算丢弃 | 102,711 条 | **0 条** |
| 合计规则数 | 24,000（撑满预算） | **21,146 / 24,000** |

**预算从瓶颈变成了富余。** 而且 `requestDomains` 语义上**更精确**：
它按请求域名匹配，不像 `||domain^` 那样依赖分隔符规则。

## 两次"整个扩展装不上"的教训（都已变成构建期检查）

浏览器**只要发现一条规则非法，就拒绝加载整个扩展**，而 Node 侧毫无迹象。
实测踩到两次：

1. **119 条规则同时带 `resourceTypes` 与 `excludedResourceTypes`**
   —— 违反"二者只能出现其一"。
2. **`||*xav.*/guang/*.gif`** 与 3 条中段带 `|` 的模式
   —— 违反 urlFilter 语法。
   报错原文：`Rule with id 2783 specifies an incorrect value for the "urlFilter" key`。

由此确立两条做法：

- **编译器负责消毒**：非法 urlFilter 直接丢弃（数量极少、价值可忽略），
  并把 `||*` 按官方建议规范化成 `*`。宁可少几条规则，也不要用户装不上。
- **构建期自检负责断言**（`src/engine/filterList/validate.ts`）：逐条检查 id 唯一、
  `resourceTypes`/`excludedResourceTypes` 互斥、urlFilter 语法、
  `requestDomains` 域名合法性、正则条数、以及"是否意外拦了主文档"。
  不通过则**构建失败**。

## 许可证（已核实）

| 列表 | 许可证 | 说明 |
|---|---|---|
| EasyList / EasyPrivacy | **GPLv3+ 或 CC BY-SA 3.0+** 双许可 | 需署名 "The EasyList authors (https://easylist.to/)" + 相同方式共享 |
| EasyList China | 头部指向同一个许可证页 | ⚠️ **但它在独立仓库里且没有 LICENSE 文件**，许可证页的授权范围措辞只覆盖"EasyList 仓库"。**分发前需书面确认** |
| uBlock Origin 的列表（uAssets） | **仅 GPLv3** | 随包分发会触发 GPLv3 §5/§6 全套义务 |

**净效果：两条分支都带"署名 + 相同方式共享"。闭源专有分发是不允许的。**

本项目的处理方式：
- 列表**不提交进版本库**（`filters/` 在 `.gitignore`），构建期抓取；
- 生成的规则集只存在于 `dist/`（构建产物）；
- 许可证与义务记录在此，**分发前必须重新评估**；
- 只收录**无付费白名单**的列表。

## 构建流程

```bash
pnpm filters     # 抓取列表到 filters/（不入库）
pnpm rulesets    # 解析 → 编译 → 打包 → 自检 → filters/generated/
pnpm build       # 组装 dist/ 并注入 manifest
```

`pnpm build` 在缺少 `filters/generated/` 时会**跳过**规则集注入并给出提示，
因此新克隆的仓库不联网也能构建（只是没有列表规则）。

## 更新路径（目标要求明确记录）

因为 MV3 的动态/会话规则额度很小（约 5,000），**列表不能运行时下载整份**，
只能构建期生成静态规则集 —— 这是 uBlock Origin Lite 走的同一条路。
因此更新路径是：

| 谁 | 怎么做 | 生效方式 |
|---|---|---|
| 开发者 | `pnpm filters`（重新抓列表）→ `pnpm rulesets`（重编译+自检）→ `pnpm build` | 重新加载扩展 |
| 用户 | 安装新版扩展 | 与扩展更新同步 |

代价与取舍（诚实记录）：

- **列表更新不独立于扩展更新**。上游列表今天加了新广告域名，要等下一次扩展发布才生效。
  这是 MV3 的架构限制，不是实现偷懒 —— 除非付出"只能用 5,000 条动态规则"的代价。
- 列表过期时间可从 `filters/meta.json` 的 `fetchedAt` 看到，编译报告里也会带上。

### 抓取到的列表版本（2026-10-11 实测）

| 列表 | 网络规则 | cosmetic | 解析丢弃 |
|---|---|---|---|
| easylist-china | 11,731 | 6,538 | 323 |
| easylist | 53,602 | 24,649 | 3,156 |
| easyprivacy | 56,235 | 36 | 39 |
| ublock-filters | 917 | 4,333 | 861 |
| ublock-privacy | 903 | 325 | 546 |
| ublock-badware | 3,948 | 138 | 324 |
| **合计** | **127,336** | **36,019** | **5,249** |

解析丢弃的主因是 `unsupported-option`（4,843 条）：`$csp` / `$redirect` /
`$removeparam` / `$popup` 等 DNR 表达不了。**丢弃而不是忽略** —— 忽略会放宽拦截范围。

## 自学习安全闸门未被绕过（目标要求）

集成列表**没有**放松既有的安全纪律，架构上做了明确隔离：

| 来源 | 资源类型限制 | 优先级 | 说明 |
|---|---|---|---|
| 列表规则（静态） | 按列表原意，可拦 image/media | 1 / 3 / 5 / 7 | 列表是人工审核过的，拦广告图是本职 |
| **自学习域名**（动态） | **永不拦 image/media**、永不拦 main_frame | 2 | 事故一的纪律原样保留 |
| **站点规则包**（动态） | 逐站取证 | 4 | 比通用列表更可信 |

优先级安排让「列表例外」能推翻自学习域名（3 > 2）—— 自学习会学错，必须留这条退路。
（本次把自学习规则的优先级从 1 明确改为 **2**，让文档承诺的层次在代码里真实存在。）

**集成层的证明**（`tests/integration/listLearningBoundary.test.ts`）：
项目原有的自学习安全测试都是在"没有列表"的前提下测的，所以专门补了一组
在**合并之后**成立的断言：

1. 对照前提：列表规则**确实**会拦 image（否则这组测试没有意义）
2. 自学习规则绝不拦 image / media（且 `SUBRESOURCE_TYPES` 结构上不含它们）
3. 自学习规则绝不拦 main_frame
4. **列表"允许拦图片"不传染给自学习规则** —— 同域名下两者类型集合不同
5. **列表例外（3）能推翻自学习拦截（2）**
6. 合并后的整体仍通过 DNR 约束自检（含主文档纪律）
7. 唯一允许拦主文档的来源仍是列表里**显式写的 `$document`**

## 列表来源只限无付费白名单者（目标要求，已变成代码强制检查）

背景：EasyList 等列表本身**不含**付费白名单，但"Acceptable Ads"是**另一份订阅**
（`exceptionrules.txt`）—— 广告主付费后进入该列表被放行。各种"免费 adblock"
后来变味，往往就是从默认勾选这份订阅开始的。

因此 `tools/filters/fetch-lists.mjs` 里加了两道**硬检查**，而不是只在文档里承诺：

- **来源配置检查**（`checkNoPaidWhitelist`）：任一来源的 id 或 URL 命中
  `exceptionrules` / `acceptableads` / `allowlist` / `whitelist` 等特征 → **中止抓取**
- **正文痕迹检查**（`scanTextForPaidWhitelist`）：列表头部注释出现
  Acceptable Ads 字样 → **标红并置非零退出码**
  （不能只看 URL —— 万一上游把 AA 合并进主列表，这里能在本地发现）

检查结果写入 `filters/meta.json` 的 `noPaidWhitelist` 字段，**每次抓取都可审计**。
实测（2026-10-11）：来源配置 6 份均通过；正文未出现任何 AA / exceptionrules 痕迹 ✓

来源清单由测试钉死（`tests/unit/listSources.test.ts`），任何增删都会被暴露。

## 回归测试与真实站点验证（目标要求）

| 验证 | 结果 |
|---|---|
| 单元/集成测试 | **424 条全部通过**（含 parse/compile/validate 与之前所有守卫） |
| 构建期自检 | 通过（DNR 约束逐条检查） |
| 验收 21 类 | **21/21**（带列表规则，无回归） |
| 试点站真实浏览器 E2E | **全部通过**，含新增的「内容 CDN 守卫」 |
| 1024cg 离线端到端 | 16/16 |
| dgav 站点 | 广告条与链接农场仍被隐藏，56 张图中 17 张正常可见 |
| 浏览器规则集实测 | 6 卷全部启用；样本域名全部命中；**三个站点的内容 CDN 零误伤** |

### 新增的两条 E2E 守卫（都是列表时代才需要的）

1. **站点自有域名的请求一个都不能被拦** —— 列表按域名拉黑，站点自己的资源
   域名一旦被覆盖就是"整站资源消失"。
2. **数据驱动的"内容 CDN"守卫** —— 从基线运行里学会哪些域名**成功加载过图片**，
   再断言净化后这些域名上没有图片被拦。这条直接对准风险 A
   （`pic.wvxrrip.cn` 这类同时承载广告素材与正文缩略图的 CDN）。
   只统计图片请求：这些域名上常有脚本（广告 SDK、统计），而拦脚本是预期行为。

### 第一期：网络规则编译器 ✅（已完成，待真实站点回归）

- `tools/filters/fetch-lists.mjs` —— 构建期抓取（含许可证元数据）
- `src/engine/filterList/parse.ts` —— ABP/EasyList 语法解析
- `src/engine/filterList/compile.ts` —— 去重/归并/打包/配额裁剪
- `src/engine/filterList/validate.ts` —— DNR 约束自检 + 域名与 urlFilter 校验
- `tools/build/gen-rulesets.ts` —— 生成规则集与覆盖率报告
- `tools/build/build.mjs` —— 注入 manifest

实测（6 份列表、127,336 条网络规则）：
**21,146 条 DNR 规则，覆盖 105,675 个域名**；浏览器实测规则集启用、
样本域名全部命中、**三个被测站点的内容 CDN 均未被误伤**。

### 第二期：cosmetic 选择器（进行中）

实测数据（6 份列表、36,019 条 cosmetic）：

| 类别 | 数量 | 处理 |
|---|---|---|
| 域名专用隐藏 | **16,878 条 → 10,812 个域名** | 本期启用 |
| 例外 `#@#` | 738 个域名 | 启用（注入时扣除） |
| 通用选择器 | 14,418 条 | **默认不注入**，与 uBOL 的取舍一致 |
| 程序化 `#?#` | 435 条 | 暂缓（需要程序化引擎） |
| 脚本注入 `##+js(...)` | 2,793 条 | 第三期 |
| `~` 排除型 | 23 条 | **跳过**（正向索引表达不了，不误用） |
| **非法选择器** | **1,466 条** | 构建期丢弃 |

**范围决定及其依据**：uBlock Origin Lite 默认**不启用通用 cosmetic 规则**
（只在"完全模式"开），因为无域名限定的选择器会套用到全网站、误伤风险高。
本实现采纳同样取舍：域名专用规则启用，通用规则只解析统计。

**投递机制**（与 uBOL 同构，避免暴露文件）：

```
构建期：域名 → 选择器索引 → 按域名哈希切成 256 片（合计 764 KB，单片最大 6.3 KB）
运行期：内容脚本 --消息(get-cosmetic, host)--> SW
        SW 读该主机名及各级父域所在的分片（通常 2–5 片）→ 回传选择器
        内容脚本过**内容守卫** → 注入 <style>
```

为什么由 SW 读文件：内容脚本直接读扩展内文件需要把文件列进
`web_accessible_resources`，那等于暴露给页面（多一个指纹面）。uBOL 也是这个架构。

**内容守卫**（本期唯一关乎安全的逻辑，已抽成可测模块 `src/content/listCosmetic.ts`）：

- 凡是会隐藏**装着正文的元素**的选择器一律剔除 —— 与既有不变量一致：
  **任何来源的规则都不得隐藏正文**
- **非法选择器**剔除：一条非法会让**整张样式表**被浏览器丢弃
  （不能只靠 `try/catch` —— 实测 jsdom 对 `div{class:red}` 不抛异常，需要语法粗筛）

**实测发现的漏洞并修复**：列表里有 250 个**通配 TLD 键**（`amazon.*`、`momondo.*`…），
原先按字面后缀查找**永远匹配不上**。现在对每一级后缀补通配形式，
并对 2 字母 ccTLD 再放宽一级（覆盖 `amazon.*` 命中 `amazon.co.jp` 这类多段后缀）。

**真实浏览器验证**：baidu 注入 184 条、zhihu 16 条、qq.com 90 条、ifeng 81 条、
iqiyi 57 条；内容守卫全部放行（这些选择器确实都是广告容器，如
`div[data-key^="ad__"]`、`#adCard`、`.GoodsRecommendCard`）；页面文字完好。
⚠️ 但这些站点首页**命中元素很少（0–1 个）**：EasyList 的 cosmetic 规则大量针对
具体页面类型（如 `#AdRight-Article-QQ` 是文章页的），且这些门户对无头浏览器
只渲染部分内容。也就是说**机制已验证，实际增益在首页上有限**，需要文章页
场景才能量到更多命中。

### 第三期：脚本注入子集（已完成）

实测 2,807 条 `##+js(...)` 规则、**3,748 个域名、50 个脚本名**，
频率分布极不均：

```
aopr 636｜acs 359｜set 327｜aeld 206｜nostif 195｜aopw 184｜nowoif 178
前 5 名覆盖 61%，前 10 名覆盖 81%，前 20 名覆盖 94%
```

**取舍依据就是这个分布**：实现 11 个高频、语义自包含的规范名，
而不是去追 50 个。已实现（含别名）：

| 规范名 | 别名 | 作用 |
|---|---|---|
| `set-constant` | `set` | 把属性固定成某值（页面改不动） |
| `abort-on-property-read` | `aopr` | 读该属性即抛错，中止当前脚本 |
| `abort-on-property-write` | `aopw` | 写该属性即抛错 |
| `no-setTimeout-if` | `nostif` | 拦住匹配的定时器 |
| `no-setInterval-if` | `nosiif` | 同上 |
| `no-window-open-if` | `nowoif` | 拦住匹配的 `window.open` |
| `no-fetch-if` | — | 匹配的 fetch 直接返回空响应 |
| `no-xhr-if` | — | 拦住匹配的 XHR |
| `json-prune` | — | 从 `JSON.parse` 结果里删路径 |
| `set-local-storage-item` | — | 设置/删除 localStorage 项 |
| `remove-cookie` | — | 让指定 cookie 过期 |

**明确不做的**（原因写在 `filterList/scriptlet.ts` 的 `SUPPORT_NOTES` 里，
避免以后有人"顺手加上"）：`abort-current-script`（要靠 getter 陷阱反查当前脚本，
易误伤同页其它脚本）、`abort-on-element-load`（语义未核实）、
`abort-on-stack-trace`（依赖错误栈字符串，脆弱）、`nowebrtc` / `noeval`（超出广告过滤范围）、
`href-sanitizer`（改写链接，风险高于收益）等。

**投递机制（与 cosmetic 不同，关键差异）**：

```
manifest 声明：
  scriptlets-engine.js        MAIN / document_start / <all_urls>   ← 引擎
  scriptlets/bundle-N.js      MAIN / document_start / 该组域名     ← 只含那批域名的规则表
```

为什么不能像 cosmetic 那样靠 SW 消息取数据：**脚本必须在 `document_start`、
页面脚本之前执行完**，而 SW 消息是异步的 —— 会有竞态。由 manifest 声明匹配域名、
浏览器直接注入就没有竞态。这正是 uBlock Origin Lite 的做法
（它把 `##+js(...)` 编译成按 world 打包的脚本文件，理由相同）。

实测结果：**1,964 条已支持 → 60 个 bundle、覆盖 2,841 个域名**；
341 个通配 TLD 域名跳过（无法表达成 match pattern）；7 条 `~` 排除型跳过。
manifest 因此从 2 KB 增到 92 KB（62 个 content_scripts 条目）。

**语义核实（子代理对 uBO master 源码逐条核实，2026-10-11）修正了我三处错误**：

| 我原先的假设 | 核实结果 |
|---|---|
| `aeld` = `abort-on-element-load` | ❌ 这个脚本**不存在**。`aeld` = **`prevent-addEventListener`** —— 代理 `EventTarget.prototype.addEventListener`，**事件类型与处理函数源码都匹配**时才丢弃监听器 |
| `remove-cookie` 的第一个参数是 cookie 名 | ❌ 是**匹配式**（字符串或 `/正则/`）。实测样例 `remove-cookie, /sc_anonymous_id\|sc_tracking_anonymous_id/`；按字面名处理会去写一个名字是那串正则的 cookie |
| `set-local-storage-item` 的 key 总是字面键 | ❌ 当 value 是 `$remove$` 时 key 是**模式**，要删掉所有匹配的键 |
| `set-constant` 支持 `$remove$` | ❌ `$remove$` 属于 storage 类脚本，`set-constant` 不支持 |
| `no-window-open-if` 只匹配 URL | ❌ 匹配的是 `callArgs.join(' ')`（广告常把关键信息放在 features 里） |
| `nostif`/`nosiif` 只有一个 needle 参数 | ❌ 还有 `delay`，支持精确值与区间 `min-max`/`min-`/`-max`，且可 `!` 取反 |

**有意保留的偏离**（记录清楚，不假装与 uBO 完全一致）：

- `set-constant` 的安全闸门**收窄了**：uBO 是 `typeof` 不符就拒绝接管
  （连 `1 → false` 都拒绝），我们只拒绝"**真实对象/函数 ↔ 原始值**"这一种。
  理由：前者会让大量过滤器本意落空，后者才是真正会把页面弄坏的情况。
- `nostif`/`nosiif` 拦截时用空函数替换回调（与 uBO 一致），
  但**未实现** `delay` 无法解析时的默认值语义（我们取"匹配任意"，更保守）。

**安全纪律**（比网络规则更要紧 —— 出错是"站点功能坏掉"而不是"广告漏拦"）：

- 每一步包 try/catch，**任何异常都不得外泄到页面**
  （实测踩到一次：jsdom 没有 `Response` 构造器，`no-fetch-if` 会把异常抛给页面）
- 只实现语义自包含、误伤面可控的子集
- **`#@#+js(...)` 例外本期不处理**：宁可不注入，也不能注入后没法制止

**真实浏览器验证**：techcrunch.com / soundcloud.com 上
引擎在 MAIN world 就位、`navigator.globalPrivacyControl === false`（set-constant 生效）、
页面文字完好（12254 / 3218 字符）、控制台报 `执行 1/2`、`3/4`。

## 三期完成度小结

| 期 | 内容 | 输入 | 产出 | 状态 |
|---|---|---|---|---|
| 一 | 网络规则 | 127,336 条 | 21,146 条 DNR 规则（105,675 域名打包 + 21,033 逐条） | ✅ |
| 二 | cosmetic 选择器 | 36,019 条 | 16,878 条域名专用（10,812 域名）→ 256 分片 | ✅ |
| 三 | 脚本注入 | 2,790 条 | 1,964 条（12 个规范名）→ 60 bundle（2,841 域名） | ✅ |

**未接入的部分及原因**（都不是遗漏）：通用 cosmetic 14,418 条（默认不启用，
与 uBOL 取舍一致）、程序化 `#?#` 435 条（需要程序化引擎 + 每条 200ms 预算）、
`abort-current-script` 等 744 条未支持脚本名、341 个通配 TLD 域名。

## 别名表的来源（重要，避免以后照抄过时文档）

uBO **没有**一份官方 JSON 别名表；权威来源是运行期拼装的
`redirectEngine.aliases`（`src/js/redirect-engine.js` 的 `loadBuiltinResources()`
从 `builtinScriptlets` 的 `aliases` 字段与 `redirect-resources.js` 的 `alias:` 字段收集）。
另外 ⚠️ 旧文档常引用的 `assets/resources/scriptlets.js` 在 master 里**已不存在**
（当前按脚本拆到 `src/js/resources/*.js`）。以后要更新别名表，应从源码派生，
不要从 wiki 抄（wiki 里有已废弃的别名）。

uBOL 把 `##+js(...)` 编译成**按 world 打包的脚本文件**
（`/rulesets/scripting/scriptlet/<world>/<id>.js`，`runAt: document_start`），
因为 `registerContentScripts` 不接受字符串代码。这块是反"反广告拦截"的关键。
