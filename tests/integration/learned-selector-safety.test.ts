import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  isHidden,
  judgeElement,
  recordableSelector,
  type Hit,
  type JudgeOptions,
} from '../../src/content/engine.ts';

// Safety-gate regression for learned selectors. Incident (2026-10-10, "all images on
// 1024cg vanished"): learning emitted `.post-card` (content cards) and `.tjtagmanager`
// (43 elements, 22 images) straight into the document_start stylesheet, which had no
// element-level guard. Earlier E2E runs used a fresh profile, so it never surfaced.

const HOST = 'afford.gjvrohros.cc';
const VIEWPORT = 1920 * 1080;

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

function hitFor(selector: string): Hit {
  return { selector, score: 10, reasons: ['test'] };
}

function optionsWithLearned(_root: ParentNode, learned: string[]): JudgeOptions {
  return {
    injected: () => false,
    host: HOST,
    viewportArea: VIEWPORT,
    selectors: { curated: [], learned },
  };
}

describe('recordableSelector：自学习入库前的四道闸门', () => {
  it('❗拒绝禁用选择器 .post-card（正文卡片类名）', () => {
    const doc = root('<div class="post-card"></div>');
    assert.equal(
      recordableSelector(hitFor('.post-card'), doc),
      null,
      '.post-card 是规则包明令禁止的选择器，自学习路径也必须拒绝',
    );
  });

  it('❗拒绝会横扫大量图片的宽泛包装类（.tjtagmanager 形态）', () => {
    // 43 elements including 22 images — the shape seen in the incident.
    const many = Array.from(
      { length: 22 },
      (_, i) => `<a class="tjtagmanager"><img src="/banner-${i}.png"></a>`,
    ).join('');
    const doc = root(`<div>${many}${'<a class="tjtagmanager"></a>'.repeat(0)}</div>`);
    assert.equal(
      recordableSelector(hitFor('.tjtagmanager'), doc, 100, 4),
      null,
      '命中元素里的图片总数超过上限时必须拒绝',
    );
  });

  it('拒绝命中数过宽的选择器', () => {
    const doc = root(`<div>${'<i class="wide"></i>'.repeat(50)}</div>`);
    assert.equal(recordableSelector(hitFor('.wide'), doc, 30), null);
  });

  it('拒绝命中元素里含正文的选择器', () => {
    const doc = root(
      '<div class="card"><article itemtype="http://schema.org/BlogPosting"></article></div>',
    );
    assert.equal(recordableSelector(hitFor('.card'), doc), null);
  });

  it('接受正常的广告位容器（含 1–2 张素材图）', () => {
    const doc = root(
      '<div class="tg-promo-float"><a href="https://spam.example.com/x"><img src="/i.png"></a></div>',
    );
    assert.equal(recordableSelector(hitFor('.tg-promo-float'), doc), '.tg-promo-float');
  });

  it('拒绝没有任何命中的选择器', () => {
    assert.equal(recordableSelector(hitFor('.nope'), root('<div></div>')), null);
  });

  it('selector 为 null 时直接返回 null', () => {
    assert.equal(recordableSelector({ selector: null, score: 0, reasons: [] }, root('<div></div>')), null);
  });
});

describe('judgeElement：自学习选择器不授予「无条件隐藏」特权', () => {
  it('❗宽泛包装类即使已被学过，也不会隐藏含图片的元素（已污染存储的兜底）', () => {
    // A user's browser may already have `.tjtagmanager` stored; guards extension reloads.
    const doc = root(
      '<div><a class="tjtagmanager"><img src="/usr/themes/Mirages/images/banner.png"></a></div>',
    );
    const banner = doc.querySelector('.tjtagmanager')!;
    const options = optionsWithLearned(doc, ['.tjtagmanager']);

    assert.equal(judgeElement(banner, options), null, '该元素既无命名也无行为证据，不该被隐藏');
  });

  it('❗装着正文的元素永远不被隐藏（对任何来源的选择器都成立）', () => {
    const doc = root('<div class="learned-ad"><article itemtype="http://schema.org/BlogPosting"></article></div>');
    const wrapper = doc.querySelector('.learned-ad')!;
    assert.equal(judgeElement(wrapper, optionsWithLearned(doc, ['.learned-ad'])), null);
  });

  it('自学习选择器 + 行为证据 → 隐藏（这正是它省下快照回填的价值）', () => {
    const doc = root(
      '<div class="tg-promo-float"><a href="https://spam.example.com/x?click_id=1"></a></div>',
    );
    const box = doc.querySelector('.tg-promo-float')!;
    const verdict = judgeElement(box, optionsWithLearned(doc, ['.tg-promo-float']));

    assert.ok(verdict, '有跨站推广链接作旁证，应当隐藏');
    assert.equal(verdict!.kind, 'heuristic');
    assert.ok(
      verdict!.kind === 'heuristic' && verdict!.hit.reasons.includes('learned-selector'),
      '理由里应标注是自学习选择器命中',
    );
  });

  it('自学习选择器 + 弱命名 → 隐藏', () => {
    const doc = root('<div class="float-layer"></div>');
    const el = doc.querySelector('.float-layer')!;
    assert.ok(judgeElement(el, optionsWithLearned(doc, ['.float-layer'])));
  });

  it('自学习选择器命中但既无命名也无行为 → 不隐藏', () => {
    const doc = root('<div class="plain-box"></div>');
    const el = doc.querySelector('.plain-box')!;
    assert.equal(judgeElement(el, optionsWithLearned(doc, ['.plain-box'])), null);
  });

  it('curated（规则包）仍然命中即隐藏 —— 它经过取证与回归测试', () => {
    const doc = root('<div class="xqbj-recommand-item-banner"><img src="/a.png"></div>');
    const el = doc.querySelector('.xqbj-recommand-item-banner')!;
    const options: JudgeOptions = {
      injected: () => false,
      host: HOST,
      viewportArea: VIEWPORT,
      selectors: { curated: ['.xqbj-recommand-item-banner'], learned: [] },
    };
    const verdict = judgeElement(el, options);
    assert.ok(verdict, '规则包选择器应命中即隐藏（它含图片是预期的）');
    assert.equal(verdict!.kind, 'rule');
  });
});

describe('真实 fixture：自学习在第二站点上不会产出危险选择器', () => {
  it('从真实页面推导出的候选选择器里，不含禁用选择器或横扫图片的选择器', () => {
    const fixture = readFileSync(new URL('../fixtures/1024cg-home.html', import.meta.url), 'utf8');
    const doc = new JSDOM(fixture, { url: 'https://1024cg.com/' }).window.document;

    // Dangerous selectors produced by the incident.
    for (const dangerous of ['.post-card', '.tjtagmanager', '.adspop']) {
      const accepted = recordableSelector(hitFor(dangerous), doc);
      if (dangerous === '.adspop') continue; // not present in this fixture
      assert.equal(accepted, null, `${dangerous} 不应被接受为自学习规则`);
    }
  });

  it('真实页面上的正常广告容器仍可被学习（不要因噎废食）', () => {
    const fixture = readFileSync(new URL('../fixtures/1024cg-home.html', import.meta.url), 'utf8');
    const doc = new JSDOM(fixture, { url: 'https://1024cg.com/' }).window.document;
    const accepted = recordableSelector(hitFor('.ad-item'), doc);
    assert.equal(accepted, '.ad-item', '服务端渲染的广告卡应当可以学习');
  });
});
