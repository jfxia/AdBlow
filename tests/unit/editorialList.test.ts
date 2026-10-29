import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJudge,
  looksLikeEditorialList,
  EDITORIAL_LIST_MIN_LINKS,
} from '../../src/content/engine.ts';

/**
 * 误杀回归：门户站把**广告位容器**命名成 `directAd_*` / `m-p-ad-*`，没有广告填充时里面回退显示
 * 编辑列表。命名里的 `ad` 命中强词表，此前只凭名字（= 阈值）就整块隐藏。
 *
 * 真实现场（2026-10-19，finance.sina.com.cn 首页）：9 个内容列表被隐藏，最多一条含 22 个站内
 * 文章链接，合计影响 455 字符的正文。
 *
 * ⚠️ 写法说明（2026-10-29 AdBlow 事故后）：站点原文是驼峰 `directAd_*`。驼峰不再切词，所以
 * `directad` 现在不产生命名证据 —— 这条用例若继续用原文写法，就会因为"根本没有命名"而通过，
 * 悄悄失去对"强命名不得盖过编辑列表形状"这一层的覆盖。因此改用等价的分隔符写法
 * `direct-ad_*`，让命名证据照旧成立。驼峰原文写法现在是**已知漏判**，见
 * tests/unit/lexicon.test.ts 的"不再按驼峰切词"用例。
 */

const PAGE = 'finance.sina.com.cn';

function el(html: string): Element {
  const box = document.createElement('div');
  box.innerHTML = html;
  return box.firstElementChild!;
}

const HEADLINE_TEXT = '债务违约未及时披露 金煤科技及相关责任人被监管警示 安徽村镇银行密集村改支';

/** n 条站内（绝对地址）文章链接，每条带完整标题（真实列表的文字量级） */
function sameSiteLinks(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `<li><a href="https://finance.sina.com.cn/2026-10-19/doc-${i}.shtml">${HEADLINE_TEXT} ${i}</a></li>`,
  ).join('');
}

describe('looksLikeEditorialList：识别"广告位里的编辑列表"', () => {
  it('多条站内文章链接 + 正文：判为编辑列表', () => {
    const node = el(`<ul id="direct-ad_dell_fidx_01" class="m-list">${sameSiteLinks(4)}</ul>`);
    assert.equal(looksLikeEditorialList(node, PAGE), true);
  });

  it('链接不足阈值：不算编辑列表', () => {
    const node = el(`<ul id="ad_slot">${sameSiteLinks(EDITORIAL_LIST_MIN_LINKS - 1)}</ul>`);
    assert.equal(looksLikeEditorialList(node, PAGE), false);
  });

  it('文字过少：不算编辑列表（广告位常见一两个词的按钮）', () => {
    const node = el('<div class="ad"><a href="/x">立即购买</a><a href="/y">了解更多</a><a href="/z">详情</a></div>');
    assert.equal(looksLikeEditorialList(node, PAGE), false);
  });

  it('只有跨站链接：是创意，不是编辑列表', () => {
    const node = el(
      `<div class="ad">${HEADLINE_TEXT}
        <a href="https://ads.example.com/a">a</a>
        <a href="https://ads.example.com/b">b</a>
        <a href="https://ads.example.com/c">c</a>
      </div>`,
    );
    assert.equal(looksLikeEditorialList(node, PAGE), false);
  });

  it('相对地址按同站计算', () => {
    const node = el(
      `<ul>${HEADLINE_TEXT}
        <li><a href="/a.shtml">a</a></li><li><a href="/b.shtml">b</a></li><li><a href="/c.shtml">c</a></li>
      </ul>`,
    );
    assert.equal(looksLikeEditorialList(node, PAGE), true);
  });

  it('javascript: 与锚点链接不计数', () => {
    const node = el(
      `<ul>${HEADLINE_TEXT}
        <li><a href="javascript:void(0)">a</a></li><li><a href="#top">b</a></li><li><a href="/c.shtml">c</a></li>
      </ul>`,
    );
    assert.equal(looksLikeEditorialList(node, PAGE), false);
  });

  it('已被我们隐藏的子块里的链接不计数', () => {
    const node = el(
      `<ul id="directAd_x">${HEADLINE_TEXT}
        <li data-adblow-hidden="1"><a href="/a">a</a></li>
        <li data-adblow-hidden="1"><a href="/b">b</a></li>
        <li data-adblow-hidden="1"><a href="/c">c</a></li>
      </ul>`,
    );
    assert.equal(looksLikeEditorialList(node, PAGE), false);
  });
});

describe('createJudge 第一层：命名不再盖过内容形状', () => {
  const judge = createJudge(() => false, PAGE, 1920 * 1080);

  it('direct-ad_*（原站 directAd_*，见文件头写法说明）里的编辑列表不再被隐藏', () => {
    const node = el(`<ul id="direct-ad_dell_fidx_01" class="m-list">${sameSiteLinks(6)}</ul>`);
    assert.equal(judge(node), null);
  });

  it('同样的容器若带跨站广告证据（行为分达标），仍然隐藏', () => {
    // 刻意保持紧凑（后代 ≤ 12）：超过上限时行为信号不累计（scoreNode 的 compact 规则），
    // 那条是另一层设计，这里要验证的是"有了行为证据后命名+编辑形状仍然可判"。
    const node = el(
      `<ul id="direct-ad_dell_fidx_01" class="m-list">${sameSiteLinks(3)}
        <li><a href="https://ads.example.com/a?utm_source=x">a</a></li>
        <li><a href="https://ads.example.com/b?utm_source=x">b</a></li>
      </ul>`,
    );
    const hit = judge(node);
    assert.ok(hit, '有跨站链接与推广参数时应判定为广告');
  });

  it('纯创意（广告位里没有编辑列表）：命名仍可单独决定', () => {
    const node = el('<div id="ad_05532" style="position:fixed"></div>');
    assert.ok(judge(node));
  });

  it('普通容器不会被误判', () => {
    const node = el(`<ul class="m-list">${sameSiteLinks(6)}</ul>`);
    assert.equal(judge(node), null);
  });
});
