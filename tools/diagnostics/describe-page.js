// AdBlow page diagnostic, meant to be run by a user.
// Usage: press F12 on the affected page, switch to Console, paste this whole file,
// press Enter, then send the output (or a screenshot) back.
// It only reads and prints the current page state and changes nothing. It answers:
// which elements were hidden, by which mechanism, whether they are content or
// navigation, and how many links are covered by something else.
// v3 determinism: earlier versions measured immediately, so differing timing and
// lazy-load progress polluted the comparison (a user's ON/OFF image counts differed
// by 49, with no way to rule out lazy loading). The script now scrolls to the
// bottom, returns to the top and waits, so ON and OFF runs are comparable.
(async () => {
  const R = 'data-adblow-reason';
  const H = 'data-adblow-hidden';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // deterministic preparation: scroll through to trigger lazy loading, then back up
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
    /* ignore */
  }

  const desc = (el) => {
    if (!el || !el.tagName) return '(null)';
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  };

  // Note: innerText of a hidden element is always empty (it is not visible), so
  // textContent is required here
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  // Recover the real source domain from the site CDN's base64 path, e.g.
  // `https://cache-2610.sgvafw.com/base/<base64 of https://fourhoi.com/...>.cache`.
  // Only after unwrapping can a lost ad image be told from a lost content image.
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

  // hidden elements, grouped by reason
  const hidden = Array.from(document.querySelectorAll('[' + H + ']'));

  // Key-area state: separates "hidden by us" from "never rendered at all".
  // Why (2026-10-13): a user reported the video player and recommendation rail being
  // filtered, while the diagnostic showed only 2 hidden ad elements -- so those
  // blocks were not rendered at all (scripts not loaded/run = network blocking).
  // This section exists to tell those two cases apart.
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
    // Images grouped by real source domain, so an ON/OFF comparison shows at a
    // glance whether the missing ones are ad images (ad domains) or content images
    // (the site's own CDN).
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
            /* ignore */
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

  // Which content/navigation elements were hidden. The classifier must not confuse
  // real content with ad blocks (tightened 2026-10-13): the old version treated any
  // ul/ol as content, so the ad carousel `ul.streamer-box2` (0 text, 10 outbound
  // links) was reported as "content hidden" every time -- pure noise. A candidate
  // now needs real text (>=30 chars) or heading/paragraph structure, and must not be
  // hidden for a reason that is inherently ad-like
  // (linkfarm/overlay/click-layer/fake-close).
  const CONTENT = 'article, main, nav, header, footer, .content, .post, .entry, .article, .nav, .menu, .sidebar, ul, ol';
  const AD_ONLY_REASONS = new Set(['linkfarm', 'overlay', 'click-layer', 'fake-close']);
  const contentHidden = [];
  for (const el of Array.from(document.querySelectorAll(CONTENT))) {
    const hid = el.closest('[' + H + ']');
    if (!hid) continue;
    const reason = hid.getAttribute(R) || '(未标)';
    if (AD_ONLY_REASONS.has(reason)) continue;
    const t = textOf(el);
    const hasProse = el.querySelector('h1,h2,h3,h4,p,article') !== null;
    if (t.length < 30 && !hasProse) continue;
    contentHidden.push({
      element: desc(el),
      被隐藏的祖先: desc(hid),
      原因: reason,
      文字字数: t.length,
      链接数: el.querySelectorAll('a[href]').length,
      摘录: t.slice(0, 40),
    });
  }
  console.log('\n%c正文/导航类元素被隐藏的情况：' + contentHidden.length + ' 个',
    'font-weight:bold;color:' + (contentHidden.length ? 'red' : 'green'));
  if (contentHidden.length) console.table(contentHidden.slice(0, 25));

  // links hidden behind something else, i.e. not clickable
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

  // what AdBlow itself injected
  const styles = Array.from(document.querySelectorAll('style[data-adblow-list-cosmetic], style[data-adblow-cosmetic]'));
  console.log('\nAdBlow 注入的样式表：' + styles.length + ' 个');
  for (const s of styles) {
    const css = s.textContent || '';
    const sels = css.split('}').map((x) => x.split('{')[0]).filter(Boolean);
    console.log(`  ${s.getAttribute('data-adblow-cosmetic') !== null ? '站点规则包样式表' : '列表 cosmetic'}：${sels.length} 条选择器`);
    if (sels.length) console.log('    前 5 条：' + JSON.stringify(sels.slice(0, 5)));
  }

  // One compact summary, copied to the clipboard. Why: earlier versions only
  // printed tables, and users tended to copy just the last one, losing the most
  // important part (hidden elements by reason and by evidence).
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
        // each item carries reason/why/size/text length, enough to locate the mechanism
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
