import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, mockFetch, CATALOGUE } from './helpers.mjs';
import { runSanity, COLUMNS, PINK, AMBER, normaliseTimestamp, normaliseTender, chooseBrandItemId, resolveBrandItemId, TENDER_REASON, maybeApplyPr1BatchDateOutlierCheck, BRAND_ITEM_ID_FORMAT, BRAND_ITEM_ID_FORMATS, setBrandItemIdFormat, getBrandItemIdFormat, fitsBrandItemIdFormat, extractChanelStyleRef, suggestedPrintedCodeAlternative, printedValueKeptReason, officialSiteShowsReason } from '../functions/_lib/sanity.js';
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

test('an unfitting item code falls through to the official style ref, or the EAN', async () => {
  const env = makeEnv();
  const seen = [];
  const lookupStub = async (_env, req) => {
    seen.push(req.itemId);
    if (req.name === 'Tote') {
      return { candidates: [{ brand: 'Chanel', officialName: 'Synthetic Tote', itemId: 'AS44010', price: 100, currency: 'GBP', sourceUrls: ['https://www.chanel.com/gb/p/AS44010'], onOfficialSite: true, matchedFields: ['name'], confidence: 0.9, matchType: 'id' }] };
    }
    return { candidates: [] };
  };
  const { result } = await runSanity(env, { batchId: 'fit', mode: 'round1', receipts: [{
    receiptKey: 'fit', merchant: 'Boutique', receiptReference: 'F1', date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP',
    items: [
      { brand: 'Chanel', item: 'Tote', itemId: 'NOT-A-REF', ean: '4000000000013', qty: 1, unitPrice: 100, amount: 100 },
      { brand: 'Chanel', item: 'Scarf', itemId: 'ALSO-NOT', ean: '4000000000020', qty: 1, unitPrice: 80, amount: 80 },
    ],
  }] }, { lookup: lookupStub });
  const first = result.agreedRows[0].cells['品牌货号'];
  const second = result.agreedRows[1].cells['品牌货号'];
  assert.notEqual(first, 'NOT-A-REF');
  assert.notEqual(second, 'ALSO-NOT');
  // Official style wins over a labelled EAN; with no official, the labelled GTIN is used.
  assert.equal(first, 'AS44010');
  assert.equal(second, '4000000000020');
  assert.equal(result.agreedRows[1].flags['品牌货号'], AMBER);
  assert.equal(result.agreedRows[1].exportMeta.comments['品牌货号'], 'Only an EAN is available; the brand item id was not found.');
  assert.deepEqual(seen, ['4000000000013', '4000000000020']);
});

test('timestamps: 24h, 00 seconds, am/pm converted', () => {
  assert.equal(normaliseTimestamp('2025-01-17', '7:20 pm'), '2025-01-17 19:20:00');
  assert.equal(normaliseTimestamp('2025-01-17', '12:05 am'), '2025-01-17 00:05:00');
  assert.equal(normaliseTimestamp('2025-01-17', '19:20:31'), '2025-01-17 19:20:31');
  assert.equal(normaliseTimestamp('17/01/2025', null), '2025-01-17 00:00:00');
  assert.equal(normaliseTimestamp('03/04/2026', null), '2026-04-03 00:00:00');
  assert.equal(normaliseTimestamp('2025-13-40', '10:00'), null);
});

test('sanity keeps the reader date issue as the purchase-time reason', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'date-issue', mode: 'round1', receipts: [{
    receiptKey: 'date-issue', merchant: 'Shop', receiptReference: 'D1',
    date: null, dateIssue: 'Day and month are ambiguous in the printed date (05/10/2024).',
    time: '17:27:00', payment: 'Card', currency: 'EUR',
    items: [{ brand: 'Books', item: 'Cookbook', itemId: '9781785038914', unitPrice: 41.95, amount: 41.95 }],
  }] });
  const row = result.agreedRows[0];
  assert.equal(row.cells['采购时间'], null);
  assert.equal(row.flags['采购时间'], PINK);
  assert.match(result.readingErrors.find(e => e.col === '采购时间').reason, /Day and month are ambiguous/);
});

