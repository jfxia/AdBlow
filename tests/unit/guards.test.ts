import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTrackingListener, shouldAllowOpen } from '../../src/inject/guards.ts';

const HOST = 'afford.gjvrohros.cc';

describe('shouldAllowOpen', () => {
  it('拦截跨站无手势弹窗', () => {
    assert.equal(shouldAllowOpen('https://spam.example.com/x', HOST, false), false);
  });

  it('放行同站跳转', () => {
    assert.equal(shouldAllowOpen('/archives/1/', HOST, true), true);
    assert.equal(shouldAllowOpen('/archives/1/', HOST, false), true);
  });

  it('放行用户手势触发的跨站链接', () => {
    assert.equal(shouldAllowOpen('https://twitter.com/x', HOST, true), true);
  });

  it('拦截空目标与 about:blank 的无手势弹窗', () => {
    assert.equal(shouldAllowOpen('about:blank', HOST, false), false);
    assert.equal(shouldAllowOpen('', HOST, false), false);
    assert.equal(shouldAllowOpen('javascript:void(0)', HOST, false), false);
  });

  it('同可注册域名的子域视为同站', () => {
    assert.equal(shouldAllowOpen('https://www.gjvrohros.cc/x', HOST, false), true);
  });

  it('视觉相似但不同可注册域名的目标一律拦截', () => {
    assert.equal(shouldAllowOpen('https://gjvrohros.cc.evil.com/x', HOST, false), false);
  });

  it('非法输入不抛异常：同源放行，无法解析则拦截', () => {
    assert.doesNotThrow(() => shouldAllowOpen('ht!tp://%%', HOST, false));
    // 这类畸形串会被当作相对引用解析成同源地址，放行是正确语义
    // （只是同源跳转，没有跨站风险）
    assert.equal(shouldAllowOpen('ht!tp://%%', HOST, false), true);
    // 真正无法解析的输入必须拦截，且不能抛
    assert.doesNotThrow(() => shouldAllowOpen('http://[', HOST, false));
    assert.equal(shouldAllowOpen('http://[', HOST, false), false);
  });

  it('协议相对地址按真实主机判定', () => {
    assert.equal(shouldAllowOpen('//evil.example.com/x', HOST, false), false);
    assert.equal(shouldAllowOpen('//afford.gjvrohros.cc/x', HOST, false), true);
  });

  it('放行时不受手势状态影响（手势只放宽不收紧）', () => {
    for (const gesture of [true, false]) {
      assert.equal(shouldAllowOpen('https://afford.gjvrohros.cc/a', HOST, gesture), true);
    }
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
