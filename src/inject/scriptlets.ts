/**
 * MAIN world implementation of scriptlet injection.
 *
 * Must be MAIN world: these patches rewrite page-owned JS behavior (`window.open`,
 * timers, property access, `JSON.parse`); an ISOLATED world gets a separate context and
 * cannot reach the page's objects.
 *
 * Safety discipline (stricter than for network rules): a mistake here breaks the site
 * instead of leaking an ad. Every step is wrapped in try/catch and no exception may escape
 * to the page; only semantically self-contained scriptlets with a bounded blast radius are
 * implemented (see filterList/scriptlet.ts).
 *
 * Measured: 2,807 rules and 50 scriptlet names; 11 canonical names are covered here,
 * including the most frequent ones (aopr/set/aopw/nostif/nowoif).
 */

export type Invocation = { canonical: string; args: string[] };

export type RunResult = {
  applied: string[];
  failed: { canonical: string; error: string }[];
};

/**
 * Turn a needle into a matcher, using uBO's three forms:
 *   `/regex/`      → regular expression
 *   plain string   → case-insensitive substring match
 *   empty string   → matches everything
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
      // Invalid regex: fall back to substring matching, stripping the surrounding
      // slashes (otherwise it could never match).
      const fallback = needle.slice(1, -1).toLowerCase();
      return (value) => value.toLowerCase().includes(fallback);
    }
  }
  const lower = needle.toLowerCase();
  return (value) => value.toLowerCase().includes(lower);
}

/** Value forms accepted by `set-constant`. */
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
 * Walk a dotted path to its host object and last property name; missing intermediate
 * levels are not created (avoids pollution).
 *
 * Intermediate levels must accept objects AND functions: `X.prototype.Y` paths are one of
 * the most common forms of these rules (measured: `Navigator.prototype.globalPrivacyControl`).
 * An earlier version accepted only `typeof === 'object'`, which silently disabled every
 * `*.prototype.*` rule — observed in the browser as "only one of two rules takes effect".
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

/** Define a property that reads but cannot be written or deleted. */
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
    // Non-configurable property (e.g. built-in window.location): ignore, the page is
    // unaffected.
  }
}

/**
 * Delay matching for `no-setTimeout-if` / `no-setInterval-if`.
 *
 * uBO semantics (verified against its `RangeParser`): the delay is an exact integer or a
 * range `min-max` / `min-` / `-max`, optionally negated with `!`. Omitted = any delay.
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
    // Unparseable: uBO falls back to a default value; we match anything (blocks more).
    test = () => true;
  }

  return negate ? (delay) => !test(delay) : test;
}

/**
 * Safety gate for `set-constant`: never overwrite a real object/function with a primitive.
 *
 * uBO rejects on any `typeof` mismatch (even number↔boolean); we narrow that to
 * "object/function ↔ primitive", which still catches the cases that break pages (replacing
 * a site's config object with `false`) without defeating filters that intend `1 → false`.
 * This is an intentional deviation, recorded here.
 */
function wouldBreakShape(existing: unknown, next: unknown): boolean {
  const isObj = (v: unknown): boolean => v !== null && (typeof v === 'object' || typeof v === 'function');
  const existingNullish = existing === null || existing === undefined;
  const nextNullish = next === null || next === undefined;
  if (existingNullish || nextNullish) return false;
  return isObj(existing) !== isObj(next);
}

/** Abort error. An Error (not a thrown string) so the page's catch can identify it. */
function makeAbortError(what: string): Error {
  const err = new Error(`adblow: aborted ${what}`);
  err.name = 'ReferenceError';
  return err;
}

