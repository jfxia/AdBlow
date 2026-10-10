import { isInjected, type PristineIndex } from '../engine/pristine.ts';
import { scoreNode } from '../engine/score.ts';
import { generalizeSelector, isSelectorSafe } from '../engine/selector.ts';
import { validateSitePack, type SitePack } from '../engine/rules.ts';

/**
 * 内容脚本的逻辑核心。
 *
 * 刻意不碰 chrome.* 与全局 document：DOM 由调用方传入，判定时机由调用方决定。
 * 这样核心逻辑能在 Node + jsdom 里完整回归，chrome 接线只剩薄薄一层。
 */

export const SCORE_THRESHOLD = 6;

export type Rejection = { packId: string; problems: string[] };

export type Hit = {
  /**
   * 泛化后的选择器；为 null 表示没有稳定特征可泛化。
   * 此时元素仍会被隐藏，但**不产出规则** —— 见 src/engine/selector.ts 的说明。
   */
  selector: string | null;
  score: number;
  reasons: string[];
};

/**
 * 从命中里筛出可安全入库的选择器。
 *
 * 两道闸门：泛化器已挡住裸标签名（返回 null），这里再做宽度实测——
 * 选择器必须在当前文档里命中不超过 maxMatches 个元素，否则丢弃。
 * 自学习规则会进入静态规则集并**无条件生效**，所以入库前必须保守。
 */
export function recordableSelector(
  hit: Hit,
  root: ParentNode,
  maxMatches = 30,
): string | null {
  if (!hit.selector) return null;
  return isSelectorSafe(hit.selector, root, maxMatches) ? hit.selector : null;
}

export type InjectionTest = (el: Element) => boolean;

/**
 * 默认的注入判定。
 *
 * ⚠️ 这里的 `reliable` 不是保守开关，是**实测必需的**（2026-10-10 标定）：
 *
 * `document_start` 时页面才刚开始解析，就地构建的快照索引几乎为空，不可信。
 * 而本站服务端 HTML 里就有紧凑外链盒子（`.contact-link`、`footer#footer`、
 * `div.container`）广告度达到 8 分，超过阈值 6 —— 用不可信快照跑启发式，
 * 必然误伤这三处；把阈值抬到 10 又会丢掉「跨站链接 + 推广参数」这条最有价值
 * 的通用检测。
 *
 * 因此：
 *   - `reliable === false`：启发式**整体关闭**，只留静态规则（精确锚点，安全）
 *   - `reliable === true` ：快照来自完整服务端 HTML，按签名精确区分注入节点
 *
 * 快照回填见 src/engine/pristine.ts 的 buildPristineIndexFromHtml 与
 * src/content/index.ts 的 PRISTINE_STRATEGY。
 */
export function makeInjectionTest(index: PristineIndex, reliable: boolean): InjectionTest {
  return (el: Element) => reliable && isInjected(el, index);
}

/**
 * 汇总要隐藏的选择器：自学习优先，规则包其次。
 *
 * 被误伤护栏拒绝的规则包整包丢弃（而不是只用它的部分选择器）——
 * 一条被拒绝的规则说明这个包本身有问题，部分采用反而更危险。
 */
export function selectorsFrom(
  packs: SitePack[],
  learned: string[],
  onReject?: (r: Rejection) => void,
): string[] {
  const out = new Set<string>(learned);

  for (const pack of packs) {
    const problems = validateSitePack(pack);
    if (problems.length) {
      onReject?.({ packId: pack.id, problems });
      continue;
    }
    for (const s of pack.cosmetic) out.add(s);
  }

  return [...out];
}

/**
 * 造一个启发式判定器。
 *
 * 两道闸门缺一不可：
 *   1. 必须像运行时注入 —— 否则会顺着行为特征误伤服务端正文
 *   2. 广告度必须过阈值 —— 否则所有动态内容都会被误伤
 */
export function createJudge(
  injected: InjectionTest,
  host: string,
  viewportArea: number,
  threshold: number = SCORE_THRESHOLD,
): (el: Element) => Hit | null {
  return (el: Element): Hit | null => {
    if (!injected(el)) return null;

    const { score, reasons } = scoreNode(el, { pageHost: host, viewportArea });
    if (score < threshold) return null;

    return { selector: generalizeSelector(el), score, reasons };
  };
}

