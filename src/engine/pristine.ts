/**
 * Server-rendered snapshot index.
 *
 * Counted 2026-10-10: the `data-ssp-*` overlay/fullscreen/marquee markers occur 0
 * times in server HTML and are always SDK-created, while container/slot-node exist as
 * empty placeholders — so absence from the snapshot is a reliable injection signal.
 * The signature uses only the node's own attributes, since the SDK fills placeholders.
 */

/** Runtime-changing or lazily backfilled attributes; excluded from the signature. */
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
  /** signature → occurrence count */
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
 * Whether the node was injected at runtime.
 *
 * Counted by signature: with 10 identical empty placeholders server-side, the 11th
 * identical node is judged injected — the intent, since the server never
 * duplicates placeholders.
 */
export function isInjected(el: Element, index: PristineIndex): boolean {
  return (index.counts.get(nodeSignature(el)) ?? 0) === 0;
}

/**
 * Build the snapshot index from server HTML text. At `document_start` the DOM is
 * nearly empty, so a local index is untrustworthy, and server-rendered outbound-link
 * boxes already score 8 (over the threshold of 6) — separating rendered from injected
 * is what keeps the heuristic safe there. Backfilling costs one same-origin request per
 * page, so it runs only when no site pack matched (src/content/index.ts).
 */
export function buildPristineIndexFromHtml(html: string, parser: DOMParser): PristineIndex {
  const doc = parser.parseFromString(html, 'text/html');
  return buildPristineIndex(doc.documentElement);
}
