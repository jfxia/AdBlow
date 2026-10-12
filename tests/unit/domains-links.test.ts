import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crossSiteResourceDomains } from '../../src/engine/domains.ts';

const HOST = 'afford.gjvrohros.cc';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('crossSiteResourceDomains：默认不含外链', () => {
  it('只看加载资源，不看 a[href]', () => {
    const domains = crossSiteResourceDomains(
      el('<article><a href="https://00076049.com/landing"></a></article>'),
      HOST,
    );
    assert.deepEqual(domains, []);
  });
});

describe('crossSiteResourceDomains：includeLinks（学习广告域名时用）', () => {
  it('算上外链域名', () => {
    const domains = crossSiteResourceDomains(
      el('<article class="ad-item"><a href="https://00076049.com/landing?x=1"></a></article>'),
      HOST,
      { includeLinks: true },
    );
    assert.deepEqual(domains, ['00076049.com']);
  });

  it('子树里的外链也算', () => {
    const domains = crossSiteResourceDomains(
      el('<div><span><a href="https://269e.2690125.cc/x"></a></span></div>'),
      HOST,
      { includeLinks: true },
    );
    assert.deepEqual(domains, ['2690125.cc']);
  });

  it('外链与资源一起收集且去重', () => {
    const domains = crossSiteResourceDomains(
      el('<div><a href="https://a.example.com/x"></a><img src="https://b.example.com/y.png"></div>'),
      HOST,
      { includeLinks: true },
    );
    assert.deepEqual(domains, ['example.com']);
  });

  it('站点内的相对外链仍然排除', () => {
    assert.deepEqual(
      crossSiteResourceDomains(el('<a href="/archives/1/"></a>'), HOST, { includeLinks: true }),
      [],
    );
  });
});
