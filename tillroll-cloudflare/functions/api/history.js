import { json, error, readJson, nowIso } from '../_lib/http.js';
import { requireAccess } from '../_lib/access.js';
const KINDS = new Set(['reading', 'sanity-run', 'export', 'refresh', 'edit', 'lookup-diff']);
export async function onRequestGet({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const u = new URL(request.url);
  const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
  const clauses = [], args = [];
  for (const k of ['workbook_id', 'receipt_key', 'batch_id', 'kind']) { const v = u.searchParams.get(k.replace('_id', 'Id').replace('_key', 'Key')) || u.searchParams.get(k); if (v) { clauses.push(`${k}=?`); args.push(v); } }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const r = await env.DB.prepare(`SELECT id, created_at, kind, batch_id, receipt_key, workbook_id, summary, detail_json FROM reading_history ${where} ORDER BY id DESC LIMIT ?`).bind(...args, limit).all();
  return json({ entries: (r.results || []).map(e => ({ ...e, detail: e.detail_json ? JSON.parse(e.detail_json) : null, detail_json: undefined })) });
}
export async function onRequestPost({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const b = await readJson(request, 200_000);
  if (!KINDS.has(b.kind)) return error(400, 'Unknown history kind.');
  const r = await env.DB.prepare('INSERT INTO reading_history (created_at, kind, batch_id, receipt_key, workbook_id, summary, detail_json) VALUES (?,?,?,?,?,?,?) RETURNING id')
    .bind(nowIso(), b.kind, b.batchId || null, b.receiptKey || null, b.workbookId || null, String(b.summary || '').slice(0, 500), b.detail ? JSON.stringify(b.detail).slice(0, 100_000) : null).first();
  return json({ id: r.id }, 201);
}
