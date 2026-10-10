import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPristineIndex, isInjected, nodeSignature } from '../../src/engine/pristine.ts';

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
