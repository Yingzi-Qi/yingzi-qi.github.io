// Gemini Vision proxy: same request shape the browser reader already builds,
// but the key stays server-side. Free-tier guard + backoff on 429/503.
import { json, error, readJson } from '../_lib/http.js';
import { reserve } from '../_lib/quota.js';
import { requireAccess } from '../_lib/access.js';
const MODELS = new Set(['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
export async function onRequestPost({ request, env }) {
  const denied = await requireAccess(request, env); if (denied) throw denied;
  if (!env.GEMINI_API_KEY) return error(503, 'Server OCR is not configured yet (no Gemini key). Use on-device OCR.', { code: 'no-key' });
  const body = await readJson(request, 9_000_000);
  if (!MODELS.has(body.model)) return error(400, 'Unsupported model.');
  if (!Array.isArray(body.contents)) return error(400, 'contents required.');
  const q = await reserve(env, 'gemini_ocr');
  if (!q.ok) return error(429, q.reason, { code: 'quota-guard', flag: '#FDE68A' });
  const payload = JSON.stringify({ contents: body.contents, generationConfig: body.generationConfig || {} });
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: payload });
    if (res.status !== 429 && res.status !== 503) break;
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
  if (!res.ok) return error(res.status === 429 ? 429 : 502, `Gemini returned ${res.status}.`);
  return json(await res.json());
}
