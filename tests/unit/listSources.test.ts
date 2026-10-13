import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_SOURCES,
  checkNoPaidWhitelist,
  scanTextForPaidWhitelist,
} from '../../tools/filters/fetch-lists.mjs';

// Hard requirement: list sources must contain no paid whitelist. EasyList et al. have none,
// but "Acceptable Ads" is a separate subscription (exceptionrules.txt) that sells
// pass-through, and "free adblock" tools usually rot by enabling it by default. This makes
// the promise a code check: such a source in the config, or AA traces in the text, fail the
// fetch outright, so nobody (including me) can slip one in unnoticed.

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
    // Every source needs license info, or attribution is impossible.
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