test('P7: unclear UK dates are DD/MM; 03/04/2026 is 3 April and there is no MM/DD fallback', () => {
  assert.equal(normaliseTimestamp('03/04/2026', null), '2026-04-03 00:00:00');
  assert.equal(normaliseTimestamp('03/04/2026', '9:15 am'), '2026-04-03 09:15:00');
  assert.equal(normaliseTimestamp('3/4/2026', null), '2026-04-03 00:00:00');
  assert.equal(normaliseTimestamp('03.04.2026', null), '2026-04-03 00:00:00');
  // 13 is not a month under DD/MM; do not reinterpret as 13 April (US MM/DD).
  assert.equal(normaliseTimestamp('04/13/2026', null), null);
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
  assert.equal(chanel.cells['采购商品方法'], 'Card');
  assert.equal(chanel.cells['供应商'], 'Selfridges');
  assert.equal(chanel.flags['供应商'], undefined);
  assert.equal(chanel.exportMeta.officialBranch, 'Selfridges London Oxford Street');
  assert.equal(chanel.cells['品牌'], 'Chanel'); assert.equal(chanel.flags['品牌'], AMBER);
  assert.equal(chanel.cells['品牌货号'], 'A69900');
  assert.equal(chanel.cells['品名'], 'Classic Flap Mini Bag'); assert.equal(chanel.flags['品名'], undefined);
  assert.equal(chanel.cells['销售金额'], 4356);
  assert.equal(vca.cells['品牌'], 'Van Cleef & Arpels');
  assert.equal(vca.cells['品牌货号'], null);
  assert.equal(vca.flags['品牌货号'], PINK);
  assert.equal(vca.cells['采购商品原价'], 3700); // printed price wins over official 3600
  // Receipt is the source of truth: printed ref 000001 is kept; official ID is only in the Amber reason.
  assert.equal(gucci.cells['品牌货号'], '000001');
  assert.equal(gucci.brandItemId, '000001');
  assert.equal(gucci.brandItemIdSource, 'brandProductCode');
  assert.equal(gucci.brandItemIdFlag, AMBER);
  assert.equal(gucci.brandItemIdReason, 'official site shows 658574');
  assert.equal(gucci.exportMeta.brandItemId, '000001');
  assert.equal(gucci.exportMeta.brandItemIdReason, 'official site shows 658574');
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
  assert.deepEqual(result.agreedRows.map(r => r.rowId), ['q3:0:u0', 'q3:0:u1', 'q3:0:u2']);
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
  assert.equal(row.cells['品名'], 'Vintage Laurel pendant');
  assert.equal(row.flags['品名'], AMBER);
  assert.equal(row.cells['采购商品原价'], 3700);
  assert.equal(row.flags['采购商品原价'], AMBER);
  assert.equal(row.cells['品牌货号'], null);
  assert.equal(row.flags['品牌货号'], PINK);
  assert.ok(row.mismatches.some(m => m.field === 'price' && m.receiptValue === 3700 && m.officialValue === 3600));
  assert.ok(row.mismatches.some(m => m.field === 'brand' && m.receiptValue === 'VCA' && m.officialValue === 'Van Cleef & Arpels'));
});

test('qty N becomes N unit rows sharing receipt id and time; line discount is estimated', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'qty', mode: 'round1', receipts: [{
    receiptKey: 'q1', merchant: 'Harrods', receiptReference: 'H-1', date: '2026-03-02', time: '7:05 pm', payment: 'Visa', currency: 'GBP',
    items: [
      { brand: 'Notes', item: 'Card holder', itemId: 'CH1', qty: 2, unitPrice: 100, amount: 190 },
      { brand: 'Notes', item: 'Cotton', itemId: 'CT1', qty: 3, unitPrice: 7, amount: 21 },
    ],
  }] });
  assert.equal(result.agreedRows.length, 5);
  const holders = result.agreedRows.filter(r => r.cells['品名'] === 'Card holder');
  assert.equal(holders.length, 2);
  assert.deepEqual(holders.map(r => r.cells['采购商品原价']), [100, 100]);
  assert.equal(holders.reduce((s, r) => s + r.cells['采购商品金额'], 0), 190);
  assert.ok(holders.every(r => r.flags['采购商品金额'] === AMBER && r.estimated && r.exportMeta.discountKind === 'estimated'));
  assert.ok(holders.every(r => r.cells['采购时间'] === '2026-03-02 19:05:00' && r.cells['采购小票id'] === 'H-1'));
  assert.equal(holders[0].rowId, 'q1:0:u0');
  assert.equal(holders[1].rowId, 'q1:0:u1');
  const cotton = result.agreedRows.filter(r => r.cells['品名'] === 'Cotton');
  assert.equal(cotton.length, 3);
  assert.ok(cotton.every(r => r.cells['采购商品金额'] === 7 && r.exportMeta.discountKind === 'none' && !r.flags['采购商品金额']));
  assert.equal(cotton[0].cells['销售金额'], 6.16);
});

