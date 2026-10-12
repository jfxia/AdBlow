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
 */
(() => {
  const R = 'data-adblow-reason';
  const H = 'data-adblow-hidden';

  const desc = (el) => {
    if (!el || !el.tagName) return '(null)';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  };

  // 注意：对已隐藏元素读 innerText 永远是空（元素不可见），必须用 textContent
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  const vw = innerWidth;
  const vh = innerHeight;

  // ── ① 被隐藏的元素，按原因聚合 ──
  const hidden = Array.from(document.querySelectorAll('[' + H + ']'));
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

  console.log('\n%c把以上输出（含展开的表格）截图或复制发给我即可。', 'font-weight:bold');
  return '诊断完成';
})();
