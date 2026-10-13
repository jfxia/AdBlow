# AdBlow 发布清单（Microsoft Edge 加载项商店）

## 一、产物

| 用途 | 文件 |
|---|---|
| **上传商店的扩展包** | `release/adblow-1.0.0-edge.zip` |
| 商店列表图标 | `store/icon-300.png`（300×300） |
| 商店截图 | `store/store-1280x800-options-{zhCN,enUS}.png`、`store/store-1280x800-popup-{zhCN,enUS}.png` |

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
- [x] `version` 为 `x.y.z`（1.0.0），由 `package.json` 单一来源注入
- [x] manifest 与界面用到的每个文案 key 在 5 种语言里都存在
- [x] 5 种语言在真实 Edge 里逐个 `--lang` 实测，文案正确、无空文案、无文字溢出
- [x] 631 项测试通过 · 21 类干扰视线广告验收 **23/23** · 试点站 E2E 全通过

## 六、许可证注意事项（重要）

过滤列表（EasyList / EasyPrivacy / uBlock 系）采用 **GPL-3.0 / CC BY-SA** 等
copyleft 许可，允许**个人使用**，但**闭源分发**存在许可冲突。
当前发布形态是"提交到商店的打包扩展"，请自行确认是否符合你的分发意图
（详见 `docs/plans/2026-10-11-filter-list-integration.md` 的许可一节）。