/**
 * 用内联样式隐藏。
 *
 * 为什么不用样式表：内联 `!important` 在作者源里优先级最高，不会被站点后续
 * 插进来的 `!important` 规则反制。样式表只是防闪现的第一道便宜防线。
 */
export function hideElement(el: Element): void {
  el.setAttribute('data-adblow-hidden', '1');
  const style = (el as HTMLElement).style;
  if (!style) return;
  style.setProperty('display', 'none', 'important');
  style.setProperty('height', '0', 'important');
  style.setProperty('margin', '0', 'important');
  style.setProperty('padding', '0', 'important');
}

export function isHidden(el: Element): boolean {
  return el.getAttribute('data-adblow-hidden') === '1';
}

/** 生成防闪现用的样式表内容。 */
export function cosmeticCss(selectors: string[]): string {
  return selectors
    .map(
      (s) =>
        `${s}{display:none !important;height:0 !important;margin:0 !important;padding:0 !important;}`,
    )
    .join('\n');
}

/**
 * 元素是否命中静态规则选择器。
 *
 * 合并成一个选择器一次 matches()，比逐个匹配快；合并串非法时退回逐个试，
 * 保证一条写坏的选择器不会让整个规则包失效。
 */
export function matchesAny(el: Element, selectors: string[]): boolean {
  if (selectors.length === 0) return false;
  try {
    return el.matches(selectors.join(','));
  } catch {
    return selectors.some((s) => {
      try {
        return el.matches(s);
      } catch {
        return false;
      }
    });
  }
}

export type Verdict = { kind: 'rule' } | { kind: 'heuristic'; hit: Hit };

export type JudgeOptions = {
  injected: InjectionTest;
  host: string;
  viewportArea: number;
  selectors: string[];
  threshold?: number;
};

/**
 * 判定单个元素：先静态规则（精确锚点），再启发式。
 *
 * 静态规则**不做**注入判定 —— 选择器本身就是精确锚点，试点站规则包里每个
 * 选择器都经过误伤护栏与真实 fixture 回归（见 tests/unit/pilot-pack.test.ts）。
 */
export function judgeElement(el: Element, options: JudgeOptions): Verdict | null {
  if (isHidden(el)) return null;
  if (matchesAny(el, options.selectors)) return { kind: 'rule' };

  const hit = createJudge(options.injected, options.host, options.viewportArea, options.threshold)(el);
  return hit ? { kind: 'heuristic', hit } : null;
}

/** 判定并应用隐藏。 */
export function applyVerdict(el: Element, verdict: Verdict | null): Verdict | null {
  if (!verdict) return null;
  hideElement(el);
  return verdict;
}

export type SweepResult = {
  hiddenByRule: number;
  hiddenByHeuristic: number;
  hits: Hit[];
};

/** 扫一遍整棵子树（不含 root 自身）。 */
export function sweep(root: ParentNode, options: JudgeOptions): SweepResult {
  const result: SweepResult = { hiddenByRule: 0, hiddenByHeuristic: 0, hits: [] };

  for (const el of Array.from(root.querySelectorAll('*'))) {
    // 已被祖先隐藏的整棵子树不必再判，省时也避免重复计数
    if (isHidden(el)) continue;
    const verdict = applyVerdict(el, judgeElement(el, options));
    if (!verdict) continue;
    if (verdict.kind === 'rule') result.hiddenByRule += 1;
    else {
      result.hiddenByHeuristic += 1;
      result.hits.push(verdict.hit);
    }
  }

  return result;
}

export type AddedResult = { rule: number; hits: Hit[] };

/** 处理一个新增节点：先判自身，再扫子树。返回统计与自学习应记录的命中。 */
export function processAdded(el: Element, options: JudgeOptions): AddedResult {
  const self = applyVerdict(el, judgeElement(el, options));
  if (self) {
    // 自身已被隐藏 → 整棵子树已经不可见，不必再逐个判定。
    // 否则既做无用功，又会把广告内部一堆节点的泛化选择器灌进自学习库当噪声。
    return self.kind === 'heuristic'
      ? { rule: 0, hits: [self.hit] }
      : { rule: 1, hits: [] };
  }
  const swept = sweep(el, options);
  return { rule: swept.hiddenByRule, hits: swept.hits };
}
