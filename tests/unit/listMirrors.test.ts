import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mirrorUrls, checkNoPaidWhitelist } from '../../tools/filters/fetch-lists.mjs';

/**
 * 镜像回退的推导规则。
 *
 * 起因：raw.githubusercontent.com 与 easylist.to 在部分网络下不可达，导致 `pnpm filters`
 * 失败、别人无法从源码构建。镜像 URL 由来源 URL 推导，避免与来源表两处维护。
 * 下面断言的镜像地址都实测可用（见提交说明）。
 */
describe('mirrorUrls：为来源推导备用地址', () => {
  it('GitHub raw 来源 → jsDelivr 对应路径', () => {
    assert.deepEqual(
      mirrorUrls('https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt'),
      ['https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/filters.txt'],
    );
  });

  it('easylist.to 来源 → adblockplus.org，再 → jsDelivr 的 gh-pages 分支', () => {
    assert.deepEqual(mirrorUrls('https://easylist.to/easylist/easylist.txt'), [
      'https://easylist-downloads.adblockplus.org/easylist.txt',
      'https://cdn.jsdelivr.net/gh/easylist/easylist@gh-pages/easylist.txt',
    ]);
  });

  it('中文列表 → 其独立仓库的 jsDelivr 镜像', () => {
    assert.deepEqual(
      mirrorUrls('https://easylist-downloads.adblockplus.org/easylistchina.txt'),
      ['https://cdn.jsdelivr.net/gh/easylist/easylistchina@master/easylistchina.txt'],
    );
  });

  it('未知形态的来源不编造镜像', () => {
    assert.deepEqual(mirrorUrls('https://example.com/some-list.txt'), []);
  });

  it('镜像地址同样要过付费白名单检查（不能从备用地址引入）', () => {
    // 正常来源配置通过
    assert.deepEqual(checkNoPaidWhitelist(), []);
    // 编造一个会经由镜像暴露付费白名单的来源，应被拦下
    const problems = checkNoPaidWhitelist([
      {
        id: 'evil',
        url: 'https://raw.githubusercontent.com/someone/lists/master/exceptionrules.txt',
      },
    ]);
    assert.ok(problems.length > 0, '含付费白名单特征的来源必须被拒绝');
  });
});
