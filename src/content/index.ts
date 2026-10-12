import { buildPristineIndexFromHtml } from '../engine/pristine.ts';
import { withTimeout } from '../engine/async.ts';
import { findInvisibleClickLayers } from '../engine/clickLayer.ts';
import { collectGrownElements, createGrowthTracker } from '../engine/geometry.ts';
import type { SitePack } from '../engine/rules.ts';
import {
  applyVerdict,
  cosmeticCss,
  findOverlayAds,
  findFakeCloseAds,
  findLinkFarms,
  hideElement,
  holdsRealContent,
  mustNotHide,
  judgeGrownElement,
  learnableAdDomains,
  makeInjectionTest,
  processAdded,
  recordableSelector,
  selectorsFrom,
  sweep,
  verifyHiding,
  type Hit,
  type JudgeOptions,
} from './engine.ts';
import { promotedSelectors, recordHit } from './learn.ts';
import { applyListCosmetic } from './listCosmetic.ts';
import { recordDomains } from './domainLearn.ts';
import { isSiteDisabled, writeStats } from './settings.ts';
import { chromeLocal } from './storage.ts';

/**
 * 几何巡检的防抖间隔。
 *
 * 展开型广告是**鼠标移入 / 滚动**触发的，所以按需巡检即可，不必常驻轮询 ——
 * 常驻 2 秒定时器在真实站点上是持续的 CPU 开销（一次巡检 = 一次
 * querySelectorAll + 最多 600 次尺寸读取）。
 *
 * ⚠️ 但**基线必须在展开之前记下**，否则第一次巡检时元素已经撑大了，
 * 面积记为"本来就大"，后续永远检测不出增长。因此 upkeep 每轮也会跑一次
 * 几何巡检来建立/更新基线，早于任何用户交互。
 */
const GEOMETRY_DEBOUNCE_MS = 600;

/**
 * 内容脚本（ISOLATED world）。
 *
 * 只做 chrome.* 接线与阶段编排；判定逻辑全在 engine.ts，可在 jsdom 里回归。
 *
 * 两个阶段（顺序很重要）：
 *   阶段一 document_start：静态规则就位。精确锚点，安全，无带宽代价。
 *   阶段二 快照回填成功后：启用启发式。理由见 engine.ts 的 makeInjectionTest。
 */

/**
 * 快照回填策略。
 *   auto（默认）没有匹配到站点规则包时才回填 —— 已有精确规则的站点不需要
 *                启发式，省掉一次同源请求（试点站 HTML 约 189KB）
 *   always      总是回填
 *   never       从不回填，启发式整体关闭
 */
const PRISTINE_STRATEGY: 'auto' | 'always' | 'never' = 'auto';

/**
 * 快照回填的等待上限。
 *
 * SW 侧要再抓一次整页（试点站约 189KB），实测会偶发长时间不返回。
 * 没有超时的话，整条 boot 会卡在这里 —— 症状是「元素确实被隐藏了，
 * 但没打印就绪日志、自学习一个域名都没记」。
 */
const BACKFILL_TIMEOUT_MS = 6000;

const store = chromeLocal();

async function loadPacks(url: string): Promise<SitePack[]> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'get-site-packs', url })) as
      | SitePack[]
      | undefined;
    return res ?? [];
  } catch (error) {
    console.warn('[adblow] 取站点规则包失败', error);
    return [];
  }
}

/** 取过滤列表里该主机名适用的域名专用 cosmetic 选择器。 */
async function requestListCosmetic(host: string): Promise<string[]> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'get-cosmetic', host })) as
      | { selectors?: string[] }
      | undefined;
    return res?.selectors ?? [];
  } catch (error) {
    console.warn('[adblow] 取列表 cosmetic 规则失败', error);
    return [];
  }
}

async function requestPristineHtml(url: string): Promise<string | null> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: 'get-pristine', url })) as
      | { html: string }
      | null;
    return res?.html ?? null;
  } catch (error) {
    console.warn('[adblow] 回填服务端快照失败', error);
    return null;
  }
}

