import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, mockFetch, CATALOGUE } from './helpers.mjs';
import { lookup, invalidate, officialMismatches, rankPriceFallback, priceFallbackGapBand, parsePrice } from '../functions/_lib/lookup.js';
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

test('price fallback does not run when the item-ID lookup is paused or only one source answered', async () => {
  const env = makeEnv({ ...KEYS, BRAVE_MONTHLY_LIMIT: '1' }); const f = mockFetch(CATALOGUE);
  await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f });
  const afterFirst = { brave: f.calls.brave, gemini: f.calls.gemini };
  const r = await lookup(env, { brand: 'Gucci', itemId: 'NOMATCH', price: 1350, currency: 'GBP' }, { fetchImpl: f });
  assert.ok(!String(r.cacheKey || '').includes(':pf:'), r.cacheKey);
  assert.ok(!(r.candidates || []).some(c => c.matchType === 'price-fallback'));
  assert.equal(f.calls.brave, afterFirst.brave, 'Brave already at the monthly guard; must not retry on fallback');
  assert.equal(f.calls.gemini, afterFirst.gemini + 1, 'only the item-ID Gemini call, not a price-fallback call');
});

test('price fallback does not run when the item-ID lookup is fully unavailable', async () => {
  const env = makeEnv(); const f = mockFetch(CATALOGUE);
  const r = await lookup(env, { brand: 'Gucci', itemId: 'NOMATCH', price: 1350, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(f.calls.brave + f.calls.gemini, 0);
  assert.ok(!String(r.cacheKey || '').includes(':pf:'));
  assert.equal((r.candidates || []).length, 0);
});


test('official mismatches: abbreviation, name upgrade, price and item-ID differences', () => {
  const req = { brandRaw: 'VCA', brand: 'Van Cleef & Arpels', itemId: '0012345', name: 'pendant', price: 3700, currency: 'GBP' };
  const cand = { brand: 'Van Cleef & Arpels', officialName: 'Vintage Alhambra pendant', itemId: '0012345', price: 3600, currency: 'GBP' };
  const m = officialMismatches(req, cand);
  assert.deepEqual(m.find(x => x.field === 'brand'), { field: 'brand', receiptValue: 'VCA', officialValue: 'Van Cleef & Arpels' });
  assert.deepEqual(m.find(x => x.field === 'name'), { field: 'name', receiptValue: 'pendant', officialValue: 'Vintage Alhambra pendant' });
  assert.deepEqual(m.find(x => x.field === 'price'), { field: 'price', receiptValue: 3700, officialValue: 3600 });
  assert.ok(!m.some(x => x.field === 'itemId'));
});

test('/api/lookup returns mismatches and flags Amber only when a mismatch or no match exists', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const exact = await lookup(env, { brand: 'Chanel', itemId: 'A69900', name: 'Classic Flap Mini Bag', price: 4950, currency: 'GBP' }, { fetchImpl: f });
  assert.deepEqual(exact.mismatches, []);
  assert.equal(exact.flag, null);
  const diff = await lookup(env, { brand: 'VCA', itemId: '0012345', name: 'pendant', price: 3700, currency: 'GBP' }, { fetchImpl: f });
  assert.ok(Array.isArray(diff.mismatches));
  assert.ok(diff.mismatches.some(m => m.field === 'brand' && m.receiptValue === 'VCA' && m.officialValue === 'Van Cleef & Arpels'));
  assert.ok(diff.mismatches.some(m => m.field === 'price' && m.receiptValue === 3700 && m.officialValue === 3600));
  assert.equal(diff.flag, '#FDE68A');
});

test('mismatches are omitted when the receipt did not print the field, never receiptValue null', () => {
  const req = { brandRaw: null, brand: null, itemId: 'A69900', name: null, price: 4950, currency: 'GBP' };
  const cand = { brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: 4950, currency: 'GBP' };
  const m = officialMismatches(req, cand);
  assert.ok(!m.some(x => x.field === 'brand' || x.field === 'name'));
  assert.ok(!m.some(x => x.receiptValue === null || x.receiptValue === undefined));
});

test('each candidate carries its own mismatches; top-level mismatches match the first candidate', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const r = await lookup(env, { brand: 'Gucci', itemId: '000001', name: 'Handbag', price: 1350, currency: 'GBP' }, { fetchImpl: f });
  assert.ok(r.candidates.length >= 2);
  for (const c of r.candidates) {
    assert.ok(Array.isArray(c.mismatches));
    assert.ok(!c.mismatches.some(x => x.receiptValue === null || x.receiptValue === undefined));
  }
  assert.deepEqual(r.mismatches, r.candidates[0].mismatches);
  assert.ok(r.candidates[0].mismatches.some(m => m.field === 'itemId' && m.receiptValue === '000001'));
});

