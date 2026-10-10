import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { validateSitePack } from '../../src/engine/rules.ts';
import { pilotPack as pack } from '../../src/rules/sites/pilot.ts';

const fixture = readFileSync(new URL('../fixtures/pilot-category.html', import.meta.url), 'utf8');

/**
 * 广告 SDK 与 SSP 样式的实物。用于给「服务端 0 命中」的选择器提供证据：
 * 一条在服务端 HTML 里不存在的规则，必须能在 SDK/SSP 实物里找到出处，
 * 否则它就是拼错的或者是凭空猜的。
 */
const sdkArtifacts =
  readFileSync(new URL('../fixtures/ad-sdk-v0.0.4.10.js', import.meta.url), 'utf8') +
  readFileSync(new URL('../fixtures/ssp.css', import.meta.url), 'utf8');

const dom = new JSDOM(fixture);
const doc = dom.window.document;
const CONTENT = 'article[itemtype*="BlogPosting"]';
const articles = Array.from(doc.querySelectorAll(CONTENT));

/** 从 `[data-x]` 或 `.cls` 形式的选择器里取出可检索的特征串。 */
function evidenceKey(selector: string): string | null {
  const attr = selector.match(/^\[(data-ssp-[a-z-]+)\]$/);
  if (attr) return attr[1]!;
  const cls = selector.match(/^\.([A-Za-z0-9_-]+)$/);
  if (cls) return cls[1]!;
  return null;
}

describe('pilot 站点规则包', () => {
  it('通过误伤护栏校验', () => {
    assert.deepEqual(validateSitePack(pack), []);
  });

  it('包含拦 SDK 脚本这条最高收益规则', () => {
    assert.ok(pack.network.some((r) => r.kind === 'path' && r.value === '/ad-sdk-v'));
  });

  it('包含竞价接口与追踪端点', () => {
    const values = pack.network.map((r) => r.value);
    for (const v of ['apiad01.cc', 'ads.zyudkkup.com', 'api.zzlprxy.cc']) {
      assert.ok(values.includes(v), `缺少 ${v}`);
    }
  });
});

describe('规则包的误伤护栏（硬约束）', () => {
  it('不包含会隐藏正文容器的选择器', () => {
    const joined = pack.cosmetic.join(' ');
    assert.ok(!joined.includes('[data-ssp-container]'), 'data-ssp-container 会连正文一起隐藏');
  });

  it('不包含任何形式的裸 .post-card', () => {
    for (const sel of pack.cosmetic) {
      assert.ok(!/(^|[\s,>])\.post-card(?![-\w])/.test(sel), `危险选择器：${sel}`);
    }
  });

  it('不包含素材 CDN（同时承载正文缩略图）', () => {
    const joined = pack.network.map((r) => r.value).join(' ');
    assert.ok(!joined.includes('pic.wvxrrip.cn'), 'pic.wvxrrip.cn 是正文缩略图来源，不能拉黑');
  });
});

describe('规则包作用于真实 fixture 时的行为', () => {
  it('fixture 里确实存在正文 article', () => {
    assert.ok(articles.length > 0, `正文数量=${articles.length}`);
  });

  it('任何一个选择器都不得命中正文 article 自身', () => {
    for (const sel of pack.cosmetic) {
      const hits = Array.from(doc.querySelectorAll(sel));
      for (const a of articles) {
        if (hits.includes(a)) assert.fail(`选择器 ${sel} 直接命中了正文 article`);
      }
    }
  });

  it('任何一个选择器都不得命中正文 article 的祖先（会连带隐藏正文）', () => {
    for (const sel of pack.cosmetic) {
      for (const hit of Array.from(doc.querySelectorAll(sel))) {
        if (hit.querySelector(CONTENT)) {
          assert.fail(
            `选择器 ${sel} 命中了包含正文 article 的容器 ` +
              `<${hit.tagName.toLowerCase()} class="${hit.getAttribute('class')}">，会连带隐藏正文`,
          );
        }
      }
    }
  });

  it('服务端 0 命中的选择器必须能在 SDK/SSP 实物里找到出处', () => {
    for (const sel of pack.cosmetic) {
      const hits = doc.querySelectorAll(sel).length;
      if (hits > 0) continue;

      const key = evidenceKey(sel);
      assert.ok(key, `选择器 ${sel} 在服务端 0 命中，且无法从中提取特征串以自证`);
      assert.ok(
        sdkArtifacts.includes(key),
        `选择器 ${sel} 在服务端 0 命中，特征串 "${key}" 也不在 SDK/ssp.css 中——可能是拼错了`,
      );
    }
  });

  it('不得命中正文缩略图（服务端渲染的懒加载图）', () => {
    const thumbs = Array.from(doc.querySelectorAll('img[data-src*="upload_01"]'));
    assert.ok(thumbs.length > 0, 'fixture 里应当有正文缩略图');
    for (const sel of pack.cosmetic) {
      const hits = Array.from(doc.querySelectorAll(sel));
      for (const t of thumbs) {
        if (hits.includes(t)) assert.fail(`选择器 ${sel} 命中了正文缩略图`);
      }
    }
  });
});

describe('fixture 与取证结论一致（防止 fixture 漂移）', () => {
  it('服务端存在 10 个空广告占位符', () => {
    assert.equal((fixture.match(/data-ssp-slot-node/g) ?? []).length, 10);
  });

  it('服务端存在 2 个 SSP 容器（其中 ssp-list 包裹正文）', () => {
    assert.equal((fixture.match(/data-ssp-container/g) ?? []).length, 2);
    assert.ok(fixture.includes('data-ssp-container="ssp-list"'));
  });

  it('服务端不含任何 SDK 运行时注入标记，证明 diff 思路成立', () => {
    for (const marker of [
      'data-ssp-slot-root',
      'data-ssp-sdk-popup-overlay',
      'data-ssp-sdk-fullscreen',
      'data-ssp-marquee',
    ]) {
      assert.ok(!fixture.includes(marker), `${marker} 不应出现在服务端 HTML 中`);
    }
  });

  it('全站有大量 div 使用 .post-card 类，证明裸选择器必然误伤', () => {
    const divs = (fixture.match(/<div[^>]*class="[^"]*\bpost-card\b[^"]*"/g) ?? []).length;
    assert.ok(divs > 50, `div.post-card 数量=${divs}`);
  });

  it('ssp-list 容器内部同时装着正文 article 与广告占位符（这就是陷阱）', () => {
    const container = doc.querySelector('[data-ssp-container="ssp-list"]');
    assert.ok(container, '未找到 ssp-list 容器');
    assert.ok(
      container.querySelector(CONTENT),
      'ssp-list 容器内应当有正文 article —— 因此绝不能隐藏该容器',
    );
    assert.ok(
      container.querySelector('[data-ssp-slot-node]'),
      'ssp-list 容器内应当有广告占位符 —— 这才是可以安全隐藏的目标',
    );
  });
});
