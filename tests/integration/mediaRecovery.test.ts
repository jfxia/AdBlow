import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIDDEN_ATTR,
  KEEP_ATTR,
  REASON_ATTR,
  createKeepState,
  hideElement,
  isHidden,
  isKept,
  isPlayingVideo,
  judgeElement,
  recoverMediaBlocks,
  selectorsFrom,
  sweep,
  type JudgeOptions,
} from '../../src/content/engine.ts';

// Second layer for the real YouTube Shorts bug (2026-10-29): the content area holds almost no
// text, so the content guards do not apply. When the block was judged, its lazy-loaded <video>
// did not exist yet; the empty block scored as an ad slot and was hidden. The video was then
// inserted into the already hidden container, and `display:none` does not stop playback:
// "sound plays, no picture".
//
// The primary fixes live elsewhere (role="main" absolute protection, attribute names are not
// naming evidence). This pass is the reverse direction of verifyHiding, for sites where a
// genuinely misjudged block only reveals itself once a video starts playing inside it.

const HOST = 'www.youtube.com';

function options(keep?: ReturnType<typeof createKeepState>): JudgeOptions {
  return {
    injected: () => true,
    host: HOST,
    viewportArea: 0,
    selectors: selectorsFrom([], []),
    keep,
  };
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

/** jsdom never decodes media; make the video look like it is playing with a picture. */
function play(
  video: Element | null,
  width = 640,
  paused = false,
): HTMLVideoElement {
  assert.ok(video && video.tagName === 'VIDEO', '测试桩需要 <video>');
  Object.defineProperty(video, 'videoWidth', { value: width, configurable: true });
  Object.defineProperty(video, 'paused', { value: paused, configurable: true });
  return video as HTMLVideoElement;
}

describe('❗recoverMediaBlocks：判定后才插入 video 的区块被恢复', () => {
  it('行为判定误隐藏的空容器，视频开始播放后被恢复', () => {
    // Ad-like evidence without any video: two cross-site links (behaviour 8 ≥ threshold 6).
    const block = mount(
      '<div id="shorts-stage">' +
        '<a href="https://ads.example.net/x">a</a>' +
        '<a href="https://spy.example.org/y">b</a>' +
        '</div>',
    );

    sweep(document.documentElement, options());
    assert.equal(isHidden(block), true, '前提：判定时还没有 video，区块被当成广告位隐藏');
    assert.equal(block.getAttribute(REASON_ATTR), 'heuristic');

    // The player mounts its video later, inside the hidden container.
    const video = document.createElement('video');
    block.appendChild(video);
    play(video);

    const keep = createKeepState();
    const result = recoverMediaBlocks(document, keep);

    assert.equal(result.restored, 1);
    assert.equal(result.checked, 1);
    assert.equal(isHidden(block), false);
    assert.equal(block.getAttribute(REASON_ATTR), null, '判定理由也要清掉，便于事后区分');
    assert.equal(block.getAttribute(KEEP_ATTR), '1');
    assert.equal(block.style.getPropertyValue('display'), '', '内联隐藏必须撤掉');
    assert.equal(block.style.getPropertyValue('visibility'), '');
    assert.equal(block.style.getPropertyPriority('display'), '');
    assert.equal(result.selectors.includes('#shorts-stage'), true);
  });

  it('恢复是幂等的：再跑一次不重复计数', () => {
    const block = mount('<div id="stage"><video></video></div>');
    hideElement(block, 'heuristic');
    play(block.querySelector('video'));

    const keep = createKeepState();
    assert.equal(recoverMediaBlocks(document, keep).restored, 1);
    assert.equal(recoverMediaBlocks(document, keep).restored, 0);
    assert.equal(recoverMediaBlocks(document, keep).checked, 0);
  });
});

describe('❗恢复条件必须收得很紧：这些一律不恢复', () => {
  it('强广告命名的区块即使有 video 也不恢复（.video-ads / ytp-ad-*）', () => {
    for (const cls of ['video-ads', 'ytp-ad-module', 'ad-slot']) {
      const block = mount(`<div class="${cls}"><video></video></div>`);
      hideElement(block, 'heuristic');
      play(block.querySelector('video'));
      assert.equal(recoverMediaBlocks(document).restored, 0, cls);
      assert.equal(isHidden(block), true, cls);
      assert.equal(block.getAttribute(KEEP_ATTR), null, cls);
    }
  });

  it('video 外面套着强广告命名的播放器容器时也不恢复', () => {
    const block = mount(
      '<div id="stage"><div class="ytp-ad-module"><video></video></div></div>',
    );
    hideElement(block, 'heuristic');
    play(block.querySelector('video'));
    assert.equal(recoverMediaBlocks(document).restored, 0);
    assert.equal(isHidden(block), true);
  });

  it('picked（用户显式选择）不恢复', () => {
    const block = mount('<div id="stage"><video></video></div>');
    hideElement(block, 'picked');
    play(block.querySelector('video'));
    assert.equal(recoverMediaBlocks(document).restored, 0);
    assert.equal(isHidden(block), true);
  });

  it('规则包命中（rule）不恢复', () => {
    for (const reason of ['rule', 'linkfarm', 'overlay', 'fake-close', 'click-layer']) {
      const block = mount('<div id="stage"><video></video></div>');
      hideElement(block, reason);
      play(block.querySelector('video'));
      assert.equal(recoverMediaBlocks(document).restored, 0, reason);
      assert.equal(isHidden(block), true, reason);
    }
  });

  it('learned（自学习命中）恢复：否则第二次访问会被学到的选择器再藏一次', () => {
    // Visit one records a selector for the misjudged shell; visit two applies it before the
    // lazy video exists. Without this, the misfire becomes permanent for the user.
    const block = mount('<div id="stage"><video></video></div>');
    hideElement(block, 'learned');
    play(block.querySelector('video'));
    assert.equal(recoverMediaBlocks(document).restored, 1);
    assert.equal(isHidden(block), false);
  });

  it('没有 video 的隐藏元素不受影响', () => {
    const block = mount('<div id="stage"><img src="/a.png"></div>');
    hideElement(block, 'heuristic');
    assert.equal(recoverMediaBlocks(document).restored, 0);
    assert.equal(isHidden(block), true);
  });

  it('paused 的 video 不恢复', () => {
    const block = mount('<div id="stage"><video></video></div>');
    hideElement(block, 'heuristic');
    play(block.querySelector('video'), 640, true);
    assert.equal(recoverMediaBlocks(document).restored, 0);
    assert.equal(isHidden(block), true);
  });

  it('videoWidth === 0（还没有解码出画面）不恢复', () => {
    const block = mount('<div id="stage"><video></video></div>');
    hideElement(block, 'heuristic');
    play(block.querySelector('video'), 0, false);
    assert.equal(recoverMediaBlocks(document).restored, 0);
    assert.equal(isHidden(block), true);
  });

  it('同页一个该恢复、一个真广告：只恢复前者', () => {
    document.body.innerHTML =
      '<div id="content-shell"><video></video></div>' +
      '<div class="video-ads" id="real-ad"><video></video></div>';
    const content = document.getElementById('content-shell')!;
    const ad = document.getElementById('real-ad')!;
    hideElement(content, 'heuristic');
    hideElement(ad, 'heuristic');
    play(content.querySelector('video'));
    play(ad.querySelector('video'));

    const result = recoverMediaBlocks(document);
    assert.equal(result.restored, 1);
    assert.equal(isHidden(content), false);
    assert.equal(isHidden(ad), true);
  });
});

describe('❗恢复后必须阻止本页再次隐藏（否则隐藏/恢复会死循环）', () => {
  it('同一节点：巡检扫完仍然可见', () => {
    const block = mount(
      '<div id="shorts-stage">' +
        '<a href="https://ads.example.net/x">a</a>' +
        '<a href="https://spy.example.org/y">b</a>' +
        '<video></video>' +
        '</div>',
    );
    hideElement(block, 'heuristic');
    play(block.querySelector('video'));

    const keep = createKeepState();
    recoverMediaBlocks(document, keep);
    assert.equal(isKept(block, keep), true);

    sweep(document.documentElement, options(keep));
    assert.equal(isHidden(block), false, '巡检不得再次隐藏已恢复的区块');
    assert.equal(block.style.getPropertyValue('display'), '');
  });

  it('自学习选择器命中也不得再次隐藏（判定时录下的选择器正是回环来源）', () => {
    const block = mount(
      '<div id="shorts-stage">' +
        '<a href="https://ads.example.net/x">a</a>' +
        '<a href="https://spy.example.org/y">b</a>' +
        '<video></video>' +
        '</div>',
    );
    hideElement(block, 'heuristic');
    play(block.querySelector('video'));

    const keep = createKeepState();
    recoverMediaBlocks(document, keep);

    const learned = selectorsFrom([], ['#shorts-stage']);
    const learnedOptions: JudgeOptions = {
      injected: () => true,
      host: HOST,
      viewportArea: 0,
      selectors: learned,
      keep,
    };
    assert.equal(judgeElement(block, learnedOptions), null);
    sweep(document.documentElement, learnedOptions);
    assert.equal(isHidden(block), false);
  });

  it('站点重渲染出同选择器的新节点：选择器摘要同样挡住（无 KEEP 属性也能拦住）', () => {
    const block = mount(
      '<div id="shorts-stage">' +
        '<a href="https://ads.example.net/x">a</a>' +
        '<video></video>' +
        '</div>',
    );
    hideElement(block, 'heuristic');
    play(block.querySelector('video'));

    const keep = createKeepState();
    recoverMediaBlocks(document, keep);

    // Re-render: a fresh node with the same id, and therefore without our attribute.
    const fresh = document.createElement('div');
    fresh.id = 'shorts-stage';
    fresh.innerHTML =
      '<a href="https://ads.example.net/x">a</a>' +
      '<a href="https://spy.example.org/y">b</a><video></video>';
    document.body.appendChild(fresh);
    play(fresh.querySelector('video'));
    assert.equal(fresh.getAttribute(KEEP_ATTR), null);

    const learned: JudgeOptions = {
      injected: () => true,
      host: HOST,
      viewportArea: 0,
      selectors: selectorsFrom([], ['#shorts-stage']),
    };
    // Control: without the keep set the learned selector hides the new node.
    assert.ok(judgeElement(fresh, learned), '对照组：没有不再隐藏集合时会被学到的选择器隐藏');
    // With the page-level keep set, the digest covers the re-rendered node.
    assert.equal(judgeElement(fresh, { ...learned, keep }), null);
    assert.equal(isKept(fresh, keep), true);
  });
});

describe('恢复动作的样式边界', () => {
  it('只撤销我们写的内联声明，站点自己改的 display 保留', () => {
    const block = mount('<div id="stage"><video></video></div>');
    hideElement(block, 'heuristic');
    // Site counter-attack, same precedence but written later.
    block.style.setProperty('display', 'block', 'important');
    play(block.querySelector('video'));

    assert.equal(recoverMediaBlocks(document).restored, 1);
    assert.equal(block.style.getPropertyValue('display'), 'block', '站点自己的声明不能删');
    assert.equal(block.style.getPropertyValue('visibility'), '', '我们写的 visibility 要删');
    assert.equal(block.style.getPropertyValue('pointer-events'), '');
    assert.equal(block.style.getPropertyValue('height'), '');
  });

  it('isPlayingVideo 要求「有画面」与「在播放」同时成立', () => {
    document.body.innerHTML = '<video></video>';
    const video = document.querySelector('video')!;
    assert.equal(isPlayingVideo(video), false, 'jsdom 默认 0 宽 + 暂停');
    play(video, 640, false);
    assert.equal(isPlayingVideo(video), true);
    play(video, 0, false);
    assert.equal(isPlayingVideo(video), false);
    play(video, 640, true);
    assert.equal(isPlayingVideo(video), false);
  });
});
