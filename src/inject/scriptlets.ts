/**
 * 脚本注入（scriptlet）的 MAIN world 实现 —— 第三期。
 *
 * ## 为什么必须在 MAIN world
 *
 * 这些脚本要改写**页面自己的** JS 行为（`window.open`、`setTimeout`、属性读写、
 * `JSON.parse`）。ISOLATED world 拿到的是隔离子上下文，改不到页面的对象。
 *
 * ## 安全纪律（比网络规则更要紧）
 *
 * 脚本注入直接改页面运行时，一旦出错就是"站点功能坏掉"而不是"广告漏拦"。
 * 因此：
 *   - 每一步都包 try/catch，**任何异常都不得外泄**到页面
 *   - 只实现**语义自包含、误伤面可控**的子集（见 filterList/scriptlet.ts 的取舍）
 *   - 不改写与广告无关的全局行为
 *
 * ## 实现子集与实测覆盖率
 *
 * 实测 2,807 条规则、50 个脚本名；本实现覆盖其中的 11 个规范名。
 * 频率最高的几个（aopr/set/aopw/nostif/nowoif）都在其中。
 */

export type Invocation = { canonical: string; args: string[] };

export type RunResult = {
  applied: string[];
  failed: { canonical: string; error: string }[];
};

/**
 * 把 needle 变成匹配函数。
 *
 * 支持三种写法（与 uBO 一致）：
 *   `/regex/`  → 正则
 *   普通字符串 → 大小写不敏感的子串匹配
 *   空字符串   → 匹配一切
 */
export function makeMatcher(needle: string): (value: string) => boolean {
  if (!needle) return () => true;
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(needle);
  if (m) {
    try {
      const re = new RegExp(m[1]!, m[2]!.replace('g', ''));
      return (value) => {
        re.lastIndex = 0;
        return re.test(value);
      };
    } catch {
      // 非法正则：退回子串匹配，但要去掉首尾斜杠（否则永远匹配不上）
      const fallback = needle.slice(1, -1).toLowerCase();
      return (value) => value.toLowerCase().includes(fallback);
    }
  }
  const lower = needle.toLowerCase();
  return (value) => value.toLowerCase().includes(lower);
}

/** `set-constant` 支持的取值写法。 */
export function constantValue(raw: string): unknown {
  switch (raw) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
    case 'undefined':
      return undefined;
    case 'noopFunc':
      return () => undefined;
    case 'trueFunc':
      return () => true;
    case 'falseFunc':
      return () => false;
    case 'emptyObj':
      return {};
    case 'emptyArr':
      return [];
    default:
      if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
      return raw;
  }
}

/**
 * 沿点分路径找到宿主对象与最后一层属性名；中间缺失的层级不创建（避免污染）。
 *
 * ⚠️ 中间层**必须同时接受对象与函数**：`X.prototype.Y` 这类"穿过构造函数"的路径
 * 是这类规则最常见的写法之一（实测 `Navigator.prototype.globalPrivacyControl`）。
 * 早期只接受 `typeof === 'object'`，于是所有 `*.prototype.*` 规则静默失效
 * ——浏览器实测表现为"两条规则只生效一条"。
 */
function resolvePath(
  win: Record<string, unknown>,
  path: string,
): { owner: Record<string, unknown>; prop: string } | null {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  let owner: Record<string, unknown> = win;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const next = owner[parts[i]!];
    const usable =
      next !== null && (typeof next === 'object' || typeof next === 'function');
    if (!usable) return null;
    owner = next as Record<string, unknown>;
  }
  return { owner, prop: parts[parts.length - 1]! };
}

/** 定义一个"读得到、写不进、删不掉"的属性。 */
function defineTrap(
  owner: Record<string, unknown>,
  prop: string,
  descriptor: PropertyDescriptor,
): void {
  try {
    Object.defineProperty(owner, prop, {
      configurable: false,
      enumerable: true,
      ...descriptor,
    });
  } catch {
    // 属性不可配置（例如内置的 window.location）—— 忽略，不影响页面
  }
}

/**
 * `no-setTimeout-if` / `no-setInterval-if` 的延迟参数匹配。
 *
 * uBO 语义（核实自源码的 `RangeParser`）：延迟可以是精确整数，
 * 也可以是区间 `min-max` / `min-` / `-max`，并且可以用 `!` 取反。
 * 不传延迟 = 任意延迟。
 */
