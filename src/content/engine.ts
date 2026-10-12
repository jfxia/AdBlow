import { isInjected, type PristineIndex } from '../engine/pristine.ts';
import { scoreNode, registrableDomain, isSameBrand } from '../engine/score.ts';
import { crossSiteResourceDomains, pageWideMediaDomains } from '../engine/domains.ts';
import { NAMING_STRONG, NAMING_WEAK, namingSignal } from '../engine/lexicon.ts';
import { generalizeSelector, isSelectorSafe } from '../engine/selector.ts';
import { forbiddenSelectorReason, validateSitePack, type SitePack } from '../engine/rules.ts';

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
 * 四道闸门（2–4 是 2026-10-10 事故后补的）：
 *   1. 泛化器已挡住裸标签名（返回 null）
 *   2. **不能是禁用选择器** —— 复用规则包那套护栏。自学习曾推导出 `.post-card`
 *      （正文卡片类名），而 `validateSitePack` 管不到自学习路径。
 *   3. **命中的元素里不能含正文**。
 *   4. **命中元素含图片的总数必须很少（≤ maxImages）**。这是区分「正常广告位」
 *      与「宽泛包装类」的关键：正常广告位只含 1–2 张素材图，而 `.tjtagmanager`
 *      这类站点通用外链包装命中 43 个元素、含 22 张图 —— 它既包广告也包内容，
 *      一旦入库就会在页面开头无条件隐藏一大片图片。
 *
 * 再加宽度实测：命中数不得超过 maxMatches（防止过宽）。
 *
 * 自学习规则会在后续访问中生效，所以入库前必须极度保守。
 */
export function recordableSelector(
  hit: Hit,
  root: ParentNode,
  maxMatches = 30,
  maxImages = 4,
): string | null {
  if (!hit.selector) return null;
  const selector = hit.selector;

  if (forbiddenSelectorReason(selector)) return null;
  if (!isSelectorSafe(selector, root, maxMatches)) return null;

  let matched: Element[] = [];
  try {
    matched = Array.from(root.querySelectorAll(selector));
  } catch {
    return null;
  }
  if (matched.length === 0) return null;

  let images = 0;
  for (const el of matched) {
    if (holdsRealContent(el)) return null;
    // 更不允许把「显式声明的导航」学成可隐藏
    if (mustNotHide(el)) return null;
    images += el.matches(MEDIA_TAGS) ? 1 : 0;
    images += el.querySelectorAll('img,video,picture').length;
    if (images > maxImages) return null;
  }

  return selector;
}

export type InjectionTest = (el: Element) => boolean;

/**
 * 默认的注入判定。**只用于「纯行为证据」那一档**（见 createJudge 的三档决策）。
 *
 * ⚠️ 这里的 `reliable` 不是保守开关，是**实测必需的**（2026-10-10 标定）：
 *
 * `document_start` 时页面才刚开始解析，就地构建的快照索引几乎为空，不可信。
 * 而试点站服务端 HTML 里就有紧凑外链盒子（`.contact-link`、`footer#footer`、
 * `div.container`）广告度达到 8 分，超过阈值 6 —— 用不可信快照跑纯行为判定，
 * 必然误伤这三处；把阈值抬到 10 又会丢掉「跨站链接 + 推广参数」这条最有价值
 * 的通用检测。
 *
 * 因此：
 *   - `reliable === false`：纯行为档**整体关闭**，只留静态规则与命名档
 *   - `reliable === true` ：快照来自完整服务端 HTML，按签名精确区分注入节点
 *
 * 快照回填见 src/engine/pristine.ts 的 buildPristineIndexFromHtml 与
 * src/content/index.ts 的 PRISTINE_STRATEGY。
 *
 * 注：**命名档（强广告命名）不受这里影响** —— 它是确定性证据，不需要注入佐证。
 * 第二站点（1024cg.com）的广告是服务端渲染的 `article.ad-item`，正是靠命名档
 * 才能拦住，否则会被这道闸门整个排除在外。
 */
export function makeInjectionTest(index: PristineIndex, reliable: boolean): InjectionTest {
  return (el: Element) => reliable && isInjected(el, index);
}

/**
 * 选择器集合：把「可信」与「自动推导」严格分开。
 *
 * 为什么必须分开（2026-10-10 事故）：自学习推导出的选择器此前与规则包混在一起，
 * 被一并写进 `document_start` 注入的样式表 —— 那条路径**没有任何元素级守卫**，
 * 于是自学习出来的 `.tjtagmanager`（站点外链包装类，内含 22 张图）和
 * `.post-card`（正文卡片类名）在页面一开头就无条件隐藏了一大片内容。
 *
 * 现在的分工：
 *   - `curated`：站点规则包，经取证与 fixture 回归测试，允许进样式表
 *   - `learned`：自动推导，**一律不进样式表**，只走带守卫的逐元素判定
 */
export type SelectorSet = {
  curated: string[];
  learned: string[];
};

/** 汇总选择器：规则包 → curated，自学习 → learned。 */
export function selectorsFrom(
  packs: SitePack[],
  learned: string[],
  onReject?: (r: Rejection) => void,
): SelectorSet {
  const curated = new Set<string>();

  for (const pack of packs) {
    const problems = validateSitePack(pack);
    if (problems.length) {
      onReject?.({ packId: pack.id, problems });
      continue;
    }
    for (const s of pack.cosmetic) curated.add(s);
  }

  return { curated: [...curated], learned: [...new Set(learned)] };
}

/** 弱命名要成立，至少要有这么多行为旁证（跨站链接 = 4）。 */
export const WEAK_NAMING_MIN_BEHAVIOR = 4;

/**
 * 内容标记：出现这些才说明该元素里装着**真实正文**。
 *
 * 这是命名档的硬性例外，来自一次自己踩出来的事故：加上命名档之后，
 * 试点站的 `<div data-ssp-container="ssp-list">` 因为属性名含 `data-ssp-`
 * 被判成强命名，于是整个正文列表被隐藏——正是设计文档 §2 反复强调的那条红线。
 *
 * 教训：**命名证据再强，也不能推翻「这里面装着正文」这个事实。**
 * 所以任何包含正文标记的元素，一律不因命名或行为被隐藏。
 */
