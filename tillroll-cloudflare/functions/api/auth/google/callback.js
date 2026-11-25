import { error, nowIso, randomId } from '../../../_lib/http.js';
import { verify, encrypt } from '../../../_lib/crypto.js';
import { cookies, cookieHeader, newSessionCookie, sessionId } from '../../../_lib/session.js';
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return Response.redirect(`${url.origin}/?drive=denied`, 302);
  const state = url.searchParams.get('state'), code = url.searchParams.get('code');
  const expected = await verify(env, cookies(request).tr_oauth_state || '');
  if (!state || !code || !expected || expected !== state) return error(400, 'OAuth state mismatch. Start Connect Google Drive again.');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${url.origin}/api/auth/google/callback`, grant_type: 'authorization_code' }) });
  if (!tokenRes.ok) return error(502, 'Google did not issue tokens.');
  const t = await tokenRes.json();
  let email = null;
  try { email = JSON.parse(atob(t.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email || null; } catch { /* optional */ }
  const id = (await sessionId(request, env)) || randomId('s_');
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO oauth_sessions (session_id, provider, account_email, enc_refresh_token, enc_access_token, access_expires_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET account_email=excluded.account_email, enc_refresh_token=COALESCE(excluded.enc_refresh_token, oauth_sessions.enc_refresh_token),
    enc_access_token=excluded.enc_access_token, access_expires_at=excluded.access_expires_at, updated_at=excluded.updated_at`)
    .bind(id, 'google', email, t.refresh_token ? await encrypt(env, t.refresh_token) : null, await encrypt(env, t.access_token), Date.now() + (t.expires_in || 3600) * 1000, now, now).run();
  const h = new Headers({ Location: `${url.origin}/?drive=connected` });
  h.append('Set-Cookie', await newSessionCookie(env, id));
  h.append('Set-Cookie', cookieHeader('tr_oauth_state', '', { maxAge: 0, path: '/api/auth/google' }));
  return new Response(null, { status: 302, headers: h });
}
