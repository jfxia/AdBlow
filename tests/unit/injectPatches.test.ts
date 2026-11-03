import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPageWideListener,
  isNavigationSource,
  looksLikeNavigationHijack,
} from '../../src/inject/clickGuard.ts';
import {
  guardAddEventListener,
  guardPropertySetter,
  guardWindowOpen,
  makeFailureReporter,
  safeVerdict,
} from '../../src/inject/safePatches.ts';

/**
 * 页面级监听器的去留，以及「补丁内部出错必须退化为原生行为」。
 *
 * 背景（2026-11-02）：`EventTarget.prototype.addEventListener` 的包装会读 `handleEvent`、
 * `toString`，原生接口完全不读这些。页面一旦用了原生允许而我们没料到的写法，异常就会从
 * `addEventListener` 逃回页面自己的初始化代码 —— 页面"能显示但不再响应"。
 *
 * 另一条：判定原来是"整段函数源码里出现 `location.href =` 或 `window.open(` 就算劫持"，
 * 于是带兜底的正常委托点击处理器被整段丢掉。现在只丢"整个函数体只有一条跳转语句"的监听器。
 */

type NativeAdd = (
  this: unknown,
  type: unknown,
  listener: unknown,
  options?: unknown,
) => unknown;

/** A page-wide target and the window/document identities it is compared against. */
function page(): { win: object; doc: { body: object; documentElement: object }; element: object } {
  const doc = { body: {}, documentElement: {} };
  return { win: {}, doc, element: {} };
}

function classify(listener: unknown, type = 'click', target?: unknown): string | null {
  const { win, doc, element } = page();
  return classifyPageWideListener({
    target: target ?? doc,
    type,
    listener,
    win,
    doc,
  }) ?? null;
}

// `new Function` keeps the source text verbatim, which is what the matcher reads.
const handlers = {
  /** SPA 路由：读 href、preventDefault、history.pushState —— 正常行为。 */
  router: new Function(`
    var a = event.target.closest('a');
    if (!a) return;
    event.preventDefault();
    history.pushState({}, '', a.getAttribute('href') || '');
  `) as EventListener,
  /** 委托点击 + "新标签打开"兜底：函数体里确实有 window.open(…)，但它的本职是路由。 */
  withOpenFallback: new Function(`
    var a = event.target.closest('a[href]');
    if (!a) return;
    if (event.metaKey || a.target === '_blank') {
      window.open(a.href, '_blank');
      return;
    }
    route(a.getAttribute('href'));
  `) as EventListener,
  /** 委托点击 + location.href 兜底。 */
  withHrefFallback: new Function(`
    var a = event.target.closest('a[href]');
    if (!a) return;
    if (history.pushState) history.pushState({}, '', a.getAttribute('href'));
    else location.href = a.getAttribute('href');
  `) as EventListener,
  /** 整个函数体就是一次跳转 —— 这才是点击劫持的形状。 */
  pureJump: new Function(`location.href = 'https://ads.example.com/x'`) as EventListener,
  pureOpen: new Function(`window.open('https://ads.example.com/x', '_blank')`) as EventListener,
};

describe('页面级监听器：只有「整个函数体就是一条跳转」才丢弃', () => {
  it('❗router 式（读 href + pushState）保留', () => {
    assert.equal(classify(handlers.router), null);
  });

  it('❗带 window.open 兜底的委托点击保留（原来会被整段丢掉）', () => {
    assert.equal(classify(handlers.withOpenFallback), null);
  });

  it('❗带 location.href 兜底的委托点击保留（原来会被整段丢掉）', () => {
    assert.equal(classify(handlers.withHrefFallback), null);
  });

  it('纯跳转丢弃', () => {
    assert.equal(classify(handlers.pureJump), 'navigation');
    assert.equal(classify(handlers.pureOpen), 'navigation');
  });

  it('非页面级目标一律保留（元素级监听器不碰）', () => {
    const { element } = page();
    assert.equal(classify(handlers.pureJump, 'click', element), null);
  });

  it('卸载期上报监听器仍按原策略丢弃，其它类型不丢', () => {
    const beacon = new Function(`navigator.sendBeacon('/report.json', 'x')`) as EventListener;
    assert.equal(classify(beacon, 'pagehide'), 'unload-beacon');
    assert.equal(classify(beacon, 'beforeunload'), 'unload-beacon');
    assert.equal(classify(beacon, 'click'), null, 'click 上的上报不该被丢');
  });

  it('同一形状在 body / documentElement / window 上同样生效', () => {
    const { win, doc } = page();
    for (const target of [doc, doc.body, doc.documentElement, win]) {
      assert.equal(
        classifyPageWideListener({ target, type: 'click', listener: handlers.pureJump, win, doc }),
        'navigation',
      );
    }
  });
});