/**
 * Run a batch of scriptlet invocations. `win` is the target window (tests pass a jsdom
 * window).
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
      // No exception may ever escape to the page.
      failed.push({ canonical: inv.canonical, error: String(error).slice(0, 120) });
    }
  }

  return { applied, failed };
}

function applyOne(inv: Invocation, win: Record<string, unknown>): boolean {
  const { canonical, args } = inv;

  switch (canonical) {
    case 'set-constant': {
      const [path, rawValue] = args;
      if (!path) return false;
      const target = resolvePath(win, path);
      if (!target) return false;
      const value = constantValue(rawValue ?? '');
      // Gate: never overwrite a real object/function with a primitive (see wouldBreakShape).
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

    // uBO semantics (verified in its source): deletes the property, then defines a
    // setter-only one — so reads yield undefined and only writes throw.
    case 'abort-on-property-write': {
      const [path, needle] = args;
      if (!path) return false;
      const target = resolvePath(win, path);
      if (!target) return false;
      const matches = needle ? makeMatcher(needle) : () => true;
      try {
        delete target.owner[target.prop];
      } catch {
        /* If undeletable, carry on; defineTrap below covers it */
      }
      defineTrap(target.owner, target.prop, {
        set: (v: unknown) => {
          if (matches(String(v))) throw makeAbortError(path);
        },
      });
      return true;
    }

    // uBO semantics: `(needle, delay?)` — needle matches the callback source, delay is an
    // exact value or a range (see makeDelayMatcher). Both must match to block.
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
            // uBO substitutes a no-op callback; the call still happens, the timer is
            // still scheduled.
            return (original as (...a: unknown[]) => unknown).call(
              this,
              () => undefined,
              timeout,
              ...rest,
            );
          }
        } catch {
          /* ignore, pass through unchanged */
        }
        return (original as (...a: unknown[]) => unknown).call(this, handler, timeout, ...rest);
      };
      win[fnName] = patched;
      return true;
    }

    // prevent-addEventListener (alias aeld; 206 measured rules).
    // uBO semantics: proxies `EventTarget.prototype.addEventListener` and drops the
    // listener only when both the event type and the handler source match.
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
            return undefined; // drop this listener
          }
        } catch {
          /* ignore */
        }
        return (original as (...a: unknown[]) => unknown).call(this, type, handler, ...rest);
      };
      return true;
    }

    // uBO matches the joined call arguments (`callArgs.join(' ')`), not just the URL —
    // ads often put the payload in windowName/features.
    case 'no-window-open-if': {
      const [needle] = args;
      const original = win.open;
      if (typeof original !== 'function') return false;
      const matches = makeMatcher(needle ?? '');
      win.open = function patched(this: unknown, ...callArgs: unknown[]): unknown {
        try {
          if (matches(callArgs.map((a) => String(a ?? '')).join(' '))) return null;
        } catch {
          /* ignore */
        }
        return (original as (...a: unknown[]) => unknown).apply(this, callArgs);
      };
      return true;
    }

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
            // Must not throw: some environments have no Response constructor (measured:
            // jsdom), and the exception would escape to the page, breaking the "no
            // exception may escape" discipline.
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
          /* pass through if the matcher fails */
        }
        return (original as (...a: unknown[]) => unknown).call(this, input, ...rest);
      };
      return true;
    }

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
          /* ignore */
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
          /* ignore */
        }
        return result;
      };
      return true;
    }

    // uBO semantics (verified in its source): `(key, value, ...varargs)`. When value is
    // `$remove$` the key is treated as a string/regex pattern and ALL matching keys are
    // removed, not one literal key. Measured:
    //   `set-local-storage-item, /sc_tracking_anonymous_id|statsig/, $remove$`
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
        // localStorage is disabled in some contexts
        return false;
      }
    }

    // The first argument is a matcher (string or `/regex/`), not a literal cookie name.
    // Measured: `remove-cookie, /sc_anonymous_id|sc_tracking_anonymous_id/` — an earlier
    // implementation treated it literally and wrote a cookie named `/sc_.../`.
    case 'remove-cookie': {
      const [needle] = args;
      if (!needle) return false;
      const doc = win.document as Document | undefined;
      if (!doc) return false;
      const matches = makeMatcher(needle);
      const host = (win.location as Location | undefined)?.hostname ?? '';

      // Pick matching names from the existing cookies (script-readable ones only).
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
            /* ignore individual failures */
          }
        }
      }
      return true;
    }

    default:
      return false;
  }
}
