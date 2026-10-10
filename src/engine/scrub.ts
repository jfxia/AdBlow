/**
 * 持久化弹窗状态清理。
 *
 * 依据（设计文档 §1.4）：试点站页面内联脚本自称「本地降级体系」，注释写明
 *   // 对齐：pending持久化 / 刷新重连 / 超时补偿 / beacon重试
 *   // / pagehide beacon / visibilitychange / 充值页刷新
 * 并用 localStorage + sessionStorage + window.name 三处持久化弹窗状态。
 * 只拦 window.open 会被「刷新后自动重开」绕过，所以必须清状态。
 */

const SCRUB_PATTERNS = [/^__ai_float_pending/, /^__ai_float_beacon/, /^__ai_float_popup/];

export function keysToScrub(keys: string[]): string[] {
  return keys.filter((k) => SCRUB_PATTERNS.some((re) => re.test(k)));
}

export function scrubWindowName(name: string): string {
  if (!name) return name;

  let parsed: unknown;
  try {
    parsed = JSON.parse(name);
  } catch {
    return name;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return name;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!SCRUB_PATTERNS.some((re) => re.test(k))) out[k] = v;
  }
  return JSON.stringify(out);
}
