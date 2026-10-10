/**
 * 单进程测试入口。
 *
 * 先静态导入 setup.ts（ESM 会保证它在下方动态导入之前求值），
 * 再自动发现并导入 tests/unit 与 tests/integration 下所有 *.test.ts。
 *
 * 用法：node tests/run-all.ts
 * 退出码由 node:test 汇总，失败非零。
 *
 * 为什么不用 `node --test`：本沙箱禁止子进程管道，而 `node --test` 会为每个
 * 测试文件 spawn 一个子进程（piped stdio）并抛 EPERM。直接 `node 本文件` 是
 * 在当前进程内执行，零 spawn。
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
