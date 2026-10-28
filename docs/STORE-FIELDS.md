# 商店提交字段（v1.0.6）

复制粘贴用。每个字段标题后面的数字是字符数，方便对照表单长度限制。
名称与简述取自扩展自身的 `_locales`，与包内声明一致，不要单独改。

## 名称 · 6 字符

```
AdBlow
```

## 简述（中文） · 54 字符

```
自研广告过滤器：行为检测 + 自学习规则，配合 EasyList 系列表拦截弹窗、浮层、视频广告与点击劫持。
```

## 简述（English） · 119 字符

```
Blocks pop-ups, overlays, video ads and click hijacking via behavior detection, self-learning rules and EasyList lists.
```

## 详细描述（中文） · 1071 字符

```
AdBlow 是一个自行实现的广告过滤器：过滤引擎、界面与构建工具链都不依赖现成的扩展框架。

主要能力

网络层使用六份公开过滤列表（EasyList、EasyList China、EasyPrivacy，以及 uBlock 的 filters、privacy、badware 三份），编译为当前版本约 21,000 条拦截规则与 2,400 条例外规则，覆盖弹窗脚本、统计脚本、视频前贴片与广告素材。

元素隐藏以域名限定的规则为主，不注入通用隐藏规则，避免误伤正文；隐藏结果可以逐条撤销。

行为检测以页面加载初期的原始快照为基准做差分，对每个元素综合判断广告类命名、跨站素材、尺寸突增、自家域名跳转包装、CDN base64 包装等形态。判定不通过的候选不会被隐藏。

反劫持在页面的主执行环境中运行，限制四类动作：点击后跳转到其他站点、页面初始化时写入弹窗状态、通过 window.open 在后台开窗、以及在页面生命周期结束时抢注上报处理器。

弹窗拦截默认拒绝跨站开窗，只在有明确依据时放行：同站地址、指向同一地点的链接、以及登录、分享、支付这类固定基础设施（当前 34 个主机）。此外还有一份约 2,700 个域名的名单作为附加层，用于明确禁止开窗的站点。被拦截的开窗按站点记录，可在规则管理页查看，并可在弹窗面板里对单个站点放行。

元素选取器允许在页面上拾取任意元素，为它生成一条只在本站生效的隐藏规则；也可以直接在页面右键选择「使用 AdBlow 拦截该元素」，面板会带着该元素打开。手动添加的规则不参与自动清理。

cookie 同意提示默认点击接受，若横幅同时提供「拒绝全部」则优先拒绝。只点击按钮、不隐藏元素，站点会记住这次选择。

隐私

全部处理在本地完成：没有遥测、没有账号、没有远程配置，也不上报任何浏览记录。两个域名清单（恶意站点、禁止开窗）随扩展一起分发，运行时不下载任何数据。学习到的规则只保存在本机，可以在规则管理页导出或清空。

已知限制

- 仅支持 Manifest V3 允许的能力：脚本注入的广度不及桌面级程序，也不支持部分过滤语法；
- 恶意站点名单与禁止开窗名单来自公开过滤列表，随版本更新，不是实时数据；
- cookie 提示的识别依赖容器形状与按钮文案，Shadow DOM 内或结构特殊的自定义横幅可能识别不到；
- 元素选取器只支持顶层文档，iframe 内的元素无法拾取；
- 弹窗拦截按主机白名单放行，未列入的正常分享或支付按钮可能被误拦，可在弹窗面板里对单个站点放行。
```

## 详细描述（English） · 2901 字符

```
AdBlow is an ad filter written from scratch: the filtering engine, the interface and the build toolchain do not build on an existing extension framework.

What it does

The network layer compiles six public filter lists (EasyList, EasyList China, EasyPrivacy, and uBlock's filters, privacy and badware lists) into about 21,000 block rules and 2,400 exceptions for the current version, covering popup scripts, tracking scripts, pre-roll video ads and ad creative.

Element hiding is driven by domain-scoped rules only; no generic hiding is injected, to keep article text intact. Every hidden element can be restored individually.

The behaviour engine diffs the page against a pristine snapshot taken early in load and judges each element on ad-like naming, cross-site assets, geometry growth, own-domain redirect wrapping and base64 CDN wrapping. Candidates that fail judgement are left alone.

The anti-hijack guard runs in the page's main world and restricts four actions: redirecting away on a click, writing popup state during initialisation, opening a background window through window.open, and claiming reporting handlers as the page unloads.

Popup blocking refuses cross-site windows by default and allows them only with a reason: a same-site address, a link pointing at the same place, or one of the 34 sign-in, share and checkout hosts. A list of about 2,700 domains adds a second layer for sites known to open ad windows. Blocked windows are recorded per site and can be allowed per site from the toolbar popup.

The element picker hides any element with a rule scoped to the current site; the same panel is reachable from the page context menu as "Block this element with AdBlow". Rules added by hand are exempt from automatic cleanup.

Cookie consent prompts are answered with "Accept" by default, or "Reject all" when the same prompt offers it. Only buttons are clicked and nothing is hidden, so the site remembers the choice.

Privacy

All processing is local: no telemetry, no account, no remote configuration, and no browsing data is reported. The two domain lists (badware, popup-blocked) ship with the extension; nothing is downloaded at runtime. Learned rules stay on the device and can be exported or cleared from the rule manager.

Known limits

- Only what Manifest V3 allows: less script-injection breadth than a desktop-class blocker, and some filter syntax is unsupported;
- the badware and popup lists come from public filter lists and ship with releases, not live;
- cookie prompts are recognised by container shape and button wording, so a banner inside a shadow root or an unusual custom banner may be missed;
- the element picker works in the top document only; elements inside iframes cannot be picked;
- popup blocking allows by hostname, so a sign-in or payment button that is not on the allowlist may be refused; the per-site switch in the popup panel resolves that.
```

