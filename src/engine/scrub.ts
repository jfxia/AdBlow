/**
 * Persistent popup-state scrubbing (design doc §1.4): the pilot site's inline
 * script keeps popup state in localStorage, sessionStorage and window.name, so
 * blocking window.open alone is bypassed by "reopen after refresh".
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
