/**
 * Failure-tolerant wrappers for the MAIN-world patches.
 *
 * Why these exist: every wrapper here stands in front of a built-in the page also calls, and each
 * one does something the real API never does — it reads a listener's source text, walks property
 * descriptors, parses a `window.open` target. A page is free to pass a Proxy, a function whose
 * `toString` was replaced, or an object with a throwing `handleEvent` getter; the native API reads
 * none of that and accepts the call. Measured: two such shapes made the exception escape through
 * `addEventListener` and abort the caller's own initialisation, which the page never expected.
 *
 * Rule for every wrapper: **an observation failure must degrade to the native behaviour**. The
 * wrapper is a guard, not a gate: if it cannot decide, the page gets exactly what the browser
 * would have given it. The only thing that is ever withheld is a decision the guard actually
 * reached.
 *
 * Logging is one-shot per failure site (`makeFailureReporter`): these wrappers run on hot paths,
 * and a page that trips one on every call must not be flooded with console output.
 */

/** Report one internal failure; implementations print at most once per site. */
export type ReportFailure = (site: string) => void;

/** One `console.debug` per failure site, ever. */
export function makeFailureReporter(
  log: (line: string) => void = (line) => {
    console.debug(line);
  },
): ReportFailure {
  const seen = new Set<string>();
  return (site) => {
    if (seen.has(site)) return;
    seen.add(site);
    try {
      log(`[adblow] ${site} 守卫内部异常，已退化为原生行为`);
    } catch {
      // A failing logger must not become the page's error either.
    }
  };
}

/**
 * Run a yes/no decision; a throw means "do not intervene".
 *
 * Used where "no" is the native behaviour (keeping an inline handler, keeping a listener).
 */
export function safeVerdict(decide: () => boolean, report: ReportFailure, site: string): boolean {
  try {
    return decide() === true;
  } catch {
    report(site);
    return false;
  }
}

type NativeAddEventListener = (
  this: unknown,
  type: unknown,
  listener: unknown,
  options?: unknown,
) => unknown;

/**
 * Wrap `EventTarget.prototype.addEventListener`.
 *
 * `classify` returns a reason string to drop the registration, or null to keep it. Any failure —
 * in the classifier, or in `onDrop` — is swallowed and the listener is registered natively.
 */
export function guardAddEventListener(
  original: NativeAddEventListener,
  classify: (target: unknown, type: string, listener: unknown) => string | null,
  onDrop: (reason: string, type: string) => void,
  report: ReportFailure,
): NativeAddEventListener {
  return function patched(
    this: unknown,
    type: unknown,
    listener: unknown,
    options?: unknown,
  ): unknown {
    try {
      const reason = classify(this, String(type ?? ''), listener);
      if (reason) {
        try {
          onDrop(reason, String(type ?? ''));
        } catch {
          // The decision stands even if reporting it failed.
        }
        return undefined;
      }
    } catch {
      report('addEventListener');
    }
    return original.call(this, type, listener, options);
  };
}

type NativeOpen = (this: unknown, ...args: unknown[]) => unknown;

/** What `window.open` should do with one call. `onBlock` runs before the refusal returns. */
export type OpenVerdict = { allow: boolean; onBlock?: () => void };

/**
 * Wrap `window.open`.
 *
 * A failing decision means the window opens as the browser would have opened it; only a decision
 * the guard actually reached can refuse it.
 */
export function guardWindowOpen(
  original: NativeOpen,
  decide: (...args: unknown[]) => OpenVerdict,
  report: ReportFailure,
): NativeOpen {
  return function patched(this: unknown, ...args: unknown[]): unknown {
    try {
      const verdict = decide(...args);
      if (!verdict.allow) {
        try {
          verdict.onBlock?.();
        } catch {
          // The refusal stands even if logging it failed.
        }
        return null;
      }
    } catch {
      report('window.open');
    }
    return Reflect.apply(original, this, args);
  };
}

type NativeSetter = (this: object, value: unknown) => unknown;

/**
 * Wrap an `on*` property setter.
 *
 * A failing verdict installs the handler exactly as the platform would; the exception never
 * reaches the page that assigned it.
 */
export function guardPropertySetter(
  setter: NativeSetter,
  isHijack: (value: unknown) => boolean,
  onDrop: (value: unknown) => void,
  report: ReportFailure,
): NativeSetter {
  return function patched(this: object, value: unknown): unknown {
    try {
      if (isHijack(value)) {
        try {
          onDrop(value);
        } catch {
          // The decision stands even if logging it failed.
        }
        return undefined;
      }
    } catch {
      report('on* 设置器');
    }
    return setter.call(this, value);
  };
}
