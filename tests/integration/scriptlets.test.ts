import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  constantValue,
  makeDelayMatcher,
  makeMatcher,
  runScriptlets,
} from '../../src/inject/scriptlets.ts';

/**
 * 脚本注入实现（第三期）—— MAIN world 行为。
 *
 * 这些脚本直接改写页面运行时，一旦出错就是"站点功能坏掉"而不是"广告漏拦"，
 * 所以每条都要有行为断言，并且**任何异常都不得外泄**。
 *
 * 测试在 jsdom window 上跑（runScriptlets 接收 win 参数，因此可测）。
 */

function freshWindow(): Record<string, unknown> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    pretendToBeVisual: true,
  });
  return dom.window as unknown as Record<string, unknown>;
}

describe('makeMatcher', () => {
  it('空 needle 匹配一切', () => {
    assert.equal(makeMatcher('')('anything'), true);
  });

  it('普通字符串按子串、大小写不敏感', () => {
    const m = makeMatcher('AdsByGoogle');
    assert.equal(m('https://x.com/adsbygoogle.js'), true);
    assert.equal(m('https://x.com/other.js'), false);
  });

  it('斜杠包裹按正则', () => {
    const m = makeMatcher('/ads?\\d+/');
    assert.equal(m('https://x.com/ad12/'), true);
    assert.equal(m('https://x.com/other/'), false);
  });

  it('非法正则退回子串匹配', () => {
    const m = makeMatcher('/([/');
    assert.equal(m('contains ([/ here'), true);
  });
});

describe('makeDelayMatcher：延迟参数（uBO 的 RangeParser 语义）', () => {
  it('不传 = 任意延迟', () => {
    assert.equal(makeDelayMatcher(undefined)(1234), true);
    assert.equal(makeDelayMatcher('')(1234), true);
  });

  it('精确值', () => {
    assert.equal(makeDelayMatcher('1000')(1000), true);
    assert.equal(makeDelayMatcher('1000')(999), false);
  });

  it('区间 min-max / min- / -max', () => {
    const range = makeDelayMatcher('500-1000');
    assert.equal(range(500), true);
    assert.equal(range(1000), true);
    assert.equal(range(1001), false);

    assert.equal(makeDelayMatcher('500-')(99999), true);
    assert.equal(makeDelayMatcher('-1000')(1), true);
    assert.equal(makeDelayMatcher('-1000')(1001), false);
  });

  it('❗! 取反', () => {
    assert.equal(makeDelayMatcher('!1000')(1000), false);
    assert.equal(makeDelayMatcher('!1000')(2000), true);
  });
});

describe('constantValue：set-constant 的取值写法', () => {
  it('识别 uBO 的特殊值', () => {
    assert.equal(constantValue('true'), true);
    assert.equal(constantValue('false'), false);
    assert.equal(constantValue('null'), null);
    assert.equal(constantValue('undefined'), undefined);
    assert.deepEqual(constantValue('emptyObj'), {});
    assert.deepEqual(constantValue('emptyArr'), []);
    assert.equal(typeof constantValue('noopFunc'), 'function');
  });

  it('数字与普通字符串', () => {
    assert.equal(constantValue('1'), 1);
    assert.equal(constantValue('-2.5'), -2.5);
    assert.equal(constantValue('hello'), 'hello');
  });
});

