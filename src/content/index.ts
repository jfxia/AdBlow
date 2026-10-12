import { buildPristineIndexFromHtml } from '../engine/pristine.ts';
import { withTimeout } from '../engine/async.ts';
import { findInvisibleClickLayers } from '../engine/clickLayer.ts';
import type { SitePack } from '../engine/rules.ts';
import {
  cosmeticCss,
  findOverlayAds,
  hideElement,
  learnableAdDomains,
  makeInjectionTest,
  processAdded,
  recordableSelector,
  selectorsFrom,
  sweep,
  type Hit,
  type JudgeOptions,
} from './engine.ts';
import { promotedSelectors, recordHit } from './learn.ts';
import { recordDomains } from './domainLearn.ts';
import { isSiteDisabled, writeStats } from './settings.ts';
import { chromeLocal } from './storage.ts';

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
      hideElement(el);
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
      hideElement(element);
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
    const layers = hideClickLayers();
    const overlays = hideOverlays();
    learnAdDomains();
    void writeStats(store, host, { rule, heuristic });
    console.debug(
      `[adblow] ${label} host=${host} 规则包=${packs.length} ` +
        `选择器=${selectorSet.curated.length}包+${selectorSet.learned.length}学 ` +
        `隐藏 rule=${rule} heuristic=${heuristic} overlay=${overlays} 点击层=${layers}`,
    );
  };

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