test('printed per-item discount is exact; a shared receipt discount is Amber and sums to the paid total', async () => {
  const samples = JSON.parse(readFileSync(new URL('../../tillroll/real-samples/index.json', import.meta.url), 'utf8'));
  const sample = name => samples.find(e => e.filename === name);
  const mac = sample('open-prices-58120.jpg');
  const jack = sample('open-prices-14480.jpg');
  const env = makeEnv();
  const macRun = await runSanity(env, { batchId: 'mac', mode: 'round1', receipts: [{ ...mac.data, receiptKey: 'mac' }] });
  const priced = macRun.result.agreedRows.filter(r => typeof r.cells['采购商品金额'] === 'number' && r.cells['采购商品金额'] !== 0);
  assert.ok(priced.length >= 3);
  for (const row of priced) {
    assert.equal(row.exportMeta.discountKind, 'printed');
    assert.notEqual(row.flags['采购商品金额'], AMBER);
    assert.equal(row.estimated, false);
  }
  assert.equal(Math.round(priced.reduce((s, r) => s + r.cells['采购商品金额'], 0) * 100) / 100, 88.2);

  const jackRun = await runSanity(env, { batchId: 'jack', mode: 'round1', receipts: [{ ...jack.data, receiptKey: 'jack' }] });
  const rows = jackRun.result.agreedRows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.exportMeta.discountKind, 'estimated');
    assert.equal(row.estimated, true);
    assert.equal(row.flags['采购商品金额'], AMBER);
    assert.equal(row.cells['采购商品原价'], 59.99);
  }
  assert.equal(Math.round(rows.reduce((s, r) => s + r.cells['采购商品金额'], 0) * 100) / 100, 89.98);
  assert.equal(rows[0].cells['采购小票id'], rows[1].cells['采购小票id']);
  assert.equal(rows[0].cells['采购时间'], rows[1].cells['采购时间']);
});

test('official match with no official price flags Amber official price unavailable and keeps the printed price', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch([{
    brand: 'Chanel', officialName: 'Mini classic handbag', itemId: 'A69900', price: null,
    url: 'https://www.chanel.com/gb/fashion/p/A69900/',
    title: 'Mini classic handbag | Chanel',
    description: 'A69900. Discover the collection.',
  }], { brave: 0, gemini: 0 }, {
    geminiCandidates: [{ brand: 'Chanel', officialName: 'Mini classic handbag', itemId: 'A69900', price: null, sourceUrls: ['https://www.chanel.com/gb/fashion/p/A69900/'] }],
  });
  const { result } = await runSanity(env, { batchId: 'np', mode: 'round1', receipts: [{
    receiptKey: 'np', merchant: 'Chanel', receiptReference: 'N1', date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Classic Flap Mini Bag', itemId: 'A69900', qty: 1, unitPrice: 4950, amount: 4950 }],
  }] }, { fetchImpl: f, lookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['采购商品原价'], 4950);
  assert.equal(row.flags['采购商品原价'], AMBER);
  assert.ok(row.mismatches.some(m => m.field === 'price' && m.reason === 'official price unavailable' && m.officialValue === null && m.receiptValue === 4950));
  assert.ok(JSON.stringify(row).includes('official price unavailable'));
});


// P4 — 采购商品方法 must normalise to UnionPay, Card, Alipay or WeChat.
test('P4: card schemes and wallets (with or without a scheme) map to Card', () => {
  assert.equal(normaliseTender('VISA CONTACTLESS'), 'Card');
  assert.equal(normaliseTender('Mastercard'), 'Card');
  assert.equal(normaliseTender('American Express'), 'Card');
  assert.equal(normaliseTender('Amex'), 'Card');
  assert.equal(normaliseTender('Maestro'), 'Card');
  assert.equal(normaliseTender('Carte Bancaire'), 'Card');
  assert.equal(normaliseTender('debit'), 'Card');
  assert.equal(normaliseTender('credit card'), 'Card');
  assert.equal(normaliseTender('UnionPay'), 'UnionPay');
  assert.equal(normaliseTender('银联'), 'UnionPay');
  assert.equal(normaliseTender('Alipay'), 'Alipay');
  assert.equal(normaliseTender('WeChat Pay'), 'WeChat');
  assert.equal(normaliseTender('Apple Pay'), 'Card');
  assert.equal(normaliseTender('Google Pay'), 'Card');
  assert.equal(normaliseTender('Samsung Pay'), 'Card');
  assert.equal(normaliseTender('Garmin Pay'), 'Card');
  assert.equal(normaliseTender('wallet'), 'Card');
  assert.equal(normaliseTender('VISA CONTACTLESS Apple Pay'), 'Card');
  assert.equal(normaliseTender('Apple Pay Mastercard'), 'Card');
  assert.equal(normaliseTender('Cash'), 'Cash');
  assert.equal(normaliseTender('PayPal'), 'PayPal');
  assert.equal(normaliseTender('Klarna'), 'Klarna');
  assert.equal(normaliseTender('gift card'), 'gift card');
  assert.equal(normaliseTender(''), null);
  assert.equal(normaliseTender(null), null);
});

