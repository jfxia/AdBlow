/**
 * 异步工具。
 */

/**
 * 给 Promise 加超时，超时返回 null 而不是抛出。
 *
 * 用于**可选增强**类调用：例如快照回填要由 service worker 再抓一次整页，
 * 实测会偶发长时间不返回。没有超时的话整条启动流程会卡在那里，
 * 而调用方本来就能在没有它的情况下正常工作。
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
