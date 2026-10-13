/**
 * Test bootstrap: installs jsdom's DOM onto Node globals.
 *
 * No Vitest: the sandbox forbids named pipes, and Vite's network-drive probe
 * (`exec('net use')` in optimizeSafeRealPathSync) fails with spawn EPERM on Windows,
 * so config loading dies. `node --test` is unusable for the same reason (one child
 * process per test file), hence the single-process `node tests/run-all.ts` route.
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
    // Node 24 exposes navigator/location as read-only getters; these tests don't need them.
  }
}