test('P4: wallets are Card with no flag; cash, PayPal, Klarna, gift card and empty are Pink with the allowed-list reason', async () => {
  const env = makeEnv();
  const item = { brand: 'Chanel', item: 'Flap bag', itemId: 'A111', qty: 1, unitPrice: 890, amount: 890 };
  const rec = (key, payment) => ({
    receiptKey: key, merchant: 'Selfridges', receiptReference: key.toUpperCase(), date: '2026-11-20', time: '12:00',
    payment, currency: 'GBP', items: [{ ...item, itemId: key }],
  });
  const { result } = await runSanity(env, { mode: 'round1', receipts: [
    rec('p4-apple', 'Apple Pay'),
    rec('p4-google', 'Google Pay'),
    rec('p4-samsung', 'Samsung Pay'),
    rec('p4-garmin', 'Garmin Pay'),
    rec('p4-wallet', 'wallet'),
    rec('p4-scheme', 'VISA CONTACTLESS Apple Pay'),
    rec('p4-visa', 'Visa'),
    rec('p4-cash', 'Cash'),
    rec('p4-paypal', 'PayPal'),
    rec('p4-klarna', 'Klarna'),
    rec('p4-gift', 'gift card'),
    rec('p4-empty', ''),
  ] });
  const byKey = Object.fromEntries(result.agreedRows.map(r => [r.receiptKey, r]));
  for (const key of ['p4-apple', 'p4-google', 'p4-samsung', 'p4-garmin', 'p4-wallet', 'p4-scheme', 'p4-visa']) {
    assert.equal(byKey[key].cells['采购商品方法'], 'Card', key);
    assert.equal(byKey[key].flags['采购商品方法'], undefined, key);
  }
  for (const [key, printed] of [['p4-cash', 'Cash'], ['p4-paypal', 'PayPal'], ['p4-klarna', 'Klarna'], ['p4-gift', 'gift card'], ['p4-empty', null]]) {
    assert.equal(byKey[key].cells['采购商品方法'], printed, key);
    assert.equal(byKey[key].flags['采购商品方法'], PINK, key);
    assert.ok(result.readingErrors.some(e => e.rowId === byKey[key].rowId && e.col === '采购商品方法' && e.reason === TENDER_REASON), key);
  }
});


// P1 — 品牌货号 is the brand's own item ID: prefer style ref, never a concession / store code.
test('P1: chooseBrandItemId prefers styleRef over EAN and skips concession codes', () => {
  assert.equal(chooseBrandItemId({ styleRef: 'A69900', itemId: '3145892123459', ean: '3145892123459' }, 'Chanel'), 'A69900');
  assert.equal(chooseBrandItemId({ sku: 'A69900', itemId: '3145892123459' }, 'Chanel'), 'A69900');
  assert.equal(chooseBrandItemId({ itemId: 'A69900', barcode: '3145892123459' }, 'Chanel'), 'A69900');
  assert.equal(chooseBrandItemId({ itemId: '1234567890', styleRef: 'A69900' }, 'Chanel'), 'A69900'); // 10-digit store-internal
  assert.equal(chooseBrandItemId({ itemId: '99999991234', style: 'A69900' }, 'Chanel'), 'A69900');
  assert.equal(chooseBrandItemId({ itemId: 'HARRODS-12345', styleRef: 'A69900' }, 'Chanel'), 'A69900');
  assert.equal(chooseBrandItemId({ itemId: '1234567890' }, 'Chanel'), null);
  assert.equal(chooseBrandItemId({ itemId: 'A69900' }, 'Chanel'), 'A69900');
});

test('P1: 品牌货号 on the row is the style, not a concession or barcode, and Pink when only a store code is present', async () => {
  const env = makeEnv();
  const mixed = {
    receiptKey: 'p1-mixed', merchant: 'Selfridges', receiptReference: 'M1', date: '2026-11-20', time: '12:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Flap bag', itemId: '3145892123459', styleRef: 'A69900', qty: 1, unitPrice: 4950, amount: 4950 }],
  };
  const onlyStore = {
    receiptKey: 'p1-store', merchant: 'Selfridges', receiptReference: 'M2', date: '2026-11-20', time: '12:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Flap bag', itemId: '1234567890', qty: 1, unitPrice: 4950, amount: 4950 }],
  };
  const { result } = await runSanity(env, { receipts: [mixed, onlyStore], mode: 'round1' });
  const withStyle = result.agreedRows.find(r => r.cells['品牌货号'] === 'A69900');
  const storeRow = result.agreedRows.find(r => r.receiptKey === 'p1-store' || r.source?.receiptKey === 'p1-store');
  assert.ok(withStyle, 'style ref should be written as 品牌货号');
  assert.notEqual(withStyle.cells['品牌货号'], '3145892123459');
  const store = storeRow || result.agreedRows.find(r => r.cells['品牌货号'] !== 'A69900');
  assert.ok(store, 'store-code-only row missing');
  assert.equal(store.cells['品牌货号'] || '', '');
  assert.equal(store.flags['品牌货号'], PINK);
});

