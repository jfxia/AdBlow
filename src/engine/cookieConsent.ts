/**
 * Cookie-consent banner recognition and button choice — **pure logic only**.
 *
 * The content layer collects element shapes, reads computed styles and clicks; this module
 * never touches the DOM, `chrome.*` or layout. That split is what lets the false-positive
 * rules below be regression-tested under Node + jsdom.
 *
 * Product decision: a banner is dismissed by clicking a button, never by hiding it. Hiding
 * leaves the site's consent state unset, so the banner returns on the next page and the user
 * has to look at it again. The chosen button is therefore one the site itself offers.
 *
 * False positives are far more expensive than misses here (the project's standing rule):
 * clicking the wrong control can sign the user in, subscribe them, or confirm an age gate.
 * Acceptance requires **all** of:
 *
 *   1. shape — `position: fixed|sticky` **and** anchored to a viewport edge or covering the
 *      viewport like a backdrop;
 *   2. vocabulary — cookie/consent/privacy wording (localised, see CONSENT_CONTEXT_PHRASES);
 *   3. a control whose label is a known accept or reject wording (never "manage options",
 *      "learn more", "continue" or a bare "yes").
 *
 * and rejects on any account/paywall/age-gate signal (see the exclusion passes in
 * judgeCookieConsentBanner).
 *
 * When a reject-style control exists, it is preferred by default: the banner still goes away,
 * but one tracking consent is not handed over. `COOKIE_CONSENT_PREFER_REJECT` flips that.
 */

export const COOKIE_CONSENT_PREFER_REJECT = true;

/**
 * Reject-style labels, in the locales AdBlow ships or is commonly used in.
 *
 * Matching is case-, accent-, punctuation- and whitespace-insensitive (see
 * normalizeConsentText). Single Latin words match whole words only, so "disagree" cannot be
 * read as "agree" and "unacceptable" cannot be read as "accept"; CJK and Cyrillic labels use
 * substring matching because they have no usable JS word boundary. Multi-word labels match
 * as substrings, which is what lets "Accept all cookies" match "accept all". Reject labels
 * are checked first, so a compound label such as "not accept" wins over the accept word it
 * contains.
 */
export const CONSENT_REJECT_PHRASES: readonly string[] = [
  // English
  'reject all',
  'reject all cookies',
  'reject cookies',
  'reject',
  'decline all',
  'decline',
  'refuse all',
  'refuse',
  'only necessary',
  'necessary only',
  'essential only',
  'only essential',
  'essential cookies only',
  'only essential cookies',
  'strictly necessary',
  'strictly necessary cookies',
  'required only',
  'only required',
  'required cookies only',
  'only required cookies',
  'functional only',
  'only functional',
  'necessary cookies',
  'only necessary cookies',
  'necessary cookies only',
  'strictly necessary only',
  'use necessary cookies only',
  'continue without accepting',
  'do not accept',
  'do not agree',
  'not accept',
  'not accepted',
  'no thanks',
  'deny',
  'disagree',
  // Chinese
  '拒绝',
  '拒绝全部',
  '全部拒绝',
  '拒绝所有',
  '仅必要',
  '只使用必要',
  '仅使用必要',
  '只接受必要',
  '拒绝并继续',
  '不同意',
  '不接受',
  '不允许',
  // Japanese
  '拒否',
  'すべて拒否',
  '全て拒否',
  '拒否する',
  '同意しない',
  '同意しません',
  '承認しません',
  '必要なもののみ',
  '必須のみ',
  '必要なcookieのみ',
  // French
  'refuser',
  'refuse',
  'refuser tout',
  'tout refuser',
  'refuser tous',
  'ne pas accepter',
  'seuls les necessaires',
  'uniquement les necessaires',
  'necessaire uniquement',
  'refuser et continuer',
  // Spanish
  'rechazar',
  'rechazar todo',
  'rechazar todos',
  'no aceptar',
  'solo necesarias',
  'solo las necesarias',
  'unicamente necesarias',
  'rechazar y continuar',
  'no acepto',
  // German
  'ablehnen',
  'alle ablehnen',
  'ablehnen alle',
  'nur notwendige',
  'nur erforderliche',
  'nur essenzielle',
  'ablehnen und fortfahren',
  'nicht akzeptieren',
  // Portuguese
  'rejeitar',
  'rejeitar tudo',
  'rejeitar todos',
  'nao aceitar',
  'apenas necessarios',
  'somente necessarios',
  'apenas necessarias',
  'rejeitar e continuar',
  'nao aceito',
  // Italian
  'rifiuta',
  'rifiuta tutto',
  'rifiuta tutti',
  'non accettare',
  'solo necessari',
  'solo i necessari',
  'rifiuta e continua',
  'non accetto',
  // Russian
  'отклонить',
  'отклонить все',
  'отклонить всё',
  'не принять',
  'только необходимые',
  'только необходимые файлы cookie',
  'отклонить и продолжить',
  'не согласен',
  'не согласна',
  // Korean
  '거부',
  '모두 거부',
  '전체 거부',
  '거부합니다',
  '수락하지 않음',
  '필수만',
  '필수 항목만',
  '동의하지 않음',
  '동의 안 함',
];