## 新版说明 v1.0.6（中文） · 251 字符

```
- 拦截「点一下弹出广告窗口」：默认拒绝跨站开窗，只在有明确依据时放行（同站地址、指向同一地点的链接、登录/分享/支付这类固定基础设施），约 2,700 个域名的名单作为附加的一层。被拦截的开窗按站点记录，可在规则管理页查看。
- 识别跳板链接：先打开一个同站页面、再由它跳转到外站时，会解码地址里的目标并按真实目标判定，记录也写成真实目标。
- 弹窗面板新增「允许本站弹窗」开关：判定被误伤时可以逐站放行。
- 元素选取器支持右键菜单入口；cookie 同意提示自动处理；过滤规则增加约 205 条。
```

## Release notes v1.0.6 (English) · 731 字符

```
- Blocks click-triggered ad windows: a cross-site window is refused by default and allowed only with a reason (same-site address, a link pointing at the same place, or sign-in/share/checkout infrastructure), with a list of about 2,700 domains as a second layer. Blocked windows are recorded per site in the rule manager.
- Recognises hop links: when a same-site page opens first and then redirects, the address inside it is decoded and judged as the real target, and the record names that target.
- Added a per-site "allow popups" switch in the popup panel for cases where the rule is wrong for a site.
- The element picker gained a context-menu entry; cookie consent prompts are handled automatically; about 205 more filter rules.
```

## 权限说明（逐项，中文） · 355 字符

```
declarativeNetRequest：当前唯一能拦网络请求的接口。AdBlow 在构建期把六份过滤列表编译成静态规则集，运行时不下载规则。

storage：保存每个站点的开关、学习到的隐藏规则、点击劫持与弹窗拦截的记录。全部在本机，不上传。

activeTab：在点击工具栏图标时读取当前标签页的地址，用于显示该站点的统计与提供拾取入口。不读取其他标签页。

contextMenus：只用于页面右键菜单中的一项「使用 AdBlow 拦截该元素」。该权限不提供浏览数据、页面内容或网络请求的访问能力。

host_permissions（所有站点）：隐藏规则与主世界守卫需要在页面加载前注入，并按站点逐个判断是否处理。没有这一项，扩展只能在少数站点工作。扩展不记录访问过的地址，也不上报任何页面内容。
```

## Permission notes (English, per permission) · 950 字符

```
declarativeNetRequest: the only interface that can block network requests. AdBlow compiles six filter lists into static rulesets at build time and downloads no rules at runtime.

storage: keeps per-site switches, learned hiding rules, and click-hijack and popup-block records. Everything stays on the device and is never uploaded.

activeTab: reads the current tab's address when the toolbar icon is clicked, to show that site's counters and to offer the element picker. Other tabs are not read.

contextMenus: used for one item only, "Block this element with AdBlow" in the page context menu. It grants no access to browsing data, page content or network requests.

host_permissions (all sites): hiding rules and the main-world guard have to be injected before the page loads, and each site has to be judged individually. Without it the extension could only work on a handful of sites. No visited address is recorded and no page content is reported.
```

## 提交前清单

- [ ] 包：`release/adblow-1.0.6-edge.zip`（不要用同名旧文件）
- [ ] 包内 `manifest.json` 的 `version` 为 1.0.6（`node tools/release/verify-package.mjs` 会解包核对）
- [ ] 1.0.4 的审核已结束（同一扩展不能有两个待审版本）
- [ ] 权限清单：`declarativeNetRequest`、`storage`、`activeTab`、`contextMenus`、所有站点；逐项说明见上
- [ ] 截图与图标：`store/` 下已有 1280×800 截图；截图里需能看出元素选取器与弹窗面板
- [ ] 描述里的数字（约 21,000 条规则、2,700 个域名、34 个主机）与实际包一致；下次发版时若变化需同步
