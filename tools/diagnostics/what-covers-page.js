/**
 * 「到底是什么盖住了页面？」—— 一锤定音的小探针。
 *
 * ## 为什么需要它（2026-10-13）
 *
 * 用户的 ON/OFF 截图对比：过滤后页面 4836px → 1551px、97% 像素近黑、只剩零星几块。
 * 但取证结果是：网络层只拦了一个无害的 /js/tongji.js（48 个资源按 7 种类型全测），
 * DOM 只隐藏 2 个广告元素，脚本注入不适用于本站。
 *
 * 站点自带一个形态完全吻合的东西：
 *   mountPreroll() → #site-preroll-gate
 *   position:fixed; inset:0; z-index:2147482500; background:rgba(0,0,0,.94)
 *   document.addEventListener('play', blockPlay, true) + pausePlayback()  → 锁死播放
 *   按钮 5 秒后可点、10 秒后自动 release()
 *
 * 所以只要问浏览器一句话就能定案：**屏幕正中央最上层的是哪个元素**。
 *
 * ## 用法（关键：在问题正在发生时运行，不要刷新）
 *
 * F12 → 控制台 → 粘贴本文件全部内容 → 回车 → 结果会自动复制到剪贴板
 */
(() => {
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < innerHeight &&
      r.left < innerWidth
    );
  };

  const describe = (el) => {
    if (!el || !el.tagName) return null;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''),
      pos: s.position,
      z: s.zIndex,
      size: Math.round(r.width) + 'x' + Math.round(r.height),
      bg: s.backgroundColor,
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      hiddenByAdBlow: el.closest('[data-adblow-hidden]') !== null,
    };
  };

  // ① 屏幕中央最上层是谁（"谁盖住了页面"的直接答案）
  const cx = Math.floor(innerWidth / 2);
  const cy = Math.floor(innerHeight / 2);
  const stack = document.elementsFromPoint(cx, cy).slice(0, 6).map(describe);

  // ② 所有"覆盖视口 ≥90%"的固定/绝对定位可见层 —— 全屏遮罩的完整清单
  const overlays = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;
    if (!inViewport(el)) continue;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'absolute') continue;
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.5) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.7) {
      overlays.push(describe(el));
    }
  }

  // ③ 播放器与视频的真实状态
  const media = {
    videos: document.querySelectorAll('video').length,
    audio: document.querySelectorAll('audio').length,
    paused: [...document.querySelectorAll('video')].map((v) => v.paused),
    hls: typeof window.Hls,
    playerBox: describe(document.querySelector('#player, [class*="player"], [id*="player"]')),
  };

  // ④ 站点自己的广告闸门是否在
  const gate = document.getElementById('site-preroll-gate');
  const preroll = {
    gateExists: !!gate,
    gateDescription: gate ? describe(gate) : null,
    prerollEnabledFlag: window.__SITE_PREROLL_ENABLED__,
    adDataFlag: typeof window.__SITE_AD_DATA__,
    prerollCompleteFired: !!window.__sitePrerollComplete,
  };

  // ⑤ 页面整体形态
  const shape = {
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    textLength: (document.body.innerText || '').trim().length,
    scrollHeight: document.body.scrollHeight,
    imgs: document.querySelectorAll('img').length,
    hiddenByAdBlow: document.querySelectorAll('[data-adblow-hidden]').length,
  };

  const summary = JSON.stringify({ stack, overlays, media, preroll, shape }, null, 1);
  try {
    copy(summary);
    console.log('%c✔ 已复制到剪贴板 —— 直接粘贴发我（这就是"谁盖住了页面"的答案）', 'font-weight:bold;color:green');
  } catch {
    console.log('%c（自动复制失败，请手动全选下面的输出）', 'font-weight:bold;color:orange');
  }
  console.log(summary);
  return summary;
})();
