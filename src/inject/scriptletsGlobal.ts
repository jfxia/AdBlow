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

/** 解码单个条目体（`名字下标 \x01 参数… \x02 …`）。 */
export function decodeEntry(names: string[], body: string): Invocation[] {
  const invocations: Invocation[] = [];
  for (const raw of body.split('\x02')) {
    if (!raw) continue;
    const parts = raw.split('\x01');
    const canonical = names[Number(parts[0])];
    if (!canonical) continue;
    invocations.push({ canonical, args: parts.slice(1) });
  }
  return invocations;
}

/** 全量解码（测试与可读性用；运行期走 runPacked 的惰性路径）。 */
export function decodePacked(namesJoined: string, data: string): Map<string, Invocation[]> {
  const map = new Map<string, Invocation[]>();
  if (!data) return map;
  const names = namesJoined ? namesJoined.split('\x01') : [];
  for (const entry of data.split('\x04')) {
    if (!entry) continue;
    const sep = entry.indexOf('\x03');
    if (sep < 0) continue;
    const invocations = decodeEntry(names, entry.slice(sep + 1));
    if (invocations.length) map.set(entry.slice(0, sep), invocations);
  }
  return map;
}

/**
 * 纯查表：按主机名从紧凑表里选出调用（不做任何执行）。
 *
 * 单独抽出来是为了**可测**：执行部分要用到 `window`，而查表逻辑
 * （尤其是边界字符防误命中）是这套编码里最容易出错的地方。
 */
export function selectPacked(namesJoined: string, data: string, host: string): Invocation[] {
  const names = namesJoined ? namesJoined.split('\x01') : [];
  const invocations: Invocation[] = [];

  for (const key of domainKeysForHost(host)) {
    const start = data.indexOf(`\x04${key}\x03`);
    if (start < 0) continue;
    const bodyStart = start + key.length + 2;
    const end = data.indexOf('\x04', bodyStart);
    invocations.push(
      ...decodeEntry(names, data.slice(bodyStart, end < 0 ? data.length : end)),
    );
  }

  return invocations;
}

/**
 * 按主机名从紧凑表里取调用并执行；返回实际执行的条数。
 *
 * ## 为什么是"惰性查表"而不是先建 Map
 *
 * 数据表 277 KB。如果每个页面（而且是每个 iframe）都先全量解码成 Map，
 * 就要建 2,800 多个字符串与对象 —— 广告重的页面有十几个 iframe 时，
 * 这个开销会从"加载扩展时卡死一次"变成"每个页面都卡一下"，
 * 只是把问题搬了个地方。
 *
 * 所以：用原生 `indexOf` 带**边界字符**在字符串里定位（几十微秒），
 * 只有真的命中该主机名时才解码那一条。
 * 边界字符（`\x04` 前导、`\x03` 收尾）保证 `a.com` 不会命中 `b.a.com`。
 */
export function runPacked(namesJoined: string, data: string, host: string): number {
  return execute(selectPacked(namesJoined, data, host));
}

/** 按主机名从规则表里取出要执行的调用并执行。 */
export function runTable(table: ScriptletTable, host: string): number {
  const invocations: Invocation[] = [];
  for (const key of domainKeysForHost(host)) {
    const list = table[key];
    if (!list) continue;
    for (const inv of list) invocations.push(inv);
  }
  return execute(invocations);
}

function execute(invocations: Invocation[]): number {
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
(window as unknown as Record<string, unknown>).__adblowScriptlets = {
  run: runTable,
  runPacked,
};
