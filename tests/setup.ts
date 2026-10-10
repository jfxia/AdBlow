/**
 * 测试环境引导：把 jsdom 的 DOM 挂到 Node 全局。
 *
 * 为什么不用 Vitest：本沙箱禁止命名管道，Vite 在 Windows 上会调
 * exec('net use') 探测网络驱动器（optimizeSafeRealPathSync），
 * 该 exec 因管道受限抛 spawn EPERM，导致 Vite/Vitest 配置加载阶段即失败。
 * 同理 `node --test` 会为每个测试文件 spawn 子进程，也不可用。
 * 因此测试走「单进程内 `node tests/run-all.ts`」路线：零子进程。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://afford.gjvrohros.cc/',
  pretendToBeVisual: true,
});

const target = globalThis as unknown as Record<string, unknown>;
const source = dom.window as unknown as Record<string, unknown>;

const KEYS = [
  'window',
  'document',
  'Element',
  'HTMLElement',
  'HTMLAnchorElement',
  'HTMLImageElement',
  'Node',
  'NodeList',
  'DocumentFragment',
  'Text',
  'Comment',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'MutationObserver',
  'DOMRect',
  'DOMParser',
  'CSS',
  'getComputedStyle',
  'location',
  'navigator',
  'history',
] as const;

for (const key of KEYS) {
  const value = source[key];
  if (value === undefined) continue;
  try {
    target[key] = value;
  } catch {
    // Node 24 的 navigator/location 是只读 getter，跳过即可；
    // 这些全局在本阶段的纯引擎测试里用不到。
  }
}
