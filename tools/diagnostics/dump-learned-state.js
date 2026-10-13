/**
 * 导出 AdBlow 的**自学习规则**（选择器 + 域名）。
 *
 * ## 为什么需要它（2026-10-13）
 *
 * 用户 ON/OFF 对比：开启过滤后页面图片从 67 张掉到 18 张（**正好等于服务端 HTML
 * 里的 18 张**），播放器 690x0、`Hls` undefined。而服务端 HTML 里**没有任何缩略图**
 * —— 说明这些图是**页面 JS 运行时创建**的，即"创建图片的脚本没跑"。
 *
 * 站点自己的关键脚本（jquery / common.js / owl.carousel / carousel-owl）和播放器库
 * （plyr / hls.js）**全部来自站点 CDN** `cdn.sgvafw.com` / `cdn-play.sgvafw.com`。
 *
 * 我在**全新 profile** 下用 `testMatchOutcome` 检查过该页 48 个同源资源
 * （按 7 种资源类型各测一遍），只命中一个无害的 `/js/tongji.js`。
 * 但用户诊断显示 `#ads-tubiao` 的隐藏原因已经是 **`learned`** —— 那是**用户 profile
 * 里积累的自学习规则**，我的检查看不到。自学习的**域名**会被提升为**全局 DNR 拦截
 * 规则**（拦 script / xhr，不拦 image），一旦误学到站点自己的 CDN，
 * 就会让这些页面上的站点脚本全部失效。
 *
 * ## 用法（在扩展页面里运行）
 *
 * 1. 打开扩展弹窗 → 「规则管理」（会打开 options 页面，是一个正常的标签页）
 * 2. 在这个标签页按 F12 → 控制台 → 粘贴本文件全部内容 → 回车
 * 3. 结果会自动复制到剪贴板，直接粘贴发我
 *
 * 扩展页面拥有 `chrome.storage` 权限，所以能直接读出原始自学习数据。
 */
(async () => {
  const out = { 说明: 'AdBlow 自学习状态导出', 时间: new Date().toISOString() };

  try {
    const all = await chrome.storage.local.get(null);
    out.存储键 = Object.keys(all);

    const brief = {};
    for (const [k, v] of Object.entries(all)) {
      const json = JSON.stringify(v);
      // 大对象只留结构摘要 + 前 3000 字符，避免输出过长
      if (json && json.length > 3000) {
        brief[k] = {
          长度: json.length,
          预览: json.slice(0, 3000),
        };
      } else {
        brief[k] = v;
      }
    }
    out.原始数据 = brief;

    // ── 专门把"域名"学习项挑出来，这是本次怀疑的重点 ──
    const domains = [];
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, path + '[' + i + ']'));
        return;
      }
      const keys = Object.keys(node);
      // 域名条目通常形如 { domain, hits, promoted, ... }
      if (keys.some((k) => /domain|host/i.test(k)) && keys.some((k) => /hit|count|promot|score/i.test(k))) {
        domains.push({ 路径: path, ...node });
      }
      for (const k of keys) walk(node[k], path + '.' + k);
    };
    walk(all, '');
    out.域名学习项 = domains;
    out.域名学习项数量 = domains.length;

    // ── 只看域名列表（最直观）──
    out['❗学到的域名清单'] = domains
      .map((d) => `${d.domain ?? d.host ?? '?'}  hits=${d.hits ?? d.count ?? '?'}  promoted=${d.promoted ?? '?'}`)
      .sort();

    // ── 当前生效的动态拦截规则（如果 API 可用）──
    try {
      const dyn = await chrome.declarativeNetRequest.getDynamicRules();
      out.动态规则数 = dyn.length;
      out.动态规则 = dyn.map((r) => ({
        id: r.id,
        action: r.action?.type,
        urlFilter: r.condition?.urlFilter,
        requestDomains: r.condition?.requestDomains,
        resourceTypes: r.condition?.resourceTypes,
        initiatorDomains: r.condition?.initiatorDomains,
      }));
    } catch (e) {
      out.动态规则读取失败 = String(e).slice(0, 120);
    }
  } catch (e) {
    out.读取失败 = String(e).slice(0, 200);
  }

  const text = JSON.stringify(out, null, 1);
  try {
    copy(text);
    console.log('%c✔ 自学习状态已复制到剪贴板 —— 直接粘贴发我', 'font-weight:bold;color:green');
  } catch {
    console.log('%c（自动复制失败，请手动全选下面的输出）', 'font-weight:bold;color:orange');
  }
  console.log(text);
  return text;
})();
