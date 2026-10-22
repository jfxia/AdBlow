import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseFilterLine, parseList, type ParsedFilter } from '../../src/engine/filterList/parse.ts';
import {
  POPUP_ALLOW_ATTR,
  POPUP_BLOCK_EVENT,
  POPUP_DENY_ELEMENT_ID,
  POPUP_LIST_ID,
  announcePopupBlock,
  createPopupDenyGate,
  extractPopupDomains,
  installPopupDenyElement,
  isPopupHost,
  parsePopupDomainArray,
  parsePopupDomainFile,
  popupDomainFromPattern,
  publishPopupAllowance,
  readPopupAllowance,
  readPopupDenyDomains,
} from '../../src/engine/popupDomains.ts';

/**
 * `$popup` rules cannot enter DNR: there is no resource type for "the page called window.open",
 * and compiled as a network rule they would block every request to the host. They are therefore
 * a separate rule kind at parse time and a runtime list at build time. The tests below pin the
 * four layers: parse -> export -> file/DOM delivery -> host matching.
 */

function popupFilter(pattern: string, overrides: Partial<ParsedFilter> = {}): ParsedFilter {
  return {
    raw: `||x^$popup`,
    pattern,
    exception: false,
    regex: false,
    badfilter: false,
    important: false,
    matchCase: false,
    popup: true,
    ...overrides,
  };
}

function newDoc(url = 'https://missav.watch/'): Document {
  return new JSDOM('<!doctype html><html><head></head><body></body></html>', { url }).window
    .document;
}

describe('$popup：解析成独立种类', () => {
  it('域名锚点 → kind=popup，且带 popup 标记', () => {
    const outcome = parseFilterLine('||adb.example^$popup');
    assert.equal(outcome.kind, 'popup');
    if (outcome.kind !== 'popup') return;
    assert.equal(outcome.filter.popup, true);
    assert.equal(outcome.filter.pattern, '||adb.example^');
  });

  it('@ 例外与 $domain= 作用域仍被解析（导出阶段决定是否可用）', () => {
    const exception = parseFilterLine('@@||allowed.example^$popup');
    assert.equal(exception.kind, 'popup');
    if (exception.kind === 'popup') {
      assert.equal(exception.filter.exception, true);
      assert.equal(exception.filter.popup, true);
    }

    const scoped = parseFilterLine('||adb.example^$popup,domain=news.example');
    assert.equal(scoped.kind, 'popup');
    if (scoped.kind === 'popup') {
      assert.deepEqual(scoped.filter.initiatorDomains, ['news.example']);
    }
  });

  it('与其它支持选项共存：$popup,third-party', () => {
    const outcome = parseFilterLine('||adb.example^$popup,third-party');
    assert.equal(outcome.kind, 'popup');
    if (outcome.kind === 'popup') assert.equal(outcome.filter.domainType, 'thirdParty');
  });

  it('❗$popup 规则绝不进入网络规则集', () => {
    const parsed = parseList('||adb.example^$popup\n||normal.example^');
    assert.equal(parsed.network.length, 1);
    assert.equal(parsed.network[0]!.pattern, '||normal.example^');
    assert.equal(parsed.popup.length, 1);
    assert.equal(parsed.popup[0]!.pattern, '||adb.example^');
  });

  it('$popup 带上不支持的选项仍然整条丢弃（不因 popup 而放宽）', () => {
    assert.equal(parseFilterLine('||a.example^$popup,redirect=noop.js').kind, 'skip');
    assert.equal(parseFilterLine('||a.example^$popup,unknownopt').kind, 'skip');
  });

  it('~popup 仍是不支持（它是"非弹窗请求"的网络规则，方向相反）', () => {
    const outcome = parseFilterLine('||a.example^$~popup');
    assert.equal(outcome.kind, 'skip');
  });

  it('没有模式的 $popup 被丢弃', () => {
    assert.equal(parseFilterLine('$popup').kind, 'skip');
  });
});

