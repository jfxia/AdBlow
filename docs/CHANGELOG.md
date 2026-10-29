# 更新日志（v1.0.0 → v1.0.8）

供应用商店发布使用：每个版本下面分中英两段，可直接粘贴到对应版本的「新版说明」字段。
数字均为该版本发布时的值。

---

## v1.0.10

### 中文（简体）

- 命名证据改为按词元整词匹配，且只取类名、id 与 aria-label／title／data-ad-slot 的取值。修掉两类误伤：属性名里的 "ads" 被当成广告标记（视频页面整页被隐藏），以及 "AdBlow" 因以 "Ad" 开头被当成广告词（扩展自己的商店条目被隐藏）。
- `role="main"`、`role="navigation"`、`role="banner"`、`role="contentinfo"` 受到绝对保护，检查先于所有判定。
- 新增媒体恢复：被隐藏的区块随后开始播放视频时恢复显示，并阻止本页再次隐藏它。
- 新浪财经个股页的研报面板不再被列表规则隐藏。
- Reddit 帖子页不再因两条网络规则中断加载。
- 命名词库新增回归测试：普通词零证据，真实页面命中数不超过实测预算。

### English

- Naming evidence is now matched by whole token and read only from class values, id values and the values of aria-label, title and data-ad-slot. This fixes two false positives: "ads" inside an attribute name counted as an ad marker (whole video pages were hidden), and "AdBlow" scored as an ad word because it starts with "Ad" (the extension hid its own store listing).
- role="main", role="navigation", role="banner" and role="contentinfo" are absolutely protected, checked before every judging rule.
- Added media recovery: a hidden block that starts playing a video is restored, and is kept from being hidden again on that page.
- The research panel on Sina Finance stock pages is no longer hidden by a list rule.
- Reddit thread pages no longer stop loading because of two network rules.
- The naming lexicon gained regression tests: ordinary words score nothing, and real pages stay inside a measured budget.

---

## v1.0.9

### 中文（简体）

- 修正视频页面整块内容被隐藏的问题：页面容器上的功能开关属性名含 "ads"，被当成广告命名。命名证据现在只取类名、id 与 aria-label、title、data-ad-slot 的取值，属性名不再参与判定。
- `role="main"`、`role="navigation"`、`role="banner"`、`role="contentinfo"` 的元素受到绝对保护，检查先于所有判定规则。
- 新增媒体恢复：被隐藏的区块若随后开始播放视频（画面已解码且未暂停），且到视频之间没有强广告命名，则恢复并阻止本页再次隐藏。
- 修正新浪财经个股页正文被隐藏的问题：列表里针对新浪财经的一条隐藏规则在个股页命中了「投资研报」「大V观点」面板，现已在构建期排除。

### English

- Fixed whole content areas being hidden on video pages: a feature-flag attribute on the page container had "ads" in its name and scored as ad naming. Naming evidence now reads class values, id values and the values of aria-label, title and data-ad-slot; attribute names no longer score.
- Elements carrying role="main", role="navigation", role="banner" or role="contentinfo" are absolutely protected; the check runs before every judging rule.
- Added media recovery: a hidden block that starts playing a video (picture decoded, not paused) is restored when nothing between the video and the block is ad-named, and is kept from being hidden again on that page.
- Fixed editorial content hidden on Sina Finance stock pages: a list rule for Sina Finance matched the research/opinion panel on quote pages and is now excluded at build time.

---

## v1.0.8

### 中文（简体）

- 修正新浪财经个股页正文被隐藏的问题：过滤列表里一条针对新浪财经的隐藏规则（隐藏选项卡栏后的区块）在个股页上命中了「投资研报」「大V观点」面板。本版在构建期排除该规则，列表上游修正后自然失效。
- 顺带统计了同类风险：20,321 条外观规则中有 3,035 条含兄弟或通用组合符（`+`、`~`），这类规则依赖页面结构，是同一类误杀的共同来源；本次只排除有确认证据的一条。

### English

- Fixed editorial content being hidden on Sina Finance stock pages: a list rule for Sina Finance (hide the block after a tab bar) matched the research/opinion panel on quote pages. The rule is now excluded at build time and stops applying once the list fixes it upstream.
- Measured the same class of risk: of 20,321 hiding rules, 3,035 use sibling or general combinators (`+`、`~`), which depend on page structure and are the common source of this kind of false positive; only the one with confirmed evidence is excluded here.

---

## v1.0.7

### 中文（简体）

- 定时任务自动发布的补丁版本：过滤列表已刷新，规则集随之重建；除列表数据与版本号外没有代码改动。

### English

- Patch release published by the scheduled task: the filter lists were refreshed and the rulesets rebuilt; nothing changed except list data and the version number.

---

## v1.0.6

### 中文（简体）

- 拦截「点一下弹出广告窗口」：默认拒绝跨站开窗，只在有明确依据时放行（同站地址、指向同一地点的链接、登录/分享/支付这类固定基础设施），恶意站点名单作为附加的一层。被拦截的开窗按站点记录，可在规则管理页查看。
- 识别跳板链接：解码查询参数里的绝对地址，按解码后的目标判定，记录写入真实目标。
- 弹窗面板新增「允许本站弹窗」开关，判定误伤时可逐站放行。

### English

- Blocks click-triggered ad windows: a cross-site window is now refused by default and allowed only with a reason (same-site address, a link pointing at the same place, or sign-in/share/checkout infrastructure), with the badware list as an extra layer. Blocked windows are recorded per site and listed in the rule manager.
- Recognises hop links: an absolute address inside a query parameter is decoded and judged as the real target, and the record names that target.
- Added a per-site "allow popups" switch for cases where the rule is wrong for a site.

---

## v1.0.5

### 中文（简体）

- 新增元素选取器：在页面上拾取任意元素，为它生成一条只在本站生效的隐藏规则。元素当场隐藏，规则可在规则管理页看到（标记为「手动添加」）并随时撤销；手动规则不参与自动清理，不会因长期未命中被删除。
- 新增右键菜单入口「使用 AdBlow 拦截该元素」：右键页面元素即可弹出拾取面板并预选该元素，确认后保存。为此新增 `contextMenus` 权限，不涉及浏览数据读取。
- 自动处理 cookie 同意提示：默认点击「接受」；横幅若提供「拒绝全部」则优先拒绝。站点属于恶意域名清单、或用户在弹窗里关闭了该站点过滤时，不改动其横幅。只点击按钮，不隐藏元素。
- 过滤规则增加约 205 条：支持 `$to` 与 `$denyallow` 两个选项（对应目标域名的包含与排除），并修正三处会让规则作用范围被静默放宽的问题。

### English

- Added the element picker: pick any element on a page and it becomes a hiding rule for that site only. The element is hidden immediately, the rule appears in the rule manager marked as manual, and it can be revoked at any time. Manual rules are exempt from the automatic caps and expiry.
- Added the right-click entry "Block this element with AdBlow": the picker panel opens with the element under the cursor already selected. This adds the `contextMenus` permission, which does not grant access to browsing data.
- Added automatic handling of cookie consent prompts: "Accept" is clicked by default, and "Reject all" is preferred when the same prompt offers it. Prompts on sites in the badware list, or on sites where filtering is switched off, are left alone. Only buttons are clicked; nothing is hidden.
- About 205 more filter rules: `$to` and `$denyallow` are now supported (target-domain inclusion and exclusion), and three cases where a rule's scope could be silently widened were fixed.

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
