# AdBlow 发布清单（Microsoft Edge 加载项商店）

**商店页面**：https://microsoftedge.microsoft.com/addons/detail/adblow/omfepilfkagfdjejmdlkkphecllioion
（已上架 v1.0.0；当前开发版本 v1.0.3）

## 一、产物

| 用途 | 文件 |
|---|---|
| **上传商店的扩展包** | `release/adblow-1.0.3-edge.zip` |
| **GitHub Release 附件：列表快照** | `release/adblow-filter-lists-<抓取日期>.zip`（名字取自 `filters/meta.json` 的 `fetchedAt`） |
| 商店列表图标 | `store/icon-300.png`（300×300） |
| 商店截图 | `store/store-1280x800-options-{zhCN,enUS}.png`、`store/store-1280x800-popup-{zhCN,enUS}.png` |

> ⚠️ **截图是手工资产，不是构建产物**。它们可能是"访问真实站点后点开弹窗"的整屏截图，
> 尺寸未必是 1280×800 那种精确值，**看起来不规整是正常的**。
> 不要自动覆盖，也不要 `git checkout` 还原；改完立刻提交（曾经因此丢失过手工成果）。
> 需要转成商店要求的精确尺寸时用 `tools/release/fit-store-shot.py`。

## 二、发布流程（四个命令）

GitHub Release 与两个附件由仓库工具完成，不再手工改文档、手工拼 zip、手工调 REST API；
Edge 加载项商店的上传仍是手工步骤（商店后台没有可用的免鉴权接口），上传 `release/adblow-<版本>-edge.zip` 即可：

```bash
pnpm filters --force                 # 仅在需要刷新过滤列表时；列表不入库
pnpm version:bump <新版本>            # 升版本：只打印将要改的版本引用（dry-run，不写文件）
pnpm version:bump <新版本> --write    # 真改：package.json + 两份 README + 本文件
git add -A && git commit && git push  # 发布必须对应一个已推送的提交
pnpm package                         # 构建 + 审计 + 打包 -> release/adblow-<版本>-edge.zip
pnpm release:github                  # dry-run：跑完全部校验并打印将要发出的请求
pnpm release:github --publish        # 建 Release，上传商店包 + 过滤列表快照
```

`pnpm version:bump` 的规则表在 `tools/release/release-core.mjs`：它逐条核对文档里的字面量，
任何一条对不上都会打印出来并拒绝写入，所以"漏改一处版本引用"不会再静默通过。
带 `--test-count <n>` 时，两份 README 的测试计数徽章与正文行也一并同步；若某一轮只是新增测试、
不升版本，用 `pnpm version:bump --counts-only --test-count <n> --write` 单独同步计数。

`pnpm release:github` 默认 **dry-run**，只做检查、不发任何写请求；`--publish` 才真正建 Release。
它会拒绝以下情况，并逐条说明修法：

- `package.json` 版本、请求的 tag、**包内** `manifest.json` 的版本三者不一致（包内版本是解压读出来的，不看构建日志）；
- 工作区有未提交改动，或 HEAD 与远端不一致（发布应对应已推送的提交）；
- `docs/release-notes/<版本>.md` 缺失或为空；
- 过滤列表快照超过 7 天（按 `filters/meta.json` 的 `fetchedAt`），提示先跑 `pnpm filters --force`；
- 缺少凭据。凭据优先取环境变量 `GH_TOKEN`，否则用 `git credential fill`；**token 内容不会被打印**（只打印长度）。

Release 已存在时复用，只补传缺失的附件；同名附件不重复上传。列表快照由工具在发布时按
`filters/*.txt` + `meta.json` 现场打包，文件名与内容都由抓取时间决定。

`--offline`（不发任何网络请求）与 `--rehearse`（仅跳过"工作区干净且已推送"这一项）只用于演练，
两者都不能与 `--publish` 同时使用。

图标与商店截图是另外的手工素材：

