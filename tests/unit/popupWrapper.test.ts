import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideOpen, unwrapOpenTarget, type OpenDecision } from '../../src/inject/guards.ts';
import { isPopupHost } from '../../src/engine/popupDomains.ts';
import { mergePopupBlockRecord } from '../../src/engine/popupBlock.ts';

/**
 * Measured bypass (2026-10-22, videos.example): the play button fired
 * `window.open('https://videos.example/pop?url=<encoded ad>')`. The wrapper is same-site, so the
 * same-site rule allowed the window, and the wrapper then navigated to the ad. These cases pin
 * the fix: a target carried in a query parameter is judged as the real destination, while
 * share / sign-in links that carry same-site or allowlisted addresses keep the old behaviour.
 */
const PAGE = 'videos.example';
const AD = 'https://ads.example/1919723/?3';
const WRAP = `https://${PAGE}/pop?url=${encodeURIComponent(AD)}`;
const enc = encodeURIComponent;

/** Host of the URL the decision was made about. */
function targetHost(decision: OpenDecision): string {
  assert.ok(decision.targetUrl, 'decision must name a target URL');
  return new URL(decision.targetUrl).hostname;
}

/** Mirrors inject/index.ts: the `$popup` list is checked against the raw and unwrapped URL. */
const LISTED = new Set(['ads.example']);
function decideWithPopupList(rawUrl: string, pageHost = PAGE): OpenDecision {
  const unwrapped = unwrapOpenTarget(rawUrl, pageHost);
  const listed = (candidate: string): boolean => {
    try {
      return isPopupHost(new URL(candidate, `https://${pageHost}`).hostname, LISTED);
    } catch {
      return false;
    }
  };
  return decideOpen({
    url: rawUrl,
    pageHost,
    hadUserGesture: true,
    popupDenied: listed(rawUrl) || (unwrapped !== null && listed(unwrapped)),
  });
}