test('brandItemId: printed style is kept; official ID is used only when none is printed', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch(CATALOGUE);
  const exact = {
    receiptKey: 'bid-p5', merchant: 'Selfridges', receiptReference: 'B1', date: '2026-11-20', time: '12:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Classic Flap Mini Bag', itemId: 'A69900', qty: 1, unitPrice: 4950, amount: 4950 }],
  };
  const idMatchPriceDiff = {
    receiptKey: 'bid-idmatch', merchant: 'Selfridges', receiptReference: 'B2', date: '2026-11-20', time: '12:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'VCA', item: 'Vintage Laurel pendant', itemId: '0012345', qty: 1, unitPrice: 3700, amount: 3700 }],
  };
  const { result } = await runSanity(env, { mode: 'round1', receipts: [exact, idMatchPriceDiff] }, { fetchImpl: f, lookup });
  const p5 = result.agreedRows.find(r => r.receiptKey === 'bid-p5');
  const sameId = result.agreedRows.find(r => r.receiptKey === 'bid-idmatch');
  assert.equal(p5.brandItemId, 'A69900');
  assert.equal(p5.brandItemIdSource, 'brandProductCode');
  assert.equal(p5.brandItemIdFlag, null);
  assert.equal(p5.cells['品牌货号'], 'A69900');
  assert.equal(p5.exportMeta.brandItemId, 'A69900');
  // VCA 0012345-style is a format miss on the shared table (VCAR…). Empty + Pink.
  assert.equal(sameId.brandItemId, null);
  assert.equal(sameId.cells['品牌货号'], null);
  assert.equal(sameId.brandItemIdFlag, PINK);
  assert.equal(sameId.flags['品牌货号'], PINK);

  // No printed style / brand code (EAN only): official ID is used, Amber unless P5.
  const eanOnlyLookup = async () => ({
    candidates: [{ brand: 'Chanel', officialName: 'Classic Flap Mini Bag', itemId: 'A69900', price: 4950, currency: 'GBP', matchType: 'id', confidence: 0.9, onOfficialSite: true, sourceUrls: ['https://www.chanel.com/p/A69900'], matchedFields: ['itemId', 'price'] }],
    cacheHit: false, cacheKey: 'ean', sourcesQueried: ['brave'], printedItemId: '3145892123459', canonicalBrand: 'Chanel', flag: '#FDE68A',
  });
  const eanOnly = {
    receiptKey: 'bid-official-only', merchant: 'Selfridges', receiptReference: 'B3', date: '2026-11-20', time: '12:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Classic Flap Mini Bag', ean: '3145892123459', qty: 1, unitPrice: 10, amount: 10 }],
  };
  const { result: r2 } = await runSanity(makeEnv(KEYS), { mode: 'round1', receipts: [eanOnly] }, { lookup: eanOnlyLookup });
  const off = r2.agreedRows[0];
  assert.equal(off.brandItemId, 'A69900');
  assert.equal(off.brandItemIdSource, 'official');
  assert.equal(off.cells['品牌货号'], 'A69900');
  assert.equal(off.exportMeta.brandItemIdSource, 'official');
});

