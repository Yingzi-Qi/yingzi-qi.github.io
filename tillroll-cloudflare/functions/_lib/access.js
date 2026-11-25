// Protects quota-spending endpoints on the public *.pages.dev URL.
import { cookies, cookieHeader, loadSession } from './session.js';
import { sign, verify } from './crypto.js';
export const ACCESS_COOKIE = 'tr_access';
const liveKeys = env => Boolean(env?.GEMINI_API_KEY || env?.BRAVE_API_KEY);
export async function requireAccess(request, env) {
  if (!env?.APP_PASSCODE) {
    if (!liveKeys(env)) return null; // mock / no-key mode: nothing to spend
    return Object.assign(new Error('Set the APP_PASSCODE secret before live look-ups are enabled on a public URL.'), { status: 503 });
  }
  const raw = cookies(request)[ACCESS_COOKIE];
  if (raw && env.SESSION_SECRET && (await verify(env, raw)) === 'unlocked') return null;
  if (await loadSession(request, env).catch(() => null)) return null;
  return Object.assign(new Error('Unlock Tillroll first.'), { status: 401, code: 'locked' });
}
export async function unlockCookie(env) { return cookieHeader(ACCESS_COOKIE, await sign(env, 'unlocked'), { maxAge: 60 * 60 * 24 * 30 }); }
export function passcodeMatches(env, given) {
  const a = String(env?.APP_PASSCODE || ''), b = String(given || '');
  if (!a || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
