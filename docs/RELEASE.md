# AdBlow 发布清单（Microsoft Edge 加载项商店）

**商店页面**：https://microsoftedge.microsoft.com/addons/detail/adblow/omfepilfkagfdjejmdlkkphecllioion
（已上架 v1.0.0；当前开发版本 v1.0.1）

## 一、产物

| 用途 | 文件 |
|---|---|
| **上传商店的扩展包** | `release/adblow-1.0.1-edge.zip` |
| 商店列表图标 | `store/icon-300.png`（300×300） |
| 商店截图 | `store/store-1280x800-options-{zhCN,enUS}.png`、`store/store-1280x800-popup-{zhCN,enUS}.png` |

> ⚠️ **截图是手工资产，不是构建产物**。它们可能是"访问真实站点后点开弹窗"的整屏截图，
> 尺寸未必是 1280×800 那种精确值，**看起来不规整是正常的**。
> 不要自动覆盖，也不要 `git checkout` 还原；改完立刻提交（曾经因此丢失过手工成果）。
> 需要转成商店要求的精确尺寸时用 `tools/release/fit-store-shot.py`。

重新生成：

```bash
pnpm icons                              # 图标（16/32/48/128 + store/icon-300.png）
node tools/release/package.mjs          # 构建 + 审计 + 打包 zip
python tools/release/compose-store-shots.py   # 商店截图合成（需先跑 _probe/gen-store-shots.mjs）
```

> **Windows 提示**：若浏览器正以"加载解压缩扩展"的方式加载 `dist/`，该目录会被占用，
> 构建时 `rmSync(dist)` 会报 `EPERM`。此时用
> `ADBLOW_DIST=dist-release node tools/release/package.mjs` 在备用目录构建并打包即可
> （构建脚本、打包脚本、E2E 脚本与探针都支持这个环境变量）。
> 不要去杀浏览器进程：实测 Edge 的实际浏览器进程与启动器不是同一个，
> 杀掉启动器没用，而真身可能被守护进程重启。
>
> ⚠️ **`dist/` 才是唯一基准产物目录**，`dist-release/`（或任何 `ADBLOW_DIST` 指定的目录）
> 只是临时的逃生通道，**用完就删**，不要留在仓库里造成"以哪个为准"的困惑。
> 两者内容本来就一样（相同源码、相同构建），差别只在于：被浏览器加载过的那个目录里
> 会多出 `_metadata/generated_indexed_rulesets/`（浏览器自动生成的规则集索引缓存，
> 约 5 MB），它**不属于产物**，打包审计会自动剔除。

## 界面文案

界面里的产品标题为 `appTitle`，各语言：

| 语言 | 标题 |
|---|---|
| 中文（简体） | AdBlow-广告清理 |
| English | AdBlow-Ad Cleaner |
| 日本語 | AdBlow-広告クリーナー |
| Français | AdBlow-Nettoyeur de pubs |
| Español | AdBlow-Limpiador de anuncios |

它同时用于 popup / options 的页面 `<title>` 与页面里的品牌行。
**manifest 的 `name` 仍是 `AdBlow`**（即扩展管理页与商店列表显示的正式名称）——
若要一并改成带后缀的名称，改 `_locales/*/messages.json` 的 `extName` 即可。

## 二、商店后台要填的内容

- **名称**：AdBlow（`_locales/*/messages.json` 的 `extName`，各语言一致）
- **简介**：取 `extDesc`（各语言都有，≤132 字符）
- **详细说明**：中文 300 字 + 对照英文版，填进商店后台的"详细说明"字段。
  文案不随仓库分发（`store/listing.md` 已从仓库移除），需要时从 git 历史取回：
  `git show 4855432^:store/listing.md`。
  改动产品功能后记得同步文案，别让商店描述落后于实际能力。
- **类别**：隐私与安全 / Productivity
- **语言**：中文（简体）、English、日本語、Français、Español
  —— 界面语言由浏览器 UI 语言决定，扩展内已内置这 5 套 `_locales`
- **截图**：上传 `store/store-1280x800-*.png`（商店要求 1280×800 或 640×400）
- **隐私政策**：必须说明"不收集、不上传任何用户数据"（见下）

## 三、需要如实声明的隐私事实

AdBlow 的行为**全部在本地**，没有任何服务端：

- **不发送**任何遥测、统计或崩溃上报
- **不读取**浏览历史、书签、账号信息
- `storage` 只存**自学习结果**（某站点上的隐藏选择器 / 广告域名）与站点开关，留在本地
- `declarativeNetRequest` 用于拦截请求，规则来自**内置的过滤列表**与本地学习的域名
- 唯一的外发流量是**扩展自身更新**（由浏览器负责）

