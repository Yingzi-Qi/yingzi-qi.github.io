// Upload an .xlsx (raw body) to Tillroll/Exports or a JSON snapshot to Tillroll/History,
// and register exports as Linked Workbooks in D1.
import { json, error, nowIso, randomId } from '../../_lib/http.js';
import { loadSession, googleAccessToken } from '../../_lib/session.js';
import { googleDrive } from '../../_lib/storage/google-drive.js';
export async function onRequestPost({ request, env }) {
  const u = new URL(request.url);
  const folder = u.searchParams.get('folder') === 'history' ? 'history' : 'exports';
  const name = (u.searchParams.get('name') || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  if (!name) return error(400, 'name is required.');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 20_000_000) return error(413, 'File too large.');
  const session = await loadSession(request, env);
  const drive = googleDrive(await googleAccessToken(env, session));
  const existing = u.searchParams.get('replaceId');
  const mime = folder === 'history' ? 'application/json' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const file = await drive.upload(folder, name, new Uint8Array(bytes), mime, existing);
  let workbookId = null;
  if (folder === 'exports' && env.DB) {
    workbookId = randomId('wb_');
    const t = nowIso();
    const row = await env.DB.prepare(`INSERT INTO linked_workbooks (workbook_id, provider, drive_file_id, name, folder, web_view_link, batch_id, created_at)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(provider, drive_file_id) DO UPDATE SET name=excluded.name, web_view_link=excluded.web_view_link RETURNING workbook_id`)
      .bind(workbookId, 'google-drive', file.id, file.name, 'Tillroll/Exports', file.webViewLink || null, u.searchParams.get('batchId'), t).first();
    workbookId = row.workbook_id;
    await env.DB.prepare('INSERT INTO reading_history (created_at, kind, batch_id, workbook_id, summary) VALUES (?,?,?,?,?)').bind(t, 'export', u.searchParams.get('batchId'), workbookId, `Exported ${file.name} to Google Drive`).run();
  }
  return json({ file, workbookId }, 201);
}
