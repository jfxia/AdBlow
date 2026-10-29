import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge, recordableSelector } from '../../src/content/engine.ts';

/**
 * 事故回归（2026-10-29）：AdBlow 在微软 Partner Center 的**扩展列表页**把自己的商店条目隐藏了。
 *
 * 用户保存的页面里有这两段（属性已节选）：
 *
 *   <img src="…/logoicon" title="AdBlow"
 *        data-adblow-hidden="1" data-adblow-reason="heuristic"
 *        data-adblow-why="ad-naming,cross-site-media">
 *   <a aria-label="AdBlow In the Store"
 *      data-adblow-hidden="1" data-adblow-reason="learned"
 *      data-adblow-why="ad-naming,learned-selector">
 *
 * 根因：命名匹配按前缀/驼峰切词，`AdBlow` 被拆成 `ad` + `blow`，命中强词 `ad`；命名 6 分 +
 * 跨站素材 3 分越过阈值 6，条目被隐藏。随后这次命中的选择器被记进自学习库并晋级，链接从此被
 * `learned` 规则永久隐藏 —— 即使命名修好也还在。
 *
 * 本文件跑的是真实判定的前两层（命名 / 行为），不是词库单测；它证明"页面原样"不再被隐藏。
 */

const HOST = 'partner.microsoft.com';
const VIEWPORT = 1920 * 1080;

/** 最坏情况：允许纯行为层参与（真实页面上第三方素材来自微软自家 CDN 时它也会参与）。 */
const judge = createJudge(() => true, HOST, VIEWPORT);

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

/** Partner Center 列表里我们自己那一行的实际形状（属性按快照还原）。 */
const SELF_ROW = `
  <div class="store-listing-row">
    <img src="https://store-images.s-microsoft.com/image/apps.12345/logoicon" title="AdBlow">
    <a class="store-listing-link" href="/en-us/dashboard/account/extensions"
       aria-label="AdBlow In the Store">AdBlow</a>
  </div>`;

describe('真实事故复盘：AdBlow 自己的商店条目不再被隐藏', () => {
  it('❗title="AdBlow" 的图标不隐藏（原先 ad-naming + cross-site-media）', () => {
    const doc = root(SELF_ROW);
    const img = doc.querySelector('img')!;
    const verdict = judge(img);
    assert.equal(verdict, null, `图标被隐藏了：${JSON.stringify(verdict)}`);
  });

  it('❗aria-label="AdBlow In the Store" 的链接不隐藏（原先 learned-selector）', () => {
    const doc = root(SELF_ROW);
    const link = doc.querySelector('a')!;
    assert.equal(judge(link), null);
  });

  it('❗整个商店条目行不隐藏（祖先也不能被连带判定）', () => {
    const doc = root(SELF_ROW);
    const row = doc.querySelector('.store-listing-row')!;
    assert.equal(judge(row), null);
  });

  it('同一行换成真实的广告命名仍然会被隐藏（收紧没有把信号一起关掉）', () => {
    const doc = root(
      SELF_ROW.replace('class="store-listing-row"', 'class="ad-slot store-listing-row"'),
    );
    const row = doc.querySelector('div')!;
    assert.ok(judge(row), '类名里出现广告词元时，判定不该退化');
  });

  it('这条链接若只靠 aria-label 被判广告，也不会被学成规则', () => {
    // 事故的第二半：错误从一次性隐藏扩散成永久规则。标签属性是唯一命名证据时不得入库。
    const doc = root('<a class="store-listing-link" aria-label="advertisement" href="#"></a>');
    const link = doc.querySelector('a')!;
    const verdict = judge(link);
    assert.ok(verdict, '前提：aria-label=advertisement 仍然足以隐藏（可以隐藏，但不学）');
    assert.equal(recordableSelector(verdict, doc), null, '仅凭标签属性命名的命中不得写入学习库');
  });
});
