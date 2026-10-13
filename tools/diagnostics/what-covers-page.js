// "What is covering the page?" -- a one-shot probe. Paste it into the console while
// the problem is happening (do not reload); the result goes to the clipboard.
// Why it exists: with filtering on, a user's page shrank 4836px -> 1551px with 97%
// of pixels nearly black, while forensics found only one harmless /js/tongji.js
// blocked and 2 DOM elements hidden. The site itself ships a perfect match:
// mountPreroll() -> #site-preroll-gate, position:fixed; inset:0;
// z-index:2147482500; background:rgba(0,0,0,.94), locking playback through a
// capture-phase 'play' handler. So one question settles it: which element is
// topmost at the centre of the screen.
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

  // topmost element at the centre of the screen (the direct answer)
  const cx = Math.floor(innerWidth / 2);
  const cy = Math.floor(innerHeight / 2);
  const stack = document.elementsFromPoint(cx, cy).slice(0, 6).map(describe);

  // every visible fixed/absolute layer covering >=90% of the viewport
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

  // real state of the player and video
  const media = {
    videos: document.querySelectorAll('video').length,
    audio: document.querySelectorAll('audio').length,
    paused: [...document.querySelectorAll('video')].map((v) => v.paused),
    hls: typeof window.Hls,
    playerBox: describe(document.querySelector('#player, [class*="player"], [id*="player"]')),
  };

  // is the site's own ad gate present
  const gate = document.getElementById('site-preroll-gate');
  const preroll = {
    gateExists: !!gate,
    gateDescription: gate ? describe(gate) : null,
    prerollEnabledFlag: window.__SITE_PREROLL_ENABLED__,
    adDataFlag: typeof window.__SITE_AD_DATA__,
    prerollCompleteFired: !!window.__sitePrerollComplete,
  };

  // overall page shape
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
