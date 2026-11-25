import { json } from '../../_lib/http.js';
import { loadSession } from '../../_lib/session.js';
import { requireAccess } from '../../_lib/access.js';
export async function onRequestGet({ request, env }) {
  const s = await loadSession(request, env).catch(() => null);
  const locked = await requireAccess(request, env);
  return json({ drive: { configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), connected: Boolean(s?.enc_refresh_token), email: s?.account_email || null },
    access: { unlocked: !locked, passcodeRequired: Boolean(env.APP_PASSCODE), reason: locked?.message || null } });
}
