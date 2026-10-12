import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMOTE_DOMAIN_AFTER,
  allDomainEntries,
  allPromotedDomains,
  clearDomains,
  domainsKey,
  forgetDomain,
  hostFromDomainsKey,
  promotedDomainsFor,
  recordDomains,
} from '../../src/content/domainLearn.ts';
import { memoryStore } from '../../src/content/storage.ts';

const PAGE = 'a.cc';

describe('网络层自学习：晋级', () => {
  it('首次出现只观察，不晋级', async () => {
    const store = memoryStore();
    await recordDomains(store, PAGE, ['ads.example.com'], 'https://a.cc/1');
    assert.deepEqual(await promotedDomainsFor(store, PAGE), []);
  });

  it(`累计出现 ${PROMOTE_DOMAIN_AFTER} 次才晋级为拦截规则（抗污染）`, async () => {
    const store = memoryStore();
    for (let i = 1; i < PROMOTE_DOMAIN_AFTER; i++) {
      await recordDomains(store, PAGE, ['ads.example.com'], `https://a.cc/${i}`);
    }
    assert.deepEqual(await promotedDomainsFor(store, PAGE), [], '未到阈值不应晋级');

    await recordDomains(store, PAGE, ['ads.example.com'], 'https://a.cc/final');
    assert.deepEqual(await promotedDomainsFor(store, PAGE), ['ads.example.com']);
  });

  it('记录首次出现的页面，便于用户判断学得对不对', async () => {
    const store = memoryStore();
    await recordDomains(store, PAGE, ['ads.example.com'], 'https://a.cc/landing');
    const entries = await allDomainEntries(store);
    assert.equal(entries[0]!.entries[0]!.samplePage, 'https://a.cc/landing');
  });

  it('空域名列表不写存储', async () => {
    const store = memoryStore();
    await recordDomains(store, PAGE, [], 'https://a.cc/');
    assert.deepEqual(await store.keys(), []);
  });

  it('同一次多个域名一起记录', async () => {
    const store = memoryStore();
    await recordDomains(store, PAGE, ['x.cc', 'y.cc'], 'https://a.cc/');
    const entries = await allDomainEntries(store);
    assert.equal(entries[0]!.entries.length, 2);
  });
});

describe('网络层自学习：全局聚合', () => {
  it('域名跨站点聚合去重（域名是全局概念）', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_DOMAIN_AFTER; i++) {
      await recordDomains(store, 'a.cc', ['shared.example.com'], 'https://a.cc/');
    }
    for (let i = 0; i < PROMOTE_DOMAIN_AFTER; i++) {
      await recordDomains(store, 'b.cc', ['shared.example.com', 'only-b.cc'], 'https://b.cc/');
    }

    const all = await allPromotedDomains(store);
    assert.deepEqual(all, ['only-b.cc', 'shared.example.com']);
  });

  it('未晋级的域名不出现在全局列表里', async () => {
    const store = memoryStore();
    await recordDomains(store, 'a.cc', ['weak.example.com'], 'https://a.cc/');
    assert.deepEqual(await allPromotedDomains(store), []);
  });

  it('无任何记录时返回空数组', async () => {
    assert.deepEqual(await allPromotedDomains(memoryStore()), []);
  });
});

describe('网络层自学习：撤销', () => {
  it('forgetDomain 删除单个域名', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_DOMAIN_AFTER; i++) {
      await recordDomains(store, PAGE, ['ads.example.com', 'other.cc'], 'https://a.cc/');
    }
    await forgetDomain(store, PAGE, 'ads.example.com');
    assert.deepEqual(await promotedDomainsFor(store, PAGE), ['other.cc']);
  });

  it('删除不存在的域名不抛异常', async () => {
    const store = memoryStore();
    await forgetDomain(store, PAGE, 'nope.cc');
    assert.deepEqual(await allDomainEntries(store), []);
    assert.deepEqual(await allPromotedDomains(store), []);
  });

  it('clearDomains 清空整组', async () => {
    const store = memoryStore();
    for (let i = 0; i < PROMOTE_DOMAIN_AFTER; i++) {
      await recordDomains(store, PAGE, ['ads.example.com'], 'https://a.cc/');
    }
    await clearDomains(store, PAGE);
    assert.deepEqual(await allPromotedDomains(store), []);
    assert.ok(!(await store.keys()).includes(domainsKey(PAGE)));
  });
});

describe('网络层自学习：键名工具', () => {
  it('hostFromDomainsKey 只认域名键', () => {
    assert.equal(hostFromDomainsKey('adDomains:a.cc'), 'a.cc');
    assert.equal(hostFromDomainsKey('learned:a.cc'), null);
    assert.equal(hostFromDomainsKey('disabled:a.cc'), null);
  });
});