export const CONTENT_MARKERS = [
  'article[itemtype*="BlogPosting"]',
  'article[itemprop]',
  '[itemprop="articleBody"]',
  'main article',
];

/** 元素自身是正文，或内部装着真实正文。 */
export function holdsRealContent(el: Element): boolean {
  return hasContentMarker(el) || hasSubstantiveText(el);
}

/**
 * 显式声明的**导航**结构。
 *
 * 与正文标记同理，这是作者的直接声明（不是我们猜的），因此列入绝对保护：
 * 用户报告过「导航列表被屏蔽」。而导航里通常只有短标签，
 * 走"文字量"这条代理指标是保护不住的（实测 12 项导航合计才 72 字）。
 *
 * ⚠️ **不用 `querySelector` 往外传播**（这点与正文标记不同）：
 * 页面上 `<body>` 几乎都包含 `<nav>`，而"同时装着导航与广告的容器"更是常见 ——
 * 一旦传播，这些容器就都变成不可隐藏，广告拦不住了。
 * 因此只保护导航**自身**（`isNavigationLike`）与导航**内部**（`isInsideNavigation`）。
 */
export const NAVIGATION_MARKERS = [
  'nav',
  '[role="navigation"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
];

/**
 * **类名类**导航标记：只保护元素自身，**不向后代传播**。
 *
 * 现实里绝大多数站点不用语义标签，而是 `<div class="navbar">` —— 用户报告的
 * 「导航栏被屏蔽」就是这种。
 *
 * ⚠️ 但它们**绝不能**像语义标记那样传播：实测加了传播之后，
 * `[class*="navbar"]` 命中 `.navbar-box` / `.top-navbar` 这类**页面级包装容器**，
 * 于是整页所有后代都被"保护"起来，广告也拦不住了（6 个集成测试当场挂掉）。
 * 所以：语义标记 = 直接声明 → 可传播；类名 = 启发式猜测 → 只保护自身。
 */
export const NAV_CONTAINER_MARKERS = [
  '[class*="navbar"]',
  '[class*="nav-bar"]',
  '[class*="navigation"]',
  '[class*="breadcrumb"]',
  '[class*="pagination"]',
  '[class*="mainmenu"]',
  '[class*="main-menu"]',
  '[class*="topmenu"]',
  '[class*="top-menu"]',
  '[class*="tabbar"]',
  '[class*="tab-bar"]',
];

export function isNavigationLike(el: Element): boolean {
  try {
    return (
      el.matches(NAVIGATION_MARKERS.join(',')) ||
      el.matches(NAV_CONTAINER_MARKERS.join(','))
    );
  } catch {
    return false;
  }
}

/** 元素位于**语义**导航内部（类名标记不参与，理由见上）。 */
export function isInsideNavigation(el: Element): boolean {
  return el.closest(NAVIGATION_MARKERS.join(',')) !== null;
}

/**
 * **绝对不可隐藏**的判据：显式声明的正文与导航。
 *
 * 任何来源（启发式、站点规则包以外的自学习、过滤列表的 cosmetic 规则）都要过这一关。
 * 文字量不在其中 —— 它是代理指标，允许被强命名推翻（见 createJudge）。
 */
export function mustNotHide(el: Element): boolean {
  return hasContentMarker(el) || isNavigationLike(el);
}

/** 语义标记（schema.org 文章标注）——**绝对保护**，任何证据都不能推翻。 */
export function hasContentMarker(el: Element): boolean {
  const selector = CONTENT_MARKERS.join(',');
  return el.matches(selector) || el.querySelector(selector) !== null;
}

/** 「实质文字量」门槛（字符数，空白折叠后）。 */
export const SUBSTANTIVE_TEXT_MIN = 200;
/** 「像样的段落」的门槛：每个至少这么多字，才算正文段落。 */
export const SUBSTANTIVE_PARA_MIN = 40;
/** 至少这么多个像样的段落才算正文。 */
export const SUBSTANTIVE_PARA_COUNT = 2;

/**
 * 元素里是否有**实质文字量**。
 *
 * ## 为什么必须加这一条（真实事故）
 *
 * 原先的内容守卫只认 schema.org 的文章标记（`article[itemprop]` 等）。
 * 那是针对试点站调的 —— 它恰好带这些标注。**换成普通站点，
 * `<div class="content">`、`<nav>`、`<ul class="menu">`、纯 `<p>` 段落
 * 一律不被保护**，内容守卫形同虚设，于是正文与导航被启发式成片误杀
 * （用户报告 xchina.co 就是这个症状）。
 *
 * ## 与语义标记的区别（重要）
 *
 * 语义标记是**直接证据**（作者显式声明"这里是正文"）→ 绝对保护。
 * 文字量是**代理指标**（广告也可能带一段文字）→ 只作为**强先验**：
 * 弱命名与纯行为证据不得隐藏它，但**强命名**（`.sponsored-post` 之类）可以。
 * 这个分层在 createJudge 里落实。
 */
export function hasSubstantiveText(el: Element): boolean {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text.length >= SUBSTANTIVE_TEXT_MIN) return true;

  let solid = 0;
  for (const p of Array.from(el.querySelectorAll('p'))) {
    if ((p.textContent ?? '').replace(/\s+/g, ' ').trim().length >= SUBSTANTIVE_PARA_MIN) {
      solid += 1;
      if (solid >= SUBSTANTIVE_PARA_COUNT) return true;
    }
  }
  return false;
}

/**
 * 元素位于正文**内部**（自身或其祖先带正文标记）。
 *
 * 与 holdsRealContent 的区别：那个问"里面装着正文吗"，这个问"我在正文里面吗"。
 * 链接农场需要后者 —— 文章内的"相关链接/参考链接"区块有 5 个以上外链很正常，
 * 但它是**作者写的内容**，不能隐藏；而页脚/侧栏里的同类区块就是广告垃圾。
 */
export function isInsideRealContent(el: Element): boolean {
  return el.closest(CONTENT_MARKERS.join(',')) !== null;
}

/** 媒体选择器：图片 / 视频 / 嵌入对象。 */
export const MEDIA_TAGS = 'img,video,source,embed,object,picture';