```bash
pnpm icons                              # 图标（16/32/48/128 + store/icon-300.png）
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

## 三、商店后台要填的内容

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

## 四、需要如实声明的隐私事实

AdBlow 的行为**全部在本地**，没有任何服务端：

- **不发送**任何遥测、统计或崩溃上报
- **不读取**浏览历史、书签、账号信息
- `storage` 只存**自学习结果**（某站点上的隐藏选择器 / 广告域名）与站点开关，留在本地
- `declarativeNetRequest` 用于拦截请求，规则来自**内置的过滤列表**与本地学习的域名
- 唯一的外发流量是**扩展自身更新**（由浏览器负责）

因此"是否收集用户数据"应选 **否**；若要填写数据用途，可写"不收集"。

## 五、权限说明（商店会逐条问用途）

| 权限 | 用途 |
|---|---|
| `declarativeNetRequest` | 按过滤列表与自学习域名拦截广告请求 |
| `storage` | 保存自学习规则与"本站关闭过滤"的开关 |
| `activeTab` | 弹窗里显示当前站点并支持单站开关 |
| `<all_urls>`（host） | 广告过滤必须覆盖用户访问的任意站点；不注入则无法工作 |

## 六、提交前的自检（都已通过）

- [x] `manifest.json` 位于 zip **根目录**，无多余目录层
- [x] ZIP 由自写实现写出，并由 `tools/release/zip.mjs` 的读取器复读：解包正常，包内
      `manifest.json` 的 `version` 与 `package.json` 一致（`pnpm release:github` 每次发布前都会再验一遍）
- [x] 包内**不含** `_metadata/`（浏览器加载扩展时自动生成的索引缓存，约 6 MB）
- [x] `name` / `version` / `description` / `icons` / `default_locale` 齐全
- [x] `version` 为 `x.y.z`（1.0.3），由 `package.json` 单一来源注入
- [x] manifest 与界面用到的每个文案 key 在 5 种语言里都存在
- [x] 5 种语言在真实 Edge 里逐个 `--lang` 实测，文案正确、无空文案、无文字溢出
- [x] 959 项测试通过 · 24 类干扰视线广告验收 **24/24** · CI 门禁（含解包审计与真实 Edge 验收）全绿

## 七、许可证（已确定）

本项目整体按 **GPL-3.0** 分发（[`LICENSE`](../LICENSE)），本仓库原创代码同时提供
**MIT**（[`LICENSE-MIT`](../LICENSE-MIT)）。

这样定的原因：打包扩展会内嵌 EasyList / EasyPrivacy / uBlock 系的 **GPL-3.0 / CC BY-SA**
过滤列表数据，这部分不能按 MIT 授权，所以整个交付物按 GPL-3.0 分发；本仓库自己的代码
（引擎、界面、构建与发布脚本、测试）与之无关，额外给出 MIT。

对商店发布的影响：GPL-3.0 **不禁止**把扩展提交到商店，但要求向收到交付物的人提供对应源码。
本仓库公开即可满足这一条；请保持仓库公开可访问（`docs/plans/2026-10-11-filter-list-integration.md`
的许可一节有更详细的分析）。第三方列表不属于本仓库，构建时抓取，各自许可见 README 的致谢一节。

## 八、上架之后：过滤列表怎么更新

静态规则集是打包文件，**MV3 没有远程替换它的接口**，所以列表的新鲜度等于发版频率：

```bash
pnpm update-lists          # 抓取 → 编译 → 构建 → 测试 → 打包，并打印刷新前后的列表日期
pnpm version:bump <新版本> --write
git add -A && git commit && git push
pnpm release:github --publish
```

`pnpm release:github` 会在快照超过 7 天时拒绝发布（按 `filters/meta.json` 的 `fetchedAt`），
所以"列表刷新"和"发版"这两件事不会悄悄脱节。

- **节奏**：每月一次；遇到明显误杀或漏拦，随版本一起发。
- 审核通过后，已安装用户会在数小时内自动更新。
- 规则管理页会显示内置列表的抓取日期（`list-info.json`），这是判断"用户手上规则是否过期"
  的唯一依据，报障时先看这一行。
- 想把更新做到"不发版"也行，但要守住六条边界（尤其"只下数据不下代码"，脚本注入必须随包），
  详见 [`docs/LIST-UPDATES.md`](LIST-UPDATES.md)。

## 九、发布说明（受版本控制）

每个版本的发布说明是一个受版本控制的文件：`docs/release-notes/<版本>.md`。

- GitHub Release 正文由 `pnpm release:github` 从该文件读取，找不到就拒绝发布；
- 同一份文本就是商店后台"新版说明"字段的内容，不再从临时文件手工复制；
- v1.0.1 与 v1.0.2 的说明已迁入 [`docs/release-notes/`](release-notes/)，v1.0.0 及更早没有留下同格式的文件。

## 十、自动发版（定时任务）

`.github/workflows/auto-release.yml` 每周一 03:17 UTC 执行一次，做的是"抓列表 → 判断有没有变 → 变了才发版"：

1. 抓取六份过滤列表并重新编译规则集，跑 `pnpm typecheck` 与全部测试（测试不过就不发）；
2. `pnpm release:auto` 把六份列表**正文**的 sha256 与编译产物计数组成指纹，与受版本控制的
   [`tools/release/baseline.json`](../tools/release/baseline.json) 比较；
3. **指纹没变**：打印结论后结束——不升版本、不提交、不发 Release。`filters/meta.json` 的 `fetchedAt`
   与 `report.json` 的 `generatedAt` / `listFetchedAt` 都不参与比较，列表头部的
   `! Version:` / `! Last modified:` / `! Checksum:` 也不参与（它们不是规则行），所以"只是重新抓了一次"
   不会被误判成有变化；
4. **指纹变了**：升 patch 版本（同时改写两份 README 与本文件的版本引用）、按变化生成
   `docs/release-notes/<新版本>.md`（已存在则保留不动）、打包、提交并推送，最后 `pnpm release:github --publish`
   建 Release 并上传附件（顺序不能反：`release:github` 要求 HEAD 已在远端）；
5. **基线文件不存在**（第一次配置，或指纹结构升级）时：只写入基线并结束，不发版；
6. **抓取不完整时拒绝判断**：配置的列表（[`tools/filters/fetch-lists.mjs`](../tools/filters/fetch-lists.mjs)
   的 `LIST_SOURCES`）少抓了一份、或基线里有而本次指纹里没有的列表，都按错误处理而不是"列表被改掉了"——
   否则一次网络失败会被当成规则变化，发出一个缺了整份列表的版本。确实要移除某个列表来源时，先删掉基线文件
   再重跑：那只记录新基线，下一次运行才会发版。

本地判断用 `pnpm release:auto`：默认 dry-run，只判断并打印结论；`--write` 才写文件。
`--decision-file <路径>` 把结论写成 JSON（dry-run 下也会写，供 CI 读取；路径应放在工作区之外）。

手动触发：仓库 **Actions → auto-release → Run workflow**；输入项 `publish` 默认不勾选，不勾选时只报告
结论、不写任何文件。

关闭自动发版：注释或删除 workflow 里的 `schedule` 一段（保留 `workflow_dispatch` 即变成纯手动），
或在 Actions 页面直接禁用该 workflow。

失败是显式失败：任何一步报错，流水线就以非零退出码结束，不会有"看起来成功但什么都没发"的中间状态；
`concurrency` 保证同一时间只有一个实例在跑，避免两次运行各自推一个提交。

## 十一、CI 结构与本地复现

CI 采用"一处定义、两处调用"：

| 文件 | 触发 | 职责 |
|---|---|---|
| `.github/workflows/checks.yml` | 仅 `workflow_call` | **唯一定义"什么算通过"**；不被任何事件直接触发，只接受调用 |
| `.github/workflows/ci.yml` | `push`、`pull_request` | 只做调用：作业体里没有一条 `run:`，只有 `uses: ./.github/workflows/checks.yml` |
| `.github/workflows/auto-release.yml` | 每周一 03:17 UTC、手动触发 | 先调用 `checks.yml`（`needs: checks`），通过之后才抓列表、判断指纹、打包与发版 |

`checks.yml` 的两个作业：

1. **build**（`ubuntu-latest`）：`pnpm install --frozen-lockfile` → `pnpm typecheck` →
   `node tests/run-all.ts` → `pnpm filters --force` → `pnpm rulesets` → `pnpm build` → `pnpm package` →
   `node tools/release/verify-package.mjs`（独立解包审计）→ 上传 `dist/` 供下一个作业使用。
   抓取与编译放在两道确定性门禁之后：树本身有问题时不必先等网络。
2. **acceptance**（`windows-latest`，`needs: build`）：下载上一步的 `dist/`，运行
   `node tools/e2e/acceptance.mjs --min-pass 24`。24 类夹具需要真实 Edge，选
   `windows-latest` 的原因是该镜像预装 Edge，而套件本来就是为 Windows 上的 Edge 写的。

四处需要说明的地方：

- **checks 里也要抓列表**。`list-info.json` 只有在规则集注入之后才会生成（见
  `tools/build/build.mjs`），而解包审计必须断言它在包里；同时受审计的包应当与真正发布的包同形。
  因此 checks 的 build 作业自己抓一次列表。auto-release 的发布作业再抓一次，因为指纹必须由
  **那一次**抓取的结果算出，而两个作业跑在不同的 runner 上，工作区无法共享。
- **`pnpm install` 仍留在 auto-release 的发布作业里**：该作业自己要跑 `pnpm rulesets`、`pnpm package`
  与 `pnpm release:github`，需要 `node_modules`；被搬进 `checks.yml` 的是 typecheck 与测试这两道判断。
- **`concurrency` 只写在两个入口上**：`ci.yml` 用 `cancel-in-progress: true`（同一 ref 的旧运行没有
  继续的意义），auto-release 保持 `cancel-in-progress: false`（正在推送的运行不能被取消）；
  `checks.yml` 作为被调用方，其并发由调用方的 `concurrency` 覆盖。
- **独立解包审计**不复用 `tools/release/package.mjs` 的审计代码路径：它用 `tools/release/zip.mjs`
  的读取器打开 `release/adblow-<版本>-edge.zip`，把包内内容读回来，断言包内 `manifest.json` 的
  `version` 与 `package.json` 一致、manifest 声明的每个文件都在包里、`_locales/`（含默认语言的
  `messages.json`）、图标、`list-info.json` 均存在。另有额外两项：包内不得出现浏览器自动生成的
  `_metadata/`；**文件名里的版本**必须与包内 manifest 一致（防止对旧产物做审计）。

`tools/e2e/acceptance.mjs` 增加了两个开关，默认行为不变：

- `ADBLOW_BROWSER=<可执行文件路径>`：浏览器候选列表变成"该项 + 两个标准 Edge 路径"，该项不存在时
  自动回退。CI 的 `windows-latest` 用它显式指向镜像里的 Edge。
- `--min-pass <n>`：命中数低于 n 时以非零退出码结束（默认 0，即只报告命中率，保持原来"尺子"的用法）。
  CI 用 `--min-pass 24`，因为文档里的验收标准就是 24/24。

验收套件失败时上传的产物：它把两个浏览器的 stdout/stderr 写到 `_probe/e2e/acc-9831.log`、
`acc-9831.err.log`、`acc-9832.log`、`acc-9832.err.log`，**不写截图**，所以
`checks.yml` 的 acceptance 作业在 `failure()` 时只上传 `_probe/e2e/*.log`。

本地复现同一套检查（与 `checks.yml` 的 build 作业一一对应）：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
node tests/run-all.ts
pnpm filters --force && pnpm rulesets   # 规则集不入库：先抓取，再编译
pnpm build && pnpm package
node tools/release/verify-package.mjs   # 独立解包审计（等价脚本：pnpm verify:package）
node tools/e2e/acceptance.mjs --min-pass 24   # 需要 Edge；位置不同时设 ADBLOW_BROWSER
```

workflow 本身无法在本机执行 —— GitHub Actions 是唯一的解释器，因此
`tests/unit/ciWorkflows.test.ts` 只做结构断言：触发条件、权限、调用关系、必需步骤存在与顺序，
以及两条真实踩过的坑（作业级 `env` 里不得出现 `runner.` 上下文；不得给 pnpm 传 `--` 分隔符）。
命令字符串的拼接细节不作断言。

