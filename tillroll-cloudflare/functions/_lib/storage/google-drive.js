// Storage adapter: Google Drive (drive.file scope). A OneDrive adapter can
// implement the same interface later: list(folder), upload(folder,name,bytes,mime), download(id), meta(id).
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDERS = { exports: ['Tillroll', 'Exports'], history: ['Tillroll', 'History'] };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export function googleDrive(token, fetchImpl = fetch) {
  const call = async (url, init = {}) => {
    const res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    if (!res.ok) throw Object.assign(new Error(`Google Drive error ${res.status}.`), { status: res.status === 401 ? 401 : 502 });
    return res;
  };
  const q = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  async function folderId(path) {
    let parent = 'root';
    for (const name of path) {
      const found = await (await call(`${API}/files?${new URLSearchParams({ q: `name='${q(name)}' and mimeType='application/vnd.google-apps.folder' and '${parent}' in parents and trashed=false`, fields: 'files(id,name)', spaces: 'drive' })}`)).json();
      if (found.files?.length) { parent = found.files[0].id; continue; }
      const made = await (await call(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) })).json();
      parent = made.id;
    }
    return parent;
  }
  return {
    provider: 'google-drive',
    async list(folder = 'exports') {
      const id = await folderId(FOLDERS[folder] || FOLDERS.exports);
      const r = await (await call(`${API}/files?${new URLSearchParams({ q: `'${id}' in parents and trashed=false`, fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)', orderBy: 'modifiedTime desc', pageSize: '100' })}`)).json();
      return r.files || [];
    },
    async upload(folder, name, bytes, mime = XLSX, existingId = null) {
      const boundary = 'tillroll' + crypto.getRandomValues(new Uint32Array(1))[0];
      const meta = existingId ? { name } : { name, parents: [await folderId(FOLDERS[folder] || FOLDERS.exports)] };
      const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`;
      const body = new Blob([head, bytes, `\r\n--${boundary}--`]);
      const url = existingId ? `${UPLOAD}/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,webViewLink,modifiedTime` : `${UPLOAD}?uploadType=multipart&fields=id,name,webViewLink,modifiedTime`;
      return (await call(url, { method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body })).json();
    },
    async download(id) { return call(`${API}/files/${encodeURIComponent(id)}?alt=media`); },
    async meta(id) { return (await call(`${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink`)).json(); },
  };
}
