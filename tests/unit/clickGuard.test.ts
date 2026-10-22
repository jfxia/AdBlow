import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAVIGATION_EVENT_TYPES,
  isCrossSiteHref,
  looksLikeNavigationHijack,
  shouldBlockClick,
} from '../../src/inject/clickGuard.ts';

const HOST = 'www.videos.example';

const base = {
  trusted: true,
  pageHost: HOST,
  linkHref: null as string | null,
  linkIsInvisible: false,
  insideHiddenAd: false,
  overInvisibleLayer: false,
};

describe('isCrossSiteHref', () => {
  it('跨站链接', () => {
    assert.equal(isCrossSiteHref('https://ads.example.com/x', HOST), true);
  });

  it('同站与相对链接', () => {
    assert.equal(isCrossSiteHref('https://www.videos.example/dm339', HOST), false);
    assert.equal(isCrossSiteHref('/dm339', HOST), false);
    assert.equal(isCrossSiteHref('https://videos.example/x', HOST), false, '同可注册域名');
  });

  it('空值与非法值不抛异常', () => {
    assert.equal(isCrossSiteHref('', HOST), false);
    assert.equal(isCrossSiteHref('javascript:void(0)', HOST), false);
    assert.doesNotThrow(() => isCrossSiteHref('http://[', HOST));
  });
});

describe('点击拦截：① 脚本合成的跨站点击', () => {
  it('不可信的点击 + 跨站链接 + 链接不可见 → 拦截', () => {
    const v = shouldBlockClick({
      ...base,
      trusted: false,
      linkHref: 'https://ads.example.com/landing',
      linkIsInvisible: true,
    });
    assert.equal(v.block, true);
    assert.equal(v.reason, 'synthetic-hidden-cross-site-click');
  });

  it('不可信但链接可见 → 放行（不误伤正常的程序化下载流程）', () => {
    const v = shouldBlockClick({
      ...base,
      trusted: false,
      linkHref: 'https://cdn.example.com/file.zip',
      linkIsInvisible: false,
    });
    assert.equal(v.block, false);
  });

  it('不可信的点击指向同站链接 → 放行', () => {
    const v = shouldBlockClick({
      ...base,
      trusted: false,
      linkHref: '/dm340',
      linkIsInvisible: true,
    });
    assert.equal(v.block, false);
  });
});

describe('点击拦截：② 真实点击落在已隐藏的广告上', () => {
  it('拦截', () => {
    const v = shouldBlockClick({ ...base, insideHiddenAd: true });
    assert.equal(v.block, true);
    assert.equal(v.reason, 'click-inside-hidden-ad');
  });
});

describe('点击拦截：③ 真实点击落在隐形全屏层上（点击劫持主通路）', () => {
  it('拦截 —— 这就是「随便点哪里都跳走」', () => {
    const v = shouldBlockClick({
      ...base,
      overInvisibleLayer: true,
      linkHref: 'https://ads.example.com/landing',
    });
    assert.equal(v.block, true);
    assert.equal(v.reason, 'invisible-click-layer');
  });

  it('即使看不出跨站链接也拦截（隐形层本身就是证据）', () => {
    const v = shouldBlockClick({ ...base, overInvisibleLayer: true, linkHref: null });
    assert.equal(v.block, true);
  });
});

describe('正常点击必须放行（误伤守卫）', () => {
  it('点站内链接', () => {
    assert.equal(shouldBlockClick({ ...base, linkHref: '/dm339' }).block, false);
  });

  it('点正常的外站链接（用户自己点的）', () => {
    assert.equal(
      shouldBlockClick({ ...base, linkHref: 'https://twitter.com/share' }).block,
      false,
      '用户主动点可见外链必须放行',
    );
  });

  it('点普通内容元素', () => {
    assert.equal(shouldBlockClick({ ...base }).block, false);
  });

  it('没有任何异常信号时一律放行', () => {
    for (const trusted of [true, false]) {
      const v = shouldBlockClick({ ...base, trusted });
      assert.equal(v.block, false);
    }
  });
});

/**
 * Detecting a document-level "click navigates away" handler — the /capture variant seen in
 * the wild: the click target is ordinary content, so the event layer cannot block it, and
 * assigning `location.href` cannot be intercepted either. The listener has to be refused at
 * registration time.
 */
