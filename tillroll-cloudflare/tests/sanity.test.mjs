import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, mockFetch, CATALOGUE } from './helpers.mjs';
import { runSanity, COLUMNS, PINK, AMBER, normaliseTimestamp } from '../functions/_lib/sanity.js';
import { lookup } from '../functions/_lib/lookup.js';
import { createRun, processRun, getRun } from '../functions/_lib/runs.js';
const REPO = new URL('../../tillroll/', import.meta.url).pathname;
const KEYS = { BRAVE_API_KEY: 'b', GEMINI_API_KEY: 'g' };
function fixtures() {
  const out = [];
  for (const set of ['real-samples', 'featured']) {
    for (const e of JSON.parse(readFileSync(`${REPO}${set}/index.json`, 'utf8'))) if (e.data?.items) out.push({ set, file: e.filename, receipt: { ...e.data, receiptKey: `${set}/${e.filename}` } });
  }
  return out;
}
function checkInvariants(result) {
  for (const row of result.agreedRows) {
    assert.deepEqual(Object.keys(row.cells), COLUMNS);
    const ts = row.cells['采购时间'];
    if (ts !== null) assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    else assert.equal(row.flags['采购时间'], PINK);
    const p = row.cells['采购商品原价'];
    if (typeof p === 'number') assert.equal(row.cells['销售金额'], Math.round((p * 0.88 + Number.EPSILON) * 100) / 100);
    if (p === 0) assert.ok(row.flags['采购商品原价'], 'zero price must be flagged');
    for (const c of Object.values(row.flags)) assert.ok([PINK, AMBER].includes(c));
  }
}

test('timestamps: 24h, 00 seconds, am/pm converted', () => {
  assert.equal(normaliseTimestamp('2025-01-17', '7:20 pm'), '2025-01-17 19:20:00');
  assert.equal(normaliseTimestamp('2025-01-17', '12:05 am'), '2025-01-17 00:05:00');
  assert.equal(normaliseTimestamp('2025-01-17', '19:20:31'), '2025-01-17 19:20:31');
  assert.equal(normaliseTimestamp('17/01/2025', null), '2025-01-17 00:00:00');
  assert.equal(normaliseTimestamp('2025-13-40', '10:00'), null);
});

test('all stored sample readings (real-samples + featured) pass the export invariants, no keys', async () => {
  const fx = fixtures();
  assert.ok(fx.length >= 25);
  const env = makeEnv();
  const { result, audit } = await runSanity(env, { batchId: 'samples', mode: 'round1', receipts: fx.map(f => f.receipt) });
  checkInvariants(result);
  assert.equal(result.workbookExportReady, true);
  // CARRIAGE 0/0 (JD France) is a confirmed true zero -> excluded
  assert.ok(audit.excludedZero.some(z => z.name === 'CARRIAGE'));
  assert.ok(!result.agreedRows.some(r => r.cells['品名'] === 'CARRIAGE'));
  // "SB SIZE 45.5": unit price unreadable + amount 0 -> doubtful, kept and Pink
  const sb = result.agreedRows.find(r => r.cells['品名'] === 'SB SIZE 45.5');
  assert.ok(sb && sb.flags['采购商品原价'] === PINK);
  // look-ups had no keys -> paused Amber, never silent
  assert.equal(result.lookupsPaused, true);
  console.log(`samples: ${fx.length} receipts, ${result.agreedRows.length} rows, ${result.excludedZeroCount} zero excluded, ${result.readingErrors.length} reading errors, ${result.lookupUncertainties.length} look-up flags`);
  assert.ok(!JSON.stringify(result).includes('trail'), 'no internal debate in final output');
});