/** 元素自身是媒体，或内部包含媒体。 */
export function containsMedia(el: Element): boolean {
  return el.matches(MEDIA_TAGS) || el.querySelector(MEDIA_TAGS) !== null;
}

/**
 * 造一个启发式判定器。**三档决策，证据强度递减**。
 *
 * 这取代了早期「一律要求脚本注入」的单档设计。那个设计在第二站点
 * （1024cg.com）上完全失效：它的广告是**服务端渲染**的 `article.ad-item`，
 * 不是脚本注入的，于是被那道闸门整个排除在外，一个都拦不住。
 *
 * 三档：
 *   ① 确定性命名证据（naming >= 强命名）：直接判定，不看注入时机、不看行为。
 *      `class="ad-item"` 这种命名本身就是证据。
 *   ② 弱命名 + 行为旁证：`banner` / `popup` / `sponsor` 这类词在正常 UI 里
 *      也常见，单独出现不算数，但配上跨站外链就足够。
 *   ③ 纯行为证据：没有命名线索，只能靠行为推断。此时**必须**先证明是脚本
 *      注入，否则会顺着行为特征误伤服务端正文（标定证据见 makeInjectionTest）。
 *
 * 三档之前先过一次**内容守卫**（holdsRealContent）——见其注释。
 */
export function createJudge(
  injected: InjectionTest,
  host: string,
  viewportArea: number,
  threshold: number = SCORE_THRESHOLD,
  contentCdnDomains?: Set<string>,
): (el: Element) => Hit | null {
  return (el: Element): Hit | null => {
    // 语义标记优先于一切证据（事故回归保护）
    if (hasContentMarker(el)) return null;

    const naming = namingSignal(el).strength;
    const { score, behavior, reasons } = scoreNode(el, {
      pageHost: host,
      viewportArea,
      contentCdnDomains,
    });

    const hit = (): Hit => ({ selector: generalizeSelector(el), score, reasons });

    // ① 确定性命名证据（强命名可以直接推翻「文字量」这个代理指标，
    //    因为命名是显式证据：`.sponsored-post` 里有正文也仍然是广告位）
    if (naming >= NAMING_STRONG) return hit();

    // 导航是页面骨架：短标签的导航靠文字量保护不住，必须单独挡
    if (isNavigationLike(el) || isInsideNavigation(el)) return null;

    // 视频/播放器：**含 `<video>` 的块不靠弱证据隐藏**（用户报告「视频窗口被屏蔽」）。
    // 带广告命名的视频位在上面那一档已经拦掉了（验收第 10/13/14 条就是这类）。
    if (el.matches('video') || el.querySelector('video') !== null) return null;

    // 文字量大 = 像正文 → **弱命名与纯行为证据不得隐藏它**
    // （这正是「正文/导航被成片误杀」的根因所在，见 hasSubstantiveText）
    if (hasSubstantiveText(el)) return null;

    // ② 弱命名 + 行为旁证
    if (naming === NAMING_WEAK && behavior >= WEAK_NAMING_MIN_BEHAVIOR) return hit();

    // ③ 纯行为证据：必须先证明是脚本注入
    if (injected(el) && behavior >= threshold) return hit();

    return null;
  };
}

/**
 * 用内联样式隐藏。
 *
 * 为什么不用样式表：内联 `!important` 在作者源里优先级最高，不会被站点后续
 * 插进来的 `!important` 规则反制。样式表只是防闪现的第一道便宜防线。
 *
 * ## ⚠️ 为什么还要设 `pointer-events` / `visibility`（真实事故）
 *
 * 实测（用户报告的 1024cg）：站点用**同一个作者源里的内联 `!important`**
 * 把 `display` 改回 `block` —— 同优先级下后写的赢，于是我们"隐藏过了"
 * 的元素又显示出来。那是一个 `position:fixed; z-index:9999`、覆盖 99.5% 视口的
 * 广告弹层，结果**整个页面的链接都点不动**，而我们的 `data-adblow-hidden`
 * 标记还挂着 —— 标记成了谎话。
 *
 * 所以隐藏要多管齐下：`display:none` 负责视觉，`pointer-events:none`
 * 保证**即使显示被改回来，点击也能穿透到下面的链接**，
 * `visibility:hidden` 再补一道。三条里至少有一条能扛住站点的反制。
 *
 * @param reason 隐藏的原因（写进 `data-adblow-reason`）。
 *   这是**排查误杀的唯一手段** —— 用户报"正文/导航被屏蔽了"时，
 *   必须能一眼看出是规则包、启发式、覆盖层、链接农场还是列表 cosmetic 干的。
 */
export function hideElement(el: Element, reason?: string): void {
  el.setAttribute('data-adblow-hidden', '1');
  if (reason) el.setAttribute(REASON_ATTR, reason);
  const style = (el as HTMLElement).style;
  if (!style) return;
  style.setProperty('display', 'none', 'important');
  style.setProperty('visibility', 'hidden', 'important');
  style.setProperty('pointer-events', 'none', 'important');
  style.setProperty('height', '0', 'important');
  style.setProperty('margin', '0', 'important');
  style.setProperty('padding', '0', 'important');
}

/** 我们隐藏过、但显示被站点改回来的次数（诊断用）。 */
export const REFOUGHT_ATTR = 'data-adblow-refought';

export type HidingAudit = {
  /** 复核过的元素数 */
  checked: number;
  /** 发现被改回来并重新隐藏的元素数 */
  refought: number;
  /** 反复被改回来的元素（站点在主动对抗），按选择器摘要聚合 */
  stubborn: string[];
};

/**
 * 复核隐藏是否仍然生效，并对被站点改回来的元素重新隐藏。
 *
 * 为什么必须复核：**`!important` 不是不可战胜的** —— 站点脚本用同样
 * `!important` 的内联样式后写就能覆盖我们（实测 1024cg 的广告弹层就是这么干的，
 * 结果整页链接都点不动）。不复核的话，`data-adblow-hidden` 会变成谎话，
 * 而我们还以为自己拦住了。
 */
