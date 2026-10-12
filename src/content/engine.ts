import { isInjected, type PristineIndex } from '../engine/pristine.ts';
import { scoreNode, registrableDomain } from '../engine/score.ts';
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
  const selector = CONTENT_MARKERS.join(',');
  return el.matches(selector) || el.querySelector(selector) !== null;
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
): (el: Element) => Hit | null {
  return (el: Element): Hit | null => {
    // 内容守卫优先于一切证据（事故回归保护）
    if (holdsRealContent(el)) return null;

    const naming = namingSignal(el).strength;
    const { score, behavior, reasons } = scoreNode(el, { pageHost: host, viewportArea });

    const hit = (): Hit => ({ selector: generalizeSelector(el), score, reasons });

    // ① 确定性命名证据
    if (naming >= NAMING_STRONG) return hit();

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

/** 元素自身或任一祖先已被隐藏（即已经不可见）。 */
export function isInsideHidden(el: Element): boolean {
  return el.closest('[data-adblow-hidden]') !== null;
}

export const HIDDEN_ATTR = 'data-adblow-hidden';

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

  return (rect.width * rect.height) / ctx.viewportArea >= OVERLAY_AREA_RATIO;
}

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

/**
 * 只看会**加载资源**的标签；不看 `<a href>`（那是点击目标，不算"使用"）。
 */
export const RESOURCE_TAGS = 'img,script,link,iframe,video,source,embed,object';

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

  const hit = createJudge(options.injected, options.host, options.viewportArea, threshold)(el);
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
