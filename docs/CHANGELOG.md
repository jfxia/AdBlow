# 更新日志（v1.0.0 → v1.0.4）

供应用商店发布使用：每个版本下面分中英两段，可直接粘贴到对应版本的「新版说明」字段。
数字均为该版本发布时的值。

---

## v1.0.4

### 中文（简体）

- 点击劫持拦截加固：除原有检查外，现在也拒绝 `document.onclick = …` 属性赋值、`<body onclick="…">` 行内属性，以及注册在 `body` / `html` 上的跳转处理器。这类代码的典型表现是页面加载后看不到广告，但鼠标随便点一下就跳到其他网站。
- 收窄弹窗放行条件：跨站 `window.open` 只在点击链接、按钮一类控件时放行；点击正文或空白处触发的跨站开窗会被拒绝，用于阻断 popunder 广告的常见手法。
- 新增「点击劫持观测」：记录“点击普通内容后顶层页面跳到其他站点”的情况，可在规则管理页查看站点、次数、最近时间与跳向域名，每行可单独删除。该功能只记录，不改变页面行为。
- 中文与英文 README 重写，补齐每项功能的前因后果。

### English

- Hardened click-hijack blocking: navigation handlers installed via `document.onclick = …`, inline `<body onclick="…">`, or on `body` / `html` are now refused as well. The symptom these produce is a page that looks clean after loading, yet jumps to another site on any click.
- Narrowed the popup policy: a cross-site `window.open` is allowed only when the click landed on a link or button; clicks on body text or blank areas no longer open one. This blocks the usual popunder delivery.
- Added click-hijack observations: records “a click on ordinary content was followed by a top-level navigation to another site”, shown in the rule manager with count, last time and destination, removable per row. Observation only; page behaviour is unchanged.
- Rewrote the Chinese and English READMEs to give each feature its problem, approach and effect.

---

## v1.0.3

### 中文（简体）

- 定时任务自动发布的补丁版本：过滤列表已刷新，规则集随之重建；除列表数据与版本号外没有代码改动。
- 编译结果：输入 129,086 条 → 拦截 20,839 条 + 例外 2,360 条，分 6 卷；域名锚点 107,733 个，合并为 115 条规则。

### English

- Patch release published by the scheduled task: the filter lists were refreshed and the rulesets rebuilt; nothing changed except list data and the version number.
- Compiled result: 129,086 input rules → 20,839 block rules and 2,360 exceptions in six rulesets; 107,733 domain anchors collapsed into 115 rules.

---

## v1.0.2

### 中文（简体）

- 规则管理页排序固定：站点按域名升序、站内规则按字母序，网络层的域名规则与隐藏规则按站点合并为一张列表；排序时忽略开头的 `www.`。
- 自学习规则加上限与衰减：每个站点最多保留 40 条已晋级选择器、200 条观察中的选择器、50 个学习到的广告域名（全局学习域名上限 2,000），30/90 天未命中即清理，命中计数每 30 天减半。目的是防止规则无限增长拖慢页面判定。
- 开发工具：移除指向已下线试点站的默认 URL，改为必须显式传参。

### English

- Fixed the ordering in the rule manager: sites sorted by domain, rules within a site sorted alphabetically, and a site's network-layer domains and hiding rules merged into one list; a leading `www.` is ignored when sorting.
- Added caps and decay to self-learning: per site at most 40 promoted selectors, 200 observing selectors and 50 learned ad domains (2,000 globally), pruned after 30/90 days without a hit, with hit counts halved every 30 days. The cap keeps rule growth from slowing page judgement.
- Development tools: removed the default URL that pointed at a pilot site that has since gone offline; an explicit URL is now required.

---

## v1.0.1

### 中文（简体）

- 新增脚本注入规则 `abort-current-script`（仅在规则自带搜索串时生效）：可覆盖的脚本注入规则由 1,964 条增至 2,286 条，覆盖域名由 2,841 个增至 3,247 个。
- 新增反过滤墙处理：站点用诱饵元素探测过滤器并遮挡页面时，弹窗给出提示，经确认后隐藏该遮罩、恢复被它遮挡的正文；广告拦截保持不变，未经确认时不改动页面。
- 规则管理页新增内置过滤列表的抓取日期。
- 修正打包环节误删列表信息文件的问题，补齐界面文案与五种语言的译者注释。

### English

- Added the `abort-current-script` scriptlet (applied only when the rule carries a search needle): supported scriptlet rules grew from 1,964 to 2,286, covering 2,841 to 3,247 domains.
- Added anti-adblock wall handling: when a site probes for a blocker and covers the page, the popup offers a per-site fix that hides the gate and restores the content it hid. Ad blocking stays on, and nothing changes on a site until the fix is accepted.
- The rule manager now shows the fetch date of the bundled filter lists.
- Fixed a packaging issue that dropped the list-info file; filled in UI strings and translator notes for all five locales.

---

## v1.0.0

首次上架版本。

### 中文（简体）

- 基于 Manifest V3 的广告过滤扩展，过滤引擎、界面与构建工具链均为自行实现。
- 网络层：6 份过滤列表（EasyList、EasyList China、EasyPrivacy、uBlock filters / privacy / badware）在构建期编译为 declarativeNetRequest 规则集。
- 元素隐藏：按域名限定的隐藏规则按哈希切成 256 个分片，由内容脚本按需向后台请求。
- 行为判定：以页面加载初期的原始快照为基准做差分，对每个元素计算广告相似度，识别脚本注入、跨站素材、尺寸突增、自家域名跳转包装、CDN base64 包装等形态。
- 反劫持：在页面 MAIN world 中限制 `window.open`、点击劫持、弹窗状态写入与文档级跳转处理器。
- 脚本注入：支持 12 个规范的 `##+js(...)` 规则名，约 1,964 条规则，覆盖 2,841 个域名。
- 自学习：按站点记录隐藏规则与广告域名，累计命中 3 次后生效，可在规则管理页逐条撤销或整体导出。
- 界面提供中文（简体，默认）、English、日本語、Français、Español 五种语言；所有处理均在本地完成，不含遥测、账号与远程配置。

### English

First release.

- An ad blocker for Manifest V3, with the filtering engine, the user interface and the build toolchain implemented from scratch.
- Network layer: six filter lists (EasyList, EasyList China, EasyPrivacy, uBlock filters / privacy / badware) compiled into declarativeNetRequest rulesets at build time.
- Element hiding: domain-scoped hiding rules hashed into 256 shards, requested from the background worker on demand.
- Behaviour engine: a diff against a pristine snapshot taken early in page load, scoring each element for ad likeness and recognising script injection, cross-site assets, geometry growth, own-domain redirect wrapping and base64 CDN wrapping.
- Anti-hijack: `window.open`, click hijacking, popup-state writes and document-level navigation handlers are restricted in the page's MAIN world.
- Scriptlets: 12 canonical `##+js(...)` names, about 1,964 rules covering 2,841 domains.
- Self-learning: hiding rules and ad domains are recorded per site, become active after 3 cumulative hits, and can be revoked entry by entry or exported from the rule manager.
- Five UI languages: Chinese (simplified, default), English, Japanese, French and Spanish. All processing is local, with no telemetry, account or remote configuration.
