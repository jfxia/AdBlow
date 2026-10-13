/**
 * Resolve to null instead of rejecting when the promise stalls past `ms`.
 * For optional enhancements: the pristine backfill can hang, and without a
 * timeout the whole startup sequence would stall with it.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
