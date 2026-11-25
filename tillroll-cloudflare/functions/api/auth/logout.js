import { json } from '../../_lib/http.js';
import { sessionId, cookieHeader, COOKIE } from '../../_lib/session.js';
export async function onRequestPost({ request, env }) {
  const id = await sessionId(request, env);
  if (id && env.DB) await env.DB.prepare('DELETE FROM oauth_sessions WHERE session_id=?').bind(id).run();
  return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader(COOKIE, '', { maxAge: 0 }) });
}
