/**
 * 过滤列表 cosmetic 选择器的注入与**内容守卫**（第二期）。
 *
 * ## 为什么单独成模块
 *
 * 这一层来自社区维护的列表、覆盖上万个域名，与「站点规则包选择器」不同：
 * 规则包经逐站取证 + fixture 回归，可以直接进样式表；列表选择器必须过守卫。
 *
 * 而这里**唯一关乎安全**的逻辑是内容守卫，它必须能被测试。
 * 因此把它从内容脚本里抽出来，document 由调用方注入，可在 jsdom 里回归。
 *
 * ## 两类必须挡掉的选择器
 *
 * 1. **会隐藏正文的**：本项目的不变量是「任何来源的规则都不得隐藏装着正文的
 *    元素」。列表里偶尔会有过宽的规则（例如命中 `article` 的伪装成广告容器的
 *    类名），放进去就是"整站内容消失"。
 * 2. **非法的**：一条非法选择器会让**整张样式表**的规则被浏览器丢弃
 *    （实测：1466 条非法选择器在构建期就被滤掉了，但运行期仍要兜底）。
 */

export const LIST_COSMETIC_ATTR = 'data-adblow-list-cosmetic';

import { looksLikeValidSelector } from '../engine/filterList/cosmetic.ts';

export type ListCosmeticResult = {
  /** 最终注入的选择器条数 */
  injected: number;
  /** 因会隐藏正文被剔除的选择器 */
  droppedForContent: string[];
  /** 因选择器非法被剔除的 */
  droppedInvalid: string[];
};

/**
 * 把选择器注入成样式表，并返回守卫结果。
 *
 * @param doc          目标文档（测试时传 jsdom document）
 * @param selectors    候选选择器
 * @param holdsContent 判断"元素里装着正文吗"的谓词，由调用方注入
 */
export function applyListCosmetic(
  doc: Document,
  selectors: string[],
  holdsContent: (el: Element) => boolean,
): ListCosmeticResult {
  const droppedForContent: string[] = [];
  const droppedInvalid: string[] = [];

  if (selectors.length === 0) {
    return { injected: 0, droppedForContent, droppedInvalid };
  }

  const safe = selectors.filter((sel) => {
    // 先做便宜的语法粗筛：不同浏览器对非法选择器的宽容度不一样
    // （实测 jsdom 对 `div{class:red}` 不抛异常），所以不能只靠 try/catch。
    if (!looksLikeValidSelector(sel)) {
      droppedInvalid.push(sel);
      return false;
    }

    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(sel));
    } catch {
      // 非法选择器会把整张样式表带崩，必须挡在外面
      droppedInvalid.push(sel);
      return false;
    }
    for (const el of matches) {
      if (holdsContent(el)) {
        droppedForContent.push(sel);
        return false;
      }
    }
    return true;
  });

  // 找到或创建样式元素
  let style = doc.querySelector(`style[${LIST_COSMETIC_ATTR}]`) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.setAttribute(LIST_COSMETIC_ATTR, '');
    (doc.head ?? doc.documentElement).appendChild(style);
  }
  style.textContent = safe.map((s) => `${s}{display:none!important;}`).join('');

  return {
    injected: safe.length,
    droppedForContent,
    droppedInvalid,
  };
}
