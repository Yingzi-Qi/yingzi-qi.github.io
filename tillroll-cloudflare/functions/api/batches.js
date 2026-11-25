// SHA-256 duplicate check for uploaded receipts (Orchestrator step "Before everyone").
import { json, error, readJson, nowIso } from '../_lib/http.js';
import { requireAccess } from '../_lib/access.js';
export async function onRequestPost({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.DB) return error(503, 'D1 is not bound.');
  const b = await readJson(request, 200_000);
  const batchId = String(b.batchId || 'b_' + Date.now().toString(36));
  const files = (Array.isArray(b.files) ? b.files : []).filter(f => /^[0-9a-f]{64}$/.test(f?.sha256 || '')).slice(0, 200);
  const t = nowIso();
  const out = [];
  for (const f of files) {
    const prior = await env.DB.prepare('SELECT batch_id, receipt_key, filename, first_seen FROM receipt_hashes WHERE sha256=?').bind(f.sha256).first();
    if (prior) { out.push({ sha256: f.sha256, duplicate: true, prior }); continue; }
    const receiptKey = 'sha:' + f.sha256.slice(0, 16);
    await env.DB.prepare('INSERT INTO receipt_hashes (sha256, batch_id, receipt_key, filename, first_seen) VALUES (?,?,?,?,?)').bind(f.sha256, batchId, receiptKey, String(f.filename || '').slice(0, 200), t).run();
    out.push({ sha256: f.sha256, duplicate: false, receiptKey });
  }
  await env.DB.prepare('INSERT INTO batches (batch_id, created_at, state, receipt_count) VALUES (?,?,?,?) ON CONFLICT(batch_id) DO UPDATE SET receipt_count=receipt_count+excluded.receipt_count').bind(batchId, t, 'Ingested', out.filter(x => !x.duplicate).length).run();
  return json({ batchId, files: out });
}
