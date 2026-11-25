import { json, error, readJson } from '../../_lib/http.js';
import { passcodeMatches, unlockCookie } from '../../_lib/access.js';
export async function onRequestPost({ request, env }) {
  if (!env.APP_PASSCODE || !env.SESSION_SECRET) return error(503, 'Passcode is not configured.');
  const { passcode } = await readJson(request, 2000);
  if (!passcodeMatches(env, passcode)) { await new Promise(r => setTimeout(r, 600)); return error(401, 'Wrong passcode.'); }
  return json({ ok: true }, 200, { 'Set-Cookie': await unlockCookie(env) });
}