test('brandItemId: Gucci printed ref 000001 is kept, Amber official site shows 658574', async () => {
  const env = makeEnv(KEYS); const f = mockFetch(CATALOGUE);
  const { result } = await runSanity(env, { batchId: 'gucci-ref', mode: 'round1', receipts: [{
    receiptKey: 'gucci-ref', merchant: 'Selfridges', receiptReference: 'G-REF', date: '2026-11-20', time: '3:15 pm',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Gucci', item: 'Handbag', itemId: '000001', qty: 1, unitPrice: 1350, amount: 1350 }],
  }] }, { fetchImpl: f, lookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌货号'], '000001');
  assert.equal(row.brandItemId, '000001');
  assert.equal(row.brandItemIdSource, 'brandProductCode');
  assert.equal(row.brandItemIdFlag, AMBER);
  assert.equal(row.brandItemIdReason, 'official site shows 658574');
  assert.equal(row.flags['品牌货号'], AMBER);
  assert.equal(row.exportMeta.brandItemId, '000001');
  assert.equal(row.exportMeta.brandItemIdReason, 'official site shows 658574');
  assert.ok(result.lookupUncertainties.some(u => u.rowId === row.rowId && u.col === '品牌货号' && u.reason === 'official site shows 658574'));
});

test('brandItemId: style ref / brand product code, EAN (Amber), empty + Pink, and forbidden concession labels', async () => {
  const env = makeEnv();
  const base = { merchant: 'Selfridges', date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP' };
  const rec = (key, items) => ({ ...base, receiptKey: key, receiptReference: key, items });
  const { result } = await runSanity(env, { mode: 'round1', receipts: [
    rec('bid-style', [{ brand: 'Chanel', item: 'Flap bag', styleRef: 'A69900', itemId: '3145892123459', ean: '3145892123459', qty: 1, unitPrice: 10, amount: 10 }]),
    rec('bid-sku', [{ brand: 'Chanel', item: 'Flap bag', sku: 'A69900', itemId: '3145892123459', qty: 1, unitPrice: 10, amount: 10 }]),
    rec('bid-code', [{ brand: 'Chanel', item: 'Flap bag', itemId: 'A69900', qty: 1, unitPrice: 10, amount: 10 }]),
    rec('bid-ean', [{ brand: 'Chanel', item: 'Flap bag', ean: '4000000000013', qty: 1, unitPrice: 10, amount: 10 }]),
    rec('bid-empty', [{ brand: 'Chanel', item: 'Flap bag', qty: 1, unitPrice: 10, amount: 10 }]),
    rec('bid-conc4', [{ brand: 'Chanel', item: 'Flap bag', styleRef: '1234', sku: '1234', qty: 1, unitPrice: 10, amount: 10 }]),
    rec('bid-999', [{ brand: 'Chanel', item: 'Flap bag', style: '99999991234', sku: '99999991234', qty: 1, unitPrice: 10, amount: 10 }]),
  ] });
  const by = Object.fromEntries(result.agreedRows.map(r => [r.receiptKey, r]));
  assert.equal(by['bid-style'].brandItemId, 'A69900');
  assert.equal(by['bid-style'].brandItemIdSource, 'styleRef');
  assert.equal(by['bid-style'].brandItemIdFlag, null);
  assert.equal(by['bid-sku'].brandItemId, 'A69900');
  assert.equal(by['bid-sku'].brandItemIdSource, 'styleRef');
  assert.equal(by['bid-code'].brandItemId, 'A69900');
  assert.equal(by['bid-code'].brandItemIdSource, 'brandProductCode');
  assert.equal(by['bid-ean'].brandItemId, '4000000000013');
  assert.equal(by['bid-ean'].brandItemIdSource, 'ean');
  assert.equal(by['bid-ean'].brandItemIdFlag, AMBER);
  assert.equal(by['bid-ean'].exportMeta.comments['品牌货号'], 'Only an EAN is available; the brand item id was not found.');
  assert.equal(by['bid-empty'].brandItemId, null);
  assert.equal(by['bid-empty'].brandItemIdSource, null);
  assert.equal(by['bid-empty'].brandItemIdFlag, PINK);
  assert.equal(by['bid-empty'].cells['品牌货号'], null);
  // 4-digit concession and 9999999xxx are never used, even when labelled style/sku.
  assert.equal(by['bid-conc4'].brandItemId, null);
  assert.equal(by['bid-conc4'].brandItemIdFlag, PINK);
  assert.equal(by['bid-999'].brandItemId, null);
  assert.equal(by['bid-999'].brandItemIdFlag, PINK);
  assert.equal(resolveBrandItemId({ item: { itemId: '1234', styleRef: '1234' }, brand: 'Chanel' }).brandItemId, null);
  assert.equal(resolveBrandItemId({ item: { sku: '99999991234', style: '99999991234' }, brand: 'Chanel' }).brandItemId, null);
});


test('BRAND_ITEM_ID_FORMAT is empty by default, injectable, and only fitting printed codes count as style refs', async () => {
  assert.equal(BRAND_ITEM_ID_FORMAT, BRAND_ITEM_ID_FORMATS);
  assert.ok(Array.isArray(BRAND_ITEM_ID_FORMATS) && BRAND_ITEM_ID_FORMATS.length > 0);
  const table = { Synthetic: /^ZZ\d{4}$/ };
  setBrandItemIdFormat(table);
  try {
    assert.equal(BRAND_ITEM_ID_FORMAT, BRAND_ITEM_ID_FORMATS);
    assert.equal(fitsBrandItemIdFormat('Synthetic', 'ZZ9999'), true);
    assert.equal(fitsBrandItemIdFormat('Synthetic', 'ZZ999l'), false);
    const fitting = resolveBrandItemId({ item: { styleRef: 'ZZ9999' }, brand: 'Synthetic' });
    assert.equal(fitting.brandItemId, 'ZZ9999');
    assert.equal(fitting.brandItemIdSource, 'styleRef');
    assert.equal(fitting.flag, null);
    // #20: a non-fitting printed code does not occupy 品牌货号. The official / I→1
    // alternative is recorded in the reason only, never written as the item id.
    const nonFitting = resolveBrandItemId({ item: { styleRef: 'ZZ999l' }, brand: 'Synthetic', officialItemId: 'ZZ9999' });
    // Official fills when the typo does not fit. It does not write the typo, and does not invent an OCR guess as the id.
    assert.equal(nonFitting.brandItemId, 'ZZ9999');
    assert.equal(nonFitting.brandItemIdSource, 'official');
    assert.notEqual(nonFitting.brandItemId, 'ZZ999l');
    assert.equal(nonFitting.printedValue, 'ZZ999l');
  } finally {
    setBrandItemIdFormat(null);
  }
  // Injection via deps.brandItemIdFormat, without mutating the exported empty default.
  const { result } = await runSanity(makeEnv(), { receipts: [{
    receiptKey: 'fmt-inj', merchant: 'Test', date: '2026-04-03', time: '14:00:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Synthetic', item: 'Tote bag', styleRef: 'XY9999', qty: 1, unitPrice: 100, amount: 100 }],
  }] }, { brandItemIdFormat: { Synthetic: /^ZZ\d{4}$/ } });
  assert.equal(BRAND_ITEM_ID_FORMAT, BRAND_ITEM_ID_FORMATS);
  assert.equal(result.agreedRows[0].cells['品牌货号'] || '', '');
  assert.equal(result.agreedRows[0].exportMeta.brandItemId || '', '');
  assert.notEqual(result.agreedRows[0].cells['品牌货号'], 'XY9999');
  assert.equal(result.agreedRows[0].flags['品牌货号'], PINK);
  assert.ok(
    result.readingErrors.some(e => e.col === '品牌货号' && (/Printed value kept|store\/internal code not used|not a recognised style code/.test(e.reason)))
    || /XY9999/.test(result.agreedRows[0].exportMeta.comments?.['品牌货号'] || ''),
    'rejected printed XY9999 should be in the reason or comment, not the cell',
  );
});

test('Chanel optional season prefix: 24P AS1234 yields style ref AS1234', async () => {
  assert.equal(extractChanelStyleRef('24P AS1234'), 'AS1234');
  assert.equal(extractChanelStyleRef('AS1234'), 'AS1234');
  const rec = resolveBrandItemId({ item: { styleRef: '24P AS1234' }, brand: 'Chanel' });
  assert.equal(rec.brandItemId, 'AS1234');
  assert.equal(rec.brandItemIdSource, 'styleRef');
  assert.equal(rec.flag, null);
  const viaItemId = resolveBrandItemId({ item: { itemId: '24P AS1234' }, brand: 'Chanel' });
  assert.equal(viaItemId.brandItemId, 'AS1234');
  const { result } = await runSanity(makeEnv(), { receipts: [{
    receiptKey: 'chanel-season', merchant: 'Chanel', date: '2026-04-03', time: '14:00:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Flap bag', styleRef: '24P AS1234', qty: 1, unitPrice: 100, amount: 100 }],
  }] });
  assert.equal(result.agreedRows[0].cells['品牌货号'], 'AS1234');
  assert.equal(result.agreedRows[0].exportMeta.brandItemId, 'AS1234');
  assert.equal(result.agreedRows[0].exportMeta.brandItemIdSource, 'styleRef');
});

