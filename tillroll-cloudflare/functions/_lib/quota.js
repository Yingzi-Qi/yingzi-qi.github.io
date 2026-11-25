// App-side quota guards. Reservations are atomic in D1: a call is only made
// after a counter slot has been reserved below the configured ceiling.
export const LIMIT_DEFAULTS = {
  BRAVE_MONTHLY_LIMIT: 950,
  GEMINI_GROUNDING_MONTHLY_LIMIT: 4800,
  GEMINI_GROUNDING_DAILY_LIMIT: 1450,
  GEMINI_OCR_DAILY_LIMIT: 400,
  KV_WRITE_SOFT_LIMIT: 900,
};
// Hard ceilings from the Orchestrator contract; env can lower but never raise past these.
const HARD = { BRAVE_MONTHLY_LIMIT: 999, GEMINI_GROUNDING_MONTHLY_LIMIT: 4999, GEMINI_GROUNDING_DAILY_LIMIT: 1499, KV_WRITE_SOFT_LIMIT: 990, GEMINI_OCR_DAILY_LIMIT: 1000 };
export function limit(env, name) {
  const v = Number(env?.[name]);
  const n = Number.isFinite(v) && v >= 0 ? v : LIMIT_DEFAULTS[name];
  return Math.min(n, HARD[name] ?? n);
}
const pad = n => String(n).padStart(2, '0');
export function periods(date = new Date()) {
  const y = date.getUTCFullYear(), m = pad(date.getUTCMonth() + 1), d = pad(date.getUTCDate());
  return { month: `month:${y}-${m}`, day: `day:${y}-${m}-${d}` };
}
async function current(env, provider, period) {
  const row = await env.DB.prepare('SELECT count FROM quota_usage WHERE provider=? AND period=?').bind(provider, period).first();
  return row ? Number(row.count) : 0;
}
async function reserveOne(env, provider, period, max) {
  const row = await env.DB.prepare(
    `INSERT INTO quota_usage (provider, period, count) VALUES (?1, ?2, 1)
     ON CONFLICT(provider, period) DO UPDATE SET count = count + 1 WHERE count < ?3
     RETURNING count`).bind(provider, period, max).first();
  if (!row) return false;
  if (Number(row.count) > max) return false; // first insert when max = 0
  return true;
}
async function release(env, provider, period) {
  await env.DB.prepare('UPDATE quota_usage SET count = MAX(count - 1, 0) WHERE provider=? AND period=?').bind(provider, period).run();
}
// Returns { ok: true } or { ok: false, reason }.
export async function reserve(env, provider, date = new Date()) {
  if (!env?.DB) return { ok: false, reason: 'Quota store (D1) is not bound, so look-ups are paused.' };
  const p = periods(date);
  if (provider === 'brave') {
    const max = limit(env, 'BRAVE_MONTHLY_LIMIT');
    return (await reserveOne(env, 'brave', p.month, max)) ? { ok: true } : { ok: false, reason: `Brave Search monthly guard reached (${max}).` };
  }
  if (provider === 'gemini_grounding') {
    const mMax = limit(env, 'GEMINI_GROUNDING_MONTHLY_LIMIT'), dMax = limit(env, 'GEMINI_GROUNDING_DAILY_LIMIT');
    if (!(await reserveOne(env, 'gemini_grounding', p.day, dMax))) return { ok: false, reason: `Gemini grounding daily guard reached (${dMax}).` };
    if (!(await reserveOne(env, 'gemini_grounding', p.month, mMax))) { await release(env, 'gemini_grounding', p.day); return { ok: false, reason: `Gemini grounding monthly guard reached (${mMax}).` }; }
    return { ok: true };
  }
  if (provider === 'gemini_ocr') {
    const max = limit(env, 'GEMINI_OCR_DAILY_LIMIT');
    return (await reserveOne(env, 'gemini_ocr', p.day, max)) ? { ok: true } : { ok: false, reason: `Gemini OCR daily guard reached (${max}).` };
  }
  throw new Error('Unknown quota provider ' + provider);
}
export async function countKvWrite(env, date = new Date()) {
  if (!env?.DB) return true;
  return reserveOne(env, 'kv_writes', periods(date).day, limit(env, 'KV_WRITE_SOFT_LIMIT'));
}
export async function status(env, date = new Date()) {
  const p = periods(date);
  const get = (prov, per) => env?.DB ? current(env, prov, per) : Promise.resolve(0);
  const [brave, gm, gd, ocr, kv] = await Promise.all([
    get('brave', p.month), get('gemini_grounding', p.month), get('gemini_grounding', p.day), get('gemini_ocr', p.day), get('kv_writes', p.day)]);
  const s = {
    brave: { used: brave, limit: limit(env, 'BRAVE_MONTHLY_LIMIT'), period: p.month, configured: Boolean(env?.BRAVE_API_KEY) },
    geminiGroundingMonthly: { used: gm, limit: limit(env, 'GEMINI_GROUNDING_MONTHLY_LIMIT'), period: p.month },
    geminiGroundingDaily: { used: gd, limit: limit(env, 'GEMINI_GROUNDING_DAILY_LIMIT'), period: p.day, configured: Boolean(env?.GEMINI_API_KEY) },
    geminiOcrDaily: { used: ocr, limit: limit(env, 'GEMINI_OCR_DAILY_LIMIT'), period: p.day },
    kvWritesDaily: { used: kv, limit: limit(env, 'KV_WRITE_SOFT_LIMIT'), period: p.day, fallbackToD1: kv >= limit(env, 'KV_WRITE_SOFT_LIMIT') },
  };
  const paused = [];
  if (!env?.DB) paused.push('D1 is not bound.');
  if (!env?.BRAVE_API_KEY && !env?.GEMINI_API_KEY) paused.push('Look-up keys have not been added yet.');
  if (s.brave.used >= s.brave.limit) paused.push('Brave Search monthly guard reached.');
  if (s.geminiGroundingMonthly.used >= s.geminiGroundingMonthly.limit) paused.push('Gemini grounding monthly guard reached.');
  if (s.geminiGroundingDaily.used >= s.geminiGroundingDaily.limit) paused.push('Gemini grounding daily guard reached.');
  return { ...s, lookupsPaused: paused.length > 0, pausedReasons: paused, flag: paused.length ? '#FDE68A' : null };
}
