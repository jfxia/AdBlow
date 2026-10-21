import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  clickConsentControl,
  findConsentBanner,
  type ConsentDomContext,
  type ConsentRect,
} from '../../src/content/consent.ts';

// DOM side of the split: candidate discovery, ancestor walking and the final button handle.
// Styles and geometry are injected because jsdom performs no layout; the decision itself is
// covered in tests/unit/cookieConsent.test.ts.

const VIEWPORT = { width: 1280, height: 800 };

type Candidate = {
  position?: string;
  display?: string;
  visibility?: string;
  opacity?: string;
  rect?: ConsentRect;
};

function docWith(body: string): Document {
  return new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    url: 'https://example.com/',
  }).window.document;
}

function ctxFor(map: Record<string, Candidate>): ConsentDomContext {
  return {
    viewport: VIEWPORT,
    styleOf: (el) => {
      const candidate = map[el.id];
      if (!candidate) return null;
      return {
        position: candidate.position ?? 'static',
        display: candidate.display ?? 'block',
        visibility: candidate.visibility ?? 'visible',
        opacity: candidate.opacity ?? '1',
        pointerEvents: 'auto',
      };
    },
    rectOf: (el) => map[el.id]?.rect ?? null,
  };
}

const BAR: Candidate = {
  position: 'fixed',
  rect: { top: 700, left: 0, width: 1280, height: 100 },
};

const COPY = '<p>We use cookies to improve your experience and measure traffic.</p>';

describe('cookie consent DOM：候选发现与点击目标', () => {
  it('固定底栏：识别横幅并优先返回拒绝按钮', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button>` +
        `<button id="reject">Reject all</button></div>`,
    );
    const hit = findConsentBanner(doc, ctxFor({ banner: BAR }));

    assert.ok(hit);
    assert.equal(hit.banner.id, 'banner');
    assert.equal(hit.button.id, 'reject');
    assert.equal(hit.kind, 'reject');
    assert.equal(hit.matchedPhrase, 'reject all');
    assert.equal(hit.reason, 'reject-preferred');
  });

  it('接受按钮在 DOM 中靠前也不影响拒绝优先', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button>` +
        `<button id="reject">Reject all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.kind, 'reject');
  });

  it('按钮包在静态容器里：沿祖先向上找到固定横幅', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<div id="inner"><button id="reject">Only necessary</button></div></div>`,
    );
    const hit = findConsentBanner(doc, ctxFor({ banner: BAR }));
    assert.equal(hit?.banner.id, 'banner');
    assert.equal(hit?.button.id, 'reject');
  });

  it('粘性顶栏也可以（sticky）', () => {
    const doc = docWith(`<div id="banner">${COPY}<button id="accept">Got it</button></div>`);
    const hit = findConsentBanner(
      doc,
      ctxFor({
        banner: { position: 'sticky', rect: { top: 0, left: 0, width: 1280, height: 90 } },
      }),
    );
    assert.equal(hit?.button.id, 'accept');
  });

  it('全屏遮罩 + 居中对话框：在遮罩层上识别，不在小对话框上', () => {
    const doc = docWith(
      `<div id="overlay">${COPY}<div id="dialog"><button id="accept">Accept all</button></div></div>`,
    );
    const hit = findConsentBanner(
      doc,
      ctxFor({
        overlay: { position: 'fixed', rect: { top: 0, left: 0, width: 1280, height: 800 } },
      }),
    );
    assert.equal(hit?.banner.id, 'overlay');
    assert.equal(hit?.button.id, 'accept');
  });

  it('输入按钮用 value 作为标签（图标按钮常见写法）', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<input id="reject" type="button" value="Reject all">` +
        `<button id="accept">Accept</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.button.id, 'reject');
  });

  it('按钮标签来自 aria-label 时也能识别', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept" aria-label="Accept all cookies">✓</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.button.id, 'accept');
  });

  it('重音 / 大小写 / 前后缀不影响识别', () => {
    const doc = docWith(
      `<div id="banner"><p>Nous utilisons des COOKIES pour votre confidentialité.</p>` +
        `<button id="accept">ACCEPTER TOUT</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.button.id, 'accept');
  });

  it('没有可识别按钮的页面返回 null', () => {
    const doc = docWith('<div id="banner"><p>Hello</p><button>Manage options</button></div>');
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('点击只触发按钮事件，不隐藏 / 不移除横幅', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button></div>`,
    );
    const button = doc.querySelector('#accept')!;
    let clicks = 0;
    button.addEventListener('click', () => {
      clicks += 1;
    });

    clickConsentControl(button);

    assert.equal(clicks, 1);
    assert.ok(doc.querySelector('#banner'), '横幅不应被移除');
    assert.equal((doc.querySelector('#banner') as HTMLElement).style.display, '');
  });
});

