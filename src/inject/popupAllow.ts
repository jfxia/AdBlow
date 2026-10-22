import { isListedHost } from '../engine/domainList.ts';

/**
 * Hosts whose popups are allowed even though they are cross-site.
 *
 * The policy in guards.ts refuses cross-site windows by default. That is right for ads, but a
 * login / OAuth / checkout window is cross-site by nature, and a false positive there costs a
 * user their sign-in. This list is the narrow exception: stable infrastructure that opens
 * windows as part of a real flow.
 *
 * Deliberately **not** a wildcard list: every entry is a real host, and matching is exact plus
 * subdomains (see domainList.isListedHost). A wildcard like `*.google.com` would also allow the
 * ad-serving and user-content hosts under that name, which is the opposite of the point. For the
 * same reason there is no generic hosting domain (e.g. `pages.dev`, `netlify.app`): any popunder
 * could rent one.
 *
 * Each entry costs coverage, so the bar is "a legitimately opened popup is common here and the
 * host is controlled by one organisation". If a site turns out to be missing, the per-site
 * "allow popups" switch is the intended fix -- this file is not meant to grow into a general
 * allowlist.
 */
export const POPUP_ALLOW_HOSTS: readonly string[] = [
  // Google: sign-in, OAuth consent and account security windows.
  'accounts.google.com',
  'myaccount.google.com',
  'accounts.youtube.com',

  // Microsoft: work/school (Entra ID) and consumer account sign-in.
  'login.microsoftonline.com',
  'login.live.com',
  'login.microsoft.com',
  'account.microsoft.com',

  // Apple: Apple ID sign-in and two-factor prompts.
  'appleid.apple.com',

  // GitHub: login, OAuth authorization and device verification. Listing the apex covers
  // api./gist. subdomains, which are all GitHub-controlled.
  'github.com',

  // Tencent: WeChat open-platform OAuth and QQ Connect.
  'open.weixin.qq.com',
  'api.weixin.qq.com',
  'graph.qq.com',
  'connect.qq.com',

  // Weibo: OAuth authorization window and the login it returns to.
  'api.weibo.com',
  'weibo.com',

  // X / Twitter: sign-in and OAuth. Both spellings stay while the old domain redirects.
  'x.com',
  'twitter.com',
  'api.twitter.com',

  // Facebook: the JS SDK opens its login dialog in a popup.
  'facebook.com',

  // Telegram: login widget (oauth.telegram.org) and t.me deep links.
  'oauth.telegram.org',
  'telegram.org',
  't.me',

  // Payments: PayPal checkout and Stripe Checkout.
  'paypal.com',
  'checkout.stripe.com',
  'stripe.com',

  // Alipay: open-platform OAuth and the account login window.
  'openapi.alipay.com',
  'auth.alipay.com',

  // Common SaaS sign-in providers used by third-party sites.
  'discord.com',
  'slack.com',
  'zoom.us',
  'accounts.spotify.com',
  'login.yahoo.com',
  'steamcommunity.com',

  // Enterprise single sign-on. Tenants live on subdomains (acme.okta.com), which the Okta
  // organisation controls; this is not a user-content namespace.
  'okta.com',
];

const ALLOWED = new Set(POPUP_ALLOW_HOSTS);

/**
 * Is this target host allowlisted?
 *
 * Exact host plus its subdomains, case-insensitive, at dot boundaries: `paypal.com` covers
 * `www.paypal.com`, and `nota.com` never matches `a.com`.
 */
export function isPopupAllowlistedHost(host: string): boolean {
  return isListedHost(host, ALLOWED);
}
