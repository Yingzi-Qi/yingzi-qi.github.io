import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, mockFetch, CATALOGUE } from './helpers.mjs';
import { runSanity, PINK, AMBER } from '../functions/_lib/sanity.js';
import { lookup } from '../functions/_lib/lookup.js';
import { keys } from '../functions/_lib/cache.js';
import { allocateProportional, expandReceipt, fromPence, supplierVisibleName } from '../../tillroll/units.js';
import { buildV2XlsxBlob, readV2Workbook, round2Body, VISIBLE_COLUMNS, HIDDEN_COLUMNS, MONEY_COLUMNS, STYLE, normaliseConfidence, sourceUrlList } from '../../tillroll/v2-excel.js';

const SAMPLES = JSON.parse(readFileSync(new URL('../../tillroll/real-samples/index.json', import.meta.url), 'utf8'));
const sample = name => SAMPLES.find(e => e.filename === name);
const KEYS = { BRAVE_API_KEY: 'b', GEMINI_API_KEY: 'g' };

async function sheetXml(blob) {
  const { default: JSZip } = await import('../../tillroll/export-vendor/jszip.min.js');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = async path => zip.file(path)?.async('string');
  return {
    zip, sheet: await read('xl/worksheets/sheet1.xml'), styles: await read('xl/styles.xml'),
    comments: await read('xl/comments1.xml'),
  };
}

test('proportional split puts the remainder on the last weighted row and sums exactly', () => {
  const shares = allocateProportional([1000, 1000, 1001], 100);
  assert.equal(shares.reduce((a, b) => a + b, 0), 100);
  assert.equal(shares[2], 100 - shares[0] - shares[1]);
  const even = allocateProportional([5999, 5999], 3000);
  assert.deepEqual(even, [1500, 1500]);
  assert.equal(fromPence(5999 - 1500) * 2, 89.98);
});

test('supplier: department store, brand boutique, mall', () => {
  assert.equal(supplierVisibleName('Selfridges', 'Selfridges London Oxford Street'), 'Selfridges');
  assert.equal(supplierVisibleName('Harrods', 'Harrods Knightsbridge'), 'Harrods');
  assert.equal(supplierVisibleName('Rolex', 'Rolex Canary Wharf'), 'Rolex Canary Wharf');
  assert.equal(supplierVisibleName('Westfield London', 'Rolex Canary Wharf'), 'Westfield London');
});

test('every stored real receipt splits so unit rows sum to the paid total', () => {
  let checked = 0;
  for (const e of SAMPLES) {
    if (!e.data?.items) continue;
    const { audit } = expandReceipt({ ...e.data, receiptKey: e.filename });
    assert.equal(audit.ok, true, `${e.filename} expected ${audit.expected} got ${audit.actual}`);
    checked++;
  }
  assert.ok(checked >= 25);
});

test('printed per-item discount is exact; a shared discount is Amber and sums to the paid total', async () => {
  const mac = sample('open-prices-58120.jpg');
  const jack = sample('open-prices-14480.jpg');
  const env = makeEnv();
  const macRun = await runSanity(env, { batchId: 'mac', mode: 'round1', receipts: [{ ...mac.data, receiptKey: 'mac' }] });
  const priced = macRun.result.agreedRows.filter(r => typeof r.cells['采购商品金额'] === 'number' && r.cells['采购商品金额'] !== 0);
  assert.ok(priced.length >= 3);
  for (const row of priced) {
    assert.equal(row.exportMeta.discountKind, 'printed');
    assert.notEqual(row.flags['采购商品金额'], AMBER);
  }
  assert.equal(Math.round(priced.reduce((s, r) => s + r.cells['采购商品金额'], 0) * 100) / 100, 88.2);

  const jackRun = await runSanity(env, { batchId: 'jack', mode: 'round1', receipts: [{ ...jack.data, receiptKey: 'jack' }] });
  const rows = jackRun.result.agreedRows;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.exportMeta.discountKind, 'estimated');
    assert.equal(row.flags['采购商品金额'], AMBER);
    assert.equal(row.cells['采购商品原价'], 59.99);
  }
  assert.equal(Math.round(rows.reduce((s, r) => s + r.cells['采购商品金额'], 0) * 100) / 100, 89.98);
  assert.equal(rows[0].cells['采购小票id'], rows[1].cells['采购小票id']);
  assert.equal(rows[0].cells['采购时间'], rows[1].cells['采购时间']);
});

