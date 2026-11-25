export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
export const error = (status, message, extra = {}) => json({ error: message, ...extra }, status);
export async function readJson(request, maxBytes = 2_000_000) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  try { return await request.json(); } catch { throw Object.assign(new Error('Body must be JSON.'), { status: 400 }); }
}
export const nowIso = () => new Date().toISOString();
export const hasDb = env => Boolean(env && env.DB);
export const hasKv = env => Boolean(env && env.LOOKUP_CACHE);
export function randomId(prefix = '') {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return prefix + Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
}
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), n => n.toString(16).padStart(2, '0')).join('');
}