test('price-fallback gap band is max(2% of printed price, £5), replacing min(2%, £1)', () => {
  assert.equal(priceFallbackGapBand(100), 5);
  assert.equal(priceFallbackGapBand(1000), 20);
  assert.equal(priceFallbackGapBand(50), 5);
});

const gucciUrl = id => `https://www.gucci.com/uk/en_gb/pr/${id}`;
function cand(partial) {
  return { brand: 'Gucci', currency: 'GBP', sourceUrls: [gucciUrl(partial.itemId || 'x')], onOfficialSite: true, matchType: 'price-fallback', ...partial };
}

test('price fallback: lighter item wins when gaps are within max(2%, £5) of the best gap', () => {
  const req = { brand: 'Gucci', itemId: 'NOMATCH', name: 'Pouch', price: 100, currency: 'GBP' };
  const heavyClose = cand({ officialName: 'Heavy pouch', itemId: 'H1', price: 110, weightGrams: 400 });
  const lightNear = cand({ officialName: 'Light pouch', itemId: 'L1', price: 112, weightGrams: 120 });
  const ranked = rankPriceFallback(req, [heavyClose, lightNear]);
  // gaps 10 and 12; band is £5; 12-10=2 <= 5 → prefer lighter
  assert.equal(ranked[0].itemId, 'L1');
});

test('price fallback: outside the gap band, closer price beats a lighter item', () => {
  const req = { brand: 'Gucci', itemId: 'NOMATCH', name: 'Pouch', price: 100, currency: 'GBP' };
  const closerHeavy = cand({ officialName: 'Heavy pouch', itemId: 'H1', price: 110, weightGrams: 400 });
  const farLight = cand({ officialName: 'Light pouch', itemId: 'L1', price: 120, weightGrams: 120 });
  const ranked = rankPriceFallback(req, [closerHeavy, farLight]);
  // gaps 10 and 20; 20-10=10 > 5 → closer price wins
  assert.equal(ranked[0].itemId, 'H1');
});

test('price fallback: exact price beats a closer-description inexact candidate (rule b after a)', () => {
  const req = { brand: 'Gucci', itemId: 'NOMATCH', name: 'Tote', price: 100, currency: 'GBP' };
  const exactPoorName = cand({ officialName: 'Unrelated Wallet', itemId: 'W1', price: 100, weightGrams: 200 });
  const closeDesc = cand({ officialName: 'Leather Tote Bag', itemId: 'T1', price: 108, weightGrams: 200 });
  // combo: exact-only = 1, description-only = 1; then exact price wins
  const ranked = rankPriceFallback(req, [closeDesc, exactPoorName]);
  assert.equal(ranked[0].itemId, 'W1');
});

test('price fallback: description + item number ranks ahead of exact-price-only (rule a before b)', () => {
  const req = { brand: 'Gucci', itemId: 'NOMATCH', name: 'Tote', style: 'ABC123', price: 100, currency: 'GBP' };
  const exactOnly = cand({ officialName: 'Unrelated Wallet', itemId: 'W1', price: 100, weightGrams: 200 });
  const descAndNumber = cand({ officialName: 'Leather Tote', itemId: 'ABC123', price: 90, weightGrams: 200 });
  const ranked = rankPriceFallback(req, [exactOnly, descAndNumber]);
  assert.equal(ranked[0].itemId, 'ABC123');
});