test('look-ups enrich rows (Amber) without overwriting printed prices or item IDs', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const receipt = { receiptKey: 'lux1', merchant: 'Selfridges', receiptReference: '0456-7788', date: '2026-11-20', time: '3:15 pm', payment: 'VISA CONTACTLESS', currency: 'GBP',
    storeClues: { addressLines: ['400 Oxford Street', 'London'], postcode: 'W1A 1AB' },
    items: [
      { brand: 'Chanel Accessory', item: 'mini', itemId: 'CHANEL A69900', qty: 1, unitPrice: 4950, amount: 4950 },
      { brand: 'VCA', item: 'pendant', itemId: '0012345', qty: 1, unitPrice: 3700, amount: 3700 },
      { brand: 'Gucci', item: 'Handbag', itemId: '000001', qty: 1, unitPrice: 1350, amount: 1350 },
      { brand: null, item: 'Gift wrap', itemId: null, qty: 1, unitPrice: 0, amount: 0 },
      { brand: 'Dior', item: 'Handbag', itemId: 'X1', qty: 1, unitPrice: 5000, amount: 5000 },
    ] };
  const { result } = await runSanity(env, { batchId: 'b1', mode: 'round1', receipts: [receipt] }, { fetchImpl: f, lookup });
  checkInvariants(result);
  const [chanel, vca, gucci, dior] = result.agreedRows;
  assert.equal(result.excludedZeroCount, 1);
  assert.equal(chanel.cells['采购时间'], '2026-11-20 15:15:00');
  assert.equal(chanel.cells['采购商品方法'], 'Visa');
  assert.equal(chanel.cells['供应商'], 'Selfridges London Oxford Street');
  assert.equal(chanel.flags['供应商'], AMBER);
  assert.equal(chanel.cells['品牌'], 'Chanel'); assert.equal(chanel.flags['品牌'], AMBER);
  assert.equal(chanel.cells['品牌货号'], 'A69900');
  assert.equal(chanel.cells['品名'], 'Classic Flap Mini Bag'); assert.equal(chanel.flags['品名'], AMBER);
  assert.equal(chanel.cells['销售金额'], 4356);
  assert.equal(vca.cells['品牌'], 'Van Cleef & Arpels');
  assert.equal(vca.cells['品牌货号'], '0012345');
  assert.equal(vca.cells['采购商品原价'], 3700); // printed price wins over official 3600
  assert.equal(gucci.cells['品牌货号'], '000001'); // printed ID kept on fallback
  assert.equal(gucci.cells['品名'], 'Horsebit 1955 mini bag');
  assert.equal(gucci.lookup.matchType, 'price-fallback');
  assert.equal(dior.cells['品名'], 'Handbag'); // ambiguous, weightless: not guessed
  assert.ok(result.lookupUncertainties.some(u => u.rowId === dior.rowId && u.candidates?.length === 2));
});