export function verifyHiding(root: ParentNode): HidingAudit {
  const audit: HidingAudit = { checked: 0, refought: 0, stubborn: [] };
  const win = (root as Document).defaultView;
  if (!win) return audit;

  for (const el of Array.from(root.querySelectorAll(`[${HIDDEN_ATTR}]`))) {
    audit.checked += 1;
    let visible = false;
    try {
      const cs = win.getComputedStyle(el);
      visible = cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch {
      continue;
    }
    if (!visible) continue;

    // 显示被改回来了 → 重新施加（保留原有原因，便于事后统计）
    const reason = el.getAttribute(REASON_ATTR) ?? undefined;
    const prev = Number(el.getAttribute(REFOUGHT_ATTR) ?? '0') + 1;
    hideElement(el, reason);
    el.setAttribute(REFOUGHT_ATTR, String(prev));
    audit.refought += 1;
    if (prev >= 2) {
      const tag = el.tagName.toLowerCase();
      const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      audit.stubborn.push(`${tag}${cls ? '.' + cls : ''}×${prev}`);
    }
  }
  return audit;
}

export function isHidden(el: Element): boolean {
  return el.getAttribute('data-adblow-hidden') === '1';
}

/** 元素自身或任一祖先已被隐藏（即已经不可见）。 */
export function isInsideHidden(el: Element): boolean {
  return el.closest('[data-adblow-hidden]') !== null;
}

export const HIDDEN_ATTR = 'data-adblow-hidden';

/** 隐藏原因所在属性（排查误杀用）。 */
export const REASON_ATTR = 'data-adblow-reason';

/**
 * 判据原因所在属性（比 REASON_ATTR 更细）。
 *
 * `data-adblow-reason` 只说"是启发式/规则包/链接农场干的"，
 * 但排查误杀时真正要回答的是"**凭哪条证据**判的" ——
 * 例如 `cross-site-iframe` / `cross-site-media` / `geometry-growth`。
 * 用户报"视频窗口被屏蔽"时，靠这个才能一眼看出是哪个信号误伤。
 */
export const WHY_ATTR = 'data-adblow-why';

/**
 * 覆盖层检测：**独立的一趟遍历，不参与逐元素打分。**
 *
 * 为什么必须独立（2026-10-10 实测踩坑）：一开始把覆盖层判定塞进 `scoreNode`，
 * 于是每个元素都要 `getComputedStyle`；而扫描过程中又不断隐藏元素（改内联样式），
 * 两者交替导致样式/布局反复失效。在 1024cg 这种大页面上直接导致整趟扫描跑不完 ——
 * 症状是「样式表注入了，但一个元素都没隐藏」，极难定位。
 *
 * 现在：先用**廉价的属性预筛**（注入型覆盖层几乎都会写内联样式），
 * 只对极少数候选做 `getComputedStyle` + 几何测量。
 *
 * 判定标准：固定/绝对定位 + 高 z-index + 占据大块视口。
 * 注意它**不足以单独判定**（Cookie 同意条、登录弹层也长这样），
 * 因此调用方应把结果当作"需要确认的候选"，而不是直接当广告。
 */
export const OVERLAY_AREA_RATIO = 0.4;
export const OVERLAY_MIN_Z = 1000;

/** 廉价预筛：只挑写了内联位置样式的元素。 */
export const OVERLAY_PRESELECTOR = '[style*="position"]';

export type OverlayContext = {
  viewportArea: number;
  styleOf?: (el: Element) => { position: string; zIndex: string } | null;
  rectOf?: (el: Element) => { width: number; height: number } | null;
};

const defaultStyleOf = (el: Element): { position: string; zIndex: string } | null => {
  const g = globalThis as unknown as { getComputedStyle?: (e: Element) => CSSStyleDeclaration };
  if (typeof g.getComputedStyle !== 'function') return null;
  try {
    const s = g.getComputedStyle(el);
    return { position: s.position, zIndex: s.zIndex };
  } catch {
    return null;
  }
};

const defaultRectOf = (el: Element): { width: number; height: number } | null => {
  try {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  } catch {
    return null;
  }
};

export function isOverlay(el: Element, ctx: OverlayContext): boolean {
  const style = (ctx.styleOf ?? defaultStyleOf)(el);
  if (!style) return false;
  if (style.position !== 'fixed' && style.position !== 'absolute') return false;

  const z = Number.parseInt(style.zIndex, 10);
  if (!Number.isFinite(z) || z < OVERLAY_MIN_Z) return false;

  const rect = (ctx.rectOf ?? defaultRectOf)(el);
  if (!rect || ctx.viewportArea <= 0) return false;

  const areaRatio = (rect.width * rect.height) / ctx.viewportArea;
  if (areaRatio >= OVERLAY_AREA_RATIO) return true;

  // ② 播放器内叠加（2026-10-10 验收实测补入）
  //
  // 视频叠加广告只盖住播放器，占视口往往不到 40%，按视口算会被漏掉。
  // 判据要求「几乎完全盖住祖先 + 该祖先里有 <video>」，因此它只匹配
  // **播放器内叠加层**，不会波及轮播图、卡片图这类"绝对定位盖住父元素"的正常布局。
  return coversVideoAncestor(el, rect, ctx);
}

/** 元素是否几乎完全盖住某个「内部含 `<video>`」的祖先（播放器内叠加层形态）。 */
function coversVideoAncestor(
  el: Element,
  rect: { width: number; height: number },
  ctx: OverlayContext,
): boolean {
  const rectOf = ctx.rectOf ?? defaultRectOf;
  const ownArea = rect.width * rect.height;
  if (ownArea <= 0) return false;

  let parent = el.parentElement;
  for (let i = 0; i < 3 && parent; i++) {
    const hasVideo = parent.querySelector('video') !== null;
    if (hasVideo) {
      const pr = rectOf(parent);
      if (pr) {
        const parentArea = pr.width * pr.height;
        const parentRatio = parentArea / Math.max(ctx.viewportArea, 1);
        const coverage = ownArea / Math.max(parentArea, 1);
        if (coverage >= OVERLAY_CONTAINER_COVERAGE && parentRatio >= OVERLAY_CONTAINER_MIN_RATIO) {
          return true;
        }
      }
      return false;
    }
    parent = parent.parentElement;
  }
  return false;
}

/** 播放器内叠加层：至少要盖住所在容器的这个比例。 */
export const OVERLAY_CONTAINER_COVERAGE = 0.8;
/** 所在容器至少要占视口这个比例，避免为角落里的小控件触发。 */
export const OVERLAY_CONTAINER_MIN_RATIO = 0.08;

/** 找出页面上的覆盖层候选（覆盖大块视口的固定/绝对定位盒子）。 */
export function findOverlays(root: ParentNode, ctx: OverlayContext): Element[] {
  const out: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(OVERLAY_PRESELECTOR))) {
    if (isInsideHidden(el)) continue;
    if (isOverlay(el, ctx)) out.push(el);
  }
  return out;
}

