import { loadSession, googleAccessToken } from '../../../_lib/session.js';
import { googleDrive } from '../../../_lib/storage/google-drive.js';
export async function onRequestGet({ request, env, params }) {
  const drive = googleDrive(await googleAccessToken(env, await loadSession(request, env)));
  const res = await drive.download(String(params.id));
  return new Response(res.body, { headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'no-store' } });
}