/**
 * Accept-style labels.
 *
 * Deliberately no generic "continue"/"confirm"/"yes": those are the labels of sign-in,
 * paywall and age-check dialogs as often as of consent banners. The surrounding exclusions
 * catch most of those, but the button table should not be a false-positive source itself.
 */
export const CONSENT_ACCEPT_PHRASES: readonly string[] = [
  // English
  'accept all',
  'accept all cookies',
  'accept cookies',
  'accept',
  'allow all',
  'allow all cookies',
  'allow cookies',
  'agree',
  'i agree',
  'yes i agree',
  'got it',
  'ok',
  'okay',
  'understood',
  // Chinese
  '同意',
  '接受',
  '允许全部',
  '全部接受',
  '接受全部',
  '同意并继续',
  '接受并继续',
  '我同意',
  '同意全部',
  '了解',
  '好的',
  '我知道了',
  // Japanese
  '承認',
  'すべて同意',
  '全て同意',
  '同意する',
  '同意',
  'すべて受け入れる',
  '受け入れる',
  'わかりました',
  '了解しました',
  // French
  'accepter',
  'accepter tout',
  'tout accepter',
  'accepter tous',
  'j accepte',
  'accepter et continuer',
  'd accord',
  // Spanish
  'aceptar',
  'aceptar todo',
  'aceptar todas',
  'acepto',
  'aceptar y continuar',
  'de acuerdo',
  // German
  'akzeptieren',
  'alle akzeptieren',
  'akzeptieren alle',
  'zustimmen',
  'ich stimme zu',
  'verstanden',
  'einverstanden',
  // Portuguese
  'aceitar',
  'aceitar tudo',
  'aceitar todos',
  'concordo',
  'aceitar e continuar',
  // Italian
  'accetta',
  'accetta tutto',
  'accetta tutti',
  'accetto',
  'accetta e continua',
  // Russian
  'принять',
  'принять все',
  'принять всё',
  'согласен',
  'соглашаюсь',
  'принять и продолжить',
  // Korean
  '동의',
  '모두 동의',
  '전체 동의',
  '동의합니다',
  '수락',
  '모두 수락',
  '확인',
];

/**
 * Wording that marks an element as a consent banner rather than a generic dialog.
 *
 * Matched as a case-insensitive substring after normalisation, so "cookie" covers "cookies"
 * and "cookie policy"; accents are stripped, hence "confidentialite" rather than
 * "confidentialité".
 */
export const CONSENT_CONTEXT_PHRASES: readonly string[] = [
  'cookie',
  'cookies',
  'consent',
  'privacy',
  'gdpr',
  'ccpa',
  'tracking',
  'personal data',
  // Chinese
  '隐私',
  '个人信息',
  '同意',
  // Japanese
  'クッキー',
  'プライバシー',
  '個人情報',
  '同意',
  // French
  'temoin',
  'confidentialite',
  'consentement',
  'donnees personnelles',
  // Spanish
  'galleta',
  'galletas',
  'privacidad',
  'consentimiento',
  'datos personales',
  // German
  'datenschutz',
  'einwilligung',
  'personenbezogene daten',
  // Portuguese
  'privacidade',
  'consentimento',
  'dados pessoais',
  // Italian
  'privacy',
  'consenso',
  'dati personali',
  // Russian
  'конфиденциальност',
  'согласие',
  'персональн',
  'куки',
  // Korean
  '개인정보',
  '쿠키',
  '동의',
];