/** 覆盖层形态本身作为旁证时，额外计入的分值。 */
export const OVERLAY_BONUS = 4;
/** 覆盖层要有多少"其它"证据才成立（弱命名或跨站链接即达标）。 */
export const OVERLAY_CORROBORATION = 4;

export type OverlayAd = { element: Element; hit: Hit };

/**
 * 找出并判定覆盖型广告位。
 *
 * 为什么需要旁证：Cookie 同意条、登录弹层、全屏引导页都是"固定定位 + 高层级 +
 * 大块视口"的形态。**只看形态会误伤它们**，而误伤 Cookie 条可能让站点卡住不
 * 给看内容。所以要求至少还有一项其它证据：弱命名以上，或有跨站链接/媒体/iframe
 * 等行为信号（后者通常意味着这层是广告而不是站点自己的 UI）。
 */
export function findOverlayAds(
  root: ParentNode,
  opts: { host: string; viewportArea: number; overlay?: OverlayContext },
): OverlayAd[] {
  const overlayCtx: OverlayContext = opts.overlay ?? { viewportArea: opts.viewportArea };
  const out: OverlayAd[] = [];

  for (const el of findOverlays(root, overlayCtx)) {
    const naming = namingSignal(el).strength;
    const { score, behavior, reasons } = scoreNode(el, {
      pageHost: opts.host,
      viewportArea: opts.viewportArea,
    });

    if (naming < NAMING_WEAK && behavior < OVERLAY_CORROBORATION) continue;

    out.push({
      element: el,
      hit: {
        selector: generalizeSelector(el),
        score: score + OVERLAY_BONUS,
        reasons: [...reasons, 'overlay'],
      },
    });
  }

  return out;
}

// ── 链接农场（用大量外站链接堆出来的广告/SEO 垃圾块）────────────────

/**
 * 一个容器里出现这么多个**不同**的跨站域名，就算链接农场。
 *
 * 取证背景（2026-10-10，用户反馈某站点图片广告仍在显示）：实测那个页面页脚有
 * **39 个不同跨站域名**的链接（`a.referrerLink`，全部 `target=_blank`），
 * 由站点自己的 `/js/partners.js` 注入到 `[data-javeve-partners]`。
 *
 * 为什么原有判据抓不到：单条跨站链接只值 4 分，低于纯行为档的 6 分门槛
 * （这是**故意的**，否则页面上每个正常外链都会变成隐藏目标）；
 * 而容器又因为后代太多（>12）根本不采信后代信号。
 *
 * 但"**一个块里挂着 5 个以上互不相同的外站域名**"是另一回事 ——
 * 正常内容区不会这样组织，广告/SEO 垃圾块才会。
 */
export const LINK_FARM_MIN_DOMAINS = 5;

/** 可能承载链接农场的容器标签。不包含 body/html/main/article（它们装着正文）。 */
const FARM_TAGS = 'div,ul,ol,section,aside,nav,footer,dl,table';

/**
 * 找出链接农场块。
 *
 * 只返回**最深**的那些候选：父级往往也满足条件（甚至整个 footer 都满足），
 * 但隐藏最深的那层就足以清掉农场，而且不会连带抹掉同层容器里的正常内容
 * （页脚导航、版权声明等）。
 */