describe('window.open 同站包装页：按解码后的真实目标判定', () => {
  it('用户实测案例：/pop?url=<编码的外站绝对地址> → 拒绝', () => {
    const decision = decideOpen({ url: WRAP, pageHost: PAGE, hadUserGesture: true });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
    assert.equal(targetHost(decision), 'ads.example');
  });

  it('相对写法的包装页同样按解码后的目标判定', () => {
    const decision = decideOpen({
      url: `/pop?url=${enc(AD)}`,
      pageHost: PAGE,
      hadUserGesture: true,
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
    assert.equal(targetHost(decision), 'ads.example');
  });

  it('参数名不固定：to / target / redirect / go / next / continue 都解', () => {
    for (const name of ['to', 'target', 'redirect', 'go', 'next', 'continue', 'u']) {
      const decision = decideOpen({
        url: `https://${PAGE}/pop?${name}=${enc(AD)}`,
        pageHost: PAGE,
        hadUserGesture: true,
      });
      assert.equal(decision.allow, false, name);
      assert.equal(decision.reason, 'cross-site', name);
      assert.equal(targetHost(decision), 'ads.example', name);
    }
  });

  it('双重编码（%25 开头）仍然解出真实目标', () => {
    const doubleEncoded = enc(enc(AD));
    const decision = decideOpen({
      url: `https://${PAGE}/pop?url=${doubleEncoded}`,
      pageHost: PAGE,
      hadUserGesture: true,
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
    assert.equal(targetHost(decision), 'ads.example');
  });

  it('解码出白名单主机 → 放行（allowlisted-host）', () => {
    for (const target of [
      'https://accounts.google.com/o/oauth2/auth',
      'https://checkout.stripe.com/pay/abc',
    ]) {
      // Encoded once and left raw: both spellings reach the same parameter value.
      for (const value of [enc(target), target]) {
        const decision = decideOpen({
          url: `https://${PAGE}/login?next=${value}`,
          pageHost: PAGE,
          hadUserGesture: true,
        });
        assert.equal(decision.allow, true, value);
        assert.equal(decision.reason, 'allowlisted-host', value);
        assert.equal(targetHost(decision), new URL(target).hostname, value);
      }
    }
  });

  it('解码出同站地址 → 按原判定（same-site 放行）', () => {
    const decision = decideOpen({
      url: `https://${PAGE}/share?url=${enc('https://www.videos.example/archives/1/')}`,
      pageHost: PAGE,
      hadUserGesture: true,
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'same-site');
  });

  it('参数值不是绝对地址 → 不影响原判定（包装页按同站放行）', () => {
    for (const url of [
      `https://${PAGE}/share?url=abc`,
      `https://${PAGE}/share?id=123`,
      `https://${PAGE}/share?url=${enc('/player')}`,
      `https://${PAGE}/share?url=${enc('javascript:alert(1)')}`,
      `https://${PAGE}/share?url=`,
      `https://${PAGE}/share`,
    ]) {
      const decision = decideOpen({ url, pageHost: PAGE, hadUserGesture: true });
      assert.equal(decision.allow, true, url);
      assert.equal(decision.reason, 'same-site', url);
    }
  });

  it('解出的目标命中 $popup 名单 → 拒绝（popup-list）', () => {
    const decision = decideWithPopupList(WRAP);
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'popup-list');
    assert.equal(targetHost(decision), 'ads.example');
    // A wrapper whose decoded host is not listed is still judged by the gesture rules.
    assert.equal(
      decideWithPopupList(`https://${PAGE}/pop?url=${enc('https://not-listed.example/x')}`).reason,
      'cross-site',
    );
  });

  it('多个参数时取第一个可用的跨站目标', () => {
    const first = 'https://first.example/track';
    const decision = decideOpen({
      url: `https://${PAGE}/pop?ref=${enc(first)}&url=${enc(AD)}`,
      pageHost: PAGE,
      hadUserGesture: true,
    });
    assert.equal(decision.allow, false);
    assert.equal(targetHost(decision), 'first.example');
  });

  it('记录通道写入解码后的真实主机，不是包装页', () => {
    for (const decision of [
      decideOpen({ url: WRAP, pageHost: PAGE, hadUserGesture: true }),
      decideWithPopupList(WRAP),
    ]) {
      assert.equal(decision.allow, false);
      const record = mergePopupBlockRecord(null, PAGE, targetHost(decision), 1000);
      assert.equal(record.lastTargetHost, 'ads.example');
    }
  });

  it('指向包装页的 <a> 不能为解码后的外站背书', () => {
    const decision = decideOpen({
      url: WRAP,
      pageHost: PAGE,
      hadUserGesture: true,
      gestureAnchorHref: `/pop?url=${enc(AD)}`,
    });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, 'cross-site');
  });

  it('用户点的链接本身就是解码后的外站 → 仍按链接放行', () => {
    const decision = decideOpen({
      url: WRAP,
      pageHost: PAGE,
      hadUserGesture: true,
      gestureAnchorHref: AD,
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'anchor-target');
    assert.equal(targetHost(decision), 'ads.example');
  });

  it('站点开关仍然压过解码后的判定', () => {
    const decision = decideOpen({
      url: WRAP,
      pageHost: PAGE,
      hadUserGesture: true,
      popupDenied: true,
      siteAllowsPopups: true,
    });
    assert.equal(decision.allow, true);
    assert.equal(decision.reason, 'site-permitted');
  });
});

describe('unwrapOpenTarget：只解一层，不做跳转追踪', () => {
  it('参数里没有绝对地址 → null', () => {
    assert.equal(unwrapOpenTarget('/article/1', PAGE), null);
    assert.equal(unwrapOpenTarget('/pop?url=abc', PAGE), null);
    assert.equal(unwrapOpenTarget('/pop?id=123', PAGE), null);
    assert.equal(unwrapOpenTarget('/pop?url=', PAGE), null);
    assert.equal(unwrapOpenTarget('/pop?url=javascript:alert(1)', PAGE), null);
  });

  it('同站参数不值得解包（保持原判定路径）', () => {
    assert.equal(unwrapOpenTarget(`/share?url=${enc('https://videos.example/x')}`, PAGE), null);
    assert.equal(unwrapOpenTarget(`/share?url=${enc('https://a.b.videos.example/x')}`, PAGE), null);
  });

  it('跨站绝对地址 → 返回解码后的绝对 URL', () => {
    assert.equal(unwrapOpenTarget(`/pop?url=${enc(AD)}`, PAGE), AD);
    assert.equal(unwrapOpenTarget(`/pop?to=${enc(enc(AD))}`, PAGE), AD);
  });

  it('只解参数这一层：包装页再跳转不在这里追', () => {
    // The parameter carries a same-site page that would redirect later: not a wrapper target
    // we can see before the window opens, and deliberately not chased.
    const nested = `https://${PAGE}/hop?to=${enc(AD)}`;
    assert.equal(unwrapOpenTarget(`/pop?url=${enc(nested)}`, PAGE), null);
    // ...but a cross-site URL nested inside that parameter *is* the destination it names.
    assert.equal(
      unwrapOpenTarget(`/pop?url=${enc(`https://other.example/hop?to=${enc(AD)}`)}`, PAGE),
      'https://other.example/hop?to=https%3A%2F%2Fads.example%2F1919723%2F%3F3',
    );
  });

  it('不可解析的输入与空主机不抛异常', () => {
    assert.doesNotThrow(() => unwrapOpenTarget('http://[', PAGE));
    assert.equal(unwrapOpenTarget('http://[', PAGE), null);
    assert.equal(unwrapOpenTarget('/pop?url=https://', PAGE), null);
  });
});
