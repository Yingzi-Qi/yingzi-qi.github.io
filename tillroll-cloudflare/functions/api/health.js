import { json } from '../_lib/http.js';
export const onRequestGet = ({ env }) => json({
  ok: true, service: 'tillroll-v2', time: new Date().toISOString(),
  bindings: { d1: Boolean(env.DB), kv: Boolean(env.LOOKUP_CACHE) },
  secrets: { gemini: Boolean(env.GEMINI_API_KEY), brave: Boolean(env.BRAVE_API_KEY), googleOAuth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), session: Boolean(env.SESSION_SECRET), passcode: Boolean(env.APP_PASSCODE) },
});
