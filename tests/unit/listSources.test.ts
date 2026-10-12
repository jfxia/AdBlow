import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_SOURCES,
  checkNoPaidWhitelist,
  scanTextForPaidWhitelist,
} from '../../tools/filters/fetch-lists.mjs';

/**
 * 目标硬要求：**列表来源只限无付费白名单者**。
 *
 * 背景：EasyList 等列表本身不含付费白名单，但"Acceptable Ads"是**另一份订阅**
 * （exceptionrules.txt）——广告主付费后进入该列表被放行。各种"免费 adblock"
 * 后来变味，往往就是从默认勾选这份订阅开始的。
 *
 * 这里把承诺变成**代码里的强制检查**：配置里加了这类来源 → 抓取直接失败；
 * 正文出现 AA 痕迹 → 也失败。这样以后有人（包括我）想偷偷加进去会立刻被拦。
 */

describe('checkNoPaidWhitelist：来源配置', () => {
  it('❗当前配置的 6 份列表全部通过', () => {
    assert.deepEqual(checkNoPaidWhitelist(), []);
  });

  it('❗Acceptable Ads 的 exceptionrules.txt 会被拦下', () => {
    const problems = checkNoPaidWhitelist([
      { id: 'aa', url: 'https://easylist-downloads.adblockplus.org/exceptionrules.txt' },
    ]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /exceptionrules/);
  });

  it('❗acceptableads 官方域名会被拦下', () => {
    assert.ok(
      checkNoPaidWhitelist([
        { id: 'aa', url: 'https://acceptableads.com/en/allowlist.txt' },
      ]).length >= 1,
    );
  });

  it('配置里实际使用的列表清单（审计用，改动会被这条测试暴露）', () => {
    assert.deepEqual(
      LIST_SOURCES.map((s) => s.id).sort(),
      ['easylist', 'easylist-china', 'easyprivacy', 'ublock-badware', 'ublock-filters', 'ublock-privacy'],
    );
    // 每个来源都要有许可证信息（否则无法署明出处）
    for (const s of LIST_SOURCES) {
      assert.ok(s.license, `${s.id} 缺许可证标注`);
      assert.ok(s.url.startsWith('https://'), `${s.id} 必须用 https`);
    }
  });
});

describe('scanTextForPaidWhitelist：正文痕迹', () => {
  it('❗头部出现 Acceptable Ads 会被发现', () => {
    const text = [
      '[Adblock Plus 2.0]',
      '! Title: Acceptable Ads',
      '! Homepage: https://acceptableads.com/',
      '||ads.example.com^',
    ].join('\n');
    assert.ok(scanTextForPaidWhitelist(text).length >= 1);
  });

  it('正常列表头部不会被误判', () => {
    const text = [
      '[Adblock Plus 2.0]',
      '! Title: EasyList',
      '! Homepage: https://easylist.to/',
      '! 说明：本列表不接受付费放行',
      '||ads.example.com^',
    ].join('\n');
    assert.deepEqual(scanTextForPaidWhitelist(text), []);
  });

  it('只检查注释行，正文里的普通词不误判', () => {
    const text = ['! 正常注释', '||acceptableads.example.com^'].join('\n');
    assert.deepEqual(scanTextForPaidWhitelist(text), []);
  });
});