test('qty N becomes N unit rows sharing receipt id and time; line discount sums to the line', async () => {
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
  assert.ok(holders.every(r => r.flags['采购商品金额'] === AMBER && r.exportMeta.discountKind === 'estimated'));
  assert.ok(holders.every(r => r.cells['采购时间'] === '2026-03-02 19:05:00' && r.cells['采购小票id'] === 'H-1'));
  assert.equal(holders[0].rowId, 'q1:0:u0');
  assert.equal(holders[1].rowId, 'q1:0:u1');
  const cotton = result.agreedRows.filter(r => r.cells['品名'] === 'Cotton');
  assert.equal(cotton.length, 3);
  assert.ok(cotton.every(r => r.cells['采购商品金额'] === 7 && r.exportMeta.discountKind === 'none' && !r.flags['采购商品金额']));
  assert.equal(cotton[0].cells['销售金额'], 6.16);
  for (const row of result.agreedRows) {
    const p = row.cells['采购商品原价'];
    assert.equal(row.cells['销售金额'], Math.round((p * 0.88 + Number.EPSILON) * 100) / 100);
  }
});

test('workbook: 10 headers, time, sale amount, only two fills, hidden columns, no formula', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch(CATALOGUE);
  const { result } = await runSanity(env, { batchId: 'xl', mode: 'round1', receipts: [{
    receiptKey: 'xl1', merchant: 'Selfridges', receiptReference: '0456-7788', date: '17/01/2025', time: '7:20 pm',
    payment: 'VISA', currency: 'GBP', storeClues: { postcode: 'W1A 1AB', addressLines: ['400 Oxford Street'] },
    items: [
      { brand: 'Chanel Accessory', item: 'mini', itemId: 'CHANEL A69900', qty: 1, unitPrice: 4950, amount: 4950 },
      { brand: 'VCA', item: 'pendant', itemId: '0012345', qty: 1, unitPrice: 3700, amount: 3700 },
      { brand: 'Gucci', item: 'Handbag', itemId: '000001', qty: 1, unitPrice: 1350, amount: 1350 },
    ],
  }] }, { fetchImpl: f, lookup });
  const blob = await buildV2XlsxBlob(result, { exportKey: '00000000-0000-4000-8000-000000000001' });
  const { sheet, styles, comments } = await sheetXml(blob);
  assert.ok(!styles.includes('FFEDC0'), 'legacy fill must be gone');
  assert.ok(styles.includes('FFFDE68A') && styles.includes('FFFECDD3'));
  assert.equal(sheet.includes('<f>'), false);
  assert.equal(sheet.includes('<f '), false);
  for (const header of VISIBLE_COLUMNS) assert.ok(sheet.includes(header), header);
  for (const header of HIDDEN_COLUMNS) assert.ok(sheet.includes(header), header);
  assert.equal(sheet.includes('Order Number'), false);
  assert.equal(sheet.includes('>Brand<'), false);
  assert.ok(sheet.includes('hidden="1"'));
  assert.ok(sheet.includes('2025-01-17 19:20:00'));
  assert.ok(sheet.includes('>4356<') || sheet.includes('<v>4356</v>'));
  // VCA receipt price kept; official 3600 is the comment and the hidden other-value.
  const vca = result.agreedRows.find(r => r.cells['品牌'] === 'Van Cleef &amp; Arpels' || r.cells['品牌'] === 'Van Cleef & Arpels');
  assert.equal(vca.cells['采购商品原价'], 3700);
  assert.equal(vca.flags['采购商品原价'], AMBER);
  assert.match(vca.exportMeta.comments['采购商品原价'], /3600/);
  assert.equal(vca.exportMeta.alternates['采购商品原价'].shown, 'receipt');
  assert.equal(vca.cells['品牌货号'], '0012345');
  const chanel = result.agreedRows[0];
  assert.equal(chanel.cells['品牌'], 'Chanel');
  assert.equal(chanel.cells['品名'], 'Classic Flap Mini Bag');
  assert.match(chanel.exportMeta.comments['品牌'], /Chanel Accessory/);
  assert.match(chanel.exportMeta.comments['品名'], /mini/);
  assert.equal(chanel.exportMeta.alternates['品牌'].shown, 'official');
  const gucci = result.agreedRows[2];
  assert.equal(gucci.cells['品牌货号'], '000001');
  assert.equal(gucci.flags['品牌货号'], AMBER);
  assert.match(gucci.exportMeta.comments['品牌货号'], /658574/);
  assert.equal(gucci.lookup.matchType, 'price-fallback');
  assert.ok(gucci.exportMeta.candidates?.length >= 1);
  assert.ok(comments && comments.includes('Chanel Accessory') && comments.includes('3600') && comments.includes('658574'));
  const parsed = await readV2Workbook(blob);
  assert.equal(parsed.kind, 'v2');
  assert.deepEqual(parsed.rows[0].values && VISIBLE_COLUMNS.map(c => parsed.rows.find(r => r.rowId === chanel.rowId).values[c]),
    VISIBLE_COLUMNS.map(c => chanel.cells[c]));
  assert.equal(parsed.rows.find(r => r.rowId === chanel.rowId).fills['品名'], AMBER);
  assert.equal(parsed.rows.find(r => r.rowId === vca.rowId).comments['采购商品原价']?.includes('3600'), true);
  assert.equal(STYLE.amber, 3);
  assert.equal(STYLE.pink, 5);
});

