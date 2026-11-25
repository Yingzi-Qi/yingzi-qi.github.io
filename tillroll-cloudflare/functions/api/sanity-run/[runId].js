import { json, error } from '../../_lib/http.js';
import { getRun } from '../../_lib/runs.js';
import { requireAccess } from '../../_lib/access.js';
export async function onRequestGet({ request, params, env, waitUntil }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const run = await getRun(env, String(params.runId), waitUntil);
  return run ? json(run) : error(404, 'Run not found.');
}