/**
 * Controls that mean the dialog is an account form, not a consent banner.
 *
 * Checked on every control inside the candidate, not just the selected one: a sign-in link
 * next to a fake "Accept" is exactly the mistake this module must not make.
 */
export const ACCOUNT_CONTROL_PHRASES: readonly string[] = [
  'sign in',
  'signin',
  'sign up',
  'signup',
  'log in',
  'login',
  'register',
  'create account',
  'my account',
  // Chinese
  '登录',
  '登入',
  '注册',
  // Japanese
  'サインイン',
  'ログイン',
  '新規登録',
  // French
  'connexion',
  'se connecter',
  'creer un compte',
  // Spanish
  'iniciar sesion',
  'registrarse',
  // German
  'anmelden',
  'einloggen',
  'registrieren',
  // Portuguese
  'entrar',
  'criar conta',
  // Italian
  'accedi',
  'registrati',
  // Russian
  'войти',
  'зарегистрироваться',
  // Korean
  '로그인',
  '회원가입',
];

/** Paywall/subscription wording: a fixed promo modal is not a consent banner. */
export const PAYWALL_PHRASES: readonly string[] = [
  'subscribe',
  'subscription',
  'paywall',
  'premium',
  'membership',
  'free trial',
  // Chinese
  '订阅',
  '付费',
  '会员',
  // Japanese
  '購読',
  '有料',
  // French
  'abonnement',
  'abonne',
  // Spanish
  'suscripcion',
  'suscrib',
  // German
  'abonnieren',
  // Portuguese
  'assinatura',
  'assinar',
  // Italian
  'abbonamento',
  // Russian
  'подписк',
  // Korean
  '구독',
  '유료',
];

/** Age-gate wording: never click through an age check on the user's behalf. */
export const AGE_GATE_PHRASES: readonly string[] = [
  'age verification',
  'verify your age',
  'are you 18',
  'are you over 18',
  'i am 18',
  'i am over 18',
  'date of birth',
  // Chinese
  '年龄验证',
  '年龄确认',
  '是否年满',
  '已满18',
  // Japanese
  '年齢確認',
  '生年月日',
  // French
  'verification de l age',
  'date de naissance',
  // Spanish
  'verificar edad',
  'fecha de nacimiento',
  // German
  'altersverifikation',
  'geburtsdatum',
  // Portuguese
  'verificacao de idade',
  'data de nascimento',
  // Italian
  'verifica dell eta',
  'data di nascita',
  // Russian
  'подтверждение возраста',
  'дата рождения',
  // Korean
  '연령 확인',
  '생년월일',
];

/**
 * Settings/preferences wording. A control that opens a preference panel does not dismiss the
 * banner, so it must never be picked as accept or reject — even if it also contains a word
 * from one of those tables ("Manage necessary cookies", "Customize preferences").
 */
export const CONSENT_NON_ACTION_PHRASES: readonly string[] = [
  'manage',
  'settings',
  'preferences',
  'customize',
  'customise',
  'options',
  'learn more',
  'more info',
  'read more',
  // Chinese
  '管理',
  '设置',
  '偏好',
  '选项',
  '更多',
  // Japanese
  '設定',
  '管理',
  'オプション',
  '詳細',
  // French
  'gerer',
  'parametres',
  'personnaliser',
  // Spanish
  'gestionar',
  'configurar',
  'preferencias',
  // German
  'verwalten',
  'einstellungen',
  'anpassen',
  // Portuguese
  'gerenciar',
  'configuracoes',
  'personalizar',
  // Italian
  'gestisci',
  'impostazioni',
  'personalizza',
  // Russian
  'настроить',
  'настройки',
  'управлять',
  // Korean
  '설정',
  '관리',
  '맞춤',
];

