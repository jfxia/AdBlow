import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  constantValue,
  makeDelayMatcher,
  makeMatcher,
  runScriptlets,
} from '../../src/inject/scriptlets.ts';

// Third-phase scriptlet injection (MAIN world behaviour). These rewrite the page at
// runtime, so a mistake breaks the site rather than merely missing an ad: every case
// needs a behavioural assertion and no exception may escape. jsdom windows make it testable.

function freshWindow(): Record<string, unknown> {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/',
    pretendToBeVisual: true,
  });
  return dom.window as unknown as Record<string, unknown>;
}

/**
 * Apply one `json-prune` rule and return the patched parser.
 *
 * A throwaway `{ JSON: { parse } }` holder rather than a jsdom window: in Node,
 * `dom.window.JSON === JSON` (measured), so patching a jsdom window would leave every later
 * `JSON.parse` in this process wrapped by the pruner. This still goes through the same
 * `runScriptlets` code path.
 */
function jsonPruner(paths: string): (text: string, reviver?: unknown) => unknown {
  const holder = {
    parse: (text: string, reviver?: unknown): unknown =>
      (JSON.parse as unknown as (t: string, r?: unknown) => unknown)(text, reviver),
  };
  runScriptlets(
    [{ canonical: 'json-prune', args: [paths] }],
    { JSON: holder } as unknown as Record<string, unknown>,
  );
  return holder.parse;
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
    win.adsEnabled = true; // page tries to overwrite
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
    // Constructor with a prototype property, mimicking Navigator.prototype.globalPrivacyControl.
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
    win.siteConfig = { adsEnabled: true }; // the site's config object
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
    // Don't build the "source contains the match word" function with `new Function`: it
    // lives in global scope and can't assign the test's locals. A closure works instead.
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
    // The rule only blocks calls with delay 5000.
    runScriptlets([{ canonical: 'no-setTimeout-if', args: ['adProbe', '5000'] }], win);
    const setTimeoutFn = win.setTimeout as (cb: () => void, ms: number) => unknown;
    const handler = (): void => {
      /* adProbe */
      ran = true;
    };

    setTimeoutFn(handler, 10); // delay doesn't match → runs
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran, true, '延迟不匹配时不应拦');

    ran = false;
    setTimeoutFn(handler, 5000); // delay matches → blocked
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(ran, false, '延迟匹配时应拦');
  });

  it('❗prevent-addEventListener（aeld）：类型与处理函数都匹配才丢弃监听器', () => {
    const win = freshWindow();
    const doc = win.document as Document;
    runScriptlets([{ canonical: 'prevent-addEventListener', args: ['click', 'adClickHandler'] }], win);

    let adClicks = 0;
    let normalClicks = 0;
    // The handler's source contains the match word.
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
    // Isolated target, not a jsdom window: `dom.window.JSON === JSON` in Node (measured),
    // so patching a jsdom window leaks into every later JSON.parse in this process.
    const parsed = jsonPruner('ads.banner')(
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

    // Clean URL, but the features string carries the match word → must block too.
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

/**
 * json-prune 的路径段语义。
 *
 * 为什么不起一个 jsdom 窗口来测：Node 里 `dom.window.JSON === JSON`（实测），给 jsdom 窗口
 * 打补丁会改到**整个进程**的原生 JSON.parse，后续用例全都穿过这层包装。这里用一个独立的
 * `{ JSON: { parse } }` 作为注入目标，走的是 runScriptlets 的同一条代码路径，互不污染。
 *
 * 语义对齐 uBO：`[]` 遍历数组元素（不删元素本身），`*` 遍历自有属性（末段则删光），每一步都
 * 要求自有属性。Reddit 的规则 `data.*.elements.edges.[].node.outboundLink` 此前因为 `[]` 被
 * 当成字面键 `"[]"` 而完全空转 —— 这组用例守住的就是"它到底删了什么、没删什么"。
 */
describe('json-prune：路径段语义（[] / * / 自有属性）', () => {
  /** shreddit GraphQL 回复的形状：3 个 edge，只有 #0、#2 的 node 带 outboundLink。 */
  const REDDIT_REPLY = JSON.stringify({
    data: {
      posts: {
        elements: {
          edges: [
            {
              cursor: 't3_aaa',
              node: {
                __typename: 'Post',
                id: 't3_aaa',
                title: 'First post',
                permalink: '/r/test/comments/aaa/first/',
                outboundLink: 'https://example.com/landing?utm=1',
                score: 42,
                media: { __typename: 'ImageMedia', url: 'https://i.redd.it/a.jpg' },
                children: [],
              },
            },
            {
              cursor: 't3_bbb',
              node: {
                __typename: 'Post',
                id: 't3_bbb',
                title: 'Second post',
                permalink: '/r/test/comments/bbb/second/',
                score: 7,
                media: null,
                children: [],
              },
            },
            {
              cursor: 't3_ccc',
              node: {
                __typename: 'Post',
                id: 't3_ccc',
                title: 'Third post',
                outboundLink: 'https://example.org/other',
                media: { __typename: 'VideoMedia' },
                children: [{ id: 'c1' }, { id: 'c2' }],
              },
            },
          ],
          pageInfo: { hasNextPage: true, endCursor: 't3_ccc' },
        },
      },
    },
  });

  it('❗Reddit 规则：只删 edges[].node.outboundLink，其它字段与数组长度都不变', () => {
    const parse = jsonPruner('data.*.elements.edges.[].node.outboundLink');
    const out = parse(REDDIT_REPLY) as Record<string, any>;

    const expected = JSON.parse(REDDIT_REPLY) as Record<string, any>;
    for (const edge of expected['data'].posts.elements.edges) delete edge.node.outboundLink;

    assert.deepEqual(out, expected, '除 outboundLink 外必须逐字段相同');
    assert.equal(Array.isArray(out['data'].posts.elements.edges), true, 'edges 必须还是数组');
    assert.equal(out['data'].posts.elements.edges.length, 3, '数组长度不变');
    assert.equal(out['data'].posts.elements.edges[1].node.id, 't3_bbb', '没有 outboundLink 的那条原样保留');
    assert.deepEqual(
      out['data'].posts.elements.edges.map((e: any) => e.cursor),
      ['t3_aaa', 't3_bbb', 't3_ccc'],
      '元素顺序不变、元素没被删',
    );
    assert.equal(out['data'].posts.elements.pageInfo.hasNextPage, true, '无关字段不动');
  });

  it('❗`[]` 只遍历数组元素，不把元素本身删掉', () => {
    const out = jsonPruner('a.[].b')('{"a":[{"b":1,"c":2},{"b":3,"d":4}]}') as Record<string, any>;
    assert.deepEqual(out, { a: [{ c: 2 }, { d: 4 }] });
    assert.equal(out['a'].length, 2, '数组长度不变');
  });

  it('`[]` 用在非数组上不匹配任何东西', () => {
    assert.deepEqual(jsonPruner('a.[].b')('{"a":{"b":1}}'), { a: { b: 1 } });
    assert.deepEqual(jsonPruner('a.[].b')('{"a":"x"}'), { a: 'x' });
    assert.deepEqual(jsonPruner('a.[].b')('{"a":null}'), { a: null });
    // uBO 在非数组上把 `[]` 退化成普通键名，因此只有真存在字面 "[]" 键时才会命中
    assert.deepEqual(jsonPruner('a.[].b')('{"a":{"[]":{"b":1,"c":2}}}'), { a: { '[]': { c: 2 } } });
  });

  it('`*`：中间段遍历每个自有属性，末段删光所有键（uBO 的 `json-prune, *`）', () => {
    assert.deepEqual(jsonPruner('x.*.ad')('{"x":{"p":{"ad":1,"k":2},"q":{"ad":3}}}'), {
      x: { p: { k: 2 }, q: {} },
    });
    assert.deepEqual(jsonPruner('*')('{"a":1,"b":2}'), {});
  });

  it('数值段就是普通键，只影响该下标的元素', () => {
    const out = jsonPruner('a.0.b')('{"a":[{"b":1},{"b":2}]}') as Record<string, any>;
    assert.deepEqual(out, { a: [{}, { b: 2 }] });
    assert.equal(out['a'].length, 2);
  });

  it('❗路径不存在 / 数组为空 / 元素不是对象 / 标量根：不抛异常也不误删', () => {
    assert.doesNotThrow(() => jsonPruner('a.b.c.d')('{"x":1}'));
    assert.deepEqual(jsonPruner('a.b.c.d')('{"x":1}'), { x: 1 });
    assert.deepEqual(jsonPruner('a.[].b')('{"a":[]}'), { a: [] });
    assert.deepEqual(jsonPruner('a.[].b')('{"a":[1,"x",null]}'), { a: [1, 'x', null] });
    assert.deepEqual(jsonPruner('a.[].b')('{"a":"nope"}'), { a: 'nope' });
    assert.equal(jsonPruner('a.b')('null'), null);
    assert.equal(jsonPruner('a.b')('42'), 42);
    assert.equal(jsonPruner('a.b')('"hi"'), 'hi');
  });

  it('JSON 本身就是数组时，`[]` 从根上遍历元素', () => {
    const out = jsonPruner('[].outboundLink')(
      '[{"outboundLink":1,"k":2},{"outboundLink":3}]',
    ) as Record<string, unknown>[];
    assert.deepEqual(out, [{ k: 2 }, {}]);
    assert.equal(out.length, 2);
  });

  it('❗输入不是 JSON：仍抛原生 SyntaxError，不被吞掉', () => {
    const parse = jsonPruner('a.b');
    assert.throws(() => parse('<html>'), (err: unknown) => err instanceof SyntaxError);
  });

  it('❗不碰继承属性：路径里的 __proto__ / constructor 改不到页面原型上', () => {
    const proto = Object.prototype as unknown as Record<string, unknown>;
    proto.adblowProbe = 1;
    try {
      // With an own-property guard both paths stop at the payload (`__proto__` is not an own
      // key of a JSON.parse result unless the response really contains it). Without the
      // guard the first one walks into Object.prototype and deletes the key realm-wide.
      assert.deepEqual(jsonPruner('__proto__.adblowProbe')('{"a":1}'), { a: 1 });
      assert.equal(proto['adblowProbe'], 1, '__proto__ 路径不能删到 Object.prototype 上');
      assert.deepEqual(jsonPruner('constructor.prototype.adblowProbe')('{"a":1}'), { a: 1 });
      assert.equal(proto['adblowProbe'], 1, 'constructor.prototype 路径同样不能');
    } finally {
      delete proto['adblowProbe'];
    }
  });

  it('reviver 仍然生效，prune 作用在 reviver 的结果上', () => {
    const out = jsonPruner('a.b')('{"a":{"b":1,"c":2}}', (k: string, v: unknown) =>
      k === 'c' ? 9 : v,
    );
    assert.deepEqual(out, { a: { c: 9 } });
  });

  it('❗返回值就是原生 parse 产出的那个对象：身份、原型、数组性都不变', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://www.reddit.com/',
    });
    const win = dom.window as unknown as Record<string, unknown>;
    const json = win.JSON as { parse: (text: string, reviver?: unknown) => unknown };
    const native = json.parse;
    try {
      const produced: unknown[] = [];
      json.parse = (text: string, reviver?: unknown) => {
        const value = native(text, reviver);
        produced.push(value);
        return value;
      };
      runScriptlets([{ canonical: 'json-prune', args: ['data.posts.elements.edges.[].node.outboundLink'] }], win);
      const out = json.parse(REDDIT_REPLY);
      assert.equal(out, produced[0], '必须是同一个对象（不是重新序列化出来的副本）');
      assert.equal(Object.getPrototypeOf(out), (win.Object as any).prototype, '原型必须是本 realm 的 Object.prototype');
      assert.equal(out instanceof (win.Object as any), true);
      const edges = (out as Record<string, any>)['data'].posts.elements.edges;
      assert.equal(Array.isArray(edges), true, '数组仍然是真数组');
    } finally {
      json.parse = native;
    }
  });

  it('补丁后的 JSON.parse 仍像原生函数（name / length / toString）', () => {
    const patched = jsonPruner('a.b');
    assert.equal(patched.name, 'parse');
    assert.equal(patched.length, 2);
    assert.match(Function.prototype.toString.call(patched), /\[native code\]/);
    assert.deepEqual(patched('{"a":1}'), { a: 1 });
  });
});

