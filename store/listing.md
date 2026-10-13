# AdBlow 发布文案

> 用途：Edge 加载项商店的"详细说明"字段（各语言版本分别填写）。
> 数字与功能点都能在仓库里对应到实现，改动功能时请同步改这里。

## 中文（简体）—— 主版本

AdBlow 是 Edge / Chrome 上的自研广告过滤器。网络层内置 EasyList 等主流列表，另有一套
运行时行为引擎，按"元素是否像广告"判断：脚本注入的浮层、跨站素材、几何突增、点击劫持
都在射程内；自家域名跳转或 CDN 的 base64 包装藏起来的广告，也能解包识破。自学习会记住
反复出现的顽固广告，累计三次命中才生效，可在"规则管理"里逐条撤销；学习结果只作用于
教会它的站点，且永不拦截图片、视频、样式与脚本——宁可漏广告，也不弄坏页面。

与 AdBlock Plus 等不同：没有"可接受广告"付费白名单，不靠收钱放行；判据看行为，不只
比对列表；每个站点都有一键关闭开关。全程本地运行，不收集、不上传数据。

## English

AdBlow is an independently developed ad blocker for Edge and Chrome. Its network layer comes
with mainstream lists such as EasyList, and on top of that sits a runtime behaviour engine
that asks whether an element *looks like* an ad: script-injected overlays, cross-site media,
sudden jumps in geometry and click hijacking are all within its reach. Ads hidden behind a
site's own redirect endpoint or wrapped in a CDN's base64 encoding are unwrapped and caught
too. Self-learning remembers the stubborn ads that keep coming back, takes effect only after
three hits, and lets you revoke any of them one by one in the rule manager; what it learns
applies only to the site that taught it, and it never blocks images, video, stylesheets or
scripts — better to miss an ad than to break a page.

Unlike AdBlock Plus and similar tools: there is no paid "Acceptable Ads" whitelist, so
nothing is let through for money; it judges by behaviour rather than only matching lists;
and every site has a one-click off switch. Everything runs locally — no data is collected or
uploaded.
