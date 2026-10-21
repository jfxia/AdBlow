import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGE_GATE_PHRASES,
  CONSENT_BACKDROP_AREA_RATIO,
  CONSENT_EDGE_GAP_PX,
  CONSENT_MAX_TEXT_CHARS,
  CONSENT_MIN_HEIGHT_PX,
  CONSENT_MIN_WIDTH_PX,
  COOKIE_CONSENT_PREFER_REJECT,
  classifyConsentButton,
  chooseConsentButton,
  consentGate,
  judgeCookieConsentBanner,
  normalizeConsentText,
  type ConsentBannerShape,
  type ConsentButtonShape,
} from '../../src/engine/cookieConsent.ts';

// The pure layer is where false-positive policy lives: no DOM, no chrome.*, every rule
// directly assertable. The DOM side is covered in tests/integration/cookieConsentDom.test.ts.

const VIEWPORT = { width: 1280, height: 800 };

/** Banner shape anchored to the bottom edge, with the given copy and controls. */
function bottomBar(
  text: string,
  buttons: ConsentButtonShape[],
  overrides: Partial<ConsentBannerShape> = {},
): ConsentBannerShape {
  return {
    position: 'fixed',
    rect: { top: 700, left: 0, width: VIEWPORT.width, height: 100 },
    viewport: VIEWPORT,
    text,
    buttons,
    ...overrides,
  };
}

const COPY = 'We use cookies to improve your experience. Read our privacy policy.';
const ACCEPT = { text: 'Accept all' };
const REJECT = { text: 'Reject all' };

describe('cookie consent：文本归一化', () => {
  it('大小写、重音、标点与空白都不影响匹配', () => {
    assert.equal(normalizeConsentText('  Accept—ALL  '), 'accept all');
    assert.equal(normalizeConsentText('Confidentialité'), 'confidentialite');
    assert.equal(normalizeConsentText("J'accepte !"), 'j accepte');
  });

  it('中文与日文不被空格拆开', () => {
    assert.equal(normalizeConsentText('同意并继续。'), '同意并继续');
    assert.equal(normalizeConsentText('すべて同意'), 'すべて同意');
  });
});

describe('cookie consent：按钮分类（多语言）', () => {
  const ACCEPTS = [
    ['Accept all cookies', 'accept all cookies'],
    ['Allow all', 'allow all'],
    ['I Agree', 'i agree'],
    ['Got it', 'got it'],
    ['OK', 'ok'],
    ['同意并继续', '同意并继续'],
    ['允许全部', '允许全部'],
    ['了解', '了解'],
    ['すべて同意', 'すべて同意'],
    ['Accepter tout', 'accepter tout'],
    ['Aceptar todo', 'aceptar todo'],
    ['Alle akzeptieren', 'alle akzeptieren'],
    ['Aceitar tudo', 'aceitar tudo'],
    ['Accetta tutto', 'accetta tutto'],
    ['Принять все', 'принять все'],
    ['모두 동의', '모두 동의'],
  ] as const;

  for (const [label, phrase] of ACCEPTS) {
    it(`接受：${label}`, () => {
      const match = classifyConsentButton(label);
      assert.equal(match?.kind, 'accept');
      assert.equal(match?.phrase, phrase);
    });
  }

  const REJECTS = [
    ['Reject all', 'reject all'],
    ['Decline', 'decline'],
    ['Only necessary', 'only necessary'],
    ['Necessary cookies only', 'necessary cookies only'],
    ['Functional only', 'functional only'],
    ['Required only', 'required only'],
    ['拒绝全部', '拒绝全部'],
    ['仅必要', '仅必要'],
    ['すべて拒否', 'すべて拒否'],
    ['Refuser tout', 'refuser tout'],
    ['Rechazar todo', 'rechazar todo'],
    ['Alle ablehnen', 'alle ablehnen'],
    ['Rejeitar tudo', 'rejeitar tudo'],
    ['Rifiuta tutto', 'rifiuta tutto'],
    ['Отклонить все', 'отклонить все'],
    ['모두 거부', '모두 거부'],
  ] as const;

  for (const [label, phrase] of REJECTS) {
    it(`拒绝：${label}`, () => {
      const match = classifyConsentButton(label);
      assert.equal(match?.kind, 'reject');
      assert.equal(match?.phrase, phrase);
    });
  }

  it('拒绝词优先于其中包含的接受词（Not accept / Не согласен / 不同意）', () => {
    assert.equal(classifyConsentButton('Not accept')?.kind, 'reject');
    assert.equal(classifyConsentButton('Не согласен')?.kind, 'reject');
    assert.equal(classifyConsentButton('不同意')?.kind, 'reject');
  });

  it('其它语言里含接受词的否定式仍是拒绝', () => {
    for (const label of [
      '不接受',
      '同意しません',
      'Ne pas accepter',
      'No aceptar',
      'Nicht akzeptieren',
      'Não aceitar',
      'Non accettare',
      'Не принять',
      '수락하지 않음',
    ]) {
      assert.equal(classifyConsentButton(label)?.kind, 'reject', label);
    }
  });

  it('单词按整词匹配：disagree 是拒绝，unacceptable 不是 accept', () => {
    assert.equal(classifyConsentButton('Disagree')?.kind, 'reject');
    assert.equal(classifyConsentButton('Unacceptable'), null);
  });

  it('管理偏好 / 了解更多 / 继续 不被当成接受或拒绝', () => {
    for (const label of [
      'Manage options',
      'Manage necessary cookies',
      'Customize preferences',
      'Learn more',
      'Continue',
      'Privacy policy',
      'Yes',
    ]) {
      assert.equal(classifyConsentButton(label), null, label);
    }
  });

  it('空标签不分类', () => {
    assert.equal(classifyConsentButton('   '), null);
  });
});

