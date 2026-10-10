import { buildPristineIndexFromHtml } from '../engine/pristine.ts';
import type { SitePack } from '../engine/rules.ts';
import {
  cosmeticCss,
  makeInjectionTest,
  processAdded,
  recordableSelector,
  selectorsFrom,
  sweep,
  type Hit,
  type JudgeOptions,
} from './engine.ts';
import { promotedSelectors, recordHit } from './learn.ts';
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
  const selectors = selectorsFrom(packs, learned, (r) =>
    console.warn('[adblow] 规则包被误伤护栏拒绝，整包丢弃', r.packId, r.problems),
  );

  // 第一道防线：防闪现样式表，早于广告 SDK 注入就位
  installCosmeticStyle(selectors);

  // 只记录经宽度检查的泛化选择器；不合格的只隐藏、不建规则
  const learn = (hits: Hit[]): void => {
    for (const hit of hits) {
      const selector = recordableSelector(hit, document);
      if (selector) void recordHit(store, host, selector);
    }
  };

  // 阶段一：仅静态规则。injected 恒 false 即关闭启发式。
  let options: JudgeOptions = {
    injected: () => false,
    host,
    viewportArea: innerWidth * innerHeight,
    selectors,
  };

  // 单一观察器 + 可变 options：阶段二升级时不必重建观察器，也不会重复处理
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === 1) learn(processAdded(node as Element, options));
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  const first = sweep(document.documentElement, options);
  learn(first.hits);

  let rule = first.hiddenByRule;
  let heuristic = first.hiddenByHeuristic;
  let mode = '仅静态规则';

  // 阶段二：回填完整服务端快照，启用启发式
  const wantBackfill =
    PRISTINE_STRATEGY === 'always' || (PRISTINE_STRATEGY === 'auto' && packs.length === 0);

  if (wantBackfill) {
    const html = await requestPristineHtml(location.href);
    if (html) {
      try {
        const index = buildPristineIndexFromHtml(html, new DOMParser());
        // 升级为带启发式的判定；已处理过的节点会被下面的全量 sweep 重新覆盖
        options = { ...options, injected: makeInjectionTest(index, true) };

        const second = sweep(document.documentElement, options);
        learn(second.hits);

        rule = second.hiddenByRule;
        heuristic = second.hiddenByHeuristic;
        mode = '含启发式';
      } catch (error) {
        console.warn('[adblow] 解析服务端快照失败，退化为仅静态规则', error);
      }
    } else {
      mode = '仅静态规则（快照回填失败）';
    }
  }

  await writeStats(store, host, { rule, heuristic });
  console.debug(
    `[adblow] 就绪(${mode}) host=${host} 规则包=${packs.length} ` +
      `选择器=${selectors.length} 隐藏 rule=${rule} heuristic=${heuristic}`,
  );
}

void boot();
