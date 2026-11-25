import { json, readJson, error } from '../../_lib/http.js';
import { createRun, processRun } from '../../_lib/runs.js';
import { requireAccess } from '../../_lib/access.js';
export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.DB) return error(503, 'D1 is not bound.');
  const denied = await requireAccess(request, env); if (denied) throw denied;
  const run = await createRun(env, await readJson(request, 4_000_000));
  waitUntil(processRun(env, run.runId));
  return json(run, 202);
}
