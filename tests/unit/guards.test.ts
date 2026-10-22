import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideOpen,
  looksLikeTrackingListener,
  shouldAllowOpen,
  type OpenRequest,
} from '../../src/inject/guards.ts';

const HOST = 'videos.example';
const AD = 'https://ads.example.com/landing';

function req(overrides: Partial<OpenRequest> = {}): OpenRequest {
  return { url: AD, pageHost: HOST, hadUserGesture: true, ...overrides };
}

/**
 * The policy flipped from "a gesture on any control may open anything" to "cross-site is
 * refused unless something concrete says the user meant it". The reported popunder fires from a
 * real play button, so a control is no longer evidence -- only an `<a>` pointing at the target
 * (or an allowlisted sign-in host) is.
 */
describe('window.open：默认拒绝跨站，只有明确依据才放行', () => {
  it('点击播放按钮（不是 <a>）打开跨站 → 拒绝', () => {
    const decision = decideOpen(req({ gestureAnchorHref: null }));
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
  });

  it('没有用户手势 → 拒绝，即使目标同站', () => {
    assert.equal(decideOpen(req({ url: '/player', hadUserGesture: false })).reason, 'no-gesture');
    assert.equal(
      decideOpen(req({ url: 'https://www.videos.example/x', hadUserGesture: false })).allow,
      false,
    );
  });

  it('同注册域名（eTLD+1）→ 放行，任意子域层级', () => {
    for (const url of [
      '/archives/1/',
      'https://videos.example/x',
      'https://www.videos.example/x',
      'https://a.b.videos.example/x',
      '//www.videos.example/x',
    ]) {
      const decision = decideOpen(req({ url }));
      assert.equal(decision.allow, true, url);
      assert.equal(decision.reason, 'same-site', url);
    }
  });

  it('点击落在 <a> 上，且链接与目标同源 → 放行', () => {
    const decision = decideOpen(
      req({
        url: 'https://player.example.com/watch?v=1',
        gestureAnchorHref: 'https://player.example.com/watch?v=1',
      }),
    );
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'anchor-target');
  });

  it('点击落在 <a> 上，链接与目标同注册域名 → 放行', () => {
    const decision = decideOpen(
      req({
        url: 'https://popup.example.com/x',
        gestureAnchorHref: 'https://www.example.com/article',
      }),
    );
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'anchor-target');
  });

  it('链接指向别的站，目标又是第三个站 → 拒绝（链接不是万能通行证）', () => {
    const decision = decideOpen(
      req({
        url: 'https://ads.example.com/x',
        gestureAnchorHref: 'https://news.example.net/article',
      }),
    );
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
  });

  it('javascript: 链接不算同源依据', () => {
    const decision = decideOpen(
      req({ url: AD, gestureAnchorHref: 'javascript:void(0)' }),
    );
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
  });

  it('目标主机在正常用途白名单 → 放行（登录 / 支付窗口）', () => {
    for (const url of [
      'https://accounts.google.com/o/oauth2/auth',
      'https://login.microsoftonline.com/common/oauth2',
      'https://appleid.apple.com/auth/authorize',
      'https://checkout.stripe.com/pay/abc',
      'https://api.weixin.qq.com/sns/oauth2',
      'https://graph.qq.com/oauth2.0',
    ]) {
      const decision = decideOpen(req({ url }));
      assert.equal(decision.allow, true, url);
      assert.equal(decision.reason, 'allowlisted-host', url);
    }
  });

  it('白名单按主机边界匹配，不是裸后缀', () => {
    assert.equal(decideOpen(req({ url: 'https://notpaypal.com/x' })).allow, false);
    assert.equal(decideOpen(req({ url: 'https://paypal.com.evil.test/x' })).allow, false);
    assert.equal(decideOpen(req({ url: 'https://www.paypal.com/checkout' })).allow, true);
  });

  it('$popup 名单命中 → 无条件拒绝（高于同站 / 链接 / 白名单）', () => {
    for (const request of [
      req({ popupDenied: true }),
      req({ url: 'https://www.videos.example/x', popupDenied: true }),
      req({ url: 'https://www.paypal.com/checkout', popupDenied: true }),
      req({ url: 'https://player.example.com/x', gestureAnchorHref: 'https://player.example.com/x', popupDenied: true }),
    ]) {
      const decision = decideOpen(request);
      assert.equal(decision.allow, false);
      assert.equal(decision.reason, 'popup-list');
    }
  });

  it('站点开关「允许本站弹窗」→ 放行跨站，并压过 $popup 名单', () => {
    const decision = decideOpen(
      req({ url: 'https://ads.example.com/x', popupDenied: true, siteAllowsPopups: true }),
    );
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'site-permitted');
  });

  it('站点开关不放过无手势与 javascript: 目标', () => {
    assert.equal(
      decideOpen(req({ hadUserGesture: false, siteAllowsPopups: true })).reason,
      'no-gesture',
    );
    assert.equal(
      decideOpen(req({ url: 'javascript:alert(1)', siteAllowsPopups: true })).reason,
      'invalid-target',
    );
  });

  it('空目标 / about:blank / javascript: → 拒绝（无论手势与开关）', () => {
    for (const url of ['', 'about:blank', 'javascript:void(0)']) {
      assert.equal(decideOpen(req({ url })).reason, 'invalid-target', url);
      assert.equal(
        decideOpen(req({ url, siteAllowsPopups: true })).allow,
        false,
        `${url} (site permitted)`,
      );
    }
  });

  it('无法解析的绝对地址拒绝且不抛异常', () => {
    assert.doesNotThrow(() => decideOpen(req({ url: 'http://[' })));
    assert.equal(decideOpen(req({ url: 'http://[' })).reason, 'invalid-target');
    // A malformed string like this parses as a relative reference (same origin), which is a
    // same-site hop and therefore allowed once a gesture exists.
    assert.equal(decideOpen(req({ url: 'ht!tp://%%' })).allow, true);
  });

  it('协议相对地址按真实主机判定', () => {
    assert.equal(decideOpen(req({ url: '//evil.example.com/x' })).allow, false);
    assert.equal(decideOpen(req({ url: '//afford.gjvrohros.cc/x', pageHost: 'afford.gjvrohros.cc' })).allow, true);
  });

  it('视觉相似但不同注册域名的目标拒绝', () => {
    assert.equal(
      decideOpen(req({ url: 'https://gjvrohros.cc.evil.com/x', pageHost: 'gjvrohros.cc' })).allow,
      false,
    );
  });

  it('shouldAllowOpen 是同一判定的布尔视图', () => {
    const request = req({ url: 'https://accounts.google.com/o/oauth2/auth' });
    assert.equal(shouldAllowOpen(request), decideOpen(request).allow);
    assert.equal(shouldAllowOpen(req()), false);
  });
});