test('price fallback via /api/lookup is always Amber and includes the candidate list', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const r = await lookup(env, { brand: 'Gucci', itemId: '000001', name: 'Handbag', price: 1350, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(r.candidates[0].matchType, 'price-fallback');
  assert.equal(r.flag, '#FDE68A');
  assert.ok(r.candidates.length >= 2);
  assert.equal(r.candidates[0].itemId, '658574'); // 380 g < 410 g at the same price
});

test('invalidate accepts price, currency, name, style and supplier and deletes pf/mf/branch keys', async () => {
  const env = makeEnv(KEYS);
  const item = keys.item('Chanel', 'A69900');
  const prev = keys.item('Chanel', 'OLD');
  const pf = keys.pf('Chanel', 'GBP', 4950);
  const mf = keys.mf('Chanel', 'Classic Flap Mini Bag', 'A69900');
  const br = keys.branch('Rolex', 'E14 5NY');
  for (const k of [item, prev, pf, mf, br]) await env.LOOKUP_CACHE.put(k, JSON.stringify({ cached: true }));
  const out = await invalidate(env, { brand: 'Chanel', itemId: 'A69900', previousItemId: 'OLD', price: 4950, currency: 'GBP', name: 'Classic Flap Mini Bag', style: 'A69900', supplier: 'Rolex', storeClues: { postcode: 'E14 5NY' } });
  const removed = new Set(out.invalidated.map(x => x.key));
  assert.ok(removed.has(item) && removed.has(prev) && removed.has(pf) && removed.has(mf) && removed.has(br));
  for (const k of [item, prev, pf, mf, br]) assert.ok(!env.LOOKUP_CACHE._m.has(k), k);
});

test('any paused source sets paused: true and unavailableReason, even if the other source answered', async () => {
  const env = makeEnv({ ...KEYS, BRAVE_MONTHLY_LIMIT: '1', GEMINI_GROUNDING_MONTHLY_LIMIT: '100', GEMINI_GROUNDING_DAILY_LIMIT: '100' });
  const f = mockFetch(CATALOGUE);
  await lookup(env, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f });
  const r = await lookup(env, { brand: 'Gucci', itemId: '446744' }, { fetchImpl: f });
  assert.equal(r.paused, true);
  assert.ok(r.unavailableReason);
  assert.ok(Array.isArray(r.quotaGuard) && r.quotaGuard.length);
  assert.equal(r.flag, '#FDE68A');
});


test('parsePrice handles common official-site formats including From and European decimals', () => {
  const cases = [
    ['£1,234.00', 1234, 'GBP'],
    ['From £1,234.00', 1234, 'GBP'],
    ['from: £ 4950', 4950, 'GBP'],
    ['£4950', 4950, 'GBP'],
    ['GBP 1,234.00', 1234, 'GBP'],
    ['1,234.00 GBP', 1234, 'GBP'],
    ['€1.234,00', 1234, 'EUR'],
    ['EUR 1.234,00', 1234, 'EUR'],
    ['1.234,00 €', 1234, 'EUR'],
    ['From €1.234,00', 1234, 'EUR'],
    ['$1,234.00', 1234, 'USD'],
    ['USD 1234', 1234, 'USD'],
    ['From $99.50', 99.5, 'USD'],
  ];
  for (const [text, price, currency] of cases) {
    const got = parsePrice(text);
    assert.deepEqual(got, { price, currency }, text);
  }
  assert.deepEqual(parsePrice('1.234,00', 'EUR', { allowBare: true }), { price: 1234, currency: 'EUR' });
  assert.deepEqual(parsePrice(4950, 'GBP'), { price: 4950, currency: 'GBP' });
  assert.equal(parsePrice('Mini classic handbag A69900 — Fashion'), null);
});

