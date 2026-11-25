// Start Google OAuth (drive.file scope only).
import { error, randomId } from '../../../_lib/http.js';
import { sign, requireSecret } from '../../../_lib/crypto.js';
import { cookieHeader } from '../../../_lib/session.js';
export const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
export async function onRequestGet({ request, env }) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return error(503, 'Google Drive is not configured yet (OAuth client pending secure handoff).', { code: 'no-oauth' });
  requireSecret(env);
  const url = new URL(request.url);
  const state = randomId('st_');
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${url.origin}/api/auth/google/callback`, response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state }).toString();
  return new Response(null, { status: 302, headers: { Location: auth.toString(), 'Set-Cookie': cookieHeader('tr_oauth_state', await sign(env, state), { maxAge: 600, path: '/api/auth/google' }) } });
}
