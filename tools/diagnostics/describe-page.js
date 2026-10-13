/**
 * AdBlow 页面诊断脚本（给用户用）。
 *
 * ## 用法
 *
 * 1. 在出问题的页面上按 F12 打开开发者工具，切到「控制台 / Console」
 * 2. 打开本文件，全选复制，粘贴到控制台，回车
 * 3. 把输出（或截图）发给我
 *
 * 它只读取页面现状并打印，**不会修改任何东西**。
 * 用来回答：哪些元素被隐藏了、是哪个机制干的、它们是不是正文/导航，
 * 以及有多少链接被别的元素盖住点不动。
 *
 * ## ⚠️ 确定性测量（v3）
 *
 * 前两版是"粘上就测"，于是两次测量的**时机/懒加载进度不同**会污染对比
 * （实测用户 ON/OFF 两次的图片数差了 49，但无法排除是懒加载进度差异）。
 * 现在脚本会先**自己滚到底、再滚回顶部并等待**，再开始测量 ——
 * 这样 ON 与 OFF 两次的结果才可比。
 */
(async () => {
  const R = 'data-adblow-reason';
  const H = 'data-adblow-hidden';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── 确定性准备：滚一遍触发懒加载，再回到顶部 ──
  try {
    const total = document.body.scrollHeight;
    for (let y = 0; y < total; y += Math.max(400, Math.floor(innerHeight * 0.8))) {
      scrollTo(0, y);
      await sleep(220);
    }
    scrollTo(0, document.body.scrollHeight);
    await sleep(1200);
    scrollTo(0, 0);
    await sleep(800);
  } catch {
    /* 忽略 */
  }

  const desc = (el) => {
    if (!el || !el.tagName) return '(null)';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  };

  // 注意：对已隐藏元素读 innerText 永远是空（元素不可见），必须用 textContent
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  /**
   * 把站点 CDN 的 base64 路径还原成**真实来源域名**。
   * 形如 `https://cache-2610.sgvafw.com/base/<base64 of https://fourhoi.com/...>.cache`
   * —— 还原后才能分清"丢的是广告图还是内容图"。
   */
  const realSource = (url) => {
    const m = /\/base\/([A-Za-z0-9+/=_-]+)/.exec(url || '');
    if (!m) return null;
    try {
      const decoded = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'));
      const h = /^https?:\/\/([^/]+)/.exec(decoded);
      return h ? h[1] : decoded.slice(0, 40);
    } catch {
      return null;
    }
  };

  const vw = innerWidth;
  const vh = innerHeight;

  // ── ① 被隐藏的元素，按原因聚合 ──
  const hidden = Array.from(document.querySelectorAll('[' + H + ']'));

  // ── ①b 关键区域状态：区分「被隐藏」与「根本没加载出来」 ──
  //
  // 为什么必须有这一节（2026-10-13）：用户报告"视频窗口/推荐栏被过滤"，
  // 但诊断显示我们只隐藏了 2 个广告元素 —— 说明问题不在 DOM 隐藏，
  // 而在**这些区块压根没渲染出来**（脚本没加载/执行=网络层拦截）。
  // 这一节就是用来分清这两种情况的。
  const areaState = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      found: true,
      sel: desc(el),
      display: s.display,
      visibility: s.visibility,
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      hiddenByUs: el.closest('[' + H + ']') !== null,
    };
  };
  const imgs = Array.from(document.querySelectorAll('img'));
  const keyAreas = {
    播放器容器: areaState('#player, [class*="player"], [id*="player"]'),
    视频标签数: document.querySelectorAll('video').length,
    播放器库Hls: typeof window.Hls,
    推荐网格_videoGrid: document.querySelectorAll('.video-grid').length,
    推荐卡_videoCard: document.querySelectorAll('.video-card').length,
    导航: areaState('nav, .navbar, [class*="navbar"]'),
    标签云数: document.querySelectorAll('.tag').length,
    图片: imgs.filter((i) => (i.naturalWidth || 0) > 0).length + '/' + imgs.length + ' 已加载',
    /**
     * ❗图片按**真实来源域名**归类 —— ON/OFF 两次对比时，
     * 一眼就能看出丢的是广告图（广告域）还是内容图（站点自己的 CDN）。
     */
    图片来源域名: (() => {
      const m = {};
      for (const i of imgs) {
        const raw = i.getAttribute('src') || '';
        const real = realSource(raw);
        let key = '（非 base64 路径）';
        if (real) key = real;
        else {
          try {
            key = new URL(raw, location.href).hostname;
          } catch {
            /* 忽略 */
          }
        }
        m[key] = (m[key] || 0) + 1;
      }
      return m;
    })(),
    我们的MAIN_world脚本: typeof window.__adblowScriptlets,
  };
  console.log('%c[关键区域状态]', 'font-weight:bold');
  for (const [k, v] of Object.entries(keyAreas)) {
    console.log('  ' + k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  const byReason = new Map();
  for (const el of hidden) {
    const reason = el.getAttribute(R) || '(未标原因：可能来自 site pack 或更早版本)';
    if (!byReason.has(reason)) byReason.set(reason, []);
    const t = textOf(el);
    byReason.get(reason).push({
      sel: desc(el),
      textChars: t.length,
      links: el.querySelectorAll('a[href]').length,
      imgs: el.querySelectorAll('img').length,
      sample: t.slice(0, 50),
    });
  }

  console.log('%c[AdBlow 诊断] 页面：' + location.href, 'font-weight:bold');
  console.log('页面文字总量 textContent：' + textOf(document.body).length + ' 字符');
  console.log('被 AdBlow 隐藏的元素：' + hidden.length + ' 个');
  for (const [reason, items] of byReason) {
    const withText = items.filter((i) => i.textChars > 30).length;
    const withLinks = items.filter((i) => i.links > 0).length;
    console.log(
      `  原因「${reason}」${items.length} 个（其中含文字>30 的 ${withText} 个、含链接的 ${withLinks} 个）`,
    );
    console.table(items.slice(0, 12));
  }

  // ── ② 正文/导航类元素里，有哪些被隐藏了 ──
  const CONTENT = 'article, main, nav, header, footer, .content, .post, .entry, .article, .nav, .menu, .sidebar, ul, ol';
  const contentHidden = [];
  for (const el of Array.from(document.querySelectorAll(CONTENT))) {
    const hid = el.closest('[' + H + ']');
    if (!hid) continue;
    const t = textOf(el);
    contentHidden.push({
      element: desc(el),
      被隐藏的祖先: desc(hid),
      原因: hid.getAttribute(R) || '(未标)',
      文字字数: t.length,
      链接数: el.querySelectorAll('a[href]').length,
      摘录: t.slice(0, 40),
    });
  }
  console.log('\n%c正文/导航类元素被隐藏的情况：' + contentHidden.length + ' 个',
    'font-weight:bold;color:' + (contentHidden.length ? 'red' : 'green'));
  if (contentHidden.length) console.table(contentHidden.slice(0, 25));

  // ── ③ 链接点不动的情况 ──
  const links = Array.from(document.querySelectorAll('a[href]')).filter((a) => {
    const r = a.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return false;
    const s = getComputedStyle(a);
    return s.display !== 'none' && s.visibility !== 'hidden';
  });
  const blockers = new Map();
  let blocked = 0;
  const samples = [];
  for (const a of links) {
    const r = a.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
    const top = document.elementFromPoint(cx, cy);
    if (!top || top === a || a.contains(top) || top.contains(a)) continue;
    blocked += 1;
    const key = desc(top);
    blockers.set(key, (blockers.get(key) || 0) + 1);
    if (samples.length < 5) {
      const s = getComputedStyle(top);
      samples.push({
        链接: desc(a) + ' → ' + String(a.href).slice(0, 45),
        挡住的元素: key,
        定位: s.position,
        zIndex: s.zIndex,
        覆盖比例: Math.round(((top.getBoundingClientRect().width * top.getBoundingClientRect().height) / (vw * vh)) * 100) + '%',
        是AdBlow隐藏的吗: top.closest('[' + H + ']') !== null,
        原因: (top.closest('[' + R + ']') || top).getAttribute(R) || '',
      });
    }
  }
  console.log('\n%c可见链接 ' + links.length + ' 个，被遮挡（点不动）的 ' + blocked + ' 个',
    'font-weight:bold;color:' + (blocked ? 'red' : 'green'));
  if (blocked) {
    console.log('按遮挡者归类：');
    console.table(Array.from(blockers).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, n]) => ({ 遮挡者: k, 次数: n })));
    console.table(samples);
  }

  // ── ④ AdBlow 自己注入的东西 ──
  const styles = Array.from(document.querySelectorAll('style[data-adblow-list-cosmetic], style[data-adblow-cosmetic]'));
  console.log('\nAdBlow 注入的样式表：' + styles.length + ' 个');
  for (const s of styles) {
    const css = s.textContent || '';
    const sels = css.split('}').map((x) => x.split('{')[0]).filter(Boolean);
    console.log(`  ${s.getAttribute('data-adblow-cosmetic') !== null ? '站点规则包样式表' : '列表 cosmetic'}：${sels.length} 条选择器`);
    if (sels.length) console.log('    前 5 条：' + JSON.stringify(sels.slice(0, 5)));
  }

  // ── ⑤ 汇总成一段精简结论并**复制到剪贴板** ──
  //
  // 为什么要有这一步：前几版只打印表格，用户很容易只复制到最后一节表格，
  // 而最关键的信息（被隐藏元素按原因/凭哪条证据）反而漏了。
  // 复制的是纯文本，直接把整段粘回来即可。
  const summary = [
    '=== AdBlow 诊断 ===',
    'URL: ' + location.href,
    '页面文字量: ' + textOf(document.body).length,
    'AdBlow 隐藏元素总数: ' + hidden.length,
    '关键区域状态（区分"被隐藏"与"根本没加载"）:',
    JSON.stringify(keyAreas, null, 1),
    '被隐藏元素（按原因 + 凭哪条证据）:',
    JSON.stringify(
      [...byReason].map(([reason, items]) => ({
        reason,
        count: items.length,
        // 每条都带上 reason/why/大小/文字量，足以定位机制
        items: items.slice(0, 15),
      })),
      null,
      1,
    ),
    '正文/导航类被隐藏: ' + contentHidden.length,
    JSON.stringify(contentHidden.slice(0, 20), null, 1),
    'AdBlow 注入的样式表:',
    JSON.stringify(
      styles.map((s) => ({
        kind: s.getAttribute('data-adblow-list-cosmetic') !== null ? '列表cosmetic' : '站点规则包',
        selectors: ((s.textContent || '').split('}').map((x) => x.split('{')[0]).filter(Boolean)).slice(0, 30),
      })),
      null,
      1,
    ),
    '可见链接 ' + links.length + '，被遮挡 ' + blocked,
    '（以上已复制到剪贴板）',
  ].join('\n');

  try {
    copy(summary);
    console.log('%c✔ 结论已复制到剪贴板 —— 直接粘贴发给我即可（不要只复制表格）', 'font-weight:bold;color:green');
  } catch {
    console.log('%c（自动复制失败：请手动全选上面的文本发我）', 'font-weight:bold;color:orange');
  }
  console.log(summary);
  return '诊断完成';
})();
