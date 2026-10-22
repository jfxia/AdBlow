# 商店提交字段（v1.0.5）

复制粘贴用。每个字段后面标了字符数，方便对照表单长度限制。
名称与简述取自扩展自身的 `_locales`，与包内声明一致，不要单独改。

## 名称

```
AdBlow
```

6 字符。

## 简述（中文，54 字符）

```
自研广告过滤器：行为检测 + 自学习规则，配合 EasyList 系列表拦截弹窗、浮层、视频广告与点击劫持。
```

## 简述（English，119 字符）

```
Blocks pop-ups, overlays, video ads and click hijacking via behavior detection, self-learning rules and EasyList lists.
```

## 新版说明 v1.0.5（中文，358 字符）

```
- 新增元素选取器：在页面上拾取任意元素，为它生成一条只在本站生效的隐藏规则。也可以直接在页面右键选择「使用 AdBlow 拦截该元素」，面板会带着该元素打开，确认即可保存。手动添加的规则不参与自动清理。
- 新增 cookie 同意提示自动处理：默认点击「接受」；横幅若提供「拒绝全部」则优先拒绝。恶意域名清单内的站点、或用户已关闭过滤的站点不改动其横幅。
- 反劫持加固：拒绝通过 document.onclick、行内 onclick 属性或注册在 body/html 上的跳转处理器；跨站 window.open 只在点击控件时放行。
- 过滤规则增加约 205 条，新增对 $to 与 $denyallow 两个选项的支持。
- 新增 contextMenus 权限，用于右键菜单入口，不涉及浏览数据读取。
```

## Release notes v1.0.5 (English, 882 characters)

```
- Added the element picker: pick any element on a page to create a hiding rule for that site only. Right-clicking and choosing "Block this element with AdBlow" opens the panel with that element already selected. Manual rules are exempt from automatic cleanup.
- Added automatic handling of cookie consent prompts: "Accept" is clicked by default, "Reject all" is preferred when offered. Banners on badware-listed sites, or where filtering is switched off, are left alone.
- Hardened click-hijack blocking: navigation handlers installed through document.onclick, inline onclick attributes or on body/html are refused; a cross-site window.open is allowed only when the click landed on a control.
- About 205 more filter rules, with new support for the $to and $denyallow options.
- Added the contextMenus permission for the right-click entry; it does not grant access to browsing data.
```

## 权限说明（审核备注，97 字符）

```
新增 contextMenus 权限，仅用于页面右键菜单中的「使用 AdBlow 拦截该元素」。该权限不提供任何浏览数据、标签页内容或网络请求的访问能力；扩展仍然全部在本地处理，不上报任何信息。
```

## Permission note (reviewer note, 430 characters)

```
The `contextMenus` permission is used for a single item: "Block this element with AdBlow" in the page context menu, which opens the element picker with the right-clicked element already selected. The permission grants no access to browsing data, page content, tab URLs or network requests. No other permission was added in this version, host permissions included; all processing stays local and nothing is reported off the device.
```

## 提交前清单

- [ ] 包：`release/adblow-1.0.5-edge.zip`（不要用同名的旧文件）
- [ ] 包内 `manifest.json` 的 `version` 为 1.0.5
- [ ] 1.0.4 的审核已结束（同一扩展不能有两个待审版本）
- [ ] 截图与列表图标未变；若界面有变化，补一张规则管理页含「手动添加」标记的截图
- [ ] 权限清单里多出 `contextMenus`，审核备注使用上面那一段