describe('looksLikeTrackingListener', () => {
  it('识别试点站的上报特征', () => {
    const beacon = () => {
      navigator.sendBeacon('https://ads.zyudkkup.com/api/eventTracking/report.json', '{}');
    };
    assert.equal(looksLikeTrackingListener(beacon), true);
  });

  it('识别 beacon / report 等关键词', () => {
    assert.equal(looksLikeTrackingListener(() => { void fetch('/report.json'); }), true);
    assert.equal(looksLikeTrackingListener(() => { void fetch('/api/ab-test/upload'); }), true);
  });

  it('支持 handleEvent 形式的监听器对象', () => {
    const obj = { handleEvent: () => { navigator.sendBeacon('/beacon', 'x'); } };
    assert.equal(looksLikeTrackingListener(obj), true);
  });

  it('不误杀普通清理逻辑（保守策略）', () => {
    const cleanup = () => {
      localStorage.removeItem('draft');
    };
    assert.equal(looksLikeTrackingListener(cleanup), false);
  });

  it('非函数输入不抛异常', () => {
    assert.equal(looksLikeTrackingListener(null), false);
    assert.equal(looksLikeTrackingListener(undefined), false);
    assert.equal(looksLikeTrackingListener(42), false);
    assert.equal(looksLikeTrackingListener({}), false);
  });
});
