import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideOpen } from '../../src/inject/guards.ts';

/**
 * A popunder fires from a click **anywhere** and then calls `window.open` for an ad window.
 * The measured site (missav.watch, 2026-10-20) ships `__htapop` with `type:"popunder"`,
 * 1001x800 and counts clickedElement; the play button itself is the trigger.
 *
 * The old rule ("a gesture on any control passes") let exactly that through. Cross-site
 * windows are now refused by default; only an `<a>` pointing at the target, a same-site
 * target, or an allowlisted host passes. These cases pin the real-world scenario.
 */
describe('popunder 回归：播放按钮不再能开跨站窗口', () => {
  const PAGE = 'missav.watch';
  const AD = 'https://ads.example.com/landing';

  it('播放按钮（<button>，不是 <a>）+ 跨站 → 拒绝', () => {
    const decision = decideOpen({
      url: AD,
      pageHost: PAGE,
      hadUserGesture: true,
      gestureAnchorHref: null,
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
  });

  it('页面自己的播放/帮助窗口仍然放行', () => {
    assert.equal(
      decideOpen({ url: '/popup/help', pageHost: PAGE, hadUserGesture: true }).allow,
      true,
    );
    assert.equal(
      decideOpen({
        url: 'https://www.missav.watch/popup',
        pageHost: PAGE,
        hadUserGesture: true,
      }).allow,
      true,
    );
  });

  it('真实外链（用户点的就是那个站）仍然放行', () => {
    const decision = decideOpen({
      url: 'https://external.example/x',
      pageHost: PAGE,
      hadUserGesture: true,
      gestureAnchorHref: 'https://external.example/article',
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'anchor-target');
  });

  it('无手势的一律拒绝', () => {
    assert.equal(
      decideOpen({ url: AD, pageHost: PAGE, hadUserGesture: false }).allow,
      false,
    );
  });

  it('$popup 名单里的目标即使从真实外链点开也拒绝', () => {
    const decision = decideOpen({
      url: 'https://ads.example.com/landing',
      pageHost: PAGE,
      hadUserGesture: true,
      gestureAnchorHref: 'https://ads.example.com/landing',
      popupDenied: true,
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'popup-list');
  });
});
