import type { DnrRule } from './dnr.ts';
import type { ResourceType } from './rules.ts';

/**
 * 把「自学习到的广告域名」编译成 DNR 拦截规则。
 *
 * ⚠️ 三条硬性安全约束（每一条都对应一次真实故障或明确的误伤风险）：
 *
 * 1. **绝不拦 `main_frame`。** 这些域名是从被隐藏的广告里学来的，通常也是广告
 *    落地页。用户完全可能主动点击（或者域名被复用于正常站点）——拦掉 main_frame
 *    会让导航直接失败，那是最难排查的故障。只拦子资源。
 *
 * 2. **绝不拦 `image` / `media`。** 见 SUBRESOURCE_TYPES 的说明：
 *    内容图与广告素材共用 CDN 太常见，拦图片会让「整站图片不显示」。
 *
 * 3. **按站点豁免。** 域名是全局概念（`ads.x.com` 在哪个站点都是广告域名），
 *    所以规则是全局的；但用户手动关掉某个站点时，那些站点下必须全部豁免，
 *    否则「关掉本站」只停了 DOM 层、网络层照旧，用户会觉得开关没用。
 */

/** 「学习到的广告域名」规则占用的 id 区间，避免与站点规则包冲突。 */
export const LEARNED_DOMAIN_ID_BASE = 30000;

/**
 * 自学习域名规则允许拦截的资源类型。
 *
 * ⚠️ **刻意不含 `image` 与 `media`**（2026-10-10 一次真实事故的教训）：
 * 曾经把全部子资源类型都放进来自学习规则，结果 1024cg 首页**所有图片都不显示**——
 * 该站的内容缩略图与广告素材共用同一个 CDN（`pic.jtzatly.cn`），
 * 域名被学走后连带把正文图片一起拦掉了。
 *
 * ⚠️ **也不含 `script` / `stylesheet` / `font`**（2026-10-13 第二次同类事故）：
 * 用户报告某视频站开启过滤后"播放器、推荐栏被屏蔽"。取证结果：
 *   - 服务端 HTML 只有 18 个 `<img>`，而开启过滤后页面**恰好只剩这 18 个**；
 *     未开启时有 67 个（多出的都是页面 JS 运行时创建的）
 *   - 播放器库 `Hls` 未定义、播放器容器 690x0（库来自站点 CDN）
 *   → 即"**创建这些元素的脚本没跑**"，而不是元素被隐藏
 * 该站的关键脚本（jquery / common.js / owl.carousel / carousel-owl）与播放器库
 * （plyr / hls.js）**全部来自它自己的 CDN**。一旦自学习把该 CDN 域名学成广告域名，
 * 就会在整站范围拦掉站点自己的 CSS/JS —— 整页功能与渲染一起崩掉。
 *
 * 结构性保证：**自学习来的网络规则永远不可能弄坏页面自身的图片、视频、样式与脚本。**
 * 代价：漏掉少量"广告脚本"本身。这部分价值很小 —— 广告脚本的拦截由**静态过滤列表**
 * 覆盖（那正是 EasyList/uBO 的强项），自学习真正独特的价值在长尾的
 * `sub_frame`（弹窗）/`xmlhttprequest`（信标）/`ping`/`websocket`。
 * 而误伤的代价是整页失效 —— 两者的不对称性决定了取舍。
 */
export const SUBRESOURCE_TYPES: ResourceType[] = [
  'sub_frame',
  'object',
  'xmlhttprequest',
  'ping',
  'websocket',
  'other',
];

/** 一条自学习域名：域名 + **教会它的站点**（用于限制爆炸半径）。 */
export type LearnedDomain = {
  domain: string;
  /** 在哪些页面宿主上学会了它。为空表示不限制（向后兼容）。 */
  initiators?: string[];
};

export function learnedDomainRules(
  domains: (string | LearnedDomain)[],
  excludedInitiatorDomains: string[] = [],
  idBase: number = LEARNED_DOMAIN_ID_BASE,
): DnrRule[] {
  const exclusions = [...new Set(excludedInitiatorDomains)].filter(Boolean).sort();

  return domains.map((raw, i) => {
    const domain = typeof raw === 'string' ? raw : raw.domain;
    const initiators =
      typeof raw === 'string' ? [] : [...new Set(raw.initiators ?? [])].filter(Boolean).sort();

    return {
      id: idBase + i,
      /**
       * 优先级 2：**高于列表普通拦截（1）、低于列表例外（3）**。
       *
       * 这个次序是有意的：自学习会学错（域名被复用于正常服务、或站点改版），
       * 所以必须留一条"列表例外能推翻自学习"的退路。
       * 见 filterList/compile.ts 的 PRIORITY 表。
       */
      priority: 2,
      action: { type: 'block' as const },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: SUBRESOURCE_TYPES,
        /**
         * ❗爆炸半径限制：自学习规则**只在教会它的站点上生效**。
         *
         * 域名是全局概念这句话有前提 —— "这个域名在本站是广告域名"不等于
         * "它在别的站点也是"。而第三方 CDN 被多个站点共用时，
         * 在 A 站学到的"广告域名"很可能正是 B 站自己的资源来源。
         * 所以即使学错了，也不会波及没有教过它的站点。
         *
         * （跨站点的通用广告域名由**静态列表**负责，那才是它们擅长的部分。）
         */
        ...(initiators.length ? { initiatorDomains: initiators } : {}),
        // 用户手动关掉的站点下要豁免：否则「关掉本站」只停了 DOM 层
        ...(exclusions.length ? { excludedInitiatorDomains: exclusions } : {}),
      },
    };
  });
}