test('round 2: cleared fills become permanent locks and are never re-flagged; skip gate', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const base = { receiptKey: 'r2', merchant: 'Harrods', receiptReference: null, date: '2026-11-21', time: '10:00', payment: 'Amex', currency: 'GBP' };
  const r1 = await runSanity(env, { batchId: 'b2', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Chanel', item: 'mini', itemId: 'A69900', unitPrice: 4950, amount: 4950 }] }] }, { fetchImpl: f, lookup });
  const row = r1.result.agreedRows[0];
  assert.equal(row.flags['采购小票id'], PINK);
  const callsBefore = f.calls.gemini;
  const r2 = await runSanity(env, { batchId: 'b2', mode: 'round2', receipts: [{ ...base, items: [{ rowId: row.rowId, brand: 'Chanel', item: 'Classic Flap Mini Bag', itemId: 'A69900', unitPrice: 4950, amount: 4950,
    clearedCols: ['采购小票id', '品名'], flaggedCols: ['品名'], previousCells: row.cells }] }] }, { fetchImpl: f, lookup });
  const row2 = r2.result.agreedRows[0];
  assert.equal(row2.flags['采购小票id'], undefined);
  assert.equal(row2.flags['品名'], undefined);
  assert.equal(f.calls.gemini, callsBefore, 'complete + verified row skipped look-up');
  const lock = await env.DB.prepare('SELECT * FROM human_verified_unflagged WHERE row_id=? AND col_key=?').bind(row.rowId, '采购小票id').first();
  assert.ok(lock);
  // a later round-1 style pass still honours the lock
  const r3 = await runSanity(env, { batchId: 'b2', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Chanel', item: 'mini', itemId: 'A69900', unitPrice: 4950, amount: 4950 }] }] }, { fetchImpl: f, lookup });
  assert.equal(r3.result.agreedRows[0].flags['采购小票id'], undefined);
});

test('round 2: edited 品牌货号 invalidates cache and re-looks-up; changes are marked', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const base = { receiptKey: 'r3', merchant: 'Gucci', receiptReference: 'G1', date: '2026-11-21', time: '10:00', payment: 'Visa', currency: 'GBP' };
  const r1 = await runSanity(env, { batchId: 'b3', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Gucci', item: 'Handbag', itemId: '000001', unitPrice: 1350, amount: 1350 }] }] }, { fetchImpl: f, lookup });
  const row = r1.result.agreedRows[0];
  const r2 = await runSanity(env, { batchId: 'b3', mode: 'round2', receipts: [{ ...base, items: [{ rowId: row.rowId, brand: 'Gucci', item: row.cells['品名'], itemId: '446744', unitPrice: 1350, amount: 1350, editedCols: ['品牌货号'], previousItemId: '000001', previousCells: row.cells }] }] }, { fetchImpl: f, lookup });
  const row2 = r2.result.agreedRows[0];
  assert.equal(row2.cells['品名'], 'GG Marmont mini bag');
  assert.equal(row2.lookup.matchType, 'id');
  assert.ok(row2.round2Changed.includes('品名') && row2.round2Changed.includes('品牌货号'));
});

test('/api/sanity-run lifecycle: queued -> completed, returns only the agreed version', async () => {
  const env = makeEnv();
  const start = await createRun(env, { batchId: 'life', mode: 'round1', receipts: [{ merchant: 'Boots', date: '2024-10-31', time: '18:13', payment: 'Card', currency: 'GBP', items: [{ item: 'OPI', unitPrice: 24, amount: 24 }] }] });
  assert.deepEqual(Object.keys(start).sort(), ['batchId', 'pollAfterMs', 'runId', 'status']);
  assert.equal(start.status, 'queued');
  await processRun(env, start.runId);
  const done = await getRun(env, start.runId, () => {});
  assert.equal(done.status, 'completed');
  for (const k of ['agreedRows', 'excludedZeroCount', 'readingErrors', 'lookupUncertainties', 'workbookExportReady']) assert.ok(k in done, k);
  assert.ok(!('audit' in done) && !('trail' in done));
  const hist = await env.DB.prepare("SELECT * FROM reading_history WHERE kind='sanity-run'").all();
  assert.equal(hist.results.length, 1);
});

test('qty 3 line becomes 3 unit rows, look-up runs once, no qty>1 Amber on 原价', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const { result, audit } = await runSanity(env, { batchId: 'q3', mode: 'round1', receipts: [{
    receiptKey: 'q3', merchant: 'Boutique', receiptReference: 'T1', date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Classic Flap Mini Bag', itemId: 'A69900', qty: 3, unitPrice: 4950, amount: 14850 }],
  }] }, { fetchImpl: f, lookup });
  assert.equal(result.agreedRows.length, 3);
  assert.deepEqual(result.agreedRows.map(r => r.rowId), ['q3:0:0', 'q3:0:1', 'q3:0:2']);
  assert.ok(result.agreedRows.every(r => r.cells['采购小票id'] === 'T1' && r.cells['采购时间'] === '2026-11-20 12:00:00'));
  assert.ok(result.agreedRows.every(r => r.cells['采购商品原价'] === 4950 && r.cells['采购商品金额'] === 4950 && r.cells['销售金额'] === 4356));
  assert.equal(audit.lookupsUsed, 1);
  assert.ok(result.agreedRows.every(r => r.flags['采购商品原价'] !== AMBER || r.mismatches?.some(m => m.field === 'price')));
});

test('qty 3 with a line discount is estimated, Amber, and sums to the paid total', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'ld', mode: 'round1', receipts: [{
    receiptKey: 'ld', merchant: 'Shop', receiptReference: 'L1', date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'X', item: 'Item', itemId: '1', qty: 3, unitPrice: 100, amount: 290, lineDiscount: 10 }],
  }] });
  assert.equal(result.agreedRows.length, 3);
  assert.deepEqual(result.agreedRows.map(r => r.cells['采购商品金额']), [96.67, 96.67, 96.66]);
  assert.ok(result.agreedRows.every(r => r.estimated && r.flags['采购商品金额'] === AMBER));
});

test('brand/name take official values on mismatch; price and item ID stay as printed', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const { result } = await runSanity(env, { batchId: 'mm', mode: 'round1', receipts: [{
    receiptKey: 'mm', merchant: 'Selfridges', receiptReference: 'M1', date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'VCA', item: 'pendant', itemId: '0012345', qty: 1, unitPrice: 3700, amount: 3700 }],
  }] }, { fetchImpl: f, lookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌'], 'Van Cleef & Arpels');
  assert.equal(row.flags['品牌'], AMBER);
  assert.equal(row.cells['品名'], 'Vintage Alhambra pendant');
  assert.equal(row.flags['品名'], AMBER);
  assert.equal(row.cells['采购商品原价'], 3700);
  assert.equal(row.flags['采购商品原价'], AMBER);
  assert.equal(row.cells['品牌货号'], '0012345');
  assert.ok(row.mismatches.some(m => m.field === 'price' && m.receiptValue === 3700 && m.officialValue === 3600));
  assert.ok(row.mismatches.some(m => m.field === 'brand' && m.receiptValue === 'VCA' && m.officialValue === 'Van Cleef & Arpels'));
});