export function makeDelayMatcher(raw: string | undefined): (delay: number) => boolean {
  if (raw === undefined || raw === '') return () => true;

  const negate = raw.startsWith('!');
  const body = negate ? raw.slice(1) : raw;

  let test: (delay: number) => boolean;
  const range = /^(-?\d+)?-(-?\d+)?$/.exec(body);
  if (range && (range[1] !== undefined || range[2] !== undefined)) {
    const min = range[1] !== undefined ? Number(range[1]) : Number.NEGATIVE_INFINITY;
    const max = range[2] !== undefined ? Number(range[2]) : Number.POSITIVE_INFINITY;
    test = (delay) => delay >= min && delay <= max;
  } else if (/^-?\d+$/.test(body)) {
    const exact = Number(body);
    test = (delay) => delay === exact;
  } else {
    // 无法解析：uBO 会退回默认值，我们选择"匹配任意"（更保守地拦）
    test = () => true;
  }

  return negate ? (delay) => !test(delay) : test;
}

/**
 * `set-constant` 的安全闸门：**拒绝用原始值覆盖一个真实对象/函数**。
 *
 * uBO 用完整的 `typeof` 不符就拒绝（number↔boolean 也会拒绝）。
 * 我们收窄成"对象/函数 ↔ 原始值"这一种：既挡掉真正会弄坏页面的情况
 * （把站点的配置对象换成 `false`），又不至于让 `1 → false` 这类
 * 过滤器本意落空。这是**有意的偏离**，记录在此。
 */
function wouldBreakShape(existing: unknown, next: unknown): boolean {
  const isObj = (v: unknown): boolean => v !== null && (typeof v === 'object' || typeof v === 'function');
  const existingNullish = existing === null || existing === undefined;
  const nextNullish = next === null || next === undefined;
  if (existingNullish || nextNullish) return false;
  return isObj(existing) !== isObj(next);
}

/** 抛出的中止错误。用 Error 而不是抛字符串，便于页面 catch 后仍能识别。 */
function makeAbortError(what: string): Error {
  const err = new Error(`adblow: aborted ${what}`);
  err.name = 'ReferenceError';
  return err;
}

/**
 * 执行一批脚本注入调用。
 *
 * @param win 目标 window（测试时传 jsdom window）
 */
export function runScriptlets(
  invocations: Invocation[],
  win: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): RunResult {
  const applied: string[] = [];
  const failed: { canonical: string; error: string }[] = [];

  for (const inv of invocations) {
    try {
      const ok = applyOne(inv, win);
      if (ok) applied.push(inv.canonical);
    } catch (error) {
      // 绝不让异常外泄到页面
      failed.push({ canonical: inv.canonical, error: String(error).slice(0, 120) });
    }
  }

  return { applied, failed };
}

