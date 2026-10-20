<div align="center">

<img src="public/icons/icon-128.png" width="96" alt="AdBlow 图标" />

# AdBlow

**在过滤列表匹配之外，依据页面运行时的元素行为判定并拦截广告。**

[![Manifest V3](https://img.shields.io/badge/manifest-v3-blueviolet)](#)
[![测试](https://img.shields.io/badge/tests-959%20passing-brightgreen)](#测试与验收)
[![界面语言](https://img.shields.io/badge/UI%20languages-5-informational)](#界面与本地化)
[![持续集成](https://github.com/jfxia/AdBlow/actions/workflows/ci.yml/badge.svg)](https://github.com/jfxia/AdBlow/actions/workflows/ci.yml)
[![自动发版](https://github.com/jfxia/AdBlow/actions/workflows/auto-release.yml/badge.svg)](https://github.com/jfxia/AdBlow/actions/workflows/auto-release.yml)

[English](README.md)

</div>

---

## 项目定位

大多数广告过滤器的结构是一样的：一张不断维护的规则表，加一个执行它的引擎。请求地址命中表里的条目就被拦下，页面元素匹配上某个选择器就被隐藏。这套办法有效，但有一个天生的盲区：广告只要换一副面孔，就不再在表里。

页面上最常见的几种「换面孔」是：脚本在加载完成后临时造一个浮层；素材来自一个全页只出现一次的域名；元素先正常渲染，随后撑大占满屏幕；跳转链接走站点自己的接口，从外面看不出是广告；图片地址用 base64 编码藏在 CDN 路径里。它们没有一条出现在任何列表，过滤列表因此拦不住。

AdBlow 换了一个判定依据：不看广告长什么样，看它在页面里做过什么。它照常执行 EasyList 系列列表，但在列表之外还逐元素观察运行时行为，例如元素是不是脚本现造的、素材来自哪里、尺寸是否异常增长、链接指向何处。过滤引擎、界面与构建工具链都由本项目自行实现，没有复用现成过滤扩展的代码。

落到实现上，取舍也很具体：判定全部在本地完成，扩展不含遥测、账号与远程配置；不设付费白名单，因此不存在出钱即可放行的通道；自学习产生的规则只作用于学习它的站点，并且可以在规则管理页逐条撤销。

## 设计取舍

**判定依据不限于过滤列表。** 运行时观测里有两类手法需要先还原、再判定：一是把广告链接改写成站点自有域名下的跳转接口，载荷里却明写 `{"kind":"ad", ...}`；二是把素材的真实地址用 base64 编码封进站点自有 CDN 的路径。这两种情况下，广告从外表看与站内链接、站内素材没有区别，所以扩展先还原出真实地址，再按真实地址判定。

**误伤的代价高于漏判。** 自学习产出的规则只在学到它的那个站点上生效，用户可以在规则管理页逐条撤销；实现上这些规则也不会作用于图片、媒体、脚本与样式表，以免把站点的正常资源一并挡掉。整个项目在这条线上的取舍只有一句：

> 宁可漏判，不可误伤。

这条原则还有一处不显眼的地方：不接受任何付费放行。AdBlock Plus 默认开启「可接受广告」，向广告主收费后放行其广告；AdBlow 不设这类白名单，构建脚本一旦在来源配置或列表正文里发现付费白名单的痕迹，就会中止拉取。理由与「宁可漏判」同源：一个收钱就能放行广告的过滤器，判定的动机就不再只是「这看起来像不像广告」。

## 架构

<img src="docs/diagrams/architecture-zh.png" width="830" alt="AdBlow 系统架构：过滤列表编译为规则集与隐藏分片，四层从后台 service worker 一直到 MAIN world">

## 处理流程

<img src="docs/diagrams/flow-zh.png" width="780" alt="AdBlow 处理流程，含反过滤墙等待用户确认的环节">

## 与其他过滤器的对比

下表只列出与本项目定位相关的维度，**不是完整评测**。AdBlock Plus、AdGuard、uBlock Origin 各有本项目不及之处（AdGuard 的产品线广度、uBlock Origin 的过滤语法覆盖）。依据各产品公开文档整理（2026-10）；若有出入，欢迎指正。

| | **AdBlow** | AdBlock Plus | AdGuard | uBlock Origin |
|---|---|---|---|---|
| EasyList 系过滤列表 | 支持 | 支持 | 支持（另有自有列表） | 支持 |
| 付费白名单（「可接受广告」） | **无** | **有，默认开启** | 无 | 无 |
| 按运行时行为判定，而不止比对列表 | **有**：跨站素材、几何突增、自家域名跳转解包、CDN base64 解包 | 无 | 无 | 无 |
| 按站点自学习，可逐条撤销，且只作用于教会它的站点 | **有** | 无 | 无 | 无 |
| 反过滤墙 | 检测到后**经用户确认**才中和，广告拦截保持不变 | 依赖过滤列表 | 依赖烦扰过滤器，自动处理 | 依赖烦扰过滤器与脚本注入，自动处理 |
| 过滤列表更新 | 随扩展版本（MV3 静态规则集） | 运行时更新 | 运行时更新 | 完整版运行时更新；MV3 版（uBO Lite）随版本 |
| 价格与许可 | 免费；项目 GPL-3.0，代码另提供 MIT | 免费（GPLv3） | 扩展免费，桌面版付费 | 免费（GPLv3） |

## 功能

### 网络层

AdBlow 在构建阶段把 6 份过滤列表（EasyList、EasyList China、EasyPrivacy、uBlock 的 filters、privacy、badware）编译成 declarativeNetRequest 规则集。12.7 万条输入规则经过去重与校验，留下 20,913 条拦截规则和 2,365 条例外规则，分装在 6 卷规则集里。十万余个域名锚点则被合并成 114 条规则。域名锚点本身体积大，逐条保留既撑大安装包，也更快撞上浏览器对静态规则数量的上限。

### 元素隐藏

AdBlow 内置 25,467 条域名限定选择器，覆盖 11,357 个域名。把整张表塞进每个标签页并不现实，因此这些规则按域名哈希切成 256 个分片，内容脚本只向后台脚本请求当前站点所在的那几片。扩展没有声明 `web_accessible_resources`，页面脚本无法自己列出分片地址，能被探测到的内部接口也就更少。

### 行为判定

内容脚本在页面加载初期记录一份原始快照，之后以它为基准做差分，再对每个元素计算广告相似度。先留快照的原因很直接：页面加载完成后，「页面原有内容」与「脚本后来塞进来的东西」在 DOM 里没有区别，只有和快照对比才分得清；「是否由脚本注入」这一项判断，依据就是这个差值。判定时先看元素自身的来历：是否由脚本注入，是否带跨站链接与素材，是否出现跨站 iframe，尺寸是否异常增长，链接是否带推广参数，命名落在三个置信档位中的哪一档。再看它的形状：是否构成全屏覆盖层、点击层、伪造关闭按钮或链接农场。命中之后，AdBlow 把命中的类别与具体证据分别写进 `data-adblow-reason` 与 `data-adblow-why`，排查误伤时可以直接看出是哪条依据触发的。

### 反劫持

页面脚本同样可能反过来干扰过滤：开新窗口、劫持点击把用户带去广告页、借弹窗状态反复弹窗、注册只负责跳转的点击处理。针对这四类动作，AdBlow 在页面的 MAIN world 里分别做了限制：调用 `window.open`；点击劫持；向弹窗状态写入数据（`localStorage`、`sessionStorage`、`window.name`）；注册「只负责跳转」的文档级点击处理函数。

### 反过滤墙

有些站点会先用诱饵元素探测过滤器，再用「请关闭广告过滤器」一类的遮罩挡住页面。遇到这种情况，AdBlow 在弹窗里给出逐站处理入口：确认之前，扩展不改变页面任何行为；确认之后，扩展隐藏该遮罩、恢复被它遮挡的正文，广告拦截本身保持不变。页面重新可读，广告也不会被放回来。检测始终在运行，所以即使还没处理，弹窗也能报告本页出现过反过滤墙。

### 脚本注入

AdBlow 支持 13 个规范的 `##+js(...)` 规则，覆盖 3,247 个域名，常用的是 `abort-on-property-read`、`set-constant`、`json-prune`、`abort-current-script`、`no-fetch-if` 与 `no-setTimeout-if`。这些规则的数据表内联在内容脚本里，因此能在页面自身脚本执行之前就位。

### 自学习

对于初步判定为广告、又反复出现的元素，AdBlow 按站点记录需要隐藏的选择器与广告域名，累计命中 3 次后才转为生效状态。设这道门槛的理由是单次命中可能只是页面恰好长得像广告，反复命中才值得写进规则；即便晋级，规则也只在学到它的站点上生效，并且可以随时撤掉。所有记录都能在「规则管理」里查看，支持逐条删除，也可以整体导出为 JSON。

### 站点开关

弹窗提供当前站点的过滤开关。关闭之后，该站点上已经生效的自学习网络规则也一并暂停。

### 界面与本地化

AdBlow 提供中文（简体，默认）、English、日本語、Français、Español 五种界面语言，跟随浏览器的界面语言自动切换。

### 隐私

所有处理都在本地完成。扩展不含遥测、账号与远程配置，除浏览器更新扩展本身之外不产生任何对外请求。

## 截图

| 弹窗：站点开关与实时统计 | 规则管理 |
|---|---|
| ![弹窗](store/store-1280x800-popup-zhCN.png) | ![规则管理](store/store-1280x800-options-enUS.png) |

## 安装

当前可以从源码构建安装：

```bash
git clone <本仓库> && cd adblow
pnpm install
pnpm filters        # 拉取 6 份过滤列表（不入库，见「许可证」）
pnpm rulesets       # 编译为网络规则集、元素隐藏分片与脚本注入数据表
pnpm build          # 产出 dist/
```

随后在 `edge://extensions`（或 `chrome://extensions`）中启用开发者模式，选择「加载解压缩的扩展」，指向 `dist/` 目录。

面向商店的发布包由 `pnpm package` 生成，当前版本为 `release/adblow-1.0.4-edge.zip`；v1.0.0 已在 Edge 加载项商店上架。一次发布由三条命令串起来：`pnpm version:bump`、`pnpm package` 与 `pnpm release:github`，详见「构建与打包」与「发布」两节。

过滤列表在构建期抓取，不随仓库分发，因此构建时需要能访问它们的上游站点。若上游被屏蔽或过慢，取列表脚本会自动回退到镜像，并打印实际使用的来源：托管在 GitHub 的列表走 jsDelivr，EasyList 走 adblockplus.org。这个过程不需要手动干预。若上游完全不可达，同一批列表也作为附件放在[最新发布](https://github.com/jfxia/AdBlow/releases/latest)里：把压缩包解压到 `filters/` 目录，再执行 `pnpm rulesets && pnpm build` 即可，全程无需联网。

## 构建与打包

```bash
pnpm test           # 959 项单元与集成测试，单进程内执行
pnpm typecheck      # tsc --noEmit
pnpm verify         # 构建 + 测试
pnpm icons          # 重新生成图标（16/32/48/128 与商店图标）
pnpm package        # 构建 + 审计 + 打包，产出 release/adblow-<版本>-edge.zip
pnpm update-lists   # 刷新过滤列表并整体重建：拉取 → 编译 → 构建 → 测试 → 打包
pnpm version:bump   # 改写版本引用（默认 dry-run，加 --write 才写文件）
pnpm release:github # 跑完全部发布校验（默认 dry-run，加 --publish 才真正发布）
```

依赖 Node.js 24 及以上与 pnpm；生成图标与商店截图另需 Python 3 与 Pillow。

过滤列表在构建阶段被编译进静态规则集，而 MV3 没有提供远程替换静态规则集的接口，所以列表的时效取决于发版频率：刷新一次列表，等于发布一个新版本。规则管理页会显示内置列表的抓取日期，用来判断当前安装的版本所携带的规则是否过期。定期发版与运行时增量更新这两条路线的取舍，以及实测得到的配额数据，见[过滤列表的更新策略](docs/LIST-UPDATES.md)。

打包时，脚本会把 `dist/` 里的文件清单与 manifest 实际声明的资源逐项核对，剔除不属于产物的文件，例如浏览器自动生成的 `_metadata/` 规则集索引缓存。最终输出的 zip 里，`manifest.json` 位于压缩包根目录。若此时浏览器正加载 `dist/`，Windows 会锁定该目录；换一个构建目录即可，不必结束浏览器进程：

```bash
ADBLOW_DIST=dist-release pnpm package
```

## 发布

一次发布是「升版本 → 打包 → 发 Release」，在没有显式开关时它不会写入任何东西：

```bash
pnpm version:bump <版本>            # 只打印将要改写的每一处版本引用
pnpm version:bump <版本> --write    # 改写 package.json、两份 README、docs/RELEASE.md
git add -A && git commit && git push
pnpm package                        # 产出 release/adblow-<版本>-edge.zip
pnpm release:github                 # 跑完全部校验，不发写请求
pnpm release:github --publish       # 建 Release 并上传附件
```

`pnpm version:bump <版本> --test-count <n>` 会一并同步测试计数徽章与正文里写明计数的行；某一轮只新增测试、不升版本时，用 `--counts-only` 单独同步。

`pnpm release:github` 会在下列任何一条不成立时拒绝发布，并给出对应的修法：

- `package.json`、请求的 tag 与包内 `manifest.json` 三者的版本必须一致；包内版本是解压读出来的，不看构建日志；
- 工作区干净，且 `HEAD` 就是远端的提交，因为发布必须对应一个已推送的提交；
- `docs/release-notes/<版本>.md` 存在且写明该版本，它既是 Release 正文，也是商店后台「新版说明」字段的内容；
- 过滤列表快照不超过 7 天（按 `filters/meta.json` 的 `fetchedAt`）；
- 凭据可用：优先取 `GH_TOKEN`，否则走 `git credential fill`；token 只打印长度，不打印内容。

Release 已存在时，工具会复用它，只补传缺失的附件，因此上传中断后重跑是安全的。两个附件分别是商店包与过滤列表快照（`filters/*.txt` 加 `meta.json`，文件名取自抓取日期）。`--offline` 与 `--rehearse` 只用于演练，不能与 `--publish` 同时使用。

同一套流程也可以无人值守：`.github/workflows/auto-release.yml` 每周执行一次，由 `pnpm release:auto` 判断是否有东西值得发。它把六份列表正文的 sha256 与编译产物计数组成指纹，和受版本控制的基线 `tools/release/baseline.json` 比较。上游列表一周没变，就不升版本、不提交、不发 Release；列表的抓取时间戳不参与比较，所以「只是重新抓了一次」不会被当成有变化。也可以在 Actions 页面手动触发，`publish` 输入默认只报告结论、不写文件。

## 项目结构

实现分为四层，逐层收敛权限与作用范围：

| 层 | 运行位置 | 职责 | 存在原因 |
|---|---|---|---|
| **网络层** | `declarativeNetRequest` | 由过滤列表编译的静态规则集，以及自学习域名的动态规则 | 在请求发出之前完成拦截 |
| **元素隐藏** | 隔离世界 | 域名限定 CSS；判定命中的元素以内联 `!important` 隐藏 | 使不应渲染的内容不进入渲染流程 |
| **行为判定** | 隔离世界 | 原始快照差分、广告相似度计算、自学习 | 覆盖过滤列表尚未收录的广告 |
| **反劫持** | MAIN world | `window.open`、点击劫持、存储写入、事件监听器 | 阻止页面反向干扰过滤行为 |

```
src/
  background/      service worker：同步网络规则、下发元素隐藏分片、记录统计
  content/         元素隐藏与行为判定：引擎、判定逻辑、学习记录存储、站点设置
  inject/          反劫持：MAIN world 限制与脚本注入运行时
  engine/          与浏览器无关的纯逻辑：相似度计算、词表、几何、DNR、过滤列表编译器、
                   脚本注入解析、选择器泛化
  rules/sites/     手写站点规则包（逐站验证的选择器）
  ui/              弹窗、规则管理、多语言
tools/
  filters/         过滤列表拉取（带付费白名单的列表会被拒绝）
  build/           规则集、元素隐藏分片、脚本注入数据表生成；打包；图标生成
  e2e/             24 类真实浏览器验收；活站端到端
  release/         审计、zip 打包、商店截图生成
  diagnostics/     可在控制台直接执行的诊断脚本，用于定位站点异常
tests/             959 项单元与集成测试（jsdom）
public/            manifest、_locales、图标
```

## 安全约束

下面这些约束都在代码里强制实现，每一条都有测试覆盖，多数可以追溯到一次真实发生的误伤事故：

- 自学习得到的网络规则不会作用于 `image`、`media`、`script`、`stylesheet`、`font`。内容缩略图与广告素材常共用同一个 CDN，一旦拦截，站点的图片会整体不可用。
- 自学习规则只在学到它的站点上生效（`initiatorDomains`）。在 A 站习得的域名不会影响 B 站。
- 隐式规则不拦截 `main_frame`，只有显式标注 `$document` 的规则才能拦截主文档。
- AdBlow 不会隐藏 `html`、`body` 或 `head`：隐藏其中任何一个都等同于清空页面。
- 设有页级隐藏预算，限制可隐藏的正文与链接比例；含正文或导航的元素一律豁免。
- 隐藏时同时设置 `display`、`visibility` 与 `pointer-events`，并在稍后复核。站点确实会用自己的 `!important` 重置 `display`，1024cg 那一例就是复核时发现的。

## 测试与验收

```bash
node tests/run-all.ts           # 959 项测试，0 失败
node tools/e2e/acceptance.mjs   # 24 类广告，在真实浏览器中实测
```

`tools/e2e/acceptance.mjs` 是验收的主体。它为 24 类遮挡视线的广告各构造一个真实形态的页面，覆盖前置弹窗、底层弹窗、插屏、随滚动漂浮、边角浮标、底部粘性横幅、页外流视频、前置贴片、中插、视频叠加、整页可点击、伪造关闭按钮、点击劫持、标签页劫持、区域展开、闪烁 GIF、富媒体、站点自有域名跳转包装、CDN base64 包装等。

每个夹具都测两次，而且顺序不能反。先关闭扩展测基线：若基线里该广告本来就没造成遮挡，说明这个夹具不成立，得重新构造；不先确认这一点，「广告消失了」就说明不了任何事。再启用扩展测量：要求广告消失，同时夹具正文仍然可见。

另有一个活站端到端脚本 `tools/e2e/run.mjs <url>`，内置图片守卫、CDN 守卫与站点自有域名守卫。有了它，「修好某类广告却开始隐藏正文」这种回归会在测试阶段暴露，不会流进发布版本。

## 持续集成

CI 门禁采用「一处定义、两处调用」的结构。`.github/workflows/checks.yml` 是唯一说明「什么算通过」的地方，且只接受调用（`workflow_call`）：

| 作业 | 运行环境 | 内容 |
|---|---|---|
| `build` | `ubuntu-latest` | 安装依赖、类型检查、跑测试套件、抓取过滤列表、编译规则集、构建、打包，然后**解包审计**（`node tools/release/verify-package.mjs`） |
| `acceptance` | `windows-latest` | 下载上一步构建出的扩展，在真实 Edge 中跑 24 类验收套件（Edge 由该镜像预装） |

`.github/workflows/ci.yml` 在每次 push 与 pull request 时调用它，并对同一 ref 的旧运行开启 `cancel-in-progress`；每周一次的 `.github/workflows/auto-release.yml` 在判断指纹之前调用的是**同一个文件**。因此不存在「能发版却过不了 PR 门禁」的树。

验收作业在 24 类中不足 24 类命中时判定失败（`--min-pass 24`），失败时把浏览器日志作为产物上传；浏览器按两个标准 Edge 路径查找，位置不同时可以用 `ADBLOW_BROWSER` 覆盖。

整套门禁可以在本地复现：

```bash
pnpm install --frozen-lockfile
pnpm typecheck && node tests/run-all.ts
pnpm filters --force && pnpm rulesets
pnpm build && pnpm package && node tools/release/verify-package.mjs
node tools/e2e/acceptance.mjs --min-pass 24
```

## 已知限制

- 通用（非域名限定）的元素隐藏规则没有注入，只注入域名限定的部分。
- 过程式隐藏规则 `#?#` 与 HTML 过滤 `##^` 尚未实现。
- `abort-current-script` 只在规则自带搜索串时生效：陷阱只中止源码里命中搜索串的那个脚本，其余脚本读取时原样放行。列表中有 38 条没有搜索串，会被丢弃。其余未实现的脚本注入（`abort-on-stack-trace`、`remove-node-text`、`nano-setTimeout-booster`、`nowebrtc`、`noeval` 等）合计 385 条。构建会如实报告跳过项，不会为了多纳入条目而放宽规则。
- 反过滤墙（站点测量诱饵元素后对页面设门禁）只有在用户逐站确认之后才会处理。弹窗会给出提示与操作入口：隐藏该提示层、恢复被它遮挡的正文，同时广告拦截保持不变。用户确认之前不改变页面任何行为，确认之后也可以随时撤销。
- 过滤列表在构建期编译，更新列表需要重新构建扩展。这是 MV3 的限制，它不支持远程替换静态规则集。
- 尚无公开的性能基准，也尚未在中立站点上与其他过滤器做同条件对比。

## 第三方组件与许可

过滤列表由各自的维护者维护，不属于本仓库，由构建阶段拉取：

| 列表 | 许可 |
|---|---|
| [EasyList](https://easylist.to/)、[EasyList China](https://easylist.to/)、[EasyPrivacy](https://easylist.to/) | GPL-3.0 / CC BY-SA 3.0 |
| [uBlock Origin assets](https://github.com/uBlockOrigin/uAssets)（filters、privacy、badware） | GPL-3.0 |

再分发由本仓库构建的任何交付物时，须遵守上述许可。

## 许可证

本项目整体按 **GPL-3.0** 分发，全文见 [LICENSE](LICENSE)；本仓库原创代码同时提供 **MIT** 授权，全文见 [LICENSE-MIT](LICENSE-MIT)，使用者可以按 MIT 条款使用这些代码。

分层授权的原因在于：构建出的扩展会内嵌上表中 GPL-3.0 / CC BY-SA 的过滤列表数据，这部分无法按 MIT 授权，所以整个交付物按 GPL-3.0 分发；本仓库自己实现的代码（引擎、界面、构建与发布脚本、测试）与这些列表无关，因此额外提供 MIT 授权，方便复用。

第三方过滤列表不属于本仓库，由构建阶段拉取，各自的许可见上表。

---

<div align="center">
<sub>AdBlow 1.0.4 · Manifest V3 · Edge 与 Chrome</sub>
</div>