function installCosmeticStyle(selectors: string[]): void {
  const style = document.createElement('style');
  style.setAttribute('data-adblow-cosmetic', '');
  style.textContent = cosmeticCss(selectors);
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * 过滤列表的域名专用 cosmetic 选择器（第二期）。
 *
 * 与「站点规则包选择器」的区别：
 *   - 规则包选择器经逐站取证 + fixture 回归测试 → 可信，直接进样式表
 *   - 列表选择器来自社区维护、覆盖上万域名 → **必须过内容守卫**
 *
 * 守卫逻辑在 content/listCosmetic.ts 里（document 由调用方注入，可单测）。
 */
function installListCosmetic(selectors: string[]): number {
  if (selectors.length === 0) return 0;
  // 列表规则必须同时过「内容」与「导航」两道闸门：
  // 社区列表是按域名批量套用的，一条过宽的选择器就能让整站正文或导航消失。
  const result = applyListCosmetic(
    document,
    selectors,
    (el) => holdsRealContent(el) || mustNotHide(el),
  );
  if (result.droppedForContent.length) {
    console.debug(
      `[adblow] 列表选择器会隐藏正文，已剔除 ${result.droppedForContent.length} 条：` +
        result.droppedForContent.slice(0, 3).map((s) => s.slice(0, 40)).join(' | '),
    );
  }
  if (result.droppedInvalid.length) {
    console.debug(`[adblow] 列表选择器非法，已剔除 ${result.droppedInvalid.length} 条`);
  }
  return result.injected;
}

async function boot(): Promise<void> {
  const host = location.hostname;

  // 安全阀：站点被关掉时立刻退出，一个都不碰
  if (await isSiteDisabled(store, host)) {
    console.debug(`[adblow] ${host} 已被用户关闭，本次不做任何处理`);
    return;
  }

  const packs = await loadPacks(location.href);
  const learned = await promotedSelectors(store, host);
  const selectorSet = selectorsFrom(packs, learned, (r) =>
    console.warn('[adblow] 规则包被误伤护栏拒绝，整包丢弃', r.packId, r.problems),
  );

  // ⚠️ 只有**规则包**选择器可以进防闪现样式表。
  //
  // 样式表在 document_start 生效，**没有任何元素级守卫**；而自学习选择器是
  // 自动推导的、未经取证。实测事故：自学习推导出 `.tjtagmanager`（站点外链
  // 包装类，内含 22 张图）与 `.post-card`（正文卡片类名）被写进样式表后，
  // 页面一开头就隐藏了一大片内容与图片。自学习选择器只走带守卫的逐元素判定。
  installCosmeticStyle(selectorSet.curated);

  // 过滤列表的域名专用 cosmetic 规则（第二期）。
  //
  // 越早注入越好（防闪现），但它是异步的（要向 SW 取分片），所以先发起请求，
  // 不阻塞后面的判定流程；拿到后再注入并走内容守卫。
  let listCosmeticCount = 0;
  void requestListCosmetic(host).then((selectors) => {
    listCosmeticCount = installListCosmetic(selectors);
    if (listCosmeticCount || selectors.length) {
      console.debug(
        `[adblow] 列表 cosmetic：候选 ${selectors.length} 条，通过内容守卫 ${listCosmeticCount} 条`,
      );
    }
    // 内容守卫依赖 DOM 已解析出元素；解析完成后再复核一次
    if (document.readyState === 'loading') {
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          listCosmeticCount = installListCosmetic(selectors);
        },
        { once: true },
      );
    }
  });

  // 只记录经宽度检查的泛化选择器；不合格的只隐藏、不建规则
  const learn = (hits: Hit[]): void => {
    for (const hit of hits) {
      const selector = recordableSelector(hit, document);
      if (selector) void recordHit(store, host, selector);
    }
  };

  /**
   * 网络层自学习：把「被隐藏的广告用到的跨站域名」记下来，够次数就晋级成
   * DNR 拦截规则。这是未知站点能**越用越好**的关键，且用户无需配置。
   *
   * 安全过滤（也被可见内容使用的域名一律不学）在 learnableAdDomains 里，
   * 有独立回归测试 —— 试点站的 pic.wvxrrip.cn 就是风险 A。
   */
  const learnAdDomains = (): void => {
    const candidates = learnableAdDomains(document, host);
    if (candidates.length > 0) void recordDomains(store, host, candidates, location.href);
  };

  // 阶段一：仅静态规则。injected 恒 false 即关闭启发式。
  let options: JudgeOptions = {
    injected: () => false,
    host,
    viewportArea: innerWidth * innerHeight,
    selectors: selectorSet,
  };

  let rule = 0;
  let heuristic = 0;

  /** 几何面积快照：用于发现「靠 CSS 撑大」的展开型广告。 */
  const tracker = createGrowthTracker();

  // 单一观察器 + 可变 options：阶段二升级时不必重建观察器，也不会重复处理
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const added = processAdded(node as Element, options);
        rule += added.rule;
        heuristic += added.hits.length;
        learn(added.hits);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // sweep 会跳过已隐藏的元素，因此多次累加不会重复计数
  const sweepNow = (): number => {
    const r = sweep(document.documentElement, options);
    learn(r.hits);
    rule += r.hiddenByRule;
    heuristic += r.hiddenByHeuristic;
    return r.hiddenByRule;
  };

  /**
   * 几何突增重判（随动伸缩 / 悬浮展开 / 自动放大）—— 独立一趟。
   *
   * 这类广告靠**纯 CSS 变化**工作：元素一直在页面上、只是又小又不起眼，
   * 鼠标移上去之后被撑成大图。不产生任何节点增删，因此 MutationObserver
   * 永远不触发 —— 验收实测里 8/18/21 三条全挂在这里。
   * 几何突增本身就是证据，所以这一趟不再要求"必须证明是脚本注入"。
   */
  const recheckGrown = (): number => {
    const grown = collectGrownElements(document, tracker, {
      viewportArea: innerWidth * innerHeight,
    });
    let n = 0;
    for (const el of grown) {
      const verdict = judgeGrownElement(el, options);
      if (verdict) {
        applyVerdict(el, verdict);
        heuristic += 1;
        n += 1;
      }
    }
    if (n) console.debug(`[adblow] 几何突增重判隐藏 ${n} 个元素`);
    return n;
  };

  /**
   * 链接农场（用大量不同外站链接堆出来的广告/SEO 垃圾块）—— 独立一趟。
   *
   * 取证：实测站点页脚有 39 个不同跨站域名的链接，由站点自己的 partners.js
   * 注入。单条跨站链接只值 4 分（低于 6 分门槛，这是故意的），
   * 容器又因后代过多不采信后代信号 —— 所以必须单独判。
   */
  const hideLinkFarms = (): number => {
    const farms = findLinkFarms(document, { host });
    for (const el of farms) {
      hideElement(el, 'linkfarm');
      heuristic += 1;
    }
    if (farms.length) console.debug(`[adblow] 链接农场：隐藏 ${farms.length} 个块`);
    return farms.length;
  };

  /**
   * 假关闭按钮（伪装成关闭的跨站链接）—— 独立一趟。
   *
   * 小浮窗过不了覆盖层面积阈值，又常常没有任何广告命名，常规判据抓不到。
   * 但「关闭控件却是跨站链接」本身极可疑：正常站点的关闭按钮不会把人带去别的域名。
   */
  const hideFakeClose = (): number => {
    const ads = findFakeCloseAds(document, { host });
    for (const { element, hit } of ads) {
      hideElement(element, 'fake-close');
      heuristic += 1;
      learn([hit]);
    }
    if (ads.length) console.debug(`[adblow] 假关闭按钮：隐藏 ${ads.length} 个广告浮窗`);
    return ads.length;
  };

  /**
   * 隐形点击层（点击劫持）—— 独立一趟。
   *
   * 与覆盖层同理，几何与样式判断不能进逐元素打分的热路径。
   * 主动隐藏它比「等用户点击时再拦」更好：隐藏后点击根本落不到它上面，
   * 而且隐藏一个「渲染不出任何可见内容」的元素在视觉上是零影响。
   */
  const hideClickLayers = (): number => {
    const layers = findInvisibleClickLayers(document, {
      viewportArea: innerWidth * innerHeight,
    });
    for (const el of layers) {
      hideElement(el, 'click-layer');
      heuristic += 1;
    }
    if (layers.length) {
      console.debug(`[adblow] 已隐藏 ${layers.length} 个隐形点击层`);
    }
    return layers.length;
  };

  /**
   * 覆盖层单独一趟（不参与逐元素打分，见 findOverlays 的说明）。
   *
   * 放在最后跑：此时普通规则与启发式都已落地，覆盖层的旁证判定能拿到最完整的
   * 上下文；而且它自己会改内联样式，放在打分之后才不会拖慢扫描。
   */
  const hideOverlays = (): number => {
    const ads = findOverlayAds(document, { host, viewportArea: innerWidth * innerHeight });
    for (const { element, hit } of ads) {
      hideElement(element, 'overlay');
      heuristic += 1;
      learn([hit]);
    }
    return ads.length;
  };

  // 首屏：此刻能扫到的部分。注意 document_start 时正文还没解析出来，
  // 这一趟通常只覆盖到 <head>，真正的清扫靠下一趟。
  sweepNow();

  /**
   * 收尾工作：覆盖层、网络层自学习、统计。
   *
   * ⚠️ **绝不能排在快照回填之后**（2026-10-10 实测踩坑）：
   * 回填要由 SW 再抓一次整页（试点站 189KB），它慢或挂住时，后面这些收尾
   * 就全被堵死——症状是「页面元素确实被隐藏了，但 AdBlow 没打印就绪日志、
   * 自学习一个域名都没记」。而这些工作**本来就不依赖回填**。
   */
  const upkeep = (label: string): void => {
    // 先跑几何巡检：第一轮建立面积基线，后续轮次才能发现"被撑大"
    recheckGrown();
    const farms = hideLinkFarms();
    const fakeClose = hideFakeClose();
    const layers = hideClickLayers();
    const overlays = hideOverlays();
    // 复核"我们隐藏过的元素是否又被显示回来了"。
    // 必须放在最后：刚隐藏的元素立刻复核没有意义，而站点改回显示
    // 通常发生在它自己的脚本跑完之后（实测 1024cg 的广告弹层就是这样，
    // 不复核的话整页链接都点不动，而我们还以为自己拦住了）。
    const audit = verifyHiding(document);
    learnAdDomains();
    void writeStats(store, host, { rule, heuristic });
    console.debug(
      `[adblow] ${label} host=${host} 规则包=${packs.length} ` +
        `选择器=${selectorSet.curated.length}包+${selectorSet.learned.length}学 ` +
        `隐藏 rule=${rule} heuristic=${heuristic} overlay=${overlays} 点击层=${layers} ` +
        `假关闭=${fakeClose} 链接农场=${farms} ` +
        `复核=${audit.checked}/重新隐藏=${audit.refought}` +
        (audit.stubborn.length ? ` 顽固=[${audit.stubborn.slice(0, 3).join(' ')}]` : ''),
    );
  };

  /**
   * 按需几何巡检：只在鼠标移入 / 滚动之后跑，而不是常驻轮询。
   *
   * 展开型广告的触发条件就是"鼠标移进来"或"滚动到视野"，因此这两个时机
   * 之后再查一次既够用，又没有常驻定时器的开销。
   * （同样地：常驻定时器还会让"把构建产物跑起来的测试"无法退出进程。）
   */
  let geometryTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleGeometryPass = (): void => {
    if (document.hidden || geometryTimer !== null) return;
    geometryTimer = setTimeout(() => {
      geometryTimer = null;
      recheckGrown();
      hideFakeClose();
      hideLinkFarms();
    }, GEOMETRY_DEBOUNCE_MS);
  };

  for (const type of ['mouseover', 'pointerover', 'scroll', 'wheel'] as const) {
    document.addEventListener(type, scheduleGeometryPass, { capture: true, passive: true });
  }

  // 关键：DOM 解析完成后必须再扫一次。
  // 只依赖 MutationObserver 也能补上，但显式扫一遍更可靠（观察器可能丢事件），
  // 实测第一版就因为只扫了 document_start 那一趟而统计到 隐藏 rule=0。
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => {
      document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
    sweepNow();
  }

  // 阶段一收尾：不依赖回填，立刻落地
  upkeep('就绪(仅静态规则)');

  // 延迟几轮再收尾一次，覆盖懒加载与延迟注入的广告位。
  // 用有限的几次而不是常驻定时器，避免长驻开销。
  for (const delay of [4000, 12000]) {
    setTimeout(() => upkeep('巡回收尾'), delay);
  }

  // 阶段二：回填完整服务端快照，启用启发式。
  // ⚠️ 必须带超时：SW 侧要再抓一次整页，卡住时不能让判定一直停在静态档。
  const wantBackfill =
    PRISTINE_STRATEGY === 'always' || (PRISTINE_STRATEGY === 'auto' && packs.length === 0);
  if (!wantBackfill) return;

  const html = await withTimeout(requestPristineHtml(location.href), BACKFILL_TIMEOUT_MS);
  if (!html) {
    console.debug('[adblow] 快照回填未在超时内返回，保持仅静态规则档');
    return;
  }

  try {
    const index = buildPristineIndexFromHtml(html, new DOMParser());
    // 升级为带启发式的判定；已处理过的节点会被下面的全量 sweep 重新覆盖
    options = { ...options, injected: makeInjectionTest(index, true) };
    sweepNow();
    upkeep('就绪(含启发式)');
  } catch (error) {
    console.warn('[adblow] 解析服务端快照失败，退化为仅静态规则', error);
  }
}

void boot();