function applyOne(inv: Invocation, win: Record<string, unknown>): boolean {
  const { canonical, args } = inv;

  switch (canonical) {
    // ── set-constant：把属性固定成某个值，页面改不动 ──
    case 'set-constant': {
      const [path, rawValue] = args;
      if (!path) return false;
      const target = resolvePath(win, path);
      if (!target) return false;
      const value = constantValue(rawValue ?? '');
      // 安全闸门：不用原始值覆盖真实对象/函数（见 wouldBreakShape 的说明）
      let existing: unknown;
      try {
        existing = target.owner[target.prop];
      } catch {
        existing = undefined;
      }
      if (wouldBreakShape(existing, value)) {
        console.debug(`[adblow] set-constant 拒绝接管 ${path}（形状不符，避免弄坏页面）`);
        return false;
      }
      defineTrap(target.owner, target.prop, {
        get: () => value,
        set: () => undefined,
      });
      return true;
    }

    // ── abort-on-property-read：读这个属性就抛错，中止正在执行的脚本 ──
    case 'abort-on-property-read': {
      const [path] = args;
      if (!path) return false;
      const target = resolvePath(win, path);
      if (!target) return false;
      defineTrap(target.owner, target.prop, {
        get: () => {
          throw makeAbortError(path);
        },
      });
      return true;
    }

    // ── abort-on-property-write：写这个属性就抛错 ──
    //
    // uBO 语义（核实自源码）：先 `delete` 再定义只有 setter 的属性 ——
    // 因此**读该属性得到 undefined**，只有写才抛错。
    case 'abort-on-property-write': {
      const [path, needle] = args;
      if (!path) return false;
      const target = resolvePath(win, path);
      if (!target) return false;
      const matches = needle ? makeMatcher(needle) : () => true;
      try {
        delete target.owner[target.prop];
      } catch {
        /* 不可删除时继续，下面的 defineProperty 会兜住 */
      }
      defineTrap(target.owner, target.prop, {
        set: (v: unknown) => {
          if (matches(String(v))) throw makeAbortError(path);
        },
      });
      return true;
    }

    // ── no-setTimeout-if / no-setInterval-if：拦住匹配的定时器 ──
    //
    // uBO 语义：`(needle, delay?)` —— needle 匹配回调源码，delay 可以是
    // 精确值或区间（见 makeDelayMatcher）。**两者都匹配才拦**。
    case 'no-setTimeout-if':
    case 'no-setInterval-if': {
      const fnName = canonical === 'no-setTimeout-if' ? 'setTimeout' : 'setInterval';
      const [needle, delayRaw] = args;
      const original = win[fnName];
      if (typeof original !== 'function') return false;
      const matchesSource = makeMatcher(needle ?? '');
      const matchesDelay = makeDelayMatcher(delayRaw);
      const patched = function patched(
        this: unknown,
        handler: unknown,
        timeout?: unknown,
        ...rest: unknown[]
      ): unknown {
        try {
          const source = typeof handler === 'function' ? String(handler) : String(handler ?? '');
          const delay = Number(timeout ?? 0);
          if (matchesSource(source) && matchesDelay(Number.isFinite(delay) ? delay : 0)) {
            // uBO 用空函数替换回调（调用仍会发生、定时器仍被排程）
            return (original as (...a: unknown[]) => unknown).call(
              this,
              () => undefined,
              timeout,
              ...rest,
            );
          }
        } catch {
          /* 忽略，按原样放行 */
        }
        return (original as (...a: unknown[]) => unknown).call(this, handler, timeout, ...rest);
      };
      win[fnName] = patched;
      return true;
    }

    // ── prevent-addEventListener（别名 aeld，实测 206 条）──
    //
    // uBO 语义：代理 `EventTarget.prototype.addEventListener`，
    // **事件类型与处理函数源码都匹配**时才丢掉这个监听器。
    case 'prevent-addEventListener': {
      const [typeNeedle, handlerNeedle] = args;
      const EventTargetCtor = win.EventTarget as { prototype?: Record<string, unknown> } | undefined;
      const proto = EventTargetCtor?.prototype;
      if (!proto || typeof proto.addEventListener !== 'function') return false;
      const matchesType = makeMatcher(typeNeedle ?? '');
      const matchesHandler = makeMatcher(handlerNeedle ?? '');
      const original = proto.addEventListener;
      proto.addEventListener = function patched(
        this: unknown,
        type: unknown,
        handler: unknown,
        ...rest: unknown[]
      ): unknown {
        try {
          if (matchesType(String(type ?? '')) && matchesHandler(String(handler ?? ''))) {
            return undefined; // 丢弃这个监听器
          }
        } catch {
          /* 忽略 */
        }
        return (original as (...a: unknown[]) => unknown).call(this, type, handler, ...rest);
      };
      return true;
    }

    // ── no-window-open-if：拦住匹配的 window.open ──
    //
    // uBO 语义：匹配的是**调用参数拼接后的字符串**（`callArgs.join(' ')`），
    // 不只是 URL —— 因为广告常把关键信息放在 windowName/features 里。
    case 'no-window-open-if': {
      const [needle] = args;
      const original = win.open;
      if (typeof original !== 'function') return false;
      const matches = makeMatcher(needle ?? '');
      win.open = function patched(this: unknown, ...callArgs: unknown[]): unknown {
        try {
          if (matches(callArgs.map((a) => String(a ?? '')).join(' '))) return null;
        } catch {
          /* 忽略 */
        }
        return (original as (...a: unknown[]) => unknown).apply(this, callArgs);
      };
      return true;
    }

    // ── no-fetch-if：让匹配的 fetch 直接返回空响应 ──
    case 'no-fetch-if': {
      const [needle] = args;
      const original = win.fetch;
      if (typeof original !== 'function') return false;
      const matches = makeMatcher(needle ?? '');
      win.fetch = function patched(this: unknown, input: unknown, ...rest: unknown[]): unknown {
        try {
          const url =
            typeof input === 'string' ? input : String((input as { url?: string })?.url ?? '');
          if (matches(url)) {
            // ⚠️ 必须保证**不抛异常**：某些环境没有 Response 构造器（实测 jsdom），
            // 直接 new Response 会把异常抛给页面，违反"任何异常都不得外泄"的纪律。
            let response: unknown;
            try {
              response = new Response('', { status: 204, statusText: 'No Content' });
            } catch {
              response = {
                ok: false,
                status: 204,
                statusText: 'No Content',
                text: () => Promise.resolve(''),
                json: () => Promise.resolve(null),
              };
            }
            return Promise.resolve(response);
          }
        } catch {
          /* 匹配失败时按原样放行 */
        }
        return (original as (...a: unknown[]) => unknown).call(this, input, ...rest);
      };
      return true;
    }

    // ── no-xhr-if：拦住匹配的 XHR ──
    case 'no-xhr-if': {
      const [needle] = args;
      const proto = (win.XMLHttpRequest as { prototype?: Record<string, unknown> } | undefined)
        ?.prototype;
      if (!proto || typeof proto.open !== 'function') return false;
      const matches = makeMatcher(needle ?? '');
      const originalOpen = proto.open;
      proto.open = function patched(
        this: Record<string, unknown>,
        method: unknown,
        url: unknown,
        ...rest: unknown[]
      ): unknown {
        try {
          if (matches(String(url ?? ''))) {
            this.__adblowBlocked = true;
            return undefined;
          }
        } catch {
          /* 忽略 */
        }
        return (originalOpen as (...a: unknown[]) => unknown).call(this, method, url, ...rest);
      };
      const originalSend = proto.send;
      if (typeof originalSend === 'function') {
        proto.send = function patched(this: Record<string, unknown>, ...a: unknown[]): unknown {
          if (this.__adblowBlocked) return undefined;
          return (originalSend as (...x: unknown[]) => unknown).call(this, ...a);
        };
      }
      return true;
    }

    // ── json-prune：从 JSON.parse 结果里删掉指定路径 ──
    case 'json-prune': {
      const [paths] = args;
      if (!paths) return false;
      const json = win.JSON as Record<string, unknown> | undefined;
      if (!json || typeof json.parse !== 'function') return false;
      const original = json.parse;
      const prunePaths = paths
        .split(/\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      const prune = (node: unknown, path: string[]): void => {
        if (node === null || typeof node !== 'object') return;
        const [head, ...tail] = path;
        if (!head) return;
        if (head === '*') {
          for (const key of Object.keys(node as Record<string, unknown>)) prune(node, [key, ...tail]);
          return;
        }
        if (tail.length === 0) {
          delete (node as Record<string, unknown>)[head];
          return;
        }
        prune((node as Record<string, unknown>)[head], tail);
      };
      json.parse = function patched(this: unknown, ...a: unknown[]): unknown {
        const result = (original as (...x: unknown[]) => unknown).apply(this, a);
        try {
          for (const p of prunePaths) prune(result, p.split('.'));
        } catch {
          /* 忽略 */
        }
        return result;
      };
      return true;
    }

    // ── set-local-storage-item：设置或删除 localStorage 项 ──
    //
    // uBO 语义（核实自源码）：`(key, value, ...varargs)`。
    // ⚠️ 当 value 是 `$remove$` 时，**key 被当成字符串/正则模式**，
    // 要删掉**所有匹配的键** —— 不是删一个字面 key。
    // 实测样例：`set-local-storage-item, /sc_tracking_anonymous_id|statsig/, $remove$`
    case 'set-local-storage-item': {
      const [key, rawValue] = args;
      if (!key) return false;
      try {
        const storage = win.localStorage as Storage | undefined;
        if (!storage) return false;
        if (rawValue === '$remove$') {
          const matches = makeMatcher(key);
          for (const existing of Object.keys(storage)) {
            if (matches(existing)) storage.removeItem(existing);
          }
          return true;
        }
        storage.setItem(key, rawValue ?? '');
        return true;
      } catch {
        // localStorage 在部分上下文被禁用
        return false;
      }
    }

    // ── remove-cookie：让匹配的 cookie 过期 ──
    //
    // ⚠️ 第一个参数是**匹配式**（字符串或 `/正则/`），不是 cookie 字面名。
    // 实测样例：`remove-cookie, /sc_anonymous_id|sc_tracking_anonymous_id/`
    // —— 早期实现按字面名处理，会去写一个名字叫 `/sc_.../ ` 的 cookie（错的）。
    case 'remove-cookie': {
      const [needle] = args;
      if (!needle) return false;
      const doc = win.document as Document | undefined;
      if (!doc) return false;
      const matches = makeMatcher(needle);
      const host = (win.location as Location | undefined)?.hostname ?? '';

      // 从现有 cookie 里挑出名字匹配的（只处理脚本可读的）
      let names: string[] = [];
      try {
        names = String(doc.cookie ?? '')
          .split(';')
          .map((pair) => pair.split('=')[0]?.trim() ?? '')
          .filter(Boolean)
          .filter((name) => matches(name));
      } catch {
        return false;
      }
      if (names.length === 0) return false;

      const domains = ['', `; domain=${host}`, `; domain=.${host}`];
      for (const name of names) {
        for (const d of domains) {
          try {
            doc.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`;
          } catch {
            /* 忽略单个失败 */
          }
        }
      }
      return true;
    }

    default:
      return false;
  }
}