describe('❗读源码失败时既不能抛，也不能丢监听器', () => {
  const throwingHandleEvent = {
    get handleEvent(): EventListener {
      throw new TypeError('handleEvent getter threw');
    },
  };
  const throwingToString = (() => {
    const fn = ((): void => undefined) as unknown as Record<string, unknown>;
    Object.defineProperty(fn, 'toString', {
      value: () => {
        throw new TypeError('toString threw');
      },
    });
    return fn;
  })();

  it('handleEvent getter 抛异常：判定不抛，监听器保留', () => {
    assert.doesNotThrow(() => looksLikeNavigationHijack(throwingHandleEvent));
    assert.equal(looksLikeNavigationHijack(throwingHandleEvent), false);
    assert.equal(classify(throwingHandleEvent), null);
  });

  it('toString 被改写：判定不抛，监听器保留', () => {
    assert.doesNotThrow(() => looksLikeNavigationHijack(throwingToString));
    assert.equal(classify(throwingToString), null);
  });

  it('❗包装后照常注册：原生 addEventListener 被调用一次，页面看不到异常', () => {
    const calls: unknown[][] = [];
    const native: NativeAdd = function (type, listener, options) {
      calls.push([type, listener, options]);
      return undefined;
    };
    const { win, doc } = page();
    const patched = guardAddEventListener(
      native,
      (target, type, listener) => classifyPageWideListener({ target, type, listener, win, doc }) ?? null,
      () => assert.fail('不该丢弃'),
      () => {},
    );
    assert.doesNotThrow(() => patched.call(doc, 'click', throwingHandleEvent, true));
    assert.equal(calls.length, 1, '必须照常注册');
    assert.equal(calls[0]![1], throwingHandleEvent);
    assert.equal(calls[0]![2], true, 'options 必须原样传下去');
  });
});

describe('补丁的降级路径：判定失败 = 原生行为', () => {
  it('addEventListener：判定抛异常时仍然调用原生实现', () => {
    const calls: unknown[][] = [];
    const reports: string[] = [];
    const patched = guardAddEventListener(
      function (type, listener) {
        calls.push([type, listener]);
        return undefined;
      },
      () => {
        throw new Error('classifier blew up');
      },
      () => assert.fail('不该丢弃'),
      (site) => reports.push(site),
    );
    assert.doesNotThrow(() => patched.call({}, 'click', handlers.router));
    assert.equal(calls.length, 1);
    assert.deepEqual(reports, ['addEventListener']);
  });

  it('addEventListener：判定为丢弃且 onDrop 抛异常时，丢弃决定仍然成立且不抛', () => {
    const calls: unknown[][] = [];
    const patched = guardAddEventListener(
      function (type, listener) {
        calls.push([type, listener]);
        return undefined;
      },
      () => 'navigation',
      () => {
        throw new Error('logging blew up');
      },
      () => {},
    );
    assert.doesNotThrow(() => patched.call({}, 'click', handlers.pureJump));
    assert.equal(calls.length, 0, '判定为丢弃时不应调用原生实现');
  });

  it('window.open：判定抛异常时按原生打开', () => {
    const opened: unknown[] = [];
    const patched = guardWindowOpen(
      (...args) => {
        opened.push(args[0]);
        return { opened: args[0] };
      },
      () => {
        throw new Error('decide blew up');
      },
      () => {},
    );
    assert.doesNotThrow(() => patched('https://good.example/x'));
    assert.deepEqual(opened, ['https://good.example/x']);
    assert.equal((patched('https://good.example/y') as { opened: string }).opened, 'https://good.example/y');
  });

  it('window.open：判定为拒绝时返回 null 且不打开，onBlock 抛异常也不改变决定', () => {
    const opened: unknown[] = [];
    let blocked = 0;
    const patched = guardWindowOpen(
      (...args) => {
        opened.push(args[0]);
        return { opened: args[0] };
      },
      () => ({
        allow: false,
        onBlock: () => {
          blocked += 1;
          throw new Error('announce blew up');
        },
      }),
      () => {},
    );
    assert.equal(patched('https://ads.example/x'), null);
    assert.equal(blocked, 1);
    assert.deepEqual(opened, []);
  });

  it('on* 设置器：判定抛异常时仍然安装处理器', () => {
    const installed: unknown[] = [];
    const patched = guardPropertySetter(
      function (value) {
        installed.push(value);
        return undefined;
      },
      () => {
        throw new Error('predicate blew up');
      },
      () => {},
      () => {},
    );
    assert.doesNotThrow(() => patched.call({}, handlers.router));
    assert.deepEqual(installed, [handlers.router]);
  });

  it('on* 设置器：命中时拒绝安装', () => {
    const installed: unknown[] = [];
    let dropped = 0;
    const patched = guardPropertySetter(
      function (value) {
        installed.push(value);
        return undefined;
      },
      (value) => looksLikeNavigationHijack(value),
      () => {
        dropped += 1;
      },
      () => {},
    );
    patched.call({}, handlers.pureJump);
    assert.deepEqual(installed, []);
    assert.equal(dropped, 1);
  });
});

describe('失败上报与一次性判定', () => {
  it('❗同一处失败只打印一次', () => {
    const lines: string[] = [];
    const report = makeFailureReporter((line) => lines.push(line));
    report('addEventListener');
    report('addEventListener');
    report('window.open');
    assert.equal(lines.length, 2, '同一处重复失败不应刷屏');
    assert.match(lines[0]!, /addEventListener/);
    assert.match(lines[0]!, /退化为原生行为/);
  });

  it('日志本身抛异常也不会外泄', () => {
    const report = makeFailureReporter(() => {
      throw new Error('console is gone');
    });
    assert.doesNotThrow(() => report('x'));
  });

  it('safeVerdict：判定抛异常等于「不介入」', () => {
    const reports: string[] = [];
    const report = (site: string): void => {
      reports.push(site);
    };
    assert.equal(safeVerdict(() => true, report, '行内'), true);
    assert.equal(
      safeVerdict(
        () => {
          throw new Error('x');
        },
        report,
        '行内',
      ),
      false,
    );
    assert.deepEqual(reports, ['行内']);
  });

  it('isNavigationSource 仍识别单个跳转语句、拒绝多语句', () => {
    assert.equal(isNavigationSource("location.href='https://ads.example.com/x'"), true);
    assert.equal(isNavigationSource(`location.href='a'; location.href='b'`), false, '多条语句保留');
    assert.equal(isNavigationSource(`if (x) location.href='a'`), false, '带分支保留');
  });
});
