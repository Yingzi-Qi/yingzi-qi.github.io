import { error } from './_lib/http.js';
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), geolocation=(), microphone=()',
};
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    // Same-origin only (CSRF guard for cookie-authenticated endpoints).
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return error(403, 'Cross-origin requests are not allowed.');
  }
  let res;
  try { res = await context.next(); }
  catch (e) { res = error(e.status || 500, e.status ? e.message : 'Internal error.', e.code ? { code: e.code } : {}); if (!e.status) console.error(e); }
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}