describe('looksLikeNavigationHijack：识别文档级跳转处理函数', () => {
  // `new Function` reproduces the real source shapes verbatim: TypeScript rejects
  // `self.location = <string>`, and a type assertion would be erased, hiding the real form.
  const fromSource = (body: string) => new Function(body) as () => void;

  it('识别直接赋值 location.href', () => {
    assert.equal(looksLikeNavigationHijack(fromSource(`location.href = 'https://ads.example.com/x'`)), true);
    assert.equal(looksLikeNavigationHijack(fromSource(`location.href='https://ads.example.com/x'`)), true);
  });

  it('识别 location.assign / replace', () => {
    assert.equal(looksLikeNavigationHijack(fromSource(`location.assign('https://ads.example.com/x')`)), true);
    assert.equal(looksLikeNavigationHijack(fromSource(`location.replace('https://ads.example.com/x')`)), true);
  });

  it('识别 window.location / self.location / document.location', () => {
    assert.equal(
      looksLikeNavigationHijack(fromSource(`window.location.href = 'https://ads.example.com/x'`)),
      true,
    );
    assert.equal(looksLikeNavigationHijack(fromSource(`self.location = 'https://ads.example.com/x'`)), true);
    assert.equal(
      looksLikeNavigationHijack(fromSource(`document.location.href = 'https://ads.example.com/x'`)),
      true,
    );
  });

  it('识别 window.open', () => {
    assert.equal(looksLikeNavigationHijack(fromSource(`window.open('https://ads.example.com/x')`)), true);
    assert.equal(looksLikeNavigationHijack(fromSource(`self.open('https://ads.example.com/x')`)), true);
  });

  it('识别括号取值形式', () => {
    assert.equal(
      looksLikeNavigationHijack(fromSource(`location['href'] = 'https://ads.example.com/x'`)),
      true,
    );
    assert.equal(
      looksLikeNavigationHijack(fromSource(`location["assign"]('https://ads.example.com/x')`)),
      true,
    );
  });

  it('识别整体赋值 location = …', () => {
    assert.equal(looksLikeNavigationHijack(fromSource(`location = 'https://ads.example.com/x'`)), true);
  });

  it('识别 handleEvent 对象形式', () => {
    const listener = {
      handleEvent: fromSource(`location.href = 'https://ads.example.com/x'`),
    };
    assert.equal(looksLikeNavigationHijack(listener), true);
  });

  it('❗不误伤 SPA 路由（读 href、用 history.pushState）', () => {
    assert.equal(
      looksLikeNavigationHijack(fromSource(`
        var a = e.target.closest('a');
        if (!a) return;
        e.preventDefault();
        history.pushState({}, '', a.getAttribute('href') || '');
      `)),
      false,
      '只读 href、用 History API 的路由是正常行为',
    );
  });

  it('❗不误伤只读取 location 的代码', () => {
    assert.equal(
      looksLikeNavigationHijack(fromSource(`
        if (location.pathname === '/x') return;
        var u = location.href;
        console.log(u, window.location.search);
      `)),
      false,
      '读取 location 不是导航操作',
    );
  });

  it('❗不误伤同名变量声明（const location = …）', () => {
    assert.equal(
      looksLikeNavigationHijack(fromSource(`const location = computePlace(); console.log(location)`)),
      false,
    );
  });

  it('❗不误伤比较运算', () => {
    assert.equal(looksLikeNavigationHijack(fromSource(`if (location.href == target) return`)), false);
  });

  it('不误伤与导航无关的监听器', () => {
    assert.equal(looksLikeNavigationHijack(() => {}), false);
    assert.equal(
      looksLikeNavigationHijack(fromSource(`document.body.classList.toggle('menu-open')`)),
      false,
    );
  });

  it('取不到源码时安全返回 false', () => {
    assert.equal(looksLikeNavigationHijack(null), false);
    assert.equal(looksLikeNavigationHijack(undefined), false);
    assert.equal(looksLikeNavigationHijack({}), false);
    assert.equal(looksLikeNavigationHijack('not a listener'), false);
  });

  it('覆盖会触发导航的事件类型', () => {
    for (const t of ['click', 'mousedown', 'pointerdown', 'touchstart', 'auxclick']) {
      assert.ok(NAVIGATION_EVENT_TYPES.has(t), t);
    }
    assert.ok(!NAVIGATION_EVENT_TYPES.has('scroll'), '滚动不该被当成导航触发');
    assert.ok(!NAVIGATION_EVENT_TYPES.has('pagehide'));
  });
});
