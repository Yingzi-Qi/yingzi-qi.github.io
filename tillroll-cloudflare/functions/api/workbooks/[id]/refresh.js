// Update / Refresh: streams the current workbook bytes from Drive so the browser
// (Excel Sync & History Manager's reader) can diff values + fills, then posts
// cleared fills to /api/locks and edited rows to /api/sanity-run (mode round2).
import { error, nowIso } from '../../../_lib/http.js';
import { loadSession, googleAccessToken } from '../../../_lib/session.js';
import { googleDrive } from '../../../_lib/storage/google-drive.js';
export async function onRequestPost({ request, env, params }) {
  if (!env.DB) return error(503, 'D1 is not bound.');
  const wb = await env.DB.prepare('SELECT * FROM linked_workbooks WHERE workbook_id=?').bind(String(params.id)).first();
  if (!wb) return error(404, 'Workbook not linked.');
  const drive = googleDrive(await googleAccessToken(env, await loadSession(request, env)));
  const res = await drive.download(wb.drive_file_id);
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE linked_workbooks SET last_refreshed_at=? WHERE workbook_id=?').bind(t, wb.workbook_id),
    env.DB.prepare('INSERT INTO reading_history (created_at, kind, workbook_id, batch_id, summary) VALUES (?,?,?,?,?)').bind(t, 'refresh', wb.workbook_id, wb.batch_id, `Refreshed ${wb.name} from Google Drive`),
  ]);
  return new Response(res.body, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-Tillroll-Workbook': wb.workbook_id, 'X-Tillroll-Batch': wb.batch_id || '', 'Cache-Control': 'no-store' } });
}
