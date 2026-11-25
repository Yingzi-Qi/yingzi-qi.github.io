// human_verified_unflagged locks (binding D1 contract).
import { json, error, readJson, nowIso } from '../_lib/http.js';
import { requireAccess } from '../_lib/access.js';
import { COLUMNS } from '../_lib/sanity.js';
export async function onRequestGet({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const ids = (new URL(request.url).searchParams.get('rowIds') || '').split(',').filter(Boolean).slice(0, 90);
  if (!ids.length) return json({ locks: [] });
  const r = await env.DB.prepare(`SELECT row_id, col_key, verified_at FROM human_verified_unflagged WHERE row_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  return json({ locks: r.results || [] });
}
export async function onRequestPost({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const { locks } = await readJson(request, 200_000);
  if (!Array.isArray(locks)) return error(400, 'locks must be an array of {rowId, col}.');
  const t = nowIso();
  const stmts = locks.filter(l => l && l.rowId && COLUMNS.includes(l.col)).slice(0, 500)
    .map(l => env.DB.prepare('INSERT OR IGNORE INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind(String(l.rowId), l.col, t));
  if (stmts.length) await env.DB.batch(stmts);
  return json({ stored: stmts.length });
}
