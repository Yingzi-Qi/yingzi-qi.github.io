import { verify, sign, decrypt, encrypt } from './crypto.js';
import { nowIso } from './http.js';
export const COOKIE = 'tr_session';
export function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
export function cookieHeader(name, value, { maxAge = 60 * 60 * 24 * 30, path = '/' } = {}) {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
export async function sessionId(request, env) {
  const raw = cookies(request)[COOKIE];
  if (!raw || !env?.SESSION_SECRET) return null;
  return verify(env, raw);
}
export async function newSessionCookie(env, id) { return cookieHeader(COOKIE, await sign(env, id)); }
export async function loadSession(request, env) {
  const id = await sessionId(request, env);
  if (!id || !env?.DB) return null;
  const row = await env.DB.prepare('SELECT * FROM oauth_sessions WHERE session_id=?').bind(id).first();
  return row || null;
}
// Returns a valid Google access token for the session, refreshing when needed.
export async function googleAccessToken(env, session, fetchImpl = fetch) {
  if (!session) throw Object.assign(new Error('Connect Google Drive first.'), { status: 401 });
  if (session.enc_access_token && Number(session.access_expires_at) > Date.now() + 60_000) return decrypt(env, session.enc_access_token);
  const refresh = await decrypt(env, session.enc_refresh_token);
  if (!refresh) throw Object.assign(new Error('Google Drive connection expired. Connect again.'), { status: 401 });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }) });
  if (!res.ok) throw Object.assign(new Error('Google refused the token refresh. Connect Google Drive again.'), { status: 401 });
  const t = await res.json();
  await env.DB.prepare('UPDATE oauth_sessions SET enc_access_token=?, access_expires_at=?, updated_at=? WHERE session_id=?')
    .bind(await encrypt(env, t.access_token), Date.now() + (t.expires_in || 3600) * 1000, nowIso(), session.session_id).run();
  return t.access_token;
}
