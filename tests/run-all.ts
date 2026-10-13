/**
 * Single-process test entry point. setup.ts is imported statically so ESM evaluates
 * it before the dynamic imports below; then every *.test.ts under tests/unit and
 * tests/integration is discovered and imported. Usage: node tests/run-all.ts.
 *
 * Not `node --test`: the sandbox forbids child-process pipes and `node --test`
 * spawns a piped child per test file, which fails with EPERM. Importing in-process
 * spawns nothing.
 */
import './setup.ts';

import { readdirSync } from 'node:fs';

const dirs = ['./unit/', './integration/'];

let count = 0;

for (const d of dirs) {
  const dir = new URL(d, import.meta.url);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort();
  } catch {
    continue;
  }
  count += files.length;
  for (const f of files) {
    await import(new URL(f, dir).href);
  }
}

if (count === 0) {
  console.error('没有发现任何测试文件');
  process.exit(1);
}