describe('runScriptlets：行为断言', () => {
  it('set-constant：值被固定，页面改写无效', () => {
    const win = freshWindow();
    win.adsEnabled = false;
    runScriptlets([{ canonical: 'set-constant', args: ['adsEnabled', 'false'] }], win);

    assert.equal(win.adsEnabled, false);
    win.adsEnabled = true; // 页面试图改写
    assert.equal(win.adsEnabled, false, '写入应被忽略');
  });

  it('set-constant：支持嵌套路径', () => {
    const win = freshWindow();
    win.myAds = { config: { enabled: true } };
    runScriptlets([{ canonical: 'set-constant', args: ['myAds.config.enabled', 'false'] }], win);
    assert.equal((win.myAds as { config: { enabled: unknown } }).config.enabled, false);
  });

  it('❗set-constant：路径可穿过构造函数（`X.prototype.Y` 是最常见写法之一）', () => {
    const win = freshWindow();
    // 造一个带原型属性的构造函数，模拟 Navigator.prototype.globalPrivacyControl
    class FakeNavigator {}
    Object.defineProperty(FakeNavigator.prototype, 'globalPrivacyControl', {
      configurable: true,
      get: () => undefined,
    });
    win.FakeNavigator = FakeNavigator;

    const result = runScriptlets(
      [{ canonical: 'set-constant', args: ['FakeNavigator.prototype.globalPrivacyControl', 'false'] }],
      win,
    );

    assert.deepEqual(result.applied, ['set-constant'], '穿过构造函数不应失败');
    const probe = new FakeNavigator() as { globalPrivacyControl?: unknown };
    assert.equal(probe.globalPrivacyControl, false, '原型上的值应被固定');
  });

  it('❗set-constant 的安全闸门：拒绝用原始值覆盖真实对象', () => {
    const win = freshWindow();
    win.siteConfig = { adsEnabled: true }; // 站点的配置对象
    const result = runScriptlets(
      [{ canonical: 'set-constant', args: ['siteConfig', 'false'] }],
      win,
    );
    assert.deepEqual(result.applied, [], '应拒绝接管');
    assert.deepEqual(win.siteConfig, { adsEnabled: true }, '对象必须原样保留');
  });

  it('原始值之间的替换仍然照做（1 → false 是过滤器本意，不该被闸门拦）', () => {
    const win = freshWindow();
    win.adsEnabled = 1;
    runScriptlets([{ canonical: 'set-constant', args: ['adsEnabled', 'false'] }], win);
    assert.equal(win.adsEnabled, false);
  });

  it('❗abort-on-property-read：读属性抛错', () => {
    const win = freshWindow();
    win.adsLoader = {};
    runScriptlets([{ canonical: 'abort-on-property-read', args: ['adsLoader'] }], win);
    assert.throws(() => (win as { adsLoader: unknown }).adsLoader);
  });

  it('❗abort-on-property-write：写属性抛错，且读得到 undefined（uBO 先 delete 再只定义 setter）', () => {
    const win = freshWindow();
    win.adConfig = 1;
    runScriptlets([{ canonical: 'abort-on-property-write', args: ['adConfig'] }], win);
    assert.equal(win.adConfig, undefined, '读应得到 undefined');
    assert.throws(() => {
      (win as { adConfig: number }).adConfig = 2;
    });
  });

  it('❗no-setTimeout-if：匹配的回调被替换成空函数（原回调不执行）', async () => {
    const win = freshWindow();
    let ranAd = false;
    let ranLegit = false;
    runScriptlets([{ canonical: 'no-setTimeout-if', args: ['adsbygoogle'] }], win);

    const setTimeoutFn = win.setTimeout as (cb: () => void, ms: number) => unknown;
    // ⚠️ 不能用 `new Function` 造"源码含匹配词"的函数 —— 它在全局作用域，
    // 赋值不到测试的局部变量（早期版本因此断言在错误前提下通过）。
    // 用注释让**闭包函数**的源码包含匹配词即可。
    const adHandler = (): void => {
      /* adsbygoogle */
      ranAd = true;
    };
    setTimeoutFn(adHandler, 0);
    setTimeoutFn(() => {
      ranLegit = true;
    }, 0);

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ranAd, false, '匹配的回调不应执行');
    assert.equal(ranLegit, true, '不匹配的回调应照常执行');
  });

  it('❗no-setTimeout-if：延迟也参与匹配', async () => {
    const win = freshWindow();
    let ran = false;
    // 规则只拦延迟 5000 的调用
    runScriptlets([{ canonical: 'no-setTimeout-if', args: ['adProbe', '5000'] }], win);
    const setTimeoutFn = win.setTimeout as (cb: () => void, ms: number) => unknown;
    const handler = (): void => {
      /* adProbe */
      ran = true;
    };

    setTimeoutFn(handler, 10); // 延迟不匹配 → 应执行
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran, true, '延迟不匹配时不应拦');

    ran = false;
    setTimeoutFn(handler, 5000); // 延迟匹配 → 应拦
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran, false, '延迟匹配时应拦');
  });

  it('❗prevent-addEventListener（aeld）：类型与处理函数都匹配才丢弃监听器', () => {
    const win = freshWindow();
    const doc = win.document as Document;
    runScriptlets([{ canonical: 'prevent-addEventListener', args: ['click', 'adClickHandler'] }], win);

    let adClicks = 0;
    let normalClicks = 0;
    // 处理函数源码里含匹配词
    const adHandler = function adClickHandler(): void {
      adClicks += 1;
    };
    const normalHandler = function somethingElse(): void {
      normalClicks += 1;
    };
    const el = doc.createElement('div');
    doc.body.appendChild(el);
    el.addEventListener('click', adHandler);
    el.addEventListener('click', normalHandler);
    el.dispatchEvent(new (win.Event as typeof Event)('click'));

    assert.equal(adClicks, 0, '匹配的监听器应被丢弃');
    assert.equal(normalClicks, 1, '不匹配的监听器应照常工作');
  });

  it('❗no-window-open-if：匹配的 URL 返回 null', () => {
    const win = freshWindow();
    let called = 0;
    win.open = () => {
      called += 1;
      return {} as unknown;
    };
    runScriptlets([{ canonical: 'no-window-open-if', args: ['adserver'] }], win);

    const openFn = win.open as (u: string) => unknown;
    assert.equal(openFn('https://adserver.example.com/x'), null, '匹配的应被拦');
    assert.equal(called, 0, '原函数不应被调用');
    openFn('https://good.example.com/x');
    assert.equal(called, 1, '不匹配的应放行');
  });

  it('❗no-fetch-if：匹配的请求被短路，不匹配的放行', async () => {
    const win = freshWindow();
    const seen: string[] = [];
    win.fetch = (input: unknown) => {
      seen.push(String(input));
      return Promise.resolve({ ok: true });
    };
    runScriptlets([{ canonical: 'no-fetch-if', args: ['tracker'] }], win);

    const fetchFn = win.fetch as (u: string) => Promise<unknown>;
    const blocked = (await fetchFn('https://tracker.example.com/p')) as { status: number };
    assert.equal(blocked.status, 204, '应返回空响应而不是发起请求');
    assert.deepEqual(seen, [], '匹配的请求不应到达原函数');

    await fetchFn('https://api.example.com/p');
    assert.deepEqual(seen, ['https://api.example.com/p']);
  });

  it('❗json-prune：删掉指定路径', () => {
    const win = freshWindow();
    runScriptlets([{ canonical: 'json-prune', args: ['ads.banner'] }], win);
    const parsed = (win.JSON as { parse: (s: string) => unknown }).parse(
      '{"ads":{"banner":"x","keep":1},"other":2}',
    ) as { ads: Record<string, unknown>; other: number };
    assert.equal('banner' in parsed.ads, false, '目标键应被删除');
    assert.equal(parsed.ads.keep, 1, '其它键保留');
    assert.equal(parsed.other, 2);
  });

  it('set-local-storage-item：设置与删除', () => {
    const win = freshWindow();
    runScriptlets([{ canonical: 'set-local-storage-item', args: ['k', 'v'] }], win);
    assert.equal((win.localStorage as Storage).getItem('k'), 'v');
    runScriptlets([{ canonical: 'set-local-storage-item', args: ['k', '$remove$'] }], win);
    assert.equal((win.localStorage as Storage).getItem('k'), null);
  });

  it('❗set-local-storage-item + $remove$：key 是模式，删掉所有匹配的键', () => {
    const win = freshWindow();
    const storage = win.localStorage as Storage;
    storage.setItem('sc_tracking_anonymous_id', 'a');
    storage.setItem('statsig.session', 'b');
    storage.setItem('keep_me', 'c');

    runScriptlets(
      [{ canonical: 'set-local-storage-item', args: ['/sc_tracking_anonymous_id|statsig/', '$remove$'] }],
      win,
    );

    assert.equal(storage.getItem('sc_tracking_anonymous_id'), null, '匹配的键应被删除');
    assert.equal(storage.getItem('statsig.session'), null, '匹配的键应被删除');
    assert.equal(storage.getItem('keep_me'), 'c', '不匹配的键必须保留');
  });

  it('❗remove-cookie：第一个参数是匹配式而不是字面名', () => {
    const win = freshWindow();
    const doc = win.document as Document;
    doc.cookie = 'sc_anonymous_id=abc';
    doc.cookie = 'keep=1';

    const result = runScriptlets(
      [{ canonical: 'remove-cookie', args: ['/sc_anonymous_id|sc_tracking_anonymous_id/'] }],
      win,
    );

    assert.deepEqual(result.applied, ['remove-cookie']);
    const after = String(doc.cookie);
    assert.ok(!after.includes('sc_anonymous_id'), `匹配的 cookie 应被清除，实际：${after}`);
    assert.ok(after.includes('keep=1'), `不匹配的 cookie 必须保留，实际：${after}`);
  });

  it('❗no-window-open-if：匹配的是调用参数拼接串，不只是 URL', () => {
    const win = freshWindow();
    let called = 0;
    win.open = () => {
      called += 1;
      return {};
    };
    runScriptlets([{ canonical: 'no-window-open-if', args: ['popunder-slot'] }], win);
    const openFn = win.open as (...a: unknown[]) => unknown;

    // URL 干净，但 features 里带匹配词 → 也要拦
    assert.equal(openFn('about:blank', '_blank', 'popunder-slot=1'), null);
    assert.equal(called, 0);
    openFn('https://good.example.com/');
    assert.equal(called, 1);
  });

  it('❗任何异常都不得外泄（未知脚本名 / 畸形参数）', () => {
    const win = freshWindow();
    const result = runScriptlets(
      [
        { canonical: 'totally-unknown', args: [] },
        { canonical: 'set-constant', args: [] },
        { canonical: 'abort-on-property-read', args: [''] },
        { canonical: 'json-prune', args: [] },
      ],
      win,
    );
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.failed, []);
  });

  it('部分失败时其余仍然生效', () => {
    const win = freshWindow();
    win.keep = 1;
    const result = runScriptlets(
      [
        { canonical: 'totally-unknown', args: [] },
        { canonical: 'set-constant', args: ['keep', 'false'] },
      ],
      win,
    );
    assert.deepEqual(result.applied, ['set-constant']);
    assert.equal(win.keep, false);
  });

  it('同一批调用重复执行不抛异常（幂等性容错）', () => {
    const win = freshWindow();
    win.x = 1;
    const inv = [{ canonical: 'set-constant', args: ['x', 'false'] }];
    runScriptlets(inv, win);
    assert.doesNotThrow(() => runScriptlets(inv, win));
  });
});