describe('$popup：导出成运行时域名名单', () => {
  it('只接受裸域名锚点（^ / ^| / 无分隔符），统一小写、去重、排序', () => {
    const domains = extractPopupDomains([
      popupFilter('||B.example^'),
      popupFilter('||a.example'),
      popupFilter('||a.example^|'),
      popupFilter('||a.example^'),
    ]);
    assert.deepEqual(domains, ['a.example', 'b.example']);
  });

  it('路径、正则、通配符与残缺域名不算', () => {
    for (const pattern of [
      '||a.example/ad',
      '/a\\.example^/',
      '||*.a.example^',
      '||allyes.^',
      '||check-tl-^',
      'a.example',
    ]) {
      assert.equal(popupDomainFromPattern(pattern), null, pattern);
      assert.deepEqual(extractPopupDomains([popupFilter(pattern)]), [], pattern);
    }
  });

  it('@@ 例外从名单里扣除', () => {
    const domains = extractPopupDomains([
      popupFilter('||keep.example^'),
      popupFilter('||drop.example^'),
      popupFilter('||drop.example^', { exception: true }),
    ]);
    assert.deepEqual(domains, ['keep.example']);
  });

  it('带 $domain= 作用域的规则跳过（守卫拿不到 opener 上下文）', () => {
    const domains = extractPopupDomains([
      popupFilter('||scoped.example^', { initiatorDomains: ['news.example'] }),
      popupFilter('||excluded.example^', { excludedInitiatorDomains: ['news.example'] }),
      popupFilter('||plain.example^'),
    ]);
    assert.deepEqual(domains, ['plain.example']);
  });

  it('带 $to= / $denyallow= 的规则同样跳过', () => {
    const domains = extractPopupDomains([
      popupFilter('||to.example^', { requestDomains: ['a.example'] }),
      popupFilter('||deny.example^', { excludedRequestDomains: ['b.example'] }),
      popupFilter('||plain.example^'),
    ]);
    assert.deepEqual(domains, ['plain.example']);
  });

  it('badfilter 取消的规则忽略', () => {
    const domains = extractPopupDomains([
      popupFilter('||a.example^', { badfilter: true }),
      popupFilter('||b.example^'),
    ]);
    assert.deepEqual(domains, ['b.example']);
  });

  it('❗不是 $popup 的网络规则不会被误当成弹窗名单（即使传错数组）', () => {
    const domains = extractPopupDomains([
      popupFilter('||a.example^', { popup: undefined }),
      popupFilter('||b.example^'),
    ]);
    assert.deepEqual(domains, ['b.example']);
  });
});

describe('弹窗名单文件 / DOM 数组解析', () => {
  it('读取 generatedFrom + domains，条目小写并去重', () => {
    const parsed = parsePopupDomainFile({
      generatedFrom: POPUP_LIST_ID,
      domains: ['A.example', 'a.example', 'www.b.example'],
    });
    assert.deepEqual([...parsed!].sort(), ['a.example', 'www.b.example']);
  });

  it('空数组是有效清单（不据此拒绝任何窗口）', () => {
    const parsed = parsePopupDomainFile({ generatedFrom: POPUP_LIST_ID, domains: [] });
    assert.ok(parsed);
    assert.equal(parsed?.size, 0);
  });

  it('文件缺失 / 形状不对 / domains 不是数组 → null', () => {
    assert.equal(parsePopupDomainFile(null), null);
    assert.equal(parsePopupDomainFile([]), null);
    assert.equal(parsePopupDomainFile({}), null);
    assert.equal(parsePopupDomainFile({ domains: 'a.example' }), null);
  });

  it('DOM 里必须是数组；非字符串条目被丢弃', () => {
    assert.equal(parsePopupDomainArray({ domains: [] }), null);
    assert.equal(parsePopupDomainArray('a.example'), null);
    assert.deepEqual([...parsePopupDomainArray(['a.example', 42, null])!], ['a.example']);
    assert.equal(parsePopupDomainArray([])?.size, 0);
  });
});

describe('弹窗主机名匹配：按 . 边界', () => {
  const domains = new Set(['a.com', 'b.net']);

  it('精确与子域（任意层级）', () => {
    assert.equal(isPopupHost('a.com', domains), true);
    assert.equal(isPopupHost('www.a.com', domains), true);
    assert.equal(isPopupHost('x.y.a.com', domains), true);
  });

  it('大小写不敏感，去掉前导 www. 与端口 / 尾点', () => {
    assert.equal(isPopupHost('WWW.A.COM', domains), true);
    assert.equal(isPopupHost('www.b.net:8080', domains), true);
    assert.equal(isPopupHost('a.com.', domains), true);
  });

  it('nota.com 不命中 a.com（不能用 includes / 裸 endsWith）', () => {
    assert.equal(isPopupHost('nota.com', domains), false);
    assert.equal(isPopupHost('a.com.evil', domains), false);
    assert.equal(isPopupHost('ba.com', domains), false);
  });

  it('空名单 / 空主机不命中', () => {
    assert.equal(isPopupHost('a.com', new Set()), false);
    assert.equal(isPopupHost('', domains), false);
    assert.equal(isPopupHost('   ', domains), false);
  });
});

