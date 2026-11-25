import { json, error } from '../../_lib/http.js';
import { requireAccess } from '../../_lib/access.js';
export async function onRequestGet({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const r = await env.DB.prepare('SELECT workbook_id, provider, drive_file_id, name, folder, web_view_link, batch_id, created_at, last_refreshed_at FROM linked_workbooks ORDER BY created_at DESC LIMIT 200').all();
  return json({ workbooks: r.results || [] });
}
