/**
 * Minimal key/value store.
 *
 * Learned rules, site switches and stats all go through it. `chrome.*` appears
 * only in the adapter, so all three work under Node + jsdom.
 */

export interface KvStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** chrome.storage.local adapter (browser side). */
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

/** In-memory implementation for tests. */
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