describe('abort-current-script：只中止命中搜索串的那个脚本', () => {
  /**
   * 这一组测试守的是本轮实现的核心安全属性：陷阱只在"当前脚本的源码命中 needle"时抛错。
   * 若哪天有人把 needle 变成可选，测试 1（不匹配的脚本必须拿到原值）会立刻失败。
   */

  /** 让 jsdom 认为"当前正在执行的是这个 script 元素"。 */
  function pretendRunning(win: Record<string, unknown>, script: Element): void {
    Object.defineProperty(win.document, 'currentScript', {
      get: () => script,
      configurable: true,
    });
  }

  function inlineScript(win: Record<string, unknown>, text: string): Element {
    const el = (win.document as Document).createElement('script');
    el.textContent = text;
    return el;
  }

  function externalScript(win: Record<string, unknown>, src: string): Element {
    const el = (win.document as Document).createElement('script');
    el.setAttribute('src', src);
    return el;
  }

  it('❗不匹配的脚本读到原值，绝不被中止', () => {
    const win = freshWindow();
    const original = { tag: 'page-owned' };
    win.adsProbe = original;
    pretendRunning(win, inlineScript(win, 'var harmless = 1;'));
    const result = runScriptlets(
      [{ canonical: 'abort-current-script', args: ['adsProbe', 'admiral'] }],
      win,
    );
    assert.deepEqual(result.applied, ['abort-current-script']);
    assert.equal(win.adsProbe, original, '无辜脚本必须拿到原值');
  });

  it('❗命中搜索串的脚本读属性时抛错（即中止该脚本）', () => {
    const win = freshWindow();
    win.adsProbe = 1;
    pretendRunning(win, inlineScript(win, 'window.adsProbe; /* admiral-detect */'));
    runScriptlets([{ canonical: 'abort-current-script', args: ['adsProbe', 'admiral'] }], win);
    assert.throws(() => (win as { adsProbe: unknown }).adsProbe);
  });

  it('外部脚本按 URL 判定', () => {
    const win = freshWindow();
    win.adsProbe = 1;
    pretendRunning(win, externalScript(win, 'https://cdn.example.com/admiral-detect.js'));
    runScriptlets([{ canonical: 'abort-current-script', args: ['adsProbe', 'admiral'] }], win);
    assert.throws(() => (win as { adsProbe: unknown }).adsProbe);
  });

  it('缺 needle 时根本不安装，读取照常返回原值', () => {
    const win = freshWindow();
    win.adsProbe = 7;
    const result = runScriptlets([{ canonical: 'abort-current-script', args: ['adsProbe'] }], win);
    assert.deepEqual(result.applied, []);
    assert.equal(win.adsProbe, 7);
  });

  it('赋值仍然生效（陷阱不劫持写入）', () => {
    const win = freshWindow();
    win.adsProbe = 1;
    pretendRunning(win, inlineScript(win, 'var harmless = 1;'));
    runScriptlets([{ canonical: 'abort-current-script', args: ['adsProbe', 'admiral'] }], win);
    (win as { adsProbe: number }).adsProbe = 5;
    assert.equal(win.adsProbe, 5);
  });
});
