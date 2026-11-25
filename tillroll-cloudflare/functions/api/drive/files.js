import { json } from '../../_lib/http.js';
import { loadSession, googleAccessToken } from '../../_lib/session.js';
import { googleDrive } from '../../_lib/storage/google-drive.js';
export async function onRequestGet({ request, env }) {
  const folder = new URL(request.url).searchParams.get('folder') === 'history' ? 'history' : 'exports';
  const drive = googleDrive(await googleAccessToken(env, await loadSession(request, env)));
  return json({ folder, files: await drive.list(folder) });
}
