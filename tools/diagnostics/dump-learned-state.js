// Exports AdBlow's self-learned rules (selectors + domains). Paste it into the
// console of an extension page (the options tab), which has chrome.storage
// access; the result is copied to the clipboard.
// Why it exists: with filtering on, a user's page dropped from 67 images to 18 --
// exactly the 18 in the server HTML -- so the missing ones are created at runtime
// by page JS, and the hidden reason for #ads-tubiao was already `learned`, i.e.
// rules accumulated in that profile. Learned domains are promoted to global DNR
// rules (script/xhr, not image), so learning a site's own CDN breaks its scripts.
(async () => {
  const out = { 说明: 'AdBlow 自学习状态导出', 时间: new Date().toISOString() };

  try {
    const all = await chrome.storage.local.get(null);
    out.存储键 = Object.keys(all);

    const brief = {};
    for (const [k, v] of Object.entries(all)) {
      const json = JSON.stringify(v);
      // large values keep a summary + the first 3000 chars, to limit output length
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

    // pick out the "domain" learning entries -- the prime suspect here
    const domains = [];
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, path + '[' + i + ']'));
        return;
      }
      const keys = Object.keys(node);
      // domain entries usually look like { domain, hits, promoted, ... }
      if (keys.some((k) => /domain|host/i.test(k)) && keys.some((k) => /hit|count|promot|score/i.test(k))) {
        domains.push({ 路径: path, ...node });
      }
      for (const k of keys) walk(node[k], path + '.' + k);
    };
    walk(all, '');
    out.域名学习项 = domains;
    out.域名学习项数量 = domains.length;

    // domain list only, the most direct view
    out['❗学到的域名清单'] = domains
      .map((d) => `${d.domain ?? d.host ?? '?'}  hits=${d.hits ?? d.count ?? '?'}  promoted=${d.promoted ?? '?'}`)
      .sort();

    // currently active dynamic block rules, if the API is available
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
