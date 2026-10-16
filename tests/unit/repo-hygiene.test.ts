import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 守卫：仓库里不能出现未解决的合并冲突标记。
 *
 * 起因是真实的：一次未完成的合并被提交上来，README.zh-CN.md 里留下了
 * `<<<<<<< HEAD` / `=======` / `>>>>>>>`，发布到 GitHub 后那一行 `=======`
 * 被 Markdown 当成 setext 标题语法，把上一行渲染成大标题——页面看着就是"格式乱了"。
 * 这类问题肉眼看 diff 很容易漏，所以让测试盯着。
 *
 * 只需扫文本文件；二进制与构建产物跳过。
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-release', 'release', 'filters', '_probe', 'store']);
const TEXT_EXT = new Set([
  '.ts', '.mjs', '.js', '.json', '.md', '.html', '.css', '.txt',
  '.py', '.yml', '.yaml', '.d.mts', '.gitignore',
]);

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push(rel);
  }
  return out;
}

const root = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = walk(root).filter((f) => {
  const name = f.split('/').pop() ?? '';
  if (name === 'LICENSE') return true;
  const dot = name.lastIndexOf('.');
  return dot > 0 && TEXT_EXT.has(name.slice(dot));
});

describe('仓库卫生', () => {
  it('没有未解决的合并冲突标记', () => {
    const offenders: string[] = [];
    for (const rel of files) {
      let body: string;
      try {
        body = readFileSync(join(root, rel), 'utf8');
      } catch {
        continue;
      }
      body.split(/\r?\n/).forEach((line, i) => {
        // 冲突标记在行首：`<<<<<<< ` / `>>>>>>> ` 后跟分支名或提交号
        if (/^(<{7}|>{7})\s/.test(line)) offenders.push(`${rel}:${i + 1}  ${line.slice(0, 40)}`);
        // `=======` 单独成行本身不违规（可能是分隔线），但同文件出现冲突标记就是冲突块
        if (/^={7}$/.test(line) && /^(<{7}|>{7})\s/m.test(body)) {
          offenders.push(`${rel}:${i + 1}  =======（冲突块内）`);
        }
      });
    }
    assert.deepEqual(offenders, [], `发现未解决的合并冲突标记：\n  ${offenders.join('\n  ')}`);
  });

  it('LICENSE 与 LICENSE-MIT 都在且内容完整', () => {
    const gpl = readFileSync(join(root, 'LICENSE'), 'utf8');
    assert.ok(gpl.includes('GNU GENERAL PUBLIC LICENSE'), 'LICENSE 不是 GPL 正文');
    assert.ok(gpl.includes('Version 3, 29 June 2007'), 'LICENSE 不是 GPL-3.0');
    assert.ok(gpl.includes('END OF TERMS AND CONDITIONS'), 'LICENSE 正文不完整');

    const mit = readFileSync(join(root, 'LICENSE-MIT'), 'utf8');
    assert.ok(mit.includes('MIT License'), 'LICENSE-MIT 缺失 MIT 标题');
    assert.ok(mit.includes('Permission is hereby granted'), 'LICENSE-MIT 正文不完整');
  });

  it('文档里不用第二人称（统一"用户 / users"式的第三人称叙述）', () => {
    /**
     * 这是刻意的文风要求，不是自动检查的洁癖：公开文档用第三人称叙述，
     * 读起来更像产品说明，而不是对着某一个人讲话。
     * 只查 Markdown 文档 —— 界面文案（_locales）里出现第二人称是正常的，
     * 那里面对的就是正在使用扩展的人。
     */
    const docs = files.filter((f) => f.endsWith('.md'));
    const second = /\b(you|your|yours|yourself|you're|you'll)\b|[你您]/i;
    const offenders: string[] = [];
    for (const rel of docs) {
      const body = readFileSync(join(root, rel), 'utf8');
      body.split(/\r?\n/).forEach((line, i) => {
        const m = second.exec(line);
        if (m) offenders.push(`${rel}:${i + 1}  “${m[0]}”  ${line.trim().slice(0, 60)}`);
      });
    }
    assert.deepEqual(offenders, [], `文档里出现第二人称：\n  ${offenders.join('\n  ')}`);
  });
});
