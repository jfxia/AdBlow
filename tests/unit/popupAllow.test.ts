import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { POPUP_ALLOW_HOSTS, isPopupAllowlistedHost } from '../../src/inject/popupAllow.ts';
import { isListedHost } from '../../src/engine/domainList.ts';
import { isValidRequestDomain } from '../../src/engine/filterList/validate.ts';

/**
 * The allowlist holds stable sign-in / payment infrastructure only. Matching is exact host
 * plus subdomains, on `.` boundaries: widening it to `*.google.com` or a bare suffix lets ad
 * hosts in, and this layer decides "allow a window", so a false allow is worse than a false
 * refusal.
 */
describe('正常用途主机白名单：名单本身的约束', () => {
  it('条目数量在 20~40 之间（窄名单，不是通用放行表）', () => {
    assert.ok(POPUP_ALLOW_HOSTS.length >= 20, `只有 ${POPUP_ALLOW_HOSTS.length} 条`);
    assert.ok(POPUP_ALLOW_HOSTS.length <= 40, `已有 ${POPUP_ALLOW_HOSTS.length} 条，超出预期范围`);
  });

  it('全部是小写、无通配符、无协议的合法域名', () => {
    for (const host of POPUP_ALLOW_HOSTS) {
      assert.equal(host, host.toLowerCase(), host);
      assert.ok(!host.includes('*'), host);
      assert.ok(!host.includes('/'), host);
      assert.ok(isValidRequestDomain(host), `${host} 不是合法域名`);
    }
  });

  it('没有重复条目', () => {
    assert.equal(new Set(POPUP_ALLOW_HOSTS).size, POPUP_ALLOW_HOSTS.length);
  });
});

describe('正常用途主机白名单：匹配边界', () => {
  it('精确命中', () => {
    assert.equal(isPopupAllowlistedHost('paypal.com'), true);
    assert.equal(isPopupAllowlistedHost('github.com'), true);
  });

  it('允许子域（任意层级，大小写不敏感）', () => {
    assert.equal(isPopupAllowlistedHost('www.paypal.com'), true);
    assert.equal(isPopupAllowlistedHost('PAYPAL.COM'), true);
    assert.equal(isPopupAllowlistedHost('a.b.paypal.com'), true);
    assert.equal(isPopupAllowlistedHost('accounts.google.com'), true);
  });

  it('nota.com 不命中 a.com（`a.com` 这类短条目也不能用裸后缀匹配）', () => {
    // The generic boundary rule itself; the allowlist uses the same function.
    assert.equal(isListedHost('nota.com', new Set(['a.com'])), false);
    assert.equal(isListedHost('a.com.evil', new Set(['a.com'])), false);
    // Same for real allowlist entries: one extra character is not a match.
    assert.equal(isPopupAllowlistedHost('notpaypal.com'), false);
    assert.equal(isPopupAllowlistedHost('paypal.com.evil.test'), false);
    assert.equal(isPopupAllowlistedHost('fakegithub.com'), false);
  });

  it('父域不在名单里时不命中（stripe.com 不因条目 checkout.stripe.com 而放行）', () => {
    // One direction only: an entry covers its subdomains, not its parents.
    assert.equal(isListedHost('example.com', new Set(['checkout.example.com'])), false);
    assert.equal(isListedHost('checkout.example.com', new Set(['example.com'])), true);
  });

  it('空主机 / 空名单不命中', () => {
    assert.equal(isPopupAllowlistedHost(''), false);
    assert.equal(isPopupAllowlistedHost('   '), false);
    assert.equal(isListedHost('paypal.com', new Set()), false);
  });
});
