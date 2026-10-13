<div align="center">

<img src="public/icons/icon-128.png" width="96" alt="AdBlow 图标" />

# AdBlow

**按"元素的行为"判断广告，而不只是比对过滤列表。**

[![Manifest V3](https://img.shields.io/badge/manifest-v3-blueviolet)](#)
[![测试](https://img.shields.io/badge/tests-631%20passing-brightgreen)](#测试与验证)
[![界面语言](https://img.shields.io/badge/UI%20languages-5-informational)](#界面)

[English](README.md)

</div>

---

## 为什么还要再做一个广告过滤器

AdBlow 同样内置各家都在用的 EasyList 系过滤列表，然后加了**第二条独立防线**：一套运行时
引擎，按元素**如何表现**打分——是不是被脚本注入页面、素材是否来自整页只出现一次的域名、
几何尺寸是否自己长大、链接是否被包进站点自家的跳转端点、素材是否藏在 CDN 的 base64 代理
之后。列表抓不到的长尾，靠行为能抓到。

第二个区别发生在**引擎判断错**的时候。每一条自学习规则都限定在教会它的站点上、可以逐条
撤销，并且在结构上**不可能**碰到图片、视频、样式或脚本。取舍是明确的：

> **宁可漏掉一个广告，也不弄坏页面。**

与 AdBlock Plus 不同：**没有"可接受广告"付费白名单**，不靠收钱放行任何广告。构建脚本
甚至会拒绝抓取含付费白名单的列表。

## 功能

**网络层** —— 6 份过滤列表（EasyList、EasyList China、EasyPrivacy、uBlock filters /
privacy / badware）编译为 declarativeNetRequest 规则集：12.7 万条输入规则经去重与校验后
保留 21,146 条拦截规则 + 2,369 条例外，分 6 卷；105,675 个域名锚点折叠成 113 条打包规则。

**外观层** —— 25,478 条域名限定选择器覆盖 11,389 个域名，切成 256 个哈希分片按需下发给
内容脚本（不使用 `web_accessible_resources`，少一个指纹面）。

**行为引擎** —— 原始快照差分 + 广告相似度评分。证据包括：脚本注入、跨站链接/素材/iframe、
几何突增、推广参数、三档置信度的广告命名、全屏覆盖层、点击层、假关闭按钮、链接农场。
它还会**解包**两种规避跨站检测的伎俩：载荷里写着 `{"kind":"ad", ...}` 的自家域名跳转，
以及把真实素材地址 base64 包起来的 CDN 路径。

**反劫持防护**（MAIN world）—— `window.open` 守卫、点击劫持守卫、清理
`localStorage`/`sessionStorage`/`window.name` 里的弹窗状态、拒绝"只做跳转"的文档级点击
处理函数。

**脚本注入支持** —— 12 个规范 `##+js(...)`（`abort-on-property-read`、`set-constant`、
`json-prune`、`no-fetch-if`、`no-setTimeout-if` 等），覆盖 2,841 个域名，以单份内联数据表
交付，保证在页面脚本之前执行。

**自学习** —— 按站点记住隐藏选择器与广告域名，累计三次命中才晋级；全部条目都在「规则
管理」里可逐条撤销，也可导出为 JSON。

**站点开关** —— 弹窗可对当前站点关闭过滤，同时暂停该站点学到的网络规则。永远留一条退路。

**界面** —— 中文（简体，默认）、English、日本語、Français、Español，按浏览器界面语言自动选择。

**隐私** —— 全程本地运行。无遥测、无账号、无远程配置；唯一的外发流量是浏览器更新扩展本身。

## 截图

| 弹窗（站点开关 + 实时统计） | 规则管理 |
|---|---|
| ![弹窗](store/store-1280x800-popup-zhCN.png) | ![规则管理](store/store-1280x800-options-enUS.png) |

## 安装

**从源码安装**（当前可用）：

```bash
git clone <本仓库> && cd adblow
pnpm install
pnpm filters        # 抓取 6 份过滤列表（不入库，见「许可」一节）
pnpm rulesets       # 编译成 DNR 规则集 + 外观分片 + 脚本注入数据表
pnpm build          # 产出 dist/
```

然后打开 `edge://extensions`（或 `chrome://extensions`），开启**开发人员模式**，选择
**加载解压缩的扩展**，指向 `dist/` 目录。

商店发布包（`adblow-1.0.0-edge.zip`）已准备好，但尚未上架。

## 构建与打包

```bash
pnpm test           # 631 项单元 + 集成测试（单进程内跑）
pnpm typecheck      # tsc --noEmit
pnpm verify         # 构建 + 测试
pnpm icons          # 重新生成图标（16/32/48/128 + 商店图标）
pnpm package        # 构建 + 审计 + 打包 -> release/adblow-<版本>-edge.zip
```

依赖：Node.js 24+、pnpm，以及带 Pillow 的 Python 3（仅生成图标与商店截图时用到）。

打包步骤会把 `dist/` 与 manifest 实际声明的文件逐一核对，剔除任何非产物文件（例如浏览器
自己生成的 `_metadata/` 规则集索引缓存），并输出 `manifest.json` 位于根目录的 zip。
若浏览器正加载着 `dist/`，Windows 会锁住该目录 —— 不要去杀进程，换目录构建即可：

```bash
ADBLOW_DIST=dist-release pnpm package
```

## 架构

四层，一层比一层更窄、更保守：

| 层 | 运行位置 | 机制 | 为什么需要 |
|---|---|---|---|
| **L1 网络** | `declarativeNetRequest` | 过滤列表编译出的静态规则集 + 学习域名的动态规则 | 在请求离开浏览器之前就拦掉 |
| **L2 外观** | 隔离世界 | 域名限定 CSS；判定命中的元素用内联 `!important` 隐藏 | 让本就不该渲染的东西不渲染 |
| **L3 行为** | 隔离世界 | 原始快照差分、广告相似度评分、自学习 | 抓列表从未见过的东西 |
| **L4 防护** | MAIN world | `window.open`、点击劫持、存储清理、监听器拒绝 | 阻止页面反制 |

```
src/
  background/      service worker：DNR 同步、外观分片下发、统计
  content/         L2+L3：引擎、判定、学习存储、站点设置
  engine/          纯逻辑、与浏览器无关：评分、词表、几何、DNR、过滤列表编译器、
                   脚本注入解析、选择器泛化
  inject/          L4：MAIN world 防护、脚本注入运行时
  rules/sites/     手写站点规则包（逐站验证过的选择器）
  ui/              弹窗 + 规则管理 + 多语言（5 种）
tools/
  filters/         列表抓取（拒绝含付费白名单的列表）
  build/           规则集 / 外观 / 脚本注入代码生成、打包、图标生成
  e2e/             23 类真实浏览器验收、活站端到端
  release/         审计、zip、商店截图
  diagnostics/     可直接粘进控制台的诊断脚本，用于排查某站点被弄坏
tests/             631 项单元 + 集成测试（jsdom）
public/            manifest、_locales、图标
```

### 安全不变量

以下每条都在代码里强制、并有测试守着——因为它们每一条都对应一次真实的失误：

- 自学习网络规则**绝不**触碰 `image`、`media`、`script`、`stylesheet`、`font` ——
  内容缩略图与广告素材经常共用同一个 CDN。
- 自学习规则限定在**教会它的站点**（`initiatorDomains`），A 站学到的域名不可能弄坏 B 站。
- 隐式规则永不拦 `main_frame`；只有显式 `$document` 规则可以。
- 引擎绝不隐藏 `html`、`body`、`head`：隐藏它们等于清空整页。
- 有页级隐藏预算限制可隐藏的文字与链接比例；装着正文或导航的元素一律豁免。
- 隐藏会同时设 `display`、`visibility`、`pointer-events` 三道，并在之后复核：站点确实会用
  自己的 `!important` 把 `display` 改回来。

## 测试与验证

```bash
node tests/run-all.ts           # 631 项测试，0 失败
node tools/e2e/acceptance.mjs   # 23 类广告，在真实浏览器里实测
```

`tools/e2e/acceptance.mjs` 是重点。它为 23 类干扰视线的广告各建一个真实形态的测试页
（前置弹窗、底层弹窗、插屏、漂浮、边角浮标、粘性横幅、页外流视频、前置贴片、中插、
视频叠加、整页可点击、假关闭按钮、点击劫持、标签页劫持、区域展开、闪烁 GIF、富媒体、
自家域名跳转包装、CDN base64 包装……）。**每个**夹具都先在关闭扩展时测一遍基线——如果
基线里它并不可见/不干扰，就认为这个夹具没有意义——再在加载扩展后测一遍。要求是广告必须
消失，**同时**夹具里的正文必须仍然可见。

另外还有活站端到端（`tools/e2e/run.mjs <url>`），带图片守卫、CDN 守卫、站点自有域名守卫，
所以"修好一个广告却开始隐藏正文"这一类回归会立刻失败。

## 已知限制

如实写出，因为只列优点的 README 没有价值：

- 通用（非域名限定）外观规则未注入；只注入域名限定的那部分。
- 过程式外观规则（`#?#`）与 HTML 过滤（`##^`）未实现。
- `##+js(abort-current-script)` 等少数脚本注入（列表里 359 条）不支持；构建会如实报告
  跳过了什么，而不是把规则悄悄放宽。
- 过滤列表在构建期编译，更新列表需要重新构建扩展（MV3 限制：不支持远程规则集）。
- 尚无公开的性能基准，也还没做与其他过滤器在**中立站点**上的公平对比。

## 致谢

过滤列表是各自维护者的成果，**不属于本仓库**，在构建时抓取：

| 列表 | 许可 |
|---|---|
| [EasyList](https://easylist.to/)、[EasyList China](https://easylist.to/)、[EasyPrivacy](https://easylist.to/) | GPLv3 / CC BY-SA 3.0 |
| [uBlock Origin assets](https://github.com/uBlockOrigin/uAssets)（filters、privacy、badware） | GPLv3 |

再分发由本仓库构建出的任何东西时，请尊重上述许可。

## 许可

**尚未选定——这是发布前唯一还开着的决定。** 仓库里的源码是作者的作品，但**构建出的扩展**
会内嵌上表中的 GPLv3 / CC BY-SA 过滤列表，所以两者不能各自决定。可选方案：

1. **整个项目用 GPL-3.0** —— 考虑到内嵌列表，这是最容易讲清楚的。
2. **代码用 MIT 或 Apache-2.0**，并明确声明构建产物内嵌第三方 GPL / CC BY-SA 数据、
   继承相应义务。

在加入 `LICENSE` 文件之前，默认保留所有权利。

---

<div align="center">
<sub>AdBlow 1.0.0 · Manifest V3 · Edge &amp; Chrome</sub>
</div>