describe('cookie consent DOM：误伤防护', () => {
  it('静态 cookie 说明栏不处理', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: { ...BAR, position: 'static' } })), null);
  });

  it('固定但居中且不够遮罩的弹窗不处理', () => {
    const doc = docWith(
      `<div id="dialog">${COPY}<button id="accept">Accept all</button></div>`,
    );
    const hit = findConsentBanner(
      doc,
      ctxFor({
        dialog: { position: 'fixed', rect: { top: 300, left: 400, width: 480, height: 200 } },
      }),
    );
    assert.equal(hit, null);
  });

  it('登录表单（密码框）不处理', () => {
    const doc = docWith(
      `<div id="banner"><p>Privacy and cookies</p><input type="password">` +
        `<button id="login">Sign in</button><button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('有登录 / 注册按钮不处理（无密码框也一样）', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="login">Log in</button>` +
        `<button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('订阅 / 付费墙文案不处理', () => {
    const doc = docWith(
      `<div id="banner"><p>Subscribe to continue. We use cookies.</p>` +
        `<button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('年龄验证文案不处理', () => {
    const doc = docWith(
      `<div id="banner"><p>Verify your age. We use cookies.</p>` +
        `<button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('横幅里含正文标记（main/article）不处理', () => {
    const doc = docWith(
      `<div id="overlay">${COPY}<main><button id="accept">Accept all</button></main></div>`,
    );
    assert.equal(
      findConsentBanner(
        doc,
        ctxFor({
          overlay: { position: 'fixed', rect: { top: 0, left: 0, width: 1280, height: 800 } },
        }),
      ),
      null,
    );
  });

  it('粘性站点头部（含导航）不处理，即使有 privacy 与 OK', () => {
    const doc = docWith(
      `<header id="banner"><p>Privacy and cookies</p><nav><a href="/">Home</a></nav>` +
        `<button id="accept">OK</button></header>`,
    );
    assert.equal(
      findConsentBanner(
        doc,
        ctxFor({
          banner: { position: 'sticky', rect: { top: 0, left: 0, width: 1280, height: 80 } },
        }),
      ),
      null,
    );
  });

  it('含搜索框的粘性头部不处理', () => {
    const doc = docWith(
      `<div id="banner"><p>Privacy and cookies</p><input type="search">` +
        `<button id="accept">OK</button></div>`,
    );
    assert.equal(
      findConsentBanner(
        doc,
        ctxFor({
          banner: { position: 'sticky', rect: { top: 0, left: 0, width: 1280, height: 80 } },
        }),
      ),
      null,
    );
  });

  it('隐藏的横幅不点', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button></div>`,
    );
    assert.equal(
      findConsentBanner(doc, ctxFor({ banner: { ...BAR, display: 'none' } })),
      null,
    );
  });

  it('透明点击层不点', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button></div>`,
    );
    assert.equal(
      findConsentBanner(doc, ctxFor({ banner: { ...BAR, opacity: '0' } })),
      null,
    );
  });

  it('真实链接不是同意按钮（点击会导航离开）', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<a id="accept" href="/account">Accept all</a></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('空 href 的链接也不点（可能整页重载，形成点击循环）', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<a id="accept" href="">Accept all</a></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('无 href 但 role=button 的链接可以点', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<a id="accept" role="button">Accept all</a></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.button.id, 'accept');
  });

  it('真实链接的接受按钮被跳过，同横幅的拒绝按钮仍可使用', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<a id="accept" href="/account">Accept all</a>` +
        `<button id="reject">Reject all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.button.id, 'reject');
  });

  it('禁用的拒绝按钮被跳过，回退到接受按钮', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="reject" disabled>Reject all</button>` +
        `<button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR }))?.button.id, 'accept');
  });

  it('不可见的拒绝按钮被跳过，回退到接受按钮', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="reject">Reject all</button>` +
        `<button id="accept">Accept all</button></div>`,
    );
    const ctx = ctxFor({ banner: BAR });
    const original = ctx.styleOf!;
    ctx.styleOf = (el) =>
      el.id === 'reject'
        ? { position: 'static', display: 'none', visibility: 'visible', opacity: '1' }
        : original(el);
    assert.equal(findConsentBanner(doc, ctx)?.button.id, 'accept');
  });

  it('文本超长的固定包装器不处理', () => {
    const doc = docWith(
      `<div id="banner">${'cookie '.repeat(2100)}<button id="accept">Accept all</button></div>`,
    );
    assert.equal(findConsentBanner(doc, ctxFor({ banner: BAR })), null);
  });

  it('视口缺失时安全退化', () => {
    const doc = docWith(
      `<div id="banner">${COPY}<button id="accept">Accept all</button></div>`,
    );
    const ctx = ctxFor({ banner: BAR });
    ctx.viewport = { width: 0, height: 0 };
    assert.equal(findConsentBanner(doc, ctx), null);
  });
});
