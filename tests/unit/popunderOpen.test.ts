import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAllowOpen } from '../../src/inject/guards.ts';

/**
 * popunder 的触发条件是"用户在**任意位置**点了一下"，然后 `window.open` 一个广告窗口。
 * 原来的策略是"带手势就一律放行"，于是这类弹窗全都漏了过去（2026-10-20，
 * missav.watch 页面里带 `__htapop` 的 popunder SDK，1001×800，统计 clickedElement）。
 *
 * 现在的判断多一个维度：手势落在哪里。
 */
describe('shouldAllowOpen：手势落在控件上才放行跨站开窗', () => {
  const AD = 'https://ads.example.com/landing';

  it('点在正文/空白处 + 跨站 → 拦截（popunder 路径）', () => {
    assert.equal(shouldAllowOpen(AD, 'missav.watch', true, false), false);
  });

  it('点在链接/按钮上 + 跨站 → 放行（分享、外链打开）', () => {
    assert.equal(shouldAllowOpen(AD, 'missav.watch', true, true), true);
  });

  it('点在正文/空白处 + 同站 → 放行（站点自己的弹窗）', () => {
    assert.equal(shouldAllowOpen('/popup/help', 'missav.watch', true, false), true);
    assert.equal(shouldAllowOpen('https://www.missav.watch/popup', 'missav.watch', true, false), true);
  });

  it('没有任何手势时行为不变：只允许同站', () => {
    assert.equal(shouldAllowOpen(AD, 'missav.watch', false, true), false);
    assert.equal(shouldAllowOpen(AD, 'missav.watch', false, false), false);
    assert.equal(shouldAllowOpen('/x', 'missav.watch', false, false), true);
  });

  it('缺省参数保持旧行为（不传手势落点按控件处理）', () => {
    assert.equal(shouldAllowOpen(AD, 'missav.watch', true), true);
  });

  it('空目标与 javascript: 一律拒绝', () => {
    assert.equal(shouldAllowOpen('', 'missav.watch', true, true), false);
    assert.equal(shouldAllowOpen('about:blank', 'missav.watch', true, true), false);
    assert.equal(shouldAllowOpen('javascript:void(0)', 'missav.watch', true, true), false);
  });
});