describe('cookie consent：按钮选择与偏好开关', () => {
  it('默认常量是有拒绝点拒绝', () => {
    assert.equal(COOKIE_CONSENT_PREFER_REJECT, true);
  });

  it('默认：同时有拒绝与接受时选拒绝', () => {
    const choice = chooseConsentButton([ACCEPT, REJECT]);
    assert.equal(choice?.kind, 'reject');
    assert.equal(choice?.buttonIndex, 1);
    assert.equal(choice?.reason, 'reject-preferred');
  });

  it('没有拒绝时选接受', () => {
    const choice = chooseConsentButton([{ text: 'Manage options' }, ACCEPT]);
    assert.equal(choice?.kind, 'accept');
    assert.equal(choice?.buttonIndex, 1);
    assert.equal(choice?.reason, 'accept-only');
  });

  it('关闭偏好后接受优先，仍可回退到拒绝', () => {
    const acceptFirst = chooseConsentButton([ACCEPT, REJECT], { preferReject: false });
    assert.equal(acceptFirst?.kind, 'accept');
    assert.equal(acceptFirst?.reason, 'accept-preferred');

    const rejectOnly = chooseConsentButton([REJECT], { preferReject: false });
    assert.equal(rejectOnly?.kind, 'reject');
    assert.equal(rejectOnly?.reason, 'reject-only');
  });

  it('禁用 / 不可见 / 不可点击的按钮不参与选择', () => {
    const choice = chooseConsentButton([
      { text: 'Reject all', enabled: false },
      { text: 'Reject all', visible: false },
      { text: 'Reject all', clickable: false },
      ACCEPT,
    ]);
    assert.equal(choice?.kind, 'accept');
    assert.equal(choice?.buttonIndex, 3);
  });

  it('没有可识别的按钮时返回 null', () => {
    assert.equal(chooseConsentButton([{ text: 'Manage options' }]), null);
  });
});