/** A banner must be at least this wide; below this it is a control, not a dialog. */
export const CONSENT_MIN_WIDTH_PX = 120;
/** A banner must be at least this tall. */
export const CONSENT_MIN_HEIGHT_PX = 32;
/** Distance from a viewport edge that still counts as "anchored" (a floating bar's margin). */
export const CONSENT_EDGE_GAP_PX = 80;
/** Share of the viewport that makes a fixed element a backdrop rather than a bar. */
export const CONSENT_BACKDROP_AREA_RATIO = 0.8;
/** Longer text means a page wrapper or article, not a prompt. */
export const CONSENT_MAX_TEXT_CHARS = 2000;

/** One control inside a candidate banner, as observed by the content layer. */
export type ConsentButtonShape = {
  /** Visible label / accessible name. */
  text: string;
  /** Defaults to true. A disabled control is never clicked. */
  enabled?: boolean;
  /** Defaults to true. A control with no rendered box is never clicked. */
  visible?: boolean;
  /**
   * Defaults to true. Links with a real destination are marked false by the content layer:
   * clicking one would navigate away instead of dismissing the banner.
   */
  clickable?: boolean;
};

/** One candidate element, as observed by the content layer. */
export type ConsentBannerShape = {
  /** Computed CSS `position`. */
  position: string;
  rect: { top: number; left: number; width: number; height: number };
  viewport: { width: number; height: number };
  /** Text of the candidate (labels included or not; both work). */
  text: string;
  buttons: readonly ConsentButtonShape[];
  /** True when the candidate contains a password input (account form). */
  hasPasswordField?: boolean;
  /** True when the candidate is, or contains, main/article markup (page wrapper). */
  hasMainContent?: boolean;
  /** True when the candidate contains site navigation or a search control (sticky header). */
  hasNavigation?: boolean;
};

export type ConsentButtonKind = 'accept' | 'reject';

export type ConsentButtonMatch = {
  kind: ConsentButtonKind;
  /** The table entry that matched, for diagnostics and tests. */
  phrase: string;
};

export type ConsentSkipReason =
  | 'not-fixed'
  | 'invalid-geometry'
  | 'too-small'
  | 'empty-text'
  | 'too-long'
  | 'main-content'
  | 'navigation'
  | 'password-field'
  | 'paywall-copy'
  | 'age-gate-copy'
  | 'account-control'
  | 'no-consent-vocabulary'
  | 'not-anchored'
  | 'no-action-button';

export type ConsentChoiceReason =
  | 'reject-preferred'
  | 'accept-only'
  | 'accept-preferred'
  | 'reject-only';

export type ConsentVerdict =
  | { isBanner: false; reason: ConsentSkipReason }
  | {
      isBanner: true;
      buttonIndex: number;
      kind: ConsentButtonKind;
      matchedPhrase: string;
      reason: ConsentChoiceReason;
    };

export type ConsentJudgeOptions = {
  /** Defaults to COOKIE_CONSENT_PREFER_REJECT. */
  preferReject?: boolean;
};

export type ConsentGateInput = {
  /** Content scripts run in every frame; banners in ad iframes are not ours to dismiss. */
  topFrame: boolean;
  siteDisabled: boolean;
  /**
   * `true`  — the host is on the packaged badware-domain list (do not touch);
   * `false` — the list was read and the host is not on it;
   * `null`  — the list could not be read. Deliberately **allowed**: a missing list must
   *           not disable banner handling in packaged builds (see badwareDomains.ts).
   */
  badwareSite: boolean | null;
};

export type ConsentGateReason =
  | 'allowed'
  | 'not-top-frame'
  | 'site-disabled'
  | 'badware-site';

export type ConsentGate = { allowed: boolean; reason: ConsentGateReason };

/**
 * Two gates before any page mutation: top frame only, site not disabled by the user, and
 * the host not on the badware list. Only `badwareSite === true` blocks; `false` and `null`
 * both allow. That asymmetry is intentional — see ConsentGateInput.
 */
export function consentGate(input: ConsentGateInput): ConsentGate {
  if (!input.topFrame) return { allowed: false, reason: 'not-top-frame' };
  if (input.siteDisabled) return { allowed: false, reason: 'site-disabled' };
  if (input.badwareSite === true) return { allowed: false, reason: 'badware-site' };
  return { allowed: true, reason: 'allowed' };
}