test('official page snippet and grounded result populate the candidate official price and currency', async () => {
  const env = makeEnv(KEYS);
  // Gemini returns no numeric price; Brave title shows "From £4,950.00".
  const f = mockFetch([{
    brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: null, currency: 'GBP',
    url: 'https://www.chanel.com/gb/fashion/p/A69900/',
    title: 'Classic Flap Mini Bag | From £4,950.00',
    description: 'A69900. Discover the collection.',
  }], { brave: 0, gemini: 0 }, {
    geminiCandidates: [{ brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: null, currency: null, sourceUrls: ['https://www.chanel.com/gb/fashion/p/A69900/'] }],
  });
  const r = await lookup(env, { brand: 'Chanel', itemId: 'A69900', name: 'Classic Flap Mini Bag', price: 4950, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(r.candidates[0].price, 4950);
  assert.equal(r.candidates[0].currency, 'GBP');
  assert.equal(r.candidates[0].onOfficialSite, true);
  assert.ok(!r.mismatches.some(m => m.reason === 'official price unavailable'));

  const env2 = makeEnv(KEYS);
  const f2 = mockFetch([{
    brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900',
    url: 'https://www.chanel.com/gb/fashion/p/A69900/',
    title: 'Classic Flap Mini Bag | Chanel',
    description: 'A69900 in denim.',
  }], { brave: 0, gemini: 0 }, {
    geminiCandidates: [{ brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: '€1.234,00', sourceUrls: ['https://www.chanel.com/gb/fashion/p/A69900/'] }],
  });
  const r2 = await lookup(env2, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f2 });
  assert.equal(r2.candidates[0].price, 1234);
  assert.equal(r2.candidates[0].currency, 'EUR');
});

test('sourcesQueried lists every source actually called, consistent with quota counters, even if Gemini errors', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch(CATALOGUE, { brave: 0, gemini: 0 }, { geminiStatus: 500 });
  const r = await lookup(env, { brand: 'Chanel', itemId: 'A69900', price: 4950, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(f.calls.brave, 1);
  assert.equal(f.calls.gemini, 1);
  assert.deepEqual(r.sourcesQueried, ['brave', 'gemini-grounding']);
  const s = await status(env);
  assert.equal(s.brave.used, 1);
  assert.equal(s.geminiGroundingDaily.used, 1);
  assert.equal(s.geminiGroundingMonthly.used, 1);
  assert.ok(r.candidates.length, 'Brave can still return an official match');
  assert.equal(r.candidates[0].itemId, 'A69900');
  assert.equal(r.candidates[0].price, 4950);
});

test('official match with a null official price is Amber with official price unavailable, never a silent pass', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch([{
    brand: 'Chanel',
    officialName: 'Mini classic handbag, Denim & gold metal, dark blue & orange — Fashion',
    itemId: 'A69900',
    price: null,
    currency: 'GBP',
    url: 'https://www.chanel.com/gb/fashion/p/A69900/',
    title: 'Mini classic handbag, Denim & gold metal, dark blue & orange — Fashion',
    description: 'A69900. Discover the CHANEL collection.',
  }], { brave: 0, gemini: 0 }, {
    geminiCandidates: [{
      brand: 'Chanel',
      officialName: 'Mini classic handbag, Denim & gold metal, dark blue & orange — Fashion',
      itemId: 'A69900',
      price: null,
      currency: 'GBP',
      sourceUrls: ['https://www.chanel.com/gb/fashion/p/A69900/'],
    }],
  });
  const r = await lookup(env, { brand: 'Chanel', itemId: 'A69900', name: 'Classic Flap Mini Bag', price: 4950, currency: 'GBP' }, { fetchImpl: f });
  assert.equal(r.candidates[0].onOfficialSite, true);
  assert.equal(r.candidates[0].matchType, 'id');
  assert.equal(r.candidates[0].price, null);
  assert.equal(r.flag, '#FDE68A');
  assert.equal(r.flagReason, 'official price unavailable');
  const m = (r.mismatches || []).find(x => x.field === 'price');
  assert.ok(m, 'price mismatch present');
  assert.equal(m.reason, 'official price unavailable');
  assert.equal(m.officialValue, null);
  assert.equal(m.receiptValue, 4950);
  assert.deepEqual(r.candidates[0].mismatches.find(x => x.field === 'price'), m);

  const env2 = makeEnv(KEYS);
  const f2 = mockFetch([{
    brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: null,
    url: 'https://www.chanel.com/gb/fashion/p/A69900/',
    title: 'Classic Flap Mini Bag | Chanel',
    description: 'A69900 official page.',
  }], { brave: 0, gemini: 0 }, {
    geminiCandidates: [{ brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: null, sourceUrls: ['https://www.chanel.com/gb/fashion/p/A69900/'] }],
  });
  const r2 = await lookup(env2, { brand: 'Chanel', itemId: 'A69900' }, { fetchImpl: f2 });
  const m2 = r2.mismatches.find(x => x.field === 'price');
  assert.equal(r2.flag, '#FDE68A');
  assert.equal(r2.flagReason, 'official price unavailable');
  assert.equal(m2.reason, 'official price unavailable');
  assert.equal(m2.officialValue, null);
  assert.ok(!('receiptValue' in m2), 'never emit receiptValue null for an unprinted field');
});