describe('cookie consent：横幅形态', () => {
  it('cookie / consent / privacy 任一出现即可', () => {
    for (const text of [
      'We use cookies on this site.',
      'Your consent matters to us.',
      'Please read our privacy notice.',
    ]) {
      const verdict = judgeCookieConsentBanner(bottomBar(text, [ACCEPT]));
      assert.equal(verdict.isBanner, true, text);
    }
  });

  it('固定定位 + 贴底边 → 横幅', () => {
    const verdict = judgeCookieConsentBanner(bottomBar(COPY, [ACCEPT, REJECT]));
    assert.equal(verdict.isBanner, true);
    if (verdict.isBanner) {
      assert.equal(verdict.kind, 'reject');
      assert.equal(verdict.matchedPhrase, 'reject all');
    }
  });

  it('粘性定位 + 贴顶边 → 横幅（sticky 也算固定）', () => {
    const verdict = judgeCookieConsentBanner({
      ...bottomBar(COPY, [ACCEPT]),
      position: 'sticky',
      rect: { top: 0, left: 0, width: VIEWPORT.width, height: 90 },
    });
    assert.equal(verdict.isBanner, true);
  });

  it('遮罩层：固定定位 + 覆盖 80% 视口，即使不贴边也算', () => {
    const verdict = judgeCookieConsentBanner({
      position: 'fixed',
      rect: { top: 40, left: 40, width: 1200, height: 720 },
      viewport: VIEWPORT,
      text: COPY,
      buttons: [ACCEPT],
    });
    assert.equal(verdict.isBanner, true);
  });

  it('静态定位不算（普通页脚里的 cookie 说明）', () => {
    const verdict = judgeCookieConsentBanner({ ...bottomBar(COPY, [ACCEPT]), position: 'static' });
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'not-fixed');
  });

  it('固定但居中、不贴边、不够遮罩 → 不点（宁漏不误伤）', () => {
    const verdict = judgeCookieConsentBanner({
      position: 'fixed',
      rect: { top: 300, left: 400, width: 480, height: 200 },
      viewport: VIEWPORT,
      text: COPY,
      buttons: [ACCEPT],
    });
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'not-anchored');
  });

  it('贴边容差与遮罩比例是具名常量', () => {
    assert.equal(CONSENT_EDGE_GAP_PX, 80);
    assert.equal(CONSENT_BACKDROP_AREA_RATIO, 0.8);
    assert.equal(CONSENT_MIN_WIDTH_PX, 120);
    assert.equal(CONSENT_MIN_HEIGHT_PX, 32);
  });

  it('太小的浮动控件不算横幅', () => {
    const verdict = judgeCookieConsentBanner({
      ...bottomBar(COPY, [ACCEPT]),
      rect: { top: 770, left: 0, width: 80, height: 20 },
    });
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'too-small');
  });

  it('视口或几何不可用时安全拒绝', () => {
    const badViewport = judgeCookieConsentBanner({
      ...bottomBar(COPY, [ACCEPT]),
      viewport: { width: 0, height: 0 },
    });
    assert.equal(badViewport.isBanner, false);

    const badRect = judgeCookieConsentBanner({
      ...bottomBar(COPY, [ACCEPT]),
      rect: { top: Number.NaN, left: 0, width: 1280, height: 100 },
    });
    assert.equal(badRect.isBanner, false);
  });

  it('文本超过上限（页面包装器）不算横幅', () => {
    const verdict = judgeCookieConsentBanner(bottomBar('cookie '.repeat(CONSENT_MAX_TEXT_CHARS), [ACCEPT]));
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'too-long');
  });
});

