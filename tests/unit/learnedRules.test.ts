import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNED_DOMAIN_ID_BASE,
  SUBRESOURCE_TYPES,
  learnedDomainRules,
} from '../../src/engine/learnedRules.ts';

describe('learnedDomainRules：自学习域名 → DNR 拦截规则', () => {
  it('编译成 ||domain^ 形式', () => {
    const rules = learnedDomainRules(['ads.example.com']);
    assert.equal(rules[0]!.condition.urlFilter, '||ads.example.com^');
    assert.deepEqual(rules[0]!.action, { type: 'block' });
  });

  it('❗绝不拦 main_frame（否则用户主动点击会直接导航失败）', () => {
    const rules = learnedDomainRules(['ads.example.com']);
    assert.ok(
      !rules[0]!.condition.resourceTypes.includes('main_frame'),
      '学习到的域名绝不能拦主文档',
    );
    assert.ok(!SUBRESOURCE_TYPES.includes('main_frame'));
  });

  it('❗❗绝不拦 image / media（事故回归：曾导致整站图片不显示）', () => {
    // 2026-10-10 真实事故：1024cg 首页所有图片不显示。
    // 内容缩略图与广告素材共用同一个 CDN，域名被学走后连带把正文图一起拦掉了。
    // 结构性保证：自学习来的网络规则**永远不可能弄坏页面的图片与视频**。
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    assert.ok(!types.includes('image'), '自学习规则不得拦图片');
    assert.ok(!types.includes('media'), '自学习规则不得拦音视频');
    assert.ok(!SUBRESOURCE_TYPES.includes('image'));
    assert.ok(!SUBRESOURCE_TYPES.includes('media'));
  });

  it('❗❗绝不拦 script / stylesheet / font（事故回归：曾让整页渲染崩掉）', () => {
    // 2026-10-13 真实事故：用户报告某视频站开启过滤后"播放器、推荐栏被屏蔽"。
    // 取证：服务端 HTML 只有 18 个 <img>，开启过滤后页面恰好只剩这 18 个
    //（未开启时 67 个，多出的全是页面 JS 运行时创建的）；
    // 播放器库 Hls 未定义、播放器容器 690x0。
    // 该站的关键脚本（jquery / common.js / owl.carousel）与播放器库（plyr / hls.js）
    // 全部来自它自己的 CDN —— 自学习把该 CDN 域名学成广告域名后，
    // 整站的 CSS/JS 被拦，页面渲染与功能一起崩。
    // 结构性保证：**自学习永远不可能弄坏页面自身的样式与脚本。**
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    for (const t of ['script', 'stylesheet', 'font']) {
      assert.ok(!types.includes(t as never), `自学习规则不得拦 ${t}`);
      assert.ok(!SUBRESOURCE_TYPES.includes(t as never));
    }
  });

  it('覆盖真正有价值的类型（弹窗 / 信标 / 追踪）', () => {
    const types = learnedDomainRules(['ads.example.com'])[0]!.condition.resourceTypes;
    for (const t of ['sub_frame', 'xmlhttprequest', 'ping', 'websocket', 'object']) {
      assert.ok(types.includes(t as never), `缺少资源类型 ${t}`);
    }
  });

  it('❗爆炸半径：只在教会它的站点上生效', () => {
    // "这个域名在本站是广告域名"不等于"它在别的站点也是"：
    // 第三方 CDN 被多站共用时，A 站学到的域名很可能正是 B 站自己的资源来源。
    const rules = learnedDomainRules([
      { domain: 'ads.example.com', initiators: ['a.com', 'b.com', 'a.com'] },
    ]);
    assert.deepEqual(rules[0]!.condition.initiatorDomains, ['a.com', 'b.com'], '去重并排序');
  });

  it('兼容纯字符串入参（不写 initiatorDomains）', () => {
    const rules = learnedDomainRules(['ads.example.com']);
    assert.equal('initiatorDomains' in rules[0]!.condition, false);
  });

  it('按站点豁免：用户关掉的站点下不生效', () => {
    const rules = learnedDomainRules(['ads.example.com'], ['off.cc', 'off.cc', '']);
    assert.deepEqual(rules[0]!.condition.excludedInitiatorDomains, ['off.cc']);
  });

  it('没有豁免站点时不写这个字段（避免生成无意义的空数组）', () => {
    const rules = learnedDomainRules(['ads.example.com'], []);
    assert.equal('excludedInitiatorDomains' in rules[0]!.condition, false);
  });

  it('id 落在专用区间且不重复', () => {
    const rules = learnedDomainRules(['a.cc', 'b.cc', 'c.cc']);
    const ids = rules.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => id >= LEARNED_DOMAIN_ID_BASE));
    // 与站点规则包的区间（10000 起）不重叠
    assert.ok(Math.min(...ids) > 19999);
  });

  it('空列表产出空数组', () => {
    assert.deepEqual(learnedDomainRules([]), []);
  });

  it('priority 为正（DNR 要求）', () => {
    assert.ok(learnedDomainRules(['a.cc'])[0]!.priority > 0);
  });
});