test('unconfirmed printed brand code is not auto-corrected into the cell; alternative stays in the comment', async () => {
  const table = { Synthetic: /^ZZ\d{4}$/ };
  // l→1 is the OCR guess (ZZ9991). The official/format-fitting code is ZZ9999.
  assert.equal(suggestedPrintedCodeAlternative('ZZ999l', 'Synthetic', table), 'ZZ9991');
  const rec = resolveBrandItemId({ item: { itemId: 'ZZ999l' }, brand: 'Synthetic', formatTable: table });
  // #20 empties the cell; printed-value-kept keeps the official/OCR alternative out of the item id.
  assert.equal(rec.brandItemId, null);
  assert.notEqual(rec.brandItemId, 'ZZ9999');
  assert.notEqual(rec.brandItemId, 'ZZ9991');
  assert.equal(rec.flag, PINK);
  assert.equal(rec.reason, printedValueKeptReason('ZZ9991'));
  assert.match(rec.reason, /ZZ9991/);
  assert.equal(rec.printedValue, 'ZZ999l');
  const { result } = await runSanity(makeEnv(), { receipts: [{
    receiptKey: 'ocr-keep', merchant: 'Test', date: '2026-04-03', time: '14:00:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Synthetic', item: 'Tote bag', itemId: 'ZZ999l', qty: 1, unitPrice: 100, amount: 100 }],
  }] }, { brandItemIdFormat: table });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌货号'] || '', '');
  assert.notEqual(row.cells['品牌货号'], 'ZZ9999');
  assert.notEqual(row.cells['品牌货号'], 'ZZ999l');
  assert.notEqual(row.cells['品牌货号'], 'ZZ9991');
  assert.equal(row.exportMeta.brandItemId || '', '');
  assert.equal(row.flags['品牌货号'], PINK);
  assert.ok(result.readingErrors.some(e => e.col === '品牌货号' && e.reason === printedValueKeptReason('ZZ9991')));
  assert.match(row.exportMeta.comments['品牌货号'] || '', /ZZ9991|ZZ999l/);
  assert.match(row.exportMeta.brandItemIdReason, /ZZ9991/);
});

