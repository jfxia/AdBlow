import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isIpLiteral, registrableDomain } from '../../src/engine/score.ts';
import { crossSiteResourceDomains } from '../../src/engine/domains.ts';

const HOST = '1024cg.com';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('isIpLiteral', () => {
  it('识别 IPv4', () => {
    assert.equal(isIpLiteral('54.169.219.76'), true);
    assert.equal(isIpLiteral('130.152.1.1'), true);
  });

  it('识别 IPv6', () => {
    assert.equal(isIpLiteral('2001:db8::1'), true);
  });

  it('普通域名不是 IP', () => {
    for (const h of ['example.com', 'a.b.c.example.com', '1024cg.com', 'x.co']) {
      assert.equal(isIpLiteral(h), false, h);
    }
  });
});

describe('registrableDomain：IP 必须原样返回（实测踩过的坑）', () => {
  it('IPv4 不再被截成末两段', () => {
    // 曾经的 bug：54.169.219.76 → '219.76'，进而生成 ||219.76^ 这种会误配的规则
    assert.equal(registrableDomain('54.169.219.76'), '54.169.219.76');
    assert.equal(registrableDomain('13.229.106.237'), '13.229.106.237');
  });

  it('IPv6 原样返回', () => {
    assert.equal(registrableDomain('2001:db8::1'), '2001:db8::1');
  });

  it('普通域名仍取末两段', () => {
    assert.equal(registrableDomain('pic.jtzatly.cn'), 'jtzatly.cn');
    assert.equal(registrableDomain('a.b.example.com'), 'example.com');
    assert.equal(registrableDomain('example.com'), 'example.com');
  });
});

describe('crossSiteResourceDomains：不学裸 IP', () => {
  it('跳过 IP 上的追踪端点', () => {
    // 站点把上报放在裸 IP + 高位端口上；裸 IP 常为共享基础设施，不学
    const domains = crossSiteResourceDomains(
      el('<script src="https://54.169.219.76:15212/api/eventTracking/batchReport.json"></script>'),
      HOST,
    );
    assert.deepEqual(domains, []);
  });

  it('同一批资源里的真实域名仍然提取', () => {
    const domains = crossSiteResourceDomains(
      el(
        '<div><script src="https://54.169.219.76:15212/a.json"></script>' +
          '<script src="https://api-dc-prod-003.cyou/b.json"></script></div>',
      ),
      HOST,
    );
    // 两段式主机的可注册域名就是它自己（'cyou' 是 TLD，不是可注册域名）
    assert.deepEqual(domains, ['api-dc-prod-003.cyou']);
  });
});