因此"是否收集用户数据"应选 **否**；若要填写数据用途，可写"不收集"。

## 四、权限说明（商店会逐条问用途）

| 权限 | 用途 |
|---|---|
| `declarativeNetRequest` | 按过滤列表与自学习域名拦截广告请求 |
| `storage` | 保存自学习规则与"本站关闭过滤"的开关 |
| `activeTab` | 弹窗里显示当前站点并支持单站开关 |
| `<all_urls>`（host） | 广告过滤必须覆盖用户访问的任意站点；不注入则无法工作 |

## 五、提交前的自检（都已通过）

- [x] `manifest.json` 位于 zip **根目录**，无多余目录层
- [x] ZIP 用独立实现（Python `zipfile`）校验：CRC 全部通过、可正常解包
- [x] 包内**不含** `_metadata/`（浏览器加载扩展时自动生成的索引缓存，约 6 MB）
- [x] `name` / `version` / `description` / `icons` / `default_locale` 齐全
- [x] `version` 为 `x.y.z`（1.0.1），由 `package.json` 单一来源注入
- [x] manifest 与界面用到的每个文案 key 在 5 种语言里都存在
- [x] 5 种语言在真实 Edge 里逐个 `--lang` 实测，文案正确、无空文案、无文字溢出
- [x] 694 项测试通过 · 24 类干扰视线广告验收 **24/24** · 试点站 E2E 全通过

## 六、许可证（已确定）

本项目整体按 **GPL-3.0** 分发（[`LICENSE`](../LICENSE)），本仓库原创代码同时提供
**MIT**（[`LICENSE-MIT`](../LICENSE-MIT)）。

这样定的原因：打包扩展会内嵌 EasyList / EasyPrivacy / uBlock 系的 **GPL-3.0 / CC BY-SA**
过滤列表数据，这部分不能按 MIT 授权，所以整个交付物按 GPL-3.0 分发；本仓库自己的代码
（引擎、界面、构建与发布脚本、测试）与之无关，额外给出 MIT。

对商店发布的影响：GPL-3.0 **不禁止**把扩展提交到商店，但要求向收到交付物的人提供对应源码。
本仓库公开即可满足这一条；请保持仓库公开可访问（`docs/plans/2026-10-11-filter-list-integration.md`
的许可一节有更详细的分析）。第三方列表不属于本仓库，构建时抓取，各自许可见 README 的致谢一节。

## 七、上架之后：过滤列表怎么更新

静态规则集是打包文件，**MV3 没有远程替换它的接口**，所以列表的新鲜度等于发版频率：

```bash
pnpm update-lists          # 抓取 → 编译 → 构建 → 测试 → 打包，并打印刷新前后的列表日期
# 改 package.json 的 version，再跑一次 pnpm package
# 上传 release/adblow-<版本>-edge.zip
```

- **节奏**：每月一次；遇到明显误杀或漏拦，随版本一起发。
- 审核通过后，已安装用户会在数小时内自动更新。
- 规则管理页会显示内置列表的抓取日期（`list-info.json`），这是判断"用户手上规则是否过期"
  的唯一依据，报障时先看这一行。
- 想把更新做到"不发版"也行，但要守住六条边界（尤其"只下数据不下代码"，脚本注入必须随包），
  详见 [`docs/LIST-UPDATES.md`](LIST-UPDATES.md)。

## 八、v1.0.1 更新说明（商店后台"新版说明"字段，按语言分别填写）

### 中文（简体）

- 新增脚本注入规则 `abort-current-script`（仅在规则自带搜索串时生效），可覆盖的脚本注入规则由
  1,964 条增至 2,286 条，覆盖域名由 2,841 个增至 3,247 个。
- 新增反过滤墙处理：站点用诱饵元素探测过滤器并遮挡页面时，弹窗会给出提示，经确认后隐藏该遮罩、
  恢复被它遮挡的正文；广告拦截保持不变，且不会在未经确认时改动页面。
- 规则管理页新增内置过滤列表的抓取日期，便于判断规则是否过期。
- 修正打包环节误删列表信息文件的问题；补齐界面文案与五种语言的译者注释。

### English

- Added the `abort-current-script` scriptlet (applied only when the rule carries a search needle):
  supported scriptlet rules grew from 1,964 to 2,286, covering 2,841 to 3,247 domains.
- Added anti-adblock wall handling: when a site probes for a blocker and covers the page, the popup
  offers a per-site fix that hides the gate and restores the content it hid. Ad blocking stays on,
  and nothing changes on a site until the fix is accepted.
- The rule manager now shows the fetch date of the bundled filter lists.
- Fixed a packaging issue that dropped the list-info file; filled in UI strings and translator notes
  for all five locales.
