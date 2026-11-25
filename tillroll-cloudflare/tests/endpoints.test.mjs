import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.mjs';
import { onRequest as mw } from '../functions/_middleware.js';
import { onRequestPost as lookupPost } from '../functions/api/lookup.js';
import { onRequestGet as quotaGet } from '../functions/api/quota.js';
import { onRequestPost as unlockPost } from '../functions/api/auth/unlock.js';
import { encrypt, decrypt, sign, verify } from '../functions/_lib/crypto.js';
const SECRET = 'x'.repeat(40);
const req = (path, body, headers = {}) => new Request('https://tillroll-v2.pages.dev' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

test('middleware blocks cross-origin POSTs and maps errors to JSON', async () => {
  const r = await mw({ request: req('/api/lookup', {}, { Origin: 'https://evil.example' }), next: async () => new Response('x') });
  assert.equal(r.status, 403);
  const e = await mw({ request: req('/api/lookup', {}), next: async () => { throw Object.assign(new Error('bad'), { status: 400 }); } });
  assert.equal(e.status, 400); assert.equal((await e.json()).error, 'bad');
});

test('live keys without APP_PASSCODE: spending endpoints refuse (503)', async () => {
  const env = makeEnv({ GEMINI_API_KEY: 'k', SESSION_SECRET: SECRET });
  await assert.rejects(lookupPost({ request: req('/api/lookup', { itemId: '1' }), env }), e => e.status === 503);
});

test('passcode unlock sets an httpOnly cookie that grants access', async () => {
  const env = makeEnv({ GEMINI_API_KEY: 'k', SESSION_SECRET: SECRET, APP_PASSCODE: 'letmein' });
  await assert.rejects(lookupPost({ request: req('/api/lookup', { itemId: '1' }), env }), e => e.status === 401);
  const bad = await unlockPost({ request: req('/api/auth/unlock', { passcode: 'nope' }), env });
  assert.equal(bad.status, 401);
  const ok = await unlockPost({ request: req('/api/auth/unlock', { passcode: 'letmein' }), env });
  const cookie = ok.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  const r = await lookupPost({ request: req('/api/lookup', { brand: 'Chanel', itemId: 'A1' }, { Cookie: cookie.split(';')[0] }), env });
  assert.equal(r.status, 200);
});

test('quota endpoint reports guards; no-key mode is paused with Amber', async () => {
  const r = await quotaGet({ env: makeEnv() });
  const q = await r.json();
  assert.equal(q.lookupsPaused, true); assert.equal(q.flag, '#FDE68A');
  assert.equal(q.brave.limit, 950);
});

test('token encryption and cookie signing round-trip', async () => {
  const env = { SESSION_SECRET: SECRET };
  const blob = await encrypt(env, 'refresh-token-123');
  assert.notEqual(blob, 'refresh-token-123');
  assert.equal(await decrypt(env, blob), 'refresh-token-123');
  const s = await sign(env, 's_abc');
  assert.equal(await verify(env, s), 's_abc');
  assert.equal(await verify(env, s.slice(0, -2) + 'AA'), null);
});
