import { json, readJson } from '../../_lib/http.js';
import { invalidate } from '../../_lib/lookup.js';
import { requireAccess } from '../../_lib/access.js';
export async function onRequestPost({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  return json(await invalidate(env, await readJson(request, 10_000)));
}
