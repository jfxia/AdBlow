import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPristineIndex, buildPristineIndexFromHtml, isInjected, nodeSignature } from '../../src/engine/pristine.ts';

function root(html: string): HTMLElement {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
}

describe('buildPristineIndex / isInjected', () => {
  it('服务端已有节点不算注入', () => {
    const r = root('<div class="post-card" id="ssp-card-0" data-ssp-slot-node></div>');
    const idx = buildPristineIndex(r);
    assert.equal(isInjected(r.querySelector('[data-ssp-slot-node]')!, idx), false);
  });

  it('之后新增的 SDK 节点算注入', () => {
    const r = root('<div class="post-card" id="ssp-card-0" data-ssp-slot-node></div>');
    const idx = buildPristineIndex(r);
    const born = document.createElement('div');
    born.setAttribute('data-ssp-slot-root', '');
    r.appendChild(born);
    assert.equal(isInjected(born, idx), true);
  });

  it('签名忽略易变属性，因此 SDK 填充已有占位符不算注入', () => {
    const a = document.createElement('div');
    a.className = 'post-card';
    a.id = 'ssp-card-0';
    a.setAttribute('data-ssp-slot-node', '');

    const b = a.cloneNode() as HTMLElement;
    b.innerHTML = '<img src="//pic.wvxrrip.cn/x.jpeg"><p>广告文案</p>';

    assert.equal(nodeSignature(b), nodeSignature(a));
  });
});

describe('buildPristineIndexFromHtml（快照回填通道）', () => {
  const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');
  const index = buildPristineIndexFromHtml(fixture, new DOMParser());

  it('服务端渲染的元素全部不算注入', () => {
    // 每个用例用独立解析结果，避免互相污染（DOM 是可变的）
    const dom = new DOMParser().parseFromString(fixture, 'text/html');
    for (const sel of ['[data-ssp-slot-node]', '[data-ssp-container]', 'article', 'footer', '.post-card']) {
      const el = dom.querySelector(sel);
      assert.ok(el, `fixture 里应当有 ${sel}`);
      assert.equal(isInjected(el, index), false, `${sel} 被判成了注入`);
    }
  });

  it('脚本注入的节点算注入', () => {
    const dom = new DOMParser().parseFromString(fixture, 'text/html');
    const born = dom.createElement('div');
    born.setAttribute('data-ssp-sdk-popup-overlay', '');
    dom.body.appendChild(born);
    assert.equal(isInjected(born, index), true);
  });

  it('与同一份 HTML 建出的原始 DOM 签名完全一致（回填可用性的前提）', () => {
    // 回填索引必须能与内容脚本实际所在的 DOM 对上，否则整套判定失效
    const pristine = new DOMParser().parseFromString(fixture, 'text/html');
    const direct = buildPristineIndex(pristine.documentElement);
    assert.equal(direct.counts.size, index.counts.size);
    for (const [sig, n] of index.counts) {
      assert.equal(direct.counts.get(sig), n, `签名不一致：${sig}`);
    }
  });

  it('索引规模合理（fixture 有上千元素）', () => {
    assert.ok(index.counts.size > 100, `size=${index.counts.size}`);
  });
});
