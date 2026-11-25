import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, CATALOGUE } from './helpers.mjs';
import { lookup, invalidate } from '../functions/_lib/lookup.js';
import { keys } from '../functions/_lib/cache.js';
import { status } from '../functions/_lib/quota.js';
const KEYS = { BRAVE_API_KEY: 'test-brave', GEMINI_API_KEY: 'test-gemini' };

test('cache keys follow the binding contract (leading zeros kept, 2dp price)', () => {
  assert.equal(keys.item('Van Cleef & Arpels', '0012345'), 'lookup:v2:item:van-cleef-&-arpels:0012345');
  assert.equal(keys.mf('Chanel', 'Mini', 'A69900'), 'lookup:v2:mf:chanel:mini:a69900');
  assert.equal(keys.pf('Gucci', 'gbp', 1350), 'lookup:v2:pf:gucci:GBP:1350.00');
  assert.equal(keys.branch('Rolex', 'E14 5AB'), 'lookup:v2:branch:rolex:e14-5ab');
});

test('id match with abbreviation brand, official-site confirmation, then cache hit', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const r1 = await lookup(env, { brand: 'VCA', itemId: '0012345', price: 3600, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(r1.cacheHit, false);
  assert.equal(r1.cacheKey, 'lookup:v2:item:van-cleef-&-arpels:0012345');
  assert.deepEqual(r1.sourcesQueried, ['brave', 'gemini-grounding']);
  assert.equal(r1.candidates[0].matchType, 'id');
  assert.equal(r1.candidates[0].onOfficialSite, true);
  assert.ok(r1.candidates[0].matchedFields.includes('itemId') && r1.candidates[0].matchedFields.includes('price'));
  assert.equal(r1.candidates[0].brand, 'Van Cleef & Arpels');
  const r2 = await lookup(env, { brand: 'VCA', itemId: '0012345', price: 3600, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(r2.cacheHit, true);
  assert.equal(f.calls.brave, 1); assert.equal(f.calls.gemini, 1);
  const r3 = await lookup(env, { brand: 'VCA', itemId: '0012345', bypassCache: true }, { fetchImpl: f });
  assert.equal(r3.cacheHit, false); assert.equal(f.calls.gemini, 2);
});

test('brand given: non-official listings are rejected', async () => {
  const env = makeEnv(KEYS);
  const r = await lookup(env, { brand: 'Gucci', itemId: '999999', price: 100, currency: 'GBP' }, { fetchImpl: mockFetch(CATALOGUE) });
  assert.ok(r.candidates.every(c => c.onOfficialSite));
  assert.ok(!r.candidates.some(c => c.itemId === '999999'));
});

test('price fallback only when item ID matches nothing; lightest weight wins', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const ok = await lookup(env, { brand: 'Gucci', itemId: '446744', price: 1350, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(ok.candidates[0].matchType, 'id');
  assert.ok(!ok.cacheKey.includes(':pf:'));
  const fb = await lookup(env, { brand: 'Gucci', itemId: '000001', price: 1350, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(fb.cacheKey, 'lookup:v2:pf:gucci:GBP:1350.00');
  assert.equal(fb.candidates[0].matchType, 'price-fallback');
  assert.equal(fb.candidates[0].itemId, '658574'); // 380 g < 410 g
  assert.equal(fb.printedItemId, '000001');
});

test('same price, no weights: candidates returned with weightGrams null', async () => {
  const env = makeEnv(KEYS);
  const r = await lookup(env, { brand: 'Dior', itemId: 'X1', price: 5000, currency: 'GBP' }, { fetchImpl: mockFetch(CATALOGUE) });
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every(c => c.weightGrams === null && c.matchType === 'price-fallback'));
});

test('invalidation on edited 品牌货号 removes cache entry', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f });
  const k = keys.item('Chanel', 'A69900');
  assert.ok(env.LOOKUP_CACHE._m.has(k));
  await invalidate(env, { brand: 'Chanel', itemId: 'A69901', previousItemId: 'A69900' });
  assert.ok(!env.LOOKUP_CACHE._m.has(k));
});

test('KV soft cap: writes fall back to D1, invalidation uses a D1 tombstone', async () => {
  const env = makeEnv({ ...KEYS, KV_WRITE_SOFT_LIMIT: '1' }); const f = mockFetch(CATALOGUE);
  await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f }); // 1 KV write
  await lookup(env, { brand: 'Gucci', itemId: '446744' }, { fetchImpl: f });  // -> D1
  const row = await env.DB.prepare('SELECT * FROM lookup_cache WHERE cache_key=?').bind(keys.item('Gucci', '446744')).first();
  assert.ok(row);
  const hit = await lookup(env, { brand: 'Gucci', itemId: '446744' }, { fetchImpl: f });
  assert.equal(hit.cacheHit, true);
  await invalidate(env, { brand: 'Chanel', itemId: 'A69900' });
  assert.ok(env.LOOKUP_CACHE._m.has(keys.item('Chanel', 'A69900'))); // KV untouched (capped)...
  const again = await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f });
  assert.equal(again.cacheHit, false); // ...but hidden by the tombstone
});

test('quota guards pause look-ups with an Amber flag and never call the APIs past the cap', async () => {
  const env = makeEnv({ ...KEYS, BRAVE_MONTHLY_LIMIT: '1', GEMINI_GROUNDING_DAILY_LIMIT: '1' }); const f = mockFetch(CATALOGUE);
  await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f });
  const r = await lookup(env, { brand: 'Gucci', itemId: '446744' }, { fetchImpl: f });
  assert.equal(f.calls.brave, 1); assert.equal(f.calls.gemini, 1);
  assert.equal(r.paused, true);
  assert.equal(r.flag, '#FDE68A');
  assert.equal(r.candidates.length, 0);
  const s = await status(env);
  assert.equal(s.lookupsPaused, true);
  // paused results are not cached
  assert.ok(!env.LOOKUP_CACHE._m.has(keys.item('Gucci', '446744')));
});

test('hard ceilings cannot be raised past the free allowances', async () => {
  const env = makeEnv({ ...KEYS, BRAVE_MONTHLY_LIMIT: '5000', GEMINI_GROUNDING_DAILY_LIMIT: '9999', GEMINI_GROUNDING_MONTHLY_LIMIT: '99999' });
  const s = await status(env);
  assert.ok(s.brave.limit < 1000 && s.geminiGroundingDaily.limit < 1500 && s.geminiGroundingMonthly.limit < 5000);
});

test('no secrets: degrades gracefully, reports unavailable, no fetch', async () => {
  const env = makeEnv(); const f = mockFetch(CATALOGUE);
  const r = await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f });
  assert.equal(f.calls.brave + f.calls.gemini, 0);
  assert.equal(r.candidates.length, 0);
  assert.match(r.unavailableReason, /not configured/);
});

test('branch suffix from storeClues (known table and grounded lookup)', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const a = await lookup(env, { supplier: 'Selfridges', storeClues: { postcode: 'W1A 1AB' } }, { fetchImpl: f });
  assert.equal(a.branch.officialStoreName, 'Selfridges London Oxford Street');
  const b = await lookup(env, { supplier: 'Rolex', storeClues: { postcode: 'E14 5NY' } }, { fetchImpl: f });
  assert.equal(b.branch.officialStoreName, 'Rolex Canary Wharf');
  assert.equal(b.branch.cacheKey, 'lookup:v2:branch:rolex:e14-5ny');
});