describe('cookie consent：误伤防护（硬性排除）', () => {
  it('没有 cookie / consent / privacy 一类词 → 不点', () => {
    const verdict = judgeCookieConsentBanner(
      bottomBar('Get 20% off your first order today.', [{ text: 'Accept' }]),
    );
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'no-consent-vocabulary');
  });

  it('含密码输入框（登录 / 注册表单）→ 不点', () => {
    const verdict = judgeCookieConsentBanner(bottomBar(COPY, [ACCEPT], { hasPasswordField: true }));
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'password-field');
  });

  it('含登录 / 注册按钮 → 不点', () => {
    for (const label of ['Sign in', 'Log in', 'Register', '登录', '注册', 'ログイン', 'Iniciar sesión']) {
      const verdict = judgeCookieConsentBanner(
        bottomBar(COPY, [{ text: label }, ACCEPT]),
      );
      assert.equal(verdict.isBanner, false, label);
      if (!verdict.isBanner) assert.equal(verdict.reason, 'account-control');
    }
  });

  it('含订阅 / 付费墙字样 → 不点', () => {
    for (const text of [
      'Subscribe to read this article. We use cookies.',
      'Subscription required. Cookie settings.',
      '订阅后继续阅读。我们使用 Cookie。',
      'Abonnement requis. Nous utilisons des cookies.',
      'Подписка. Мы используем cookie.',
    ]) {
      const verdict = judgeCookieConsentBanner(bottomBar(text, [ACCEPT]));
      assert.equal(verdict.isBanner, false, text);
      if (!verdict.isBanner) assert.equal(verdict.reason, 'paywall-copy');
    }
  });

  it('含年龄验证字样 → 不点', () => {
    const verdict = judgeCookieConsentBanner(
      bottomBar('Verify your age to continue. We use cookies.', [ACCEPT]),
    );
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'age-gate-copy');
  });

  it('年龄词表里不出现裸 18，避免 "18 partners" 误伤', () => {
    assert.equal(AGE_GATE_PHRASES.includes('18+'), false);
    const verdict = judgeCookieConsentBanner(
      bottomBar('We and our 18 partners use cookies.', [ACCEPT]),
    );
    assert.equal(verdict.isBanner, true);
  });

  it('候选是 / 含正文标记（main / article / role=main）→ 不点', () => {
    const verdict = judgeCookieConsentBanner(bottomBar(COPY, [ACCEPT], { hasMainContent: true }));
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'main-content');
  });

  it('候选是粘性站点头部（含导航 / 搜索）→ 不点', () => {
    const verdict = judgeCookieConsentBanner(bottomBar(COPY, [ACCEPT], { hasNavigation: true }));
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'navigation');
  });

  it('只有 "Manage options" 一类按钮 → 不点', () => {
    const verdict = judgeCookieConsentBanner(
      bottomBar(COPY, [{ text: 'Manage options' }, { text: 'Learn more' }]),
    );
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'no-action-button');
  });

  it('全部按钮都不可用时 → 不点', () => {
    const verdict = judgeCookieConsentBanner(
      bottomBar(COPY, [
        { text: 'Accept all', enabled: false },
        { text: 'Reject all', visible: false },
      ]),
    );
    assert.equal(verdict.isBanner, false);
    if (!verdict.isBanner) assert.equal(verdict.reason, 'no-action-button');
  });
});

describe('cookie consent：两道闸门', () => {
  it('正常情况下放行', () => {
    const gate = consentGate({ topFrame: true, siteDisabled: false, badwareSite: false });
    assert.deepEqual(gate, { allowed: true, reason: 'allowed' });
  });

  it('非顶层文档（iframe）不处理', () => {
    const gate = consentGate({ topFrame: false, siteDisabled: false, badwareSite: false });
    assert.deepEqual(gate, { allowed: false, reason: 'not-top-frame' });
  });

  it('用户已关闭本站过滤 → 不处理', () => {
    const gate = consentGate({ topFrame: true, siteDisabled: true, badwareSite: false });
    assert.deepEqual(gate, { allowed: false, reason: 'site-disabled' });
  });

  it('站点在恶意域名清单里 → 不处理', () => {
    const gate = consentGate({ topFrame: true, siteDisabled: false, badwareSite: true });
    assert.deepEqual(gate, { allowed: false, reason: 'badware-site' });
  });

  it('清单读不到（null）→ 刻意放行，不能退回“整体不动”', () => {
    const gate = consentGate({ topFrame: true, siteDisabled: false, badwareSite: null });
    assert.deepEqual(gate, { allowed: true, reason: 'allowed' });
  });

  it('顶层优先于其它原因，且关闭站点优先于恶意域名', () => {
    assert.equal(
      consentGate({ topFrame: false, siteDisabled: true, badwareSite: null }).reason,
      'not-top-frame',
    );
    assert.equal(
      consentGate({ topFrame: true, siteDisabled: true, badwareSite: true }).reason,
      'site-disabled',
    );
  });
});
