/**
 * 最小键值存储抽象。
 *
 * 自学习规则、站点开关、统计都走它；`chrome.*` 只出现在适配器里，
 * 因此这三块逻辑都能在 Node + jsdom 里直接测。
 */

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** chrome.storage.local 适配器（浏览器侧）。 */
export function chromeLocal(): KvStore {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const all = (await chrome.storage.local.get(key)) as Record<string, T | undefined>;
      return all[key];
    },
    async set(key: string, value: unknown): Promise<void> {
      await chrome.storage.local.set({ [key]: value });
    },
    async remove(key: string): Promise<void> {
      await chrome.storage.local.remove(key);
    },
    async keys(): Promise<string[]> {
      return Object.keys(await chrome.storage.local.get(null));
    },
  };
}

/** 内存实现，供测试使用。 */
export function memoryStore(initial: Record<string, unknown> = {}): KvStore {
  const data: Record<string, unknown> = { ...initial };
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      data[key] = value;
    },
    async remove(key: string): Promise<void> {
      delete data[key];
    },
    async keys(): Promise<string[]> {
      return Object.keys(data);
    },
  };
}