/**
 * Lowercase, strip accents, turn every run of punctuation into one space.
 *
 * `NFD` + combining-mark removal makes "confidentialité" and "confidentialite" the same
 * string; punctuation-to-space keeps the token rules below usable for "accept-all",
 * "J'accepte" and "18+".
 */
export function normalizeConsentText(raw: string): string {
  return (raw ?? '')
    .toLowerCase()
    // NFD splits accented Latin letters and Japanese dakuten alike. Strip only the Latin
    // combining marks (U+0300–U+036F), then NFC puts kana back together: doing both keeps
    // "confidentialité" == "confidentialite" without turning "すべて" into "すへ て".
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True for Han/Kana/Hangul, where whitespace tokenisation does not apply. */
function hasCjk(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(text);
}

/** Cyrillic has no ASCII word boundary in JS regexes; prefix matching is safer there. */
function hasCyrillic(text: string): boolean {
  return /[\u0400-\u04ff]/.test(text);
}

/**
 * One table entry against one normalised text.
 *
 * Single non-CJK words match whole words only (space-delimited after normalisation) so that
 * "disagree" cannot satisfy "agree". Multi-word labels and CJK labels match as substrings,
 * which is how "Accept all cookies" satisfies "accept all".
 */
function phraseMatches(text: string, normalizedPhrase: string): boolean {
  if (!normalizedPhrase) return false;
  if (hasCjk(normalizedPhrase) || hasCyrillic(normalizedPhrase) || normalizedPhrase.includes(' ')) {
    return text.includes(normalizedPhrase);
  }
  return ` ${text} `.includes(` ${normalizedPhrase} `);
}

/** Longest matching entry wins, so diagnostics report the most specific label. */
function bestPhraseMatch(
  text: string,
  phrases: readonly string[],
): string | null {
  let best: string | null = null;
  for (const phrase of phrases) {
    const normalized = normalizeConsentText(phrase);
    if (!phraseMatches(text, normalized)) continue;
    if (best === null || normalized.length > best.length) best = normalized;
  }
  return best;
}

/**
 * Classify one control label. Reject is checked first on purpose: labels such as
 * "Not accept" / "Не согласен" contain an accept-looking word and must not be read as accept.
 */
export function classifyConsentButton(raw: string): ConsentButtonMatch | null {
  const text = normalizeConsentText(raw);
  if (!text) return null;
  // A settings control is never a dismissal even when it borrows accept/reject wording.
  if (bestPhraseMatch(text, CONSENT_NON_ACTION_PHRASES) !== null) return null;
  const reject = bestPhraseMatch(text, CONSENT_REJECT_PHRASES);
  if (reject !== null) return { kind: 'reject', phrase: reject };
  const accept = bestPhraseMatch(text, CONSENT_ACCEPT_PHRASES);
  if (accept !== null) return { kind: 'accept', phrase: accept };
  return null;
}

/** A control is eligible only if the page could actually receive the click. */
function isUsableButton(button: ConsentButtonShape): boolean {
  return (
    button.enabled !== false &&
    button.visible !== false &&
    button.clickable !== false &&
    normalizeConsentText(button.text).length > 0
  );
}

/**
 * Pick the control to click. Reject is preferred when present; the flag flips the preference
 * but both directions still dismiss the banner. A reject-style control that is disabled or
 * off-screen does not block the accept fallback.
 */
export function chooseConsentButton(
  buttons: readonly ConsentButtonShape[],
  options: ConsentJudgeOptions = {},
): {
  buttonIndex: number;
  kind: ConsentButtonKind;
  matchedPhrase: string;
  reason: ConsentChoiceReason;
} | null {
  const preferReject = options.preferReject ?? COOKIE_CONSENT_PREFER_REJECT;
  const rejects: { index: number; match: ConsentButtonMatch }[] = [];
  const accepts: { index: number; match: ConsentButtonMatch }[] = [];

  for (let i = 0; i < buttons.length; i += 1) {
    const button = buttons[i];
    if (!button || !isUsableButton(button)) continue;
    const match = classifyConsentButton(button.text);
    if (!match) continue;
    if (match.kind === 'reject') rejects.push({ index: i, match });
    else accepts.push({ index: i, match });
  }

  const first = (
    list: { index: number; match: ConsentButtonMatch }[],
    reason: ConsentChoiceReason,
  ) => {
    const entry = list[0];
    if (!entry) return null;
    return {
      buttonIndex: entry.index,
      kind: entry.match.kind,
      matchedPhrase: entry.match.phrase,
      reason,
    };
  };

  if (preferReject) {
    return first(rejects, 'reject-preferred') ?? first(accepts, 'accept-only');
  }
  return first(accepts, 'accept-preferred') ?? first(rejects, 'reject-only');
}

/** Fixed/sticky plus edge-anchored or backdrop-sized. */
function hasBannerShape(shape: ConsentBannerShape): boolean {
  const position = normalizeConsentText(shape.position);
  if (position !== 'fixed' && position !== 'sticky') return false;

  const { rect, viewport } = shape;
  if (!(viewport.width > 0) || !(viewport.height > 0)) return false;
  if (
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    return false;
  }
  if (rect.width < CONSENT_MIN_WIDTH_PX || rect.height < CONSENT_MIN_HEIGHT_PX) return false;

  const gaps = [
    rect.top,
    rect.left,
    viewport.height - (rect.top + rect.height),
    viewport.width - (rect.left + rect.width),
  ];
  const edgeAnchored = Math.min(...gaps) <= CONSENT_EDGE_GAP_PX;
  const areaRatio = (rect.width * rect.height) / (viewport.width * viewport.height);
  return edgeAnchored || areaRatio >= CONSENT_BACKDROP_AREA_RATIO;
}

/**
 * Is this candidate a cookie-consent banner, and if so which control should be clicked?
 *
 * The order of the checks is the audit trail: shape first (cheap, and a static newsletter box
 * fails immediately), then absolute exclusions, then the positive vocabulary and button
 * evidence. Every rejection has its own reason so test failures and logs are diagnosable.
 */
export function judgeCookieConsentBanner(
  shape: ConsentBannerShape,
  options: ConsentJudgeOptions = {},
): ConsentVerdict {
  if (!hasBannerShape(shape)) {
    const position = normalizeConsentText(shape.position);
    if (position !== 'fixed' && position !== 'sticky') return { isBanner: false, reason: 'not-fixed' };
    const { rect, viewport } = shape;
    if (!(viewport.width > 0) || !(viewport.height > 0)) {
      return { isBanner: false, reason: 'invalid-geometry' };
    }
    if (rect.width < CONSENT_MIN_WIDTH_PX || rect.height < CONSENT_MIN_HEIGHT_PX) {
      return { isBanner: false, reason: 'too-small' };
    }
    return { isBanner: false, reason: 'not-anchored' };
  }

  const text = normalizeConsentText(shape.text);
  if (!text) return { isBanner: false, reason: 'empty-text' };
  if (text.length > CONSENT_MAX_TEXT_CHARS) return { isBanner: false, reason: 'too-long' };

  // Absolute exclusions: one of these and the candidate is never a consent banner, whatever
  // the copy and shape look like.
  if (shape.hasMainContent === true) return { isBanner: false, reason: 'main-content' };
  if (shape.hasNavigation === true) return { isBanner: false, reason: 'navigation' };
  if (shape.hasPasswordField === true) return { isBanner: false, reason: 'password-field' };
  if (bestPhraseMatch(text, PAYWALL_PHRASES) !== null) {
    return { isBanner: false, reason: 'paywall-copy' };
  }
  if (bestPhraseMatch(text, AGE_GATE_PHRASES) !== null) {
    return { isBanner: false, reason: 'age-gate-copy' };
  }
  for (const button of shape.buttons) {
    const label = normalizeConsentText(button.text);
    if (label && bestPhraseMatch(label, ACCOUNT_CONTROL_PHRASES) !== null) {
      return { isBanner: false, reason: 'account-control' };
    }
  }

  const hasContext = CONSENT_CONTEXT_PHRASES.some((phrase) =>
    phraseMatches(text, normalizeConsentText(phrase)),
  );
  if (!hasContext) return { isBanner: false, reason: 'no-consent-vocabulary' };

  const choice = chooseConsentButton(shape.buttons, options);
  if (!choice) return { isBanner: false, reason: 'no-action-button' };
  return { isBanner: true, ...choice };
}
