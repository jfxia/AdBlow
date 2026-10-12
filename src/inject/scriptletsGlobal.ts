/**
 * 脚本注入引擎的 MAIN world 入口（构建期由 Rollup 打成 `scriptlets-engine.js`）。
 *
 * 设计要点：**引擎与数据分离**。
 *   - 本文件（引擎）随 manifest 声明为 `<all_urls>`，只负责实现与分发
 *   - 构建期生成的 `scriptlets/bundle-N.js` 只含**该组域名的规则表**，
 *     由 manifest 声明为匹配那批域名 —— 浏览器保证只在相关站点注入
 *
 * 为什么这样分：脚本必须在 `document_start`、**页面脚本之前**执行完毕。
 * 如果靠内容脚本向 SW 取数据再执行，就会与页面脚本产生竞态（SW 消息是异步的）。
 * 由 manifest 声明匹配域名、浏览器直接注入，就没有竞态。
 * uBlock Origin Lite 用的是同一套机制。
 */
import { domainKeysForHost } from '../engine/filterList/cosmetic.ts';
import { runScriptlets, type Invocation } from './scriptlets.ts';

export type ScriptletTable = Record<string, Invocation[]>;

/**
 * 按主机名从规则表里取出要执行的调用并执行。
 *
 * 语义与 cosmetic 层一致：沿各级父域向上收集（`a.b.com` → `a.b.com`、`b.com`、`com`），
 * 并支持通配 TLD 键（`ticketmaster.*`）。
 */
export function runTable(table: ScriptletTable, host: string): number {
  const invocations: Invocation[] = [];
  for (const key of domainKeysForHost(host)) {
    const list = table[key];
    if (!list) continue;
    for (const inv of list) invocations.push(inv);
  }
  if (invocations.length === 0) return 0;

  const result = runScriptlets(invocations, window as unknown as Record<string, unknown>);
  try {
    console.debug(
      `[adblow] 脚本注入：执行 ${result.applied.length}/${invocations.length}` +
        (result.failed.length
          ? `，失败 ${result.failed.length}（${result.failed
              .slice(0, 3)
              .map((f) => `${f.canonical}:${f.error}`)
              .join(' | ')}）`
          : ''),
    );
  } catch {
    /* console 不可用也要静默 */
  }
  return result.applied.length;
}

// 暴露给构建期生成的 bundle 文件调用
(window as unknown as Record<string, unknown>).__adblowScriptlets = { run: runTable };