export function findLinkFarms(
  root: ParentNode,
  opts: { host: string; minDomains?: number },
): Element[] {
  const min = opts.minDomains ?? LINK_FARM_MIN_DOMAINS;
  const pageReg = registrableDomain(opts.host);

  const candidates: Element[] = [];
  for (const el of Array.from(root.querySelectorAll(FARM_TAGS))) {
    if (isInsideHidden(el)) continue;

    const domains = new Set<string>();
    for (const a of Array.from(el.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
      try {
        const parsed = new URL(href, `https://${opts.host}`);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const reg = registrableDomain(parsed.hostname);
        if (!reg || reg === pageReg) continue;
        // 同品牌的镜像/备用域名不算"另一个域名" —— 实测 dgav36 的
        // 「最新镜像网址」目录页正文就是几十个这样的域名，按跨站算会把正文
        // 整块判成链接农场（用户报告的误杀）。
        if (isSameBrand(parsed.hostname, opts.host)) continue;
        domains.add(reg);
      } catch {
        /* 忽略非法 URL */
      }
    }
    if (domains.size < min) continue;
    if (holdsRealContent(el)) continue;
    // 导航（自身或内部）不是链接农场 —— 用户报告过「导航列表被屏蔽」。
    // ⚠️ 但**伪装成导航的广告位**要留出退路：如果它自己带着广告强命名
    // （`nav.ad-links` 这种），那命名就是显式证据，照判。
    if (isNavigationLike(el) || isInsideNavigation(el)) {
      if (namingSignal(el).strength < NAMING_STRONG) continue;
    }
    // 链接农场是"只有链接、没有文字"的墙。带实质文字的块不是农场 ——
    // 导航列表、友链说明、索引页都可能挂着不少外链，但它们是内容。
    if (hasSubstantiveText(el)) continue;
    // 文章内部的"相关链接/参考链接"是作者写的内容，不是广告垃圾
    if (isInsideRealContent(el)) continue;
    candidates.push(el);
  }

  return candidates.filter(
    (el) => !candidates.some((other) => other !== el && el.contains(other)),
  );
}

/**
 * 只看会**加载资源**的标签；不看 `<a href>`（那是点击目标，不算"使用"）。
 */
export const RESOURCE_TAGS = 'img,script,link,iframe,video,source,embed,object';

// ── 几何突增重判（随动伸缩 / 悬浮展开 / 自动放大）────────────────────

/** 几何突增作为旁证时额外计入的分值。 */
export const GROWTH_BONUS = 4;

/**
 * 判定一个「面积刚刚突然撑大」的元素。
 *
 * 与常规三档判定的区别：**不再要求"必须证明是脚本注入"**。
 * 几何突增本身就是证据 —— 一个原本不起眼的盒子突然撑到占视口 15% 以上，
 * 同时带弱命名或跨站链接/素材，这就足够说明它是展开型广告。
 *
 * ⚠️ 产出的 hit 刻意**不带 selector**：几何是**瞬时证据**，
 * 一个正常组件偶然撑大不该被固化成永久规则。隐藏当下这一次即可。
 */
export function judgeGrownElement(el: Element, options: JudgeOptions): Verdict | null {
  if (isHidden(el)) return null;
  if (holdsRealContent(el)) return null;

  const naming = namingSignal(el).strength;
  const { score, behavior, reasons } = scoreNode(el, {
    pageHost: options.host,
    viewportArea: options.viewportArea,
  });

  if (naming < NAMING_WEAK && behavior < OVERLAY_CORROBORATION) return null;

  return {
    kind: 'heuristic',
    hit: {
      selector: null,
      score: score + GROWTH_BONUS,
      reasons: [...reasons, 'geometry-growth'],
    },
  };
}

// ── 假关闭按钮（伪装成关闭的跨站链接）──────────────────────────────

/**
 * 「看起来是关闭控件」的线索。
 *
 * 用属性选择器做廉价预筛，再用 looksLikeCloseControl 精确判断。
 */
export const CLOSE_HINT_SELECTOR = [
  '[class*="close"]',
  '[class*="Close"]',
  '[id*="close"]',
  '[id*="Close"]',
  '[class*="dismiss"]',
  '[class*="Dismiss"]',
  '[aria-label*="close"]',
  '[aria-label*="Close"]',
  '[aria-label*="关闭"]',
  '[title*="close"]',
  '[title*="Close"]',
  '[title*="关闭"]',
].join(',');

/** 常见的关闭符号/文字。 */
const CLOSE_TEXTS = new Set(['×', '✕', '✖', '╳', 'x', 'X', '关', '关闭', 'close', 'Close', 'CLOSE']);

/** 元素是否"看起来用于关闭"。 */
export function looksLikeCloseControl(el: Element): boolean {
  const hay = [
    el.getAttribute('class') ?? '',
    el.getAttribute('id') ?? '',
    el.getAttribute('aria-label') ?? '',
    el.getAttribute('title') ?? '',
    el.getAttribute('role') ?? '',
  ]
    .join(' ')
    .toLowerCase();

  if (/close|dismiss|关闭/.test(hay)) return true;

  const text = (el.textContent ?? '').trim();
  return CLOSE_TEXTS.has(text);
}

/** 跨站链接判断（按可注册域名）。 */
function isCrossSiteLink(href: string, pageHost: string): boolean {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
  try {
    const parsed = new URL(href, `https://${pageHost}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return registrableDomain(parsed.hostname) !== registrableDomain(pageHost);
  } catch {
    return false;
  }
}

/** 假关闭按钮：向上找它的广告容器，最多追这么多层。 */
export const FAKE_CLOSE_MAX_DEPTH = 6;

/**
 * 找「假关闭按钮」并给出应当隐藏的广告容器。
 *
 * 手法：广告浮窗上的 "×" 其实是个跨站链接，点了不是关闭而是跳转。
 * 常规判据抓不到它 —— 小浮窗（占视口不到 40%）过不了覆盖层阈值，
 * 又常常没有任何广告命名。但"**关闭控件却是跨站链接**"这件事本身极可疑：
 * 正常站点的关闭按钮不会把人带到别的域名去。
 *
 * 处理方式不是拦点击（那样广告还在），而是**把外层广告容器整体隐藏**。
 */
export function findFakeCloseAds(
  root: ParentNode,
  opts: { host: string; maxDepth?: number },
): OverlayAd[] {
  const maxDepth = opts.maxDepth ?? FAKE_CLOSE_MAX_DEPTH;
  const out: OverlayAd[] = [];
  const seen = new Set<Element>();

  for (const el of Array.from(root.querySelectorAll(CLOSE_HINT_SELECTOR))) {
    if (isInsideHidden(el)) continue;
    if (!looksLikeCloseControl(el)) continue;

    const anchor = el.closest('a[href]');
    if (!anchor) continue;
    if (!isCrossSiteLink(anchor.getAttribute('href') ?? '', opts.host)) continue;

    // 从链接向上找"看起来像广告浮层"的容器。
    //
    // ⚠️ 必须**优先取定位祖先**（2026-10-10 单元测试抓到的真 bug）：
    // 早先的实现取"最外层匹配的祖先"，而任意一层含图片的通用包裹 div 都算匹配，
    // 结果会选到一个离广告浮窗很远的容器 —— 隐藏范围过大。广告浮窗一定是
    // 固定/绝对定位的，所以定位祖先才是正确目标。
    let positioned: Element | null = null;
    let mediaFallback: Element | null = null;
    let node: Element | null = anchor.parentElement;
    for (let i = 0; i < maxDepth && node; i++) {
      if (node === document.body || node === document.documentElement) break;
      // 一旦碰上装着正文的祖先就停手 —— 宁可漏，不可误伤内容
      if (holdsRealContent(node)) break;

      let isPositioned = false;
      try {
        const pos = getComputedStyle(node).position;
        isPositioned = pos === 'fixed' || pos === 'absolute';
      } catch {
        isPositioned = false;
      }

      if (isPositioned) {
        // 持续向上覆盖：定位链上最外层的那个才是整个浮窗
        positioned = node;
      } else if (positioned === null && mediaFallback === null) {
        // 只有完全找不到定位祖先时，才退而求其次用一个含媒体的近层容器
        if (node.querySelector('img,video,iframe,canvas') !== null) mediaFallback = node;
      }

      node = node.parentElement;
    }

    const container = positioned ?? mediaFallback;
    if (!container || seen.has(container)) continue;
    seen.add(container);

    out.push({
      element: container,
      hit: {
        selector: generalizeSelector(container),
        score: 0,
        reasons: ['fake-close-cross-site'],
      },
    });
  }

  return out;
}

/**
 * 站点自有基础设施的声明位置（canonical / og / 图标）。
 *
 * 为什么需要：试点站的 canonical 指向 `cgw666.com` —— 那是它的**镜像域名**，
 * 同时托管正文图。而「被隐藏的推荐位图片」恰好引用了它。若不排除，
 * 网络层自学习会把站点自己的域名学成广告域名，一次就把正文图全废掉。
 * 这与 §2 的风险 A 是同一类错误，只是入口不同。
 */
const SITE_OWNED_SELECTOR = [
  'link[rel~="canonical"]',
  'link[rel~="icon"]',
  'link[rel~="apple-touch-icon"]',
  'link[rel~="alternate"]',
  'meta[property="og:url"]',
  'meta[property="og:image"]',
  'meta[name="twitter:image"]',
].join(',');

/** 从 head 元数据里提取「这个站点自己的」域名。 */
export function siteOwnedDomains(root: ParentNode, pageHost: string): Set<string> {
  const out = new Set<string>();
  const consider = (raw: string): void => {
    if (!raw) return;
    let parsed: URL;
    try {
      parsed = new URL(raw, `https://${pageHost}`);
    } catch {
      return;
    }
    const reg = registrableDomain(parsed.hostname);
    if (reg) out.add(reg);
  };

  for (const node of Array.from(root.querySelectorAll(SITE_OWNED_SELECTOR))) {
    consider(node.getAttribute('href') ?? '');
    consider(node.getAttribute('content') ?? '');
  }
  return out;
}

/**
 * 从「已被隐藏的广告」里提炼出**可以安全学习**的跨站域名。
 *
 * 这是网络层自学习的决策核心，因此放在纯逻辑层而不是接线层。
 *
 * ⚠️ 三道安全过滤都是硬要求，各有回归测试：
 *
 *   1. **只要某域名在本页任何位置充当过图片/视频来源，就绝不学它**
 *      （不论可见与否）。这是 2026-10-10 一次真实事故的直接产物：
 *      1024cg 的内容缩略图与广告素材共用 `pic.jtzatly.cn`，而内容图是懒加载的，
 *      「是否被可见内容使用」这个判断会被时序错开骗过 —— 域名被学走后
 *      **整站图片全部不显示**。现在改成结构性判断，不再依赖时序。
 *   2. 也被**可见内容**使用的域名不学（风险 A：试点站的 `pic.wvxrrip.cn`）。
 *   3. **站点自有域名**（canonical / og / 图标所指）不学。试点站 canonical 指向
 *      镜像域名 `cgw666.com`，而它托管正文图，学它同样致命。
 */
export function learnableAdDomains(root: ParentNode, pageHost: string): string[] {
  const hidden = root.querySelectorAll(`[${HIDDEN_ATTR}]`);
  if (hidden.length === 0) return [];

  const adDomains = new Set<string>();
  for (const el of hidden) {
    // 学习时算上外链：广告落地页域名学会后拦其子资源可挡弹窗，
    // 而拦截子资源不影响 <a href> 导航（main_frame 已排除）。
    for (const d of crossSiteResourceDomains(el, pageHost, { includeLinks: true })) {
      adDomains.add(d);
    }
  }
  if (adDomains.size === 0) return [];

  // 过滤 ①（结构性，不依赖时序）：整页媒体域名一律不学
  const media = pageWideMediaDomains(root, pageHost);

  // 过滤 ②：可见内容使用的域名。判定**不算外链**：可见内容里有个指向该域名的
  // 链接，不构成"该域名是站点的正常资源来源"。
  const usedByVisible = new Set<string>();
  for (const el of root.querySelectorAll(RESOURCE_TAGS)) {
    if (isInsideHidden(el)) continue;
    for (const d of crossSiteResourceDomains(el, pageHost)) usedByVisible.add(d);
  }

  // 过滤 ③：站点自有域名
  const owned = siteOwnedDomains(root, pageHost);

  return [...adDomains].filter((d) => !media.has(d) && !usedByVisible.has(d) && !owned.has(d));
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
  selectors: SelectorSet;
  threshold?: number;
  /** 页级预算兜底（见 createHidingBudget）。不传则不设兜底（测试用）。 */
  budget?: HidingBudget;
  /** 站点自己的内容 CDN（见 frequentMediaDomains）。不传则不做这项排除。 */
  contentCdnDomains?: Set<string>;
};

/**
 * 判定单个元素：先规则选择器，再启发式。
 *
 * ⚠️ **curated 与 learned 的待遇必须不同**（2026-10-10 事故）：
 *
 *   - `curated`（站点规则包）：经取证与 fixture 回归测试，命中即隐藏。
 *   - `learned`（自学习推导）：**只免去「必须证明是脚本注入」这一步**，
 *     仍然要求元素自带命名或行为证据。这一点很关键 —— 早先的实现在这里
 *     给了自学习选择器「无条件隐藏」的权力，于是 `.tjtagmanager`
 *     （站点外链包装类，命中 43 个元素、含 22 张图）把图片整片隐藏了。
 *
 * 另外「绝不隐藏装着正文的元素」是全局不变量，对 curated 同样适用。
 */
export function judgeElement(el: Element, options: JudgeOptions): Verdict | null {
  if (isHidden(el)) return null;
  if (holdsRealContent(el)) return null;

  const { threshold = SCORE_THRESHOLD } = options;

  if (options.selectors.curated.length > 0 && matchesAny(el, options.selectors.curated)) {
    return { kind: 'rule' };
  }

  if (options.selectors.learned.length > 0 && matchesAny(el, options.selectors.learned)) {
    // 自学习规则只加速，不授予特权：仍需命名或行为证据
    const naming = namingSignal(el).strength;
    const { behavior, score, reasons } = scoreNode(el, {
      pageHost: options.host,
      viewportArea: options.viewportArea,
    });
    if (naming >= NAMING_WEAK || behavior >= threshold) {
      return {
        kind: 'heuristic',
        hit: { selector: null, score, reasons: [...reasons, 'learned-selector'] },
      };
    }
  }

  const hit = createJudge(
    options.injected,
    options.host,
    options.viewportArea,
    threshold,
    options.contentCdnDomains,
  )(el);
  return hit ? { kind: 'heuristic', hit } : null;
}

/** 判定并应用隐藏。隐藏原因写进 `data-adblow-reason`，便于事后排查误杀。 */
export function applyVerdict(
  el: Element,
  verdict: Verdict | null,
  budget?: HidingBudget,
): Verdict | null {
  if (!verdict) return null;
  // 页级预算兜底：绝不允许把整页清空（见 createHidingBudget）
  if (budget && !budget.canHide(el)) return null;
  const reason =
    verdict.kind === 'rule'
      ? 'rule'
      : (verdict.hit?.reasons ?? []).includes('learned-selector')
        ? 'learned'
        : 'heuristic';
  // 记下**凭哪条证据**判的（排查误杀时最关键的信息）
  if (verdict.kind === 'heuristic' && verdict.hit.reasons.length) {
    el.setAttribute(WHY_ATTR, verdict.hit.reasons.join(','));
  }
  hideElement(el, reason);
  budget?.commit(el);
  return verdict;
}

/** 隐藏文字 / 链接占全页的比例上限（页级兜底，宁可少拦也不能清空页面）。 */
export const PAGE_TEXT_BUDGET_SHARE = 0.7;
export const PAGE_LINK_BUDGET_SHARE = 0.7;
/**
 * 页面内容太少时**不启用**预算。
 *
 * ⚠️ 这是验收实测被迫加的：夹具页面上只有一个广告探针，隐藏它 = 该页 100%
 * 的链接 → 被 70% 阈值拒绝 → 广告反而拦不住，验收从 21/21 掉到 12/21。
 * 页级兜底的目的是"别把有内容的页面清空"，本来就**不该**作用在
 * 内容量微不足道的页面上。
 */
export const BUDGET_MIN_TOTAL_LINKS = 10;
export const BUDGET_MIN_TOTAL_TEXT = 400;

export type HidingBudget = {
  /** 还能隐藏这个元素吗（会突破页级预算就返回 false）。 */
  canHide(el: Element): boolean;
  /** 记入已隐藏的量（必须在真的隐藏之后调用）。 */
  commit(el: Element): void;
  /** 页面继续加载后重测基线（分母只增不减）。 */
  refresh(doc: Document): void;
  stats(): {
    text: number;
    links: number;
    totalText: number;
    totalLinks: number;
    suppressed: number;
    enabled: boolean;
  };
};

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * 量一页的"内容量"，**排除 `<script>` / `<style>` 里的代码文本**。
 *
 * 不排除的话，内联 JS 多的页面文字总量能到十几万字符（实测 dgav36 报
 * 110034），预算就永远碰不到、形同虚设。
 */
function measureContent(root: Element): { text: number; links: number } {
  let clone: Element;
  try {
    clone = root.cloneNode(true) as Element;
  } catch {
    return { text: 0, links: 0 };
  }
  for (const el of Array.from(clone.querySelectorAll('script,style,noscript,template'))) {
    el.remove();
  }
  return {
    text: collapse(clone.textContent ?? '').length,
    links: clone.querySelectorAll('a[href]').length,
  };
}

/**
 * 页级预算兜底：**逐元素判定之外的最后一道保险**。
 *
 * ## 为什么必须要有（用户报告的真实误杀）
 *
 * dgav36.xyz 上有一张「最新镜像网址」目录页，**整页正文就是几十张镜像卡片**。
 * 启发式逐张判定，每张都"有证据"（跨站链接），于是把整页 96 个块全隐藏了 ——
 * 用户看到的是"正文被误杀"。逐元素判定的根本缺陷是：**从不问
 * "我是不是把整个页面清空了"**。
 *
 * ## 三个必须注意的设计点（都是踩出来的）
 *
 * 1. **内容太少的页面不启用**：夹具页只有一个探针，隐藏它就是该页 100% 的链接，
 *    会反过来让广告拦不住（验收 21/21 → 12/21）。
 * 2. **文字量要排除 `<script>`**：否则内联 JS 让分母虚高到十几万，预算永远不触发。
 * 3. **基线在"动手前"测，且分母只增不减**：在隐藏过程中重测等于把已隐藏的
 *    部分从分母里去掉，预算就永远用不完。页面后续加载出更多内容时，
 *    用 `refresh` 把新增量加进分母。
 */
export function createHidingBudget(
  doc: Document,
  opts: {
    textShare?: number;
    linkShare?: number;
    minLinks?: number;
    minText?: number;
  } = {},
): HidingBudget {
  const textShare = opts.textShare ?? PAGE_TEXT_BUDGET_SHARE;
  const linkShare = opts.linkShare ?? PAGE_LINK_BUDGET_SHARE;
  const minLinks = opts.minLinks ?? BUDGET_MIN_TOTAL_LINKS;
  const minText = opts.minText ?? BUDGET_MIN_TOTAL_TEXT;

  let text = 0;
  let links = 0;
  let totalText = 0;
  let totalLinks = 0;
  let suppressed = 0;

  const enabled = (): boolean => totalLinks >= minLinks || totalText >= minText;

  const initial = doc.body ?? doc.documentElement;
  if (initial) {
    const m = measureContent(initial);
    totalText = m.text;
    totalLinks = m.links;
  }

  return {
    canHide(el: Element): boolean {
      // 页面内容太少 → 兜底不生效（这时"少拦"比"少误杀"更重要）
      if (!enabled()) return true;
      const t = collapse(el.textContent ?? '').length;
      const l = el.querySelectorAll('a[href]').length;
      if (text + t > totalText * textShare || links + l > totalLinks * linkShare) {
        suppressed += 1;
        return false;
      }
      return true;
    },
    commit(el: Element): void {
      text += collapse(el.textContent ?? '').length;
      links += el.querySelectorAll('a[href]').length;
    },
    refresh(current: Document): void {
      const root = current.body ?? current.documentElement;
      if (!root) return;
      const m = measureContent(root);
      // 当前可见量 + 我们已隐藏量 = 曾经观察到的总量；分母只增不减
      totalText = Math.max(totalText, m.text + text);
      totalLinks = Math.max(totalLinks, m.links + links);
    },
    stats: () => ({ text, links, totalText, totalLinks, suppressed, enabled: enabled() }),
  };
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
    const verdict = applyVerdict(el, judgeElement(el, options), options.budget);
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
  const self = applyVerdict(el, judgeElement(el, options), options.budget);
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
