/**
 * 自研广告命名识别（词库）。
 *
 * ⚠️ 2026-10-10 第二次取证后重写。旧版有两个致命问题，在第二站点
 * （1024cg.com）上完全失效：
 *
 *   1. **用的是子串匹配 + 很小的词表**，`ad-item`、`ads-title`、`post-card-ads`
 *      这些最直白的命名一个都认不出——连最基本的整词 `ad` 都不认。
 *   2. 词表里塞了试点站专属标记当通用词，等于把通用性寄托在个案上。
 *
 * 现在改为**整词分档**：把 class/id/属性名按非字母数字切词，只认独立词，
 * 因此 `download` / `header` / `thread` / `shadow` / `gradient` / `add` 这些
 * 含 "ad" 字母的词不会被误判，而 `ad-card-0` → ['ad','card','0'] 能命中。
 *
 * 分档的理由（避免误伤是第一优先级）：
 *   - SSP 专属标记：我们实际逆向取证过的，单独出现即可判定
 *   - 强命名：广告专用术语，正常页面内容不会这么命名
 *   - 弱命名：在正常 UI 里也常见（banner / popup / float / sponsor），
 *     单独出现**不足以**判定，必须另有旁证
 */

/** 3 = 站点取证标记；2 = 强命名；1 = 弱命名；0 = 无信号 */
export const NAMING_SSP = 3;
export const NAMING_STRONG = 2;
export const NAMING_WEAK = 1;
export const NAMING_NONE = 0;

/**
 * 站点取证标记（专属，来自对 ad-sdk 与 ssp.css 的逆向）。
 * 这些是证据，不是猜测。
 */
const SSP_SUBSTRINGS = ['data-ssp-', 'xqbj-component-ssp', 'xqbj-recommand-item-banner'];

/**
 * 强命名：广告专用术语，正常页面内容不会这样命名。
 * 整词匹配，因此 'ad' 只认独立词。
 */
const STRONG_TOKENS = new Set([
  'ad',
  'ads',
  'adv',
  'advert',
  'adverts',
  'advertising',
  'advertisement',
  'advertisements',
  'adbox',
  'adslot',
  'adunit',
  'aditem',
  'adcard',
  'adwrap',
  'adcontainer',
  'adspop',
  'admask',
  'adframe',
  'adserver',
  'adsystem',
  'adbanner',
  'doubleclick',
  'guanggao',
  'popunder',
  'preroll',
  'interstitial',
  'ssp',
  // 视频广告的行业通用术语（2026-10-10 验收实测补入）：
  // outstream/instream 是页外流与内嵌流的标准叫法，vast/vmap/vpaid 是
  // IAB 的广告投放协议名，正常页面内容不会用这些词命名。
  'outstream',
  'instream',
  'vast',
  'vmap',
  'vpaid',
]);

/** 连写/无分隔符形式：整词切不出来，只能子串匹配。 */
const STRONG_SUBSTRINGS = [
  'adsbygoogle',
  'doubleclick',
  'adserver',
  'adsystem',
  'guanggao',
  'advertisement',
  // 'ssp' 是广告技术专有缩写，几乎不会出现在正常命名里；
  // 而且站点常用连写形式（`tjssp`），整词切不出来，必须子串匹配
  'ssp',
];

/**
 * 弱命名：在正常 UI 里同样常见，单独出现不能判定。
 * 例如 `<header class="no-banner-image">`、站点自己的 popup.js、
 * 以及「sponsors 鸣谢名单」这类合法内容。
 */
const WEAK_TOKENS = new Set([
  'banner',
  'promo',
  'promotion',
  'promoted',
  'sponsor',
  'sponsored',
  'popup',
  'pop',
  'float',
  'gg',
  // 粘性横幅（底部/顶部固定条）。在正常 UI 里 `sticky` 也用于粘性页头，
  // 所以只作为弱词：必须另有跨站链接/素材等旁证才成立。
  'sticky',
  // 广告轮播容器（2026-10-13 实测漏拦）。
  // 真实案例：站点用 `Banner2` 类把广告挂进 `.streamer-container2` /
  // `ul.streamer-box2`，里面 3 张广告图来自 3 个不同的广告域名。
  // 收成弱词而不是强词：直播站的"主播卡片"也可能叫 streamer。
  'streamer',
  'couplet',
  'piaofu',
]);

/**
 * 刻意**不**收录的词（记录取舍，避免以后有人"顺手加上"）：
 *
 * - `overlay`：`.overlay` / `.modal-overlay` 是合法对话框的通用类名
 *   （Bootstrap 等大量框架在用），而这类对话框常含跨站链接（分享、支付），
 *   收进来会把正常对话框一起隐藏。视频叠加广告改用**几何判据**解决
 *   （见 content/engine.ts 的「播放器内覆盖」分支）。
 * - `video`：任何视频播放器都会命中，收进来等于隐藏全站视频。
 */

/** 否定前缀：`no-banner-image` 里的 banner 不算信号。 */
const NEGATIONS = new Set(['no', 'not', 'non', 'without']);

const SPLIT = /[^a-z0-9]+/;

export type NamingSignal = {
  strength: number;
  /** 命中的词或标记，便于调试与统计 */
  matched: string[];
};

export function namingSignal(el: Element): NamingSignal {
  const hay = [
    el.getAttribute('class') ?? '',
    el.getAttribute('id') ?? '',
    Array.from(el.attributes)
      .map((a) => a.name)
      .join(' '),
  ].join(' ');

  // ① 站点取证标记（子串，专属）
  for (const marker of SSP_SUBSTRINGS) {
    if (hay.includes(marker)) return { strength: NAMING_SSP, matched: [marker] };
  }

  // ② 连写强形式（子串）
  for (const sub of STRONG_SUBSTRINGS) {
    if (hay.includes(sub)) return { strength: NAMING_STRONG, matched: [sub] };
  }

  // ③ 整词匹配
  //
  // ⚠️ 分词前必须**切开驼峰与数字边界**（2026-10-13 实测漏拦）：
  // 站点把顶部横幅广告命名为 `.topBanner`，而 `topbanner` 与 `banner` 不是同一个词，
  // 于是这个明显的广告容器完全匹配不到任何词表项。
  // 切开后 `topBanner` → `top banner` ✓、`adCard0` → `ad card 0` ✓。
  const normalized = hay.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  const tokens = normalized.split(SPLIT).filter(Boolean);
  const strong: string[] = [];
  const weak: string[] = [];

  for (const [i, token] of tokens.entries()) {
    const negated = i > 0 && NEGATIONS.has(tokens[i - 1]!);
    if (negated) continue;
    if (STRONG_TOKENS.has(token)) strong.push(token);
    else if (WEAK_TOKENS.has(token)) weak.push(token);
  }

  if (strong.length) return { strength: NAMING_STRONG, matched: strong };
  if (weak.length) return { strength: NAMING_WEAK, matched: weak };
  return { strength: NAMING_NONE, matched: [] };
}

/** 兼容入口：只需强度时用它。 */
export function adSignalStrength(el: Element): number {
  return namingSignal(el).strength;
}
