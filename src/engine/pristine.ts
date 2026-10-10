/**
 * 服务端快照索引。
 *
 * 设计依据（设计文档 §1.3，2026-10-10 实测计数）：
 *   data-ssp-slot-root / data-ssp-sdk-popup-overlay / data-ssp-sdk-fullscreen /
 *   data-ssp-marquee* 在服务端 HTML 中出现次数均为 0，全部由 SDK 运行时创建；
 *   而 data-ssp-container / data-ssp-slot-node 在服务端就存在（空占位符）。
 *
 * 因此「不在快照里」是可靠的注入信号。但签名必须**只比对节点自身属性**：
 * SDK 会填充既有占位符，若把子节点算进签名，会把「填充」误判成「注入」。
 */

/** 运行时会变、或由懒加载回填的属性，不参与签名。 */
const VOLATILE_ATTRS = new Set(['style', 'src', 'srcset', 'data-src', 'width', 'height']);

export function nodeSignature(el: Element): string {
  const attrs = Array.from(el.attributes)
    .filter((a) => !VOLATILE_ATTRS.has(a.name) && !a.name.startsWith('data-v-'))
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(';');
  return `${el.tagName.toLowerCase()}|${attrs}`;
}

export type PristineIndex = {
  /** 签名 → 出现次数 */
  counts: Map<string, number>;
  builtAt: number;
};

export function buildPristineIndex(root: ParentNode): PristineIndex {
  const counts = new Map<string, number>();

  const walk = (n: ParentNode): void => {
    for (const child of Array.from(n.children)) {
      const sig = nodeSignature(child);
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
      walk(child);
    }
  };

  walk(root);
  return { counts, builtAt: Date.now() };
}

/**
 * 判断节点是否为运行时注入。
 *
 * 按签名计数：服务端存在 10 个同签名空占位符时，第 11 个同签名节点会被判为
 * 注入——这正是期望行为，占位符不会被服务端复制。
 */
export function isInjected(el: Element, index: PristineIndex): boolean {
  return (index.counts.get(nodeSignature(el)) ?? 0) === 0;
}