describe('MAIN world：从 DOM 读取名单（懒加载 + 失败放行）', () => {
  it('发布的是 inert JSON 元素，不是可执行脚本', () => {
    const doc = newDoc();
    assert.equal(installPopupDenyElement(doc, ['ads.example']), true);
    const el = doc.getElementById(POPUP_DENY_ELEMENT_ID);
    assert.ok(el);
    assert.equal(el!.tagName, 'SCRIPT');
    assert.equal(el!.getAttribute('type'), 'application/json');
    assert.deepEqual(JSON.parse(el!.textContent!), ['ads.example']);
  });

  it('重复发布不会插入第二个元素', () => {
    const doc = newDoc();
    installPopupDenyElement(doc, ['a.example']);
    installPopupDenyElement(doc, ['b.example']);
    assert.equal(doc.querySelectorAll(`#${POPUP_DENY_ELEMENT_ID}`).length, 1);
  });

  it('命中名单 → 拒绝；不在名单 → 放行', () => {
    const doc = newDoc();
    installPopupDenyElement(doc, ['ads.example']);
    const gate = createPopupDenyGate(doc);
    assert.equal(gate.isDenied('https://ads.example/x', 'https://missav.watch/'), true);
    assert.equal(gate.isDenied('https://sub.ads.example/x', 'https://missav.watch/'), true);
    assert.equal(gate.isDenied('https://other.example/x', 'https://missav.watch/'), false);
  });

  it('❗读不到名单（元素缺失 / JSON 坏 / 空文本）→ 放行', () => {
    const missing = newDoc();
    assert.equal(createPopupDenyGate(missing).isDenied('https://ads.example/x'), false);

    const broken = newDoc();
    const bad = broken.createElement('script');
    bad.id = POPUP_DENY_ELEMENT_ID;
    bad.textContent = '{not json';
    broken.head.appendChild(bad);
    assert.equal(readPopupDenyDomains(broken), null);
    assert.equal(createPopupDenyGate(broken).isDenied('https://ads.example/x'), false);
  });

  it('空数组是有效名单：不拒绝任何窗口', () => {
    const doc = newDoc();
    installPopupDenyElement(doc, []);
    assert.equal(createPopupDenyGate(doc).isDenied('https://ads.example/x'), false);
  });

  it('不依赖启动顺序：先调用守卫、后写入元素，下一次调用就能命中', () => {
    const doc = newDoc();
    const gate = createPopupDenyGate(doc);
    assert.equal(gate.isDenied('https://ads.example/x', 'https://missav.watch/'), false);
    installPopupDenyElement(doc, ['ads.example']);
    assert.equal(gate.isDenied('https://ads.example/x', 'https://missav.watch/'), true);
  });

  it('相对地址按 base 解析后再比主机', () => {
    const doc = newDoc();
    installPopupDenyElement(doc, ['ads.example']);
    const gate = createPopupDenyGate(doc);
    assert.equal(gate.isDenied('//ads.example/x', 'https://missav.watch/page'), true);
    assert.equal(gate.isDenied('/local', 'https://ads.example/page'), true);
    assert.equal(gate.isDenied('/local', 'https://missav.watch/page'), false);
  });

  it('空目标与不可解析目标放行（由手势策略单独判断）', () => {
    const doc = newDoc();
    installPopupDenyElement(doc, ['ads.example']);
    const gate = createPopupDenyGate(doc);
    assert.equal(gate.isDenied(''), false);
    assert.equal(gate.isDenied('http://['), false);
  });
});

describe('站点逃生门：DOM 发布与读取', () => {
  it('默认不发布 = 不允许', () => {
    const doc = newDoc();
    assert.equal(readPopupAllowance(doc), false);
  });

  it('打开写入 "1"，关闭时删掉属性（存储里也不留 false）', () => {
    const doc = newDoc();
    publishPopupAllowance(doc, true);
    assert.equal(doc.documentElement.getAttribute(POPUP_ALLOW_ATTR), '1');
    assert.equal(readPopupAllowance(doc), true);
    publishPopupAllowance(doc, false);
    assert.equal(doc.documentElement.hasAttribute(POPUP_ALLOW_ATTR), false);
    assert.equal(readPopupAllowance(doc), false);
  });
});

describe('拦截记录事件', () => {
  it('只传字符串目标，跨 world 安全', () => {
    const seen: Event[] = [];
    const fakeDoc = {
      dispatchEvent: (event: Event) => {
        seen.push(event);
        return true;
      },
    } as unknown as Document;

    announcePopupBlock(fakeDoc, 'https://ads.example/x');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.type, POPUP_BLOCK_EVENT);
    assert.equal((seen[0] as CustomEvent).detail, 'https://ads.example/x');
    assert.equal(typeof (seen[0] as CustomEvent).detail, 'string');
  });

  it('dispatchEvent 抛异常时不往外冒（记录丢失不能反过来影响拦截）', () => {
    const fakeDoc = {
      dispatchEvent: () => {
        throw new Error('detached');
      },
    } as unknown as Document;
    assert.doesNotThrow(() => announcePopupBlock(fakeDoc, 'https://ads.example/x'));
  });
});