test('cleared Pink/Amber fill becomes a lock and is never re-flagged; edits are detected', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch(CATALOGUE);
  const base = { receiptKey: 'lock1', merchant: 'Harrods', receiptReference: null, date: '2026-11-21', time: '10:00', payment: 'Amex', currency: 'GBP' };
  const r1 = await runSanity(env, { batchId: 'lock', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Chanel', item: 'mini', itemId: 'A69900', unitPrice: 4950, amount: 4950 }] }] }, { fetchImpl: f, lookup });
  const row = r1.result.agreedRows[0];
  assert.equal(row.flags['采购小票id'], PINK);
  assert.equal(row.flags['品名'], AMBER);
  const blob = await buildV2XlsxBlob(r1.result, { exportKey: '00000000-0000-4000-8000-000000000002' });
  const { default: JSZip } = await import('../../tillroll/export-vendor/jszip.min.js');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const pink = xml.match(/<c r="A2"[^>]*s="[56]"/);
  const amber = xml.match(/<c r="E2"[^>]*s="[34]"/);
  assert.ok(pink && amber, xml.slice(0, 500));
  xml = xml.replace(pink[0], pink[0].replace(/s="[56]"/, 's="0"'));
  xml = xml.replace(amber[0], amber[0].replace(/s="[34]"/, 's="0"'));
  xml = xml.replace('Classic Flap Mini Bag', 'Classic Flap Mini Bag edited');
  zip.file('xl/worksheets/sheet1.xml', xml);
  const edited = await zip.generateAsync({ type: 'uint8array' });
  const planned = await readV2Workbook(edited);
  const item = planned.receipts[0].items[0];
  assert.ok(item.clearedCols.includes('采购小票id') && item.clearedCols.includes('品名'));
  assert.ok(item.editedCols.includes('品名'));
  assert.equal(item.previousItemId, null);
  assert.deepEqual(planned.locks.map(l => l.col).sort(), ['品名', '采购小票id'].sort());
  const t = new Date().toISOString();
  await env.DB.batch(planned.locks.map(l => env.DB.prepare('INSERT OR IGNORE INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind(l.rowId, l.col, t)));
  const calls = f.calls.gemini;
  const r2 = await runSanity(env, { batchId: 'lock', mode: 'round2', receipts: planned.receipts }, { fetchImpl: f, lookup });
  const again = r2.result.agreedRows[0];
  assert.equal(again.flags['采购小票id'], undefined);
  assert.equal(again.flags['品名'], undefined);
  assert.equal(again.cells['品名'], 'Classic Flap Mini Bag edited');
  assert.ok(!again.round2Changed.includes('采购小票id'));
  assert.equal(f.calls.gemini, calls, 'verified brand, name and price with an unedited item id skip look-up');
  const r3 = await runSanity(env, { batchId: 'lock', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Chanel', item: 'mini', itemId: 'A69900', unitPrice: 4950, amount: 4950 }] }] }, { fetchImpl: f, lookup });
  assert.equal(r3.result.agreedRows[0].flags['采购小票id'], undefined);
  assert.equal(r3.result.agreedRows[0].flags['品名'], undefined);
});

test('edited 品牌货号 invalidates the 2dp price-fallback key and re-looks-up; paused stays Amber', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch(CATALOGUE);
  const base = { receiptKey: 'pf', merchant: 'Gucci', receiptReference: 'G1', date: '2026-11-21', time: '10:00', payment: 'Visa', currency: 'GBP' };
  const r1 = await runSanity(env, { batchId: 'pf', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Gucci', item: 'Handbag', itemId: '000001', unitPrice: 1350, amount: 1350 }] }] }, { fetchImpl: f, lookup });
  const row = r1.result.agreedRows[0];
  assert.equal(keys.pf('Gucci', 'GBP', 1350), 'lookup:v2:pf:gucci:GBP:1350.00');
  assert.equal(row.lookup.cacheKey, 'lookup:v2:pf:gucci:GBP:1350.00');
  const blob = await buildV2XlsxBlob(r1.result);
  const parsed = await readV2Workbook(blob);
  parsed.receipts[0].items[0].itemId = '446744';
  parsed.receipts[0].items[0].editedCols = ['品牌货号'];
  parsed.receipts[0].items[0].previousItemId = '000001';
  const r2 = await runSanity(env, { batchId: 'pf', mode: 'round2', receipts: parsed.receipts }, { fetchImpl: f, lookup });
  assert.equal(r2.result.agreedRows[0].cells['品名'], 'GG Marmont mini bag');
  assert.equal(r2.result.agreedRows[0].lookup.matchType, 'id');
  assert.ok(r2.result.agreedRows[0].round2Changed.includes('品名'));
  assert.equal(r2.result.agreedRows[0].flags['品名'], AMBER);
  const pf = await env.LOOKUP_CACHE.get(keys.pf('Gucci', 'GBP', 1350));
  assert.equal(pf, null);

  const paused = await runSanity(makeEnv(), { batchId: 'pause', mode: 'round1', receipts: [{ receiptKey: 'p', merchant: 'Rolex', receiptReference: 'R1', date: '2026-01-02', time: '09:00', payment: 'Cash', currency: 'GBP', storeClues: { postcode: 'E14 5AB' }, items: [{ brand: 'Rolex', item: 'Datejust', itemId: '126234', unitPrice: 8000, amount: 8000 }] }] });
  const role = paused.result.agreedRows[0];
  assert.equal(role.cells['供应商'], 'Rolex Canary Wharf');
  assert.equal(role.flags['供应商'], AMBER);
  assert.equal(paused.result.lookupsPaused, true);
  assert.equal(role.flags['品名'], AMBER);
});

test('header fill is the dark green, never a flag colour; money format and autoFilter stay', async () => {
  const blob = await buildV2XlsxBlob({ agreedRows: [{
    rowId: 'hdr', receiptKey: 'hdr',
    cells: Object.fromEntries(VISIBLE_COLUMNS.map(c => [c, MONEY_COLUMNS.has(c) ? 12.5 : 'synthetic'])),
    flags: {},
  }] });
  const { sheet, styles, zip } = await sheetXml(blob);
  assert.match(styles, /FF1E4946/);
  assert.match(styles, /numFmtId="4"/);
  const headerFill = styles.match(/<fill><patternFill patternType="solid"><fgColor rgb="([^"]+)"/);
  assert.equal(headerFill[1], 'FF1E4946');
  assert.equal(headerFill[1] === 'FFFECDD3' || headerFill[1] === 'FFFDE68A', false);
  const headerRow = sheet.match(/<row r="1"[\s\S]*?<\/row>/)[0];
  assert.equal(/s="[3456]"/.test(headerRow), false);
  assert.match(sheet, /<autoFilter /);
  const book = await zip.file('xl/workbook.xml').async('string');
  assert.match(book, /name="Excluded zero items"/);
  assert.match(book, /name="Flags"/);
  assert.equal(normaliseConfidence('high'), 'high');
  assert.equal(normaliseConfidence('0.5'), 0.5);
  assert.deepEqual(sourceUrlList('https://a.test | https://b.test'), ['https://a.test', 'https://b.test']);
});

test('flags persist on an untouched Refresh, and both renders write the extra sheets', async () => {
  const env = makeEnv();
  const reason = 'Synthetic reader could not confirm this item id.';
  async function syntheticLookup(_env, body) {
    if (body.supplier && !body.itemId && !body.name) {
      const pc = String(body.storeClues?.postcode || '').replace(/\s+/g, '');
      if (/rolex/i.test(body.supplier) && /^E14/i.test(pc)) return { candidates: [], branch: { officialStoreName: 'Rolex Canary Wharf', sourceUrls: ['https://synthetic.example/store'] } };
      return { candidates: [], branch: null };
    }
    return {
      candidates: [{
        brand: body.brand || 'Synthetic', officialName: 'Official Synthetic Scarf', itemId: 'OFFICIAL-SYN',
        price: body.price, currency: 'GBP', matchType: 'id', confidence: 'high',
        sourceUrls: ['https://synthetic.example/a', 'https://synthetic.example/b'],
        matchedFields: ['itemId'], onOfficialSite: true, weightGrams: null,
      }],
      cacheHit: false, cacheKey: 'lookup:test', sourcesQueried: ['brave'], flag: '#FDE68A', printedItemId: body.itemId, canonicalBrand: body.brand || null,
    };
  }
  const round1 = await runSanity(env, { batchId: 'persist', mode: 'round1', receipts: [
    {
      receiptKey: 'syn-a', merchant: 'Synthetic Department Store', receiptReference: 'SYN-A',
      date: '2026-04-04', time: '09:30', payment: 'Cash',
      items: [
        { brand: 'Synthetic', item: 'Scarf', itemId: 'SYN-PINK-1', qty: 1, unitPrice: 40, amount: 40, readingFlags: ['品牌货号'], flagReasons: { '品牌货号': reason } },
        { brand: 'Synthetic', item: 'Notebook', itemId: 'SYN-OK-2', qty: 1, unitPrice: 12, amount: 12 },
        { brand: 'Synthetic', item: 'Tissue', qty: 1, unitPrice: 0, amount: 0, zeroConfirmed: true },
      ],
    },
    {
      receiptKey: 'syn-b', merchant: 'Rolex', receiptReference: 'SYN-B',
      date: '2026-04-04', time: '15:00', payment: 'Visa', currency: 'GBP',
      storeClues: { postcode: 'E14 5AB', addressLines: ['1 Canada Square'] },
      items: [{ brand: 'Rolex', item: 'Watch', itemId: 'SYN-W-3', qty: 1, unitPrice: 5000, amount: 5000 }],
    },
  ] }, { lookup: syntheticLookup });
  const pink = round1.result.agreedRows.find(r => r.cells['品牌货号'] === 'SYN-PINK-1');
  const other = round1.result.agreedRows.find(r => r.cells['品牌货号'] === 'SYN-OK-2');
  const supplier = round1.result.agreedRows.find(r => r.cells['品牌货号'] === 'SYN-W-3');
  assert.equal(pink.flags['品牌货号'], PINK);
  assert.equal(supplier.cells['供应商'], 'Rolex Canary Wharf');
  assert.equal(supplier.flags['供应商'], AMBER);
  assert.equal(round1.result.excludedZero.some(z => z.name === 'Tissue'), true);

  const blob1 = await buildV2XlsxBlob(round1.result, { exportKey: '00000000-0000-4000-8000-000000000010' });
  const book1 = await (await sheetXml(blob1)).zip.file('xl/workbook.xml').async('string');
  const flags1 = await (await sheetXml(blob1)).zip.file('xl/worksheets/sheet3.xml').async('string');
  const zeros1 = await (await sheetXml(blob1)).zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(book1, /name="Excluded zero items"/);
  assert.match(book1, /name="Flags"/);
  assert.match(flags1, new RegExp(reason));
  assert.match(flags1, /#FECDD3/);
  assert.match(zeros1, /Tissue/);
  assert.match(flags1, /FF1E4946|s="1"/);

  const planned = await readV2Workbook(blob1);
  const pinkItem = planned.receipts.flatMap(r => r.items).find(it => it.itemId === 'SYN-PINK-1');
  assert.ok(pinkItem.readingFlags.includes('品牌货号'));
  assert.equal(pinkItem.baselineFlags['品牌货号'], PINK);
  assert.deepEqual(planned.receipts.find(r => r.receiptKey === 'syn-b').storeClues.postcode, 'E14 5AB');
  assert.equal(planned.receipts[0].currency, 'GBP');
  const looked = planned.receipts.flatMap(r => r.items).find(it => it.itemId === 'SYN-OK-2');
  assert.equal(looked.baselineConfidence, 'high');
  assert.deepEqual(looked.baselineSourceUrls, ['https://synthetic.example/a', 'https://synthetic.example/b']);

  const round2 = await runSanity(env, round2Body(planned, 'persist'), { lookup: syntheticLookup });
  const pink2 = round2.result.agreedRows.find(r => r.cells['品牌货号'] === 'SYN-PINK-1');
  const other2 = round2.result.agreedRows.find(r => r.rowId === other.rowId);
  const supplier2 = round2.result.agreedRows.find(r => r.rowId === supplier.rowId);
  assert.equal(pink2.flags['品牌货号'], PINK);
  assert.notEqual(pink2.flags['品牌货号'], AMBER);
  assert.equal(pink2.flagReasons['品牌货号'], reason);
  assert.equal(other2.cells['品名'], 'Official Synthetic Scarf');
  assert.equal(supplier2.flags['供应商'], AMBER);
  assert.equal(supplier2.cells['供应商'], 'Rolex Canary Wharf');
  assert.equal(round2.result.excludedZero.some(z => z.name === 'Tissue'), true);

  const blob2 = await buildV2XlsxBlob(round2.result);
  const packed = await sheetXml(blob2);
  const book2 = await packed.zip.file('xl/workbook.xml').async('string');
  const flags2 = await packed.zip.file('xl/worksheets/sheet3.xml').async('string');
  const zeros2 = await packed.zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(book2, /name="Excluded zero items"/);
  assert.match(book2, /name="Flags"/);
  assert.match(flags2, /SYN-PINK-1|品牌货号/);
  assert.match(flags2, /#FECDD3/);
  assert.match(zeros2, /Tissue/);
  const header2 = (await packed.zip.file('xl/worksheets/sheet3.xml').async('string')).match(/<row r="1"[\s\S]*?<\/row>/)[0];
  assert.equal(/s="[3456]"/.test(header2), false);
});