test('PR #1 checkBatchDateOutliers hook applies Pink and does not overwrite human_verified_unflagged locks', async () => {
  const item = { brand: 'Chanel', item: 'Flap bag', itemId: 'A111', qty: 1, unitPrice: 10, amount: 10 };
  const rec = (key) => ({
    receiptKey: key, merchant: 'Selfridges', receiptReference: key.toUpperCase(), date: '2026-11-20', time: '12:00',
    payment: 'Visa', currency: 'GBP', items: [{ ...item }],
  });
  const idle = await runSanity(makeEnv(), { mode: 'round1', receipts: [rec('date-idle')] });
  assert.ok((idle.audit.trail || []).some(s => s.stage === 'pr1-batch-date-outlier' && s.applied === false));
  assert.equal(idle.result.agreedRows[0].flags['采购时间'], undefined);

  const env = makeEnv();
  const lockedId = 'date-locked:0:u0';
  await env.DB.prepare('INSERT OR IGNORE INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)')
    .bind(lockedId, '采购时间', new Date().toISOString()).run();
  const called = [];
  const checkBatchDateOutliers = (units, { now } = {}) => {
    assert.ok(Array.isArray(units));
    assert.ok(now instanceof Date);
    called.push(...units.map(u => u.rowId));
    return units.map(u => ({ rowId: u.rowId, field: '采购时间', flag: '#FECDD3', reason: 'date outlier' }));
  };
  const hooked = await runSanity(env, { mode: 'round1', receipts: [rec('date-open'), rec('date-locked')] }, { checkBatchDateOutliers });
  assert.ok(called.includes('date-open:0:u0') && called.includes('date-locked:0:u0'));
  assert.ok((hooked.audit.trail || []).some(s => s.stage === 'pr1-batch-date-outlier' && s.applied === true && s.name === 'checkBatchDateOutliers'));
  const open = hooked.result.agreedRows.find(r => r.receiptKey === 'date-open');
  const locked = hooked.result.agreedRows.find(r => r.receiptKey === 'date-locked');
  assert.equal(open.flags['采购时间'], PINK);
  assert.ok(hooked.result.readingErrors.some(e => e.rowId === open.rowId && e.col === '采购时间' && e.reason === 'date outlier'));
  assert.equal(locked.flags['采购时间'], undefined);
  assert.ok(!hooked.result.readingErrors.some(e => e.rowId === locked.rowId && e.col === '采购时间'));
  assert.equal(typeof maybeApplyPr1BatchDateOutlierCheck, 'function');
});

test('Chanel bare digits are a format miss: empty + Pink', async () => {
  const { result } = await runSanity(makeEnv(), { receipts: [{
    receiptKey: 'ch-digits', merchant: 'Test', date: '2026-04-03', time: '14:00:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Flap bag', itemId: '1234567', qty: 1, unitPrice: 100, amount: 100 }],
  }] });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌货号'], null);
  assert.equal(row.flags['品牌货号'], PINK);
  assert.notEqual(row.cells['品牌货号'], '1234567');
});

test('store-code itemId fills only a labelled valid GTIN, Amber, exact comment; unlabelled or bad checksum stay empty', async () => {
  const { result } = await runSanity(makeEnv(), { receipts: [{
    receiptKey: 'ean-fill', merchant: 'Test', date: '2026-04-03', time: '14:00:00',
    payment: 'Visa', currency: 'GBP',
    items: [
      { brand: 'Synthetic Co', item: 'Tote bag', itemId: '2222222222', ean: '4000000000013', qty: 1, unitPrice: 100, amount: 100 },
      { brand: 'Synthetic Co', item: 'Scarf', itemId: '2222222222', sku: '4000000000020', qty: 1, unitPrice: 80, amount: 80 },
      { brand: 'Synthetic Co', item: 'Belt', itemId: '2222222222', ean: '4000000000010', qty: 1, unitPrice: 40, amount: 40 },
      { brand: 'Synthetic Co', item: 'Hat', itemId: '4321', concessionCode: '4321', qty: 1, unitPrice: 20, amount: 20 },
    ],
  }] });
  const [labelled, unlabelled, bad, bare] = result.agreedRows;
  assert.equal(labelled.cells['品牌货号'], '4000000000013');
  assert.equal(labelled.flags['品牌货号'], AMBER);
  assert.equal(labelled.exportMeta.comments['品牌货号'], 'Only an EAN is available; the brand item id was not found.');
  assert.equal(unlabelled.cells['品牌货号'], null);
  assert.equal(unlabelled.flags['品牌货号'], PINK);
  assert.notEqual(unlabelled.cells['品牌货号'], '4000000000020');
  assert.equal(bad.cells['品牌货号'], null);
  assert.equal(bad.flags['品牌货号'], PINK);
  assert.equal(bare.cells['品牌货号'], null);
  assert.equal(bare.flags['品牌货号'], PINK);
});

test('a format-fitting printed style is not overwritten by an official id', async () => {
  const { result } = await runSanity(makeEnv(), { receipts: [{
    receiptKey: 'keep-printed', merchant: 'Test', date: '2026-04-03', time: '14:00:00',
    payment: 'Visa', currency: 'GBP',
    items: [{ brand: 'Chanel', item: 'Flap bag', styleRef: 'AS1234', qty: 1, unitPrice: 100, amount: 100 }],
  }] }, { lookup: async () => ({
    candidates: [{ brand: 'Chanel', officialName: 'Flap bag', itemId: 'AS9999', price: 100, currency: 'GBP', matchType: 'id', confidence: 0.9, onOfficialSite: true, sourceUrls: ['https://www.chanel.com/gb/p/AS9999'], matchedFields: ['itemId'] }],
    cacheHit: false, cacheKey: 'k', sourcesQueried: ['brave'], printedItemId: 'AS1234', canonicalBrand: 'Chanel',
  }) });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌货号'], 'AS1234');
  assert.notEqual(row.cells['品牌货号'], 'AS9999');
  assert.match(row.exportMeta.comments['品牌货号'] || row.brandItemIdReason || '', /AS9999/);
});
