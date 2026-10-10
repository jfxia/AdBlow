/**
 * 单进程测试入口。
 *
 * 先静态导入 setup.ts（ESM 会保证它在下方动态导入之前求值），
 * 再自动发现并导入 tests/unit 下所有 *.test.ts。
 *
 * 用法：node tests/run-all.ts
 * 退出码由 node:test 汇总，失败非零。
 */
import './setup.ts';

import { readdirSync } from 'node:fs';

const dir = new URL('./unit/', import.meta.url);

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

if (files.length === 0) {
  console.error('没有发现任何测试文件');
  process.exit(1);
}

for (const f of files) {
  await import(new URL(f, dir).href);
}
