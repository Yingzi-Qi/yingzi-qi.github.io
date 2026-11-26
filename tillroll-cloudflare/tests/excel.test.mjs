import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeEnv, mockFetch, CATALOGUE, seedCatalogue } from './helpers.mjs';
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
  const holders = result.agreedRows.filter(r => r.cells['品名'] === 'Card Holder');
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
  assert.equal(vca.cells['品牌货号'], null);
  assert.equal(vca.flags['品牌货号'], PINK);
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
  assert.equal(parsed.rows.find(r => r.rowId === chanel.rowId).fills['品名'], undefined);
  assert.equal(parsed.rows.find(r => r.rowId === chanel.rowId).fills['品牌'], AMBER);
  assert.equal(parsed.rows.find(r => r.rowId === vca.rowId).comments['采购商品原价']?.includes('3600'), true);
  assert.equal(STYLE.amber, 3);
  assert.equal(STYLE.pink, 5);
});

test('cleared Pink/Amber fill becomes a lock and is never re-flagged; edits are detected', async () => {
  const env = makeEnv(KEYS);
  const f = mockFetch(CATALOGUE);
  const base = { receiptKey: 'lock1', merchant: 'Harrods', receiptReference: null, date: '2026-11-21', time: '10:00', payment: 'Amex', currency: 'GBP' };
  const r1 = await runSanity(env, { batchId: 'lock', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Chanel Accessory', item: 'mini', itemId: 'A69900', unitPrice: 4950, amount: 4950 }] }] }, { fetchImpl: f, lookup });
  const row = r1.result.agreedRows[0];
  assert.equal(row.flags['采购小票id'], PINK);
  assert.equal(row.flags['品牌'], AMBER);
  assert.equal(row.flags['品名'], undefined);
  const blob = await buildV2XlsxBlob(r1.result, { exportKey: '00000000-0000-4000-8000-000000000002' });
  const { default: JSZip } = await import('../../tillroll/export-vendor/jszip.min.js');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  let xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const pink = xml.match(/<c r="A2"[^>]*s="[56]"/);
  const amber = xml.match(/<c r="D2"[^>]*s="[34]"/);
  assert.ok(pink && amber, xml.slice(0, 800));
  xml = xml.replace(pink[0], pink[0].replace(/s="[56]"/, 's="0"'));
  xml = xml.replace(amber[0], amber[0].replace(/s="[34]"/, 's="0"'));
  xml = xml.replace('Classic Flap Mini Bag', 'Classic Flap Mini Bag edited');
  zip.file('xl/worksheets/sheet1.xml', xml);
  const edited = await zip.generateAsync({ type: 'uint8array' });
  const planned = await readV2Workbook(edited);
  const item = planned.receipts[0].items[0];
  assert.ok(item.clearedCols.includes('采购小票id') && item.clearedCols.includes('品牌'));
  assert.ok(item.editedCols.includes('品名'));
  assert.equal(item.previousItemId, null);
  assert.deepEqual(planned.locks.map(l => l.col).sort(), ['品牌', '采购小票id'].sort());
  const t = new Date().toISOString();
  await env.DB.batch(planned.locks.map(l => env.DB.prepare('INSERT OR IGNORE INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind(l.rowId, l.col, t)));
  const calls = f.calls.gemini;
  const r2 = await runSanity(env, { batchId: 'lock', mode: 'round2', receipts: planned.receipts }, { fetchImpl: f, lookup });
  const again = r2.result.agreedRows[0];
  assert.equal(again.flags['采购小票id'], undefined);
  assert.equal(again.flags['品牌'], undefined);
  assert.equal(again.cells['品名'], 'Classic Flap Mini Bag Edited');
  assert.ok(!again.round2Changed.includes('采购小票id'));
  assert.equal(f.calls.gemini, calls, 'verified brand, name and price with an unedited item id skip look-up');
  const r3 = await runSanity(env, { batchId: 'lock', mode: 'round1', receipts: [{ ...base, items: [{ brand: 'Chanel Accessory', item: 'mini', itemId: 'A69900', unitPrice: 4950, amount: 4950 }] }] }, { fetchImpl: f, lookup });
  assert.equal(r3.result.agreedRows[0].flags['采购小票id'], undefined);
  assert.equal(r3.result.agreedRows[0].flags['品牌'], undefined);
});

test('edited 品牌货号 invalidates the 2dp price-fallback key and re-looks-up; missing exact table entry stays Amber', async () => {
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
  assert.equal(r2.result.agreedRows[0].cells['品名'], 'Gg Marmont Mini Bag');
  assert.equal(r2.result.agreedRows[0].lookup.matchType, 'id');
  assert.ok(r2.result.agreedRows[0].round2Changed.includes('品名'));
  assert.equal(r2.result.agreedRows[0].flags['品名'], undefined);
  const pf = await env.LOOKUP_CACHE.get(keys.pf('Gucci', 'GBP', 1350));
  assert.equal(pf, null);

  const paused = await runSanity(makeEnv(), { batchId: 'pause', mode: 'round1', receipts: [{ receiptKey: 'p', merchant: 'Rolex', receiptReference: 'R1', date: '2026-01-02', time: '09:00', payment: 'Cash', currency: 'GBP', storeClues: { postcode: 'E14 5AB' }, items: [{ brand: 'Rolex', item: 'Datejust', itemId: '126234', unitPrice: 8000, amount: 8000 }] }] });
  const role = paused.result.agreedRows[0];
  // The deterministic sanity path has no branch-name inference. The printed
  // supplier remains visible and any unresolved branch is flagged Amber.
  assert.equal(role.cells['供应商'], 'Rolex');
  assert.equal(role.flags['供应商'], AMBER);
  assert.equal(paused.result.lookupsPaused, undefined);
  assert.equal(role.flags['品名'], AMBER);
  assert.match(role.flagReasons['品名'], /No exact catalogue match/);
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

test('excluded zero sheet keeps 采购小票id and 采购时间 in Sheet 1 format', async () => {
  const env = makeEnv();
  const round1 = await runSanity(env, { batchId: 'zero-cols', mode: 'round1', receipts: [{
    receiptKey: 'syn-z', merchant: 'Synthetic Store', receiptReference: 'SYN-ZERO-9',
    date: '2026-06-15', time: '7:05 pm', payment: 'Cash',
    items: [
      { brand: 'Synthetic', item: 'Pencil', itemId: 'SYN-P', qty: 1, unitPrice: 3, amount: 3 },
      { brand: 'Synthetic', item: 'Paper bag', qty: 1, unitPrice: 0, amount: 0, zeroConfirmed: true },
    ],
  }] });
  const packed1 = await sheetXml(await buildV2XlsxBlob(round1.result));
  const zeros1 = await packed1.zip.file('xl/worksheets/sheet2.xml').async('string');
  const flags1 = await packed1.zip.file('xl/worksheets/sheet3.xml').async('string');
  assert.match(zeros1, /采购小票id/);
  assert.match(zeros1, /采购时间/);
  assert.match(zeros1, /SYN-ZERO-9/);
  assert.match(zeros1, /2026-06-15 19:05:00/);
  assert.match(zeros1, /Paper bag/);
  assert.match(flags1, /Tillroll receipt key/);
  assert.match(flags1, />Value</);
  const planned = await readV2Workbook(await buildV2XlsxBlob(round1.result));
  const zero = planned.excludedZero.find(z => z.name === 'Paper bag');
  assert.equal(zero.receiptId, 'SYN-ZERO-9');
  assert.equal(zero.purchaseTime, '2026-06-15 19:05:00');
  const round2 = await runSanity(env, round2Body(planned, 'zero-cols'));
  const zeros2 = await (await sheetXml(await buildV2XlsxBlob(round2.result))).zip.file('xl/worksheets/sheet2.xml').async('string');
  assert.match(zeros2, /SYN-ZERO-9/);
  assert.match(zeros2, /2026-06-15 19:05:00/);
  const again = await readV2Workbook(await buildV2XlsxBlob(round2.result));
  const zero2 = again.excludedZero.find(z => z.name === 'Paper bag');
  assert.equal(zero2.receiptId, 'SYN-ZERO-9');
  assert.equal(zero2.purchaseTime, '2026-06-15 19:05:00');
});

test('strict receipt gate evidence survives workbook round-trip into Round 2', async () => {
  const evidence = {
    layout: 'chanel-boutique', layoutStatus: 'known', parserReasons: [],
    total: 100, itemCountCheck: { printed: 1, exported: 1, passed: true },
    receiptId: 'SYN-REF-01', imageLink: 'synthetic://receipt-1', sha256: 'synthetic-hash-1',
    sourceLines: [3, 4],
  };
  const row = {
    rowId: 'strict-1:0:u0', receiptKey: 'strict-1', flags: {},
    cells: {
      '采购小票id': 'SYN-REF-01', '采购时间': '2026-04-03 14:00:00',
      '供应商': 'Chanel', '品牌': 'Chanel', '品名': 'Synthetic Tote',
      '品牌货号': 'AS1234', '采购商品原价': 100, '采购商品金额': 100,
      '采购商品方法': 'Card', '销售金额': 88,
    },
    exportMeta: { currency: 'GBP', receiptEvidence: evidence },
  };
  const blob = await buildV2XlsxBlob({ exportableRows: [row] });
  const planned = await readV2Workbook(blob);
  const body = round2Body(planned, 'strict-round2');
  const receipt = body.receipts[0];
  assert.equal(receipt.layout, evidence.layout);
  assert.equal(receipt.layoutStatus, evidence.layoutStatus);
  assert.equal(receipt.gateRequired, true);
  assert.equal(receipt.total, 100);
  assert.deepEqual(receipt.itemCountCheck, evidence.itemCountCheck);
  assert.equal(receipt.imageLink, evidence.imageLink);
  assert.equal(receipt.sha256, evidence.sha256);
  assert.deepEqual(receipt.items[0].sourceLines, evidence.sourceLines);

  const env = seedCatalogue(makeEnv(), [{
    brand: 'Chanel', itemId: 'AS1234', officialName: 'Synthetic Tote', price: 100,
    sourceUrl: 'https://catalogue.synthetic.example/AS1234',
  }]);
  const { result } = await runSanity(env, body);
  assert.equal(result.receiptGates[0].status, 'pass');
  assert.equal(result.workbookExportReady, true);
});

test('P4: 采购商品方法 is UnionPay, Card, Alipay or WeChat; anything else is Pink', async () => {
  const env = makeEnv();
  const base = { merchant: 'Synthetic Store', date: '2026-07-01', time: '10:00', currency: 'GBP', items: [{ brand: 'Synthetic', item: 'Pencil', itemId: 'SYN-P4', unitPrice: 4, amount: 4 }] };
  const { result } = await runSanity(env, { batchId: 'p4', mode: 'round1', receipts: [
    { ...base, receiptKey: 'p4-visa', receiptReference: 'P4-VISA', payment: 'Visa' },
    { ...base, receiptKey: 'p4-ali', receiptReference: 'P4-ALI', payment: 'Alipay' },
    { ...base, receiptKey: 'p4-wx', receiptReference: 'P4-WX', payment: 'WeChat Pay' },
    { ...base, receiptKey: 'p4-up', receiptReference: 'P4-UP', payment: 'UnionPay' },
    { ...base, receiptKey: 'p4-cash', receiptReference: 'P4-CASH', payment: 'Cash' },
    { ...base, receiptKey: 'p4-empty', receiptReference: 'P4-EMPTY', payment: '' },
  ] });
  const byId = Object.fromEntries(result.agreedRows.map(r => [r.cells['采购小票id'], r]));
  for (const [id, value] of [['P4-VISA', 'Card'], ['P4-ALI', 'Alipay'], ['P4-WX', 'Wechat'], ['P4-UP', 'Unionpay']]) {
    assert.equal(byId[id].cells['采购商品方法'], value);
    assert.equal(byId[id].flags['采购商品方法'], undefined);
  }
  assert.equal(byId['P4-CASH'].cells['采购商品方法'], 'Cash');
  assert.equal(byId['P4-CASH'].flags['采购商品方法'], PINK);
  assert.match(byId['P4-CASH'].flagReasons['采购商品方法'], /UnionPay, Card, Alipay or WeChat/);
  assert.match(byId['P4-CASH'].exportMeta.comments['采购商品方法'], /UnionPay, Card, Alipay or WeChat/);
  assert.equal(byId['P4-EMPTY'].cells['采购商品方法'], null);
  assert.equal(byId['P4-EMPTY'].flags['采购商品方法'], PINK);
});

test('P5: exact item id and price leave 品名 unfilled; partial and fallback stay Amber', async () => {
  const env = makeEnv();
  await env.DB.prepare('INSERT INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind('p5-lock', '品名', '2026-11-25T17:45:00.000Z').run();
  const hit = (itemId, price, matchType, name) => ({
    candidates: [{ brand: 'Synthetic', officialName: name, itemId, price, currency: 'GBP', matchType, confidence: 0.9, sourceUrls: ['https://synthetic.example/p'], matchedFields: ['itemId', 'price'], onOfficialSite: true, weightGrams: null }],
    cacheHit: false, cacheKey: 'k', sourcesQueried: ['brave'], flag: '#FDE68A', printedItemId: itemId, canonicalBrand: 'Synthetic',
  });
  const lookup = async (_env, body) => {
    if (body.supplier && !body.itemId) return { candidates: [], branch: null };
    if (body.itemId === 'SYN-EXACT') return hit('SYN-EXACT', 100, 'id', 'Official Exact Coat');
    if (body.itemId === 'SYN-PART') return hit('SYN-PART', 80, 'id', 'Official Partial Coat');
    if (body.itemId === 'SYN-FB') return hit('SYN-OTHER', 50, 'price-fallback', 'Fallback Coat');
    if (body.itemId === 'SYN-LOCK') return hit('SYN-LOCK', 100, 'id', 'Should Not Replace');
    return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
  };
  const { result } = await runSanity(env, { batchId: 'p5', mode: 'round1', receipts: [{
    receiptKey: 'p5', merchant: 'Synthetic Store', receiptReference: 'P5-1', date: '2026-07-02', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'p5-exact', brand: 'Synthetic', item: 'Coat', itemId: 'SYN-EXACT', unitPrice: 100, amount: 100, readingFlags: ['采购小票id'] },
      { rowId: 'p5-part', brand: 'Synthetic', item: 'Coat', itemId: 'SYN-PART', unitPrice: 100, amount: 100 },
      { rowId: 'p5-fb', brand: 'Synthetic', item: 'Coat', itemId: 'SYN-FB', unitPrice: 50, amount: 50 },
      { rowId: 'p5-lock', brand: 'Synthetic', item: 'Locked Name', itemId: 'SYN-LOCK', unitPrice: 100, amount: 100 },
    ],
  }] }, { lookup });
  const exact = result.agreedRows.find(r => r.rowId === 'p5-exact');
  const part = result.agreedRows.find(r => r.rowId === 'p5-part');
  const fb = result.agreedRows.find(r => r.rowId === 'p5-fb');
  const locked = result.agreedRows.find(r => r.rowId === 'p5-lock');
  assert.equal(exact.cells['品名'], 'Official Exact Coat');
  assert.equal(exact.flags['品名'], undefined);
  assert.equal(exact.flags['采购小票id'], PINK);
  assert.equal(part.flags['品名'], AMBER);
  assert.equal(fb.flags['品名'], AMBER);
  assert.equal(fb.lookup.matchType, 'price-fallback');
  assert.equal(locked.cells['品名'], 'Locked Name');
  assert.equal(locked.flags['品名'], undefined);
});

test('P1: 品牌货号 prefers a style reference over an EAN or concession code', async () => {
  const env = makeEnv();
  const lookup = async (_env, body) => {
    if (body.itemId === '5012345678901') return { candidates: [{ brand: 'Synthetic', officialName: 'Style Bag', itemId: 'ST-88', price: 20, currency: 'GBP', matchType: 'multi-field', confidence: 0.7, sourceUrls: ['https://synthetic.example/st'], matchedFields: ['name'], onOfficialSite: true, weightGrams: null }], cacheHit: false, cacheKey: 'ean', sourcesQueried: ['brave'], printedItemId: body.itemId, canonicalBrand: 'Synthetic' };
    if (body.itemId === '9999999001') return { candidates: [{ brand: 'Synthetic', officialName: 'Concession Scarf', itemId: '9999999001', price: 15, currency: 'GBP', matchType: 'price-fallback', confidence: 0.4, sourceUrls: ['https://synthetic.example/cc'], matchedFields: [], onOfficialSite: false, weightGrams: null }], cacheHit: false, cacheKey: 'cc', sourcesQueried: ['brave'], printedItemId: body.itemId, canonicalBrand: 'Synthetic' };
    return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
  };
  const { result } = await runSanity(env, { batchId: 'p1', mode: 'round1', receipts: [{
    receiptKey: 'p1', merchant: 'Synthetic Store', receiptReference: 'P1-1', date: '2026-07-03', time: '12:00', payment: 'Card', currency: 'GBP',
    items: [
      { brand: 'Synthetic', item: 'Bag', itemId: '5012345678901', ean: '5012345678901', sku: 'ST-88', unitPrice: 20, amount: 20 },
      { brand: 'Synthetic', item: 'Scarf', itemId: '9999999001', unitPrice: 15, amount: 15 },
    ],
  }] }, { lookup });
  const ean = result.agreedRows.find(r => r.cells['品名'] === 'Style Bag');
  const concession = result.agreedRows.find(r => r.cells['品名'] === 'Concession Scarf');
  assert.equal(ean.cells['品牌货号'], 'ST-88');
  assert.equal(ean.flags['品牌货号'], AMBER);
  assert.match(ean.exportMeta.comments['品牌货号'], /5012345678901/);
  assert.equal(ean.exportMeta.alternates['品牌货号'].official, 'ST-88');
  assert.equal(ean.exportMeta.alternates['品牌货号'].receipt, '5012345678901');
  assert.equal(concession.cells['品牌货号'], null);
  assert.equal(concession.flags['品牌货号'], PINK);
  assert.equal(concession.flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(concession.exportMeta.comments['品牌货号'], /9999999001/);
  assert.match(concession.exportMeta.comments['品牌货号'], /no brand item ID printed/);
  assert.equal(concession.exportMeta.alternates['品牌货号'].receipt, '9999999001');
  assert.equal(concession.exportMeta.alternates['品牌货号'].shown, 'receipt');
});

test('1a: Visa, Mastercard, Amex, Maestro, debit and credit map to Card with no fill', async () => {
  const env = makeEnv();
  const base = { merchant: 'Synthetic Store', date: '2026-07-05', time: '10:00', currency: 'GBP', items: [{ brand: 'Synthetic', item: 'Pencil', itemId: 'SYN-1A', unitPrice: 4, amount: 4 }] };
  const payments = [['Visa', '1A-VISA'], ['Mastercard', '1A-MC'], ['Amex', '1A-AMEX'], ['Maestro', '1A-MAESTRO'], ['Debit', '1A-DEBIT'], ['Credit', '1A-CREDIT']];
  const { result } = await runSanity(env, { batchId: '1a', mode: 'round1', receipts: payments.map(([payment, id]) => ({ ...base, receiptKey: id, receiptReference: id, payment })) });
  for (const row of result.agreedRows) {
    assert.equal(row.cells['采购商品方法'], 'Card');
    assert.equal(row.flags['采购商品方法'], undefined);
    assert.equal(row.exportMeta.comments['采购商品方法'], undefined);
    assert.equal(row.exportMeta.pendingOwnerConfirmation, null);
  }
});

test('1b: a wallet with no printed scheme is Card with no fill; cash and an empty tender stay Pink', async () => {
  const env = makeEnv();
  const base = { merchant: 'Synthetic Store', date: '2026-07-06', time: '10:00', currency: 'GBP', items: [{ brand: 'Synthetic', item: 'Pencil', itemId: 'SYN-1B', unitPrice: 4, amount: 4 }] };
  const { result } = await runSanity(env, { batchId: '1b', mode: 'round1', receipts: [
    { ...base, receiptKey: '1b-apple', receiptReference: '1B-APPLE', payment: 'Apple Pay' },
    { ...base, receiptKey: '1b-google', receiptReference: '1B-GOOGLE', payment: 'Google Pay' },
    { ...base, receiptKey: '1b-visa', receiptReference: '1B-VISA', payment: 'VISA CONTACTLESS Apple Pay' },
    { ...base, receiptKey: '1b-cash', receiptReference: '1B-CASH', payment: 'Cash' },
    { ...base, receiptKey: '1b-empty', receiptReference: '1B-EMPTY', payment: '' },
  ] });
  const byId = Object.fromEntries(result.agreedRows.map(r => [r.cells['采购小票id'], r]));
  for (const id of ['1B-APPLE', '1B-GOOGLE']) {
    assert.equal(byId[id].cells['采购商品方法'], 'Card');
    assert.equal(byId[id].flags['采购商品方法'], undefined);
    assert.equal(byId[id].exportMeta.comments['采购商品方法'], undefined);
    assert.equal(byId[id].flagReasons['采购商品方法'], undefined);
    assert.equal(byId[id].exportMeta.pendingOwnerConfirmation, null);
  }
  assert.equal(byId['1B-VISA'].cells['采购商品方法'], 'Card');
  assert.equal(byId['1B-VISA'].flags['采购商品方法'], undefined);
  assert.equal(byId['1B-VISA'].exportMeta.pendingOwnerConfirmation, null);
  assert.equal(byId['1B-CASH'].cells['采购商品方法'], 'Cash');
  assert.equal(byId['1B-CASH'].flags['采购商品方法'], PINK);
  assert.match(byId['1B-CASH'].flagReasons['采购商品方法'], /UnionPay, Card, Alipay or WeChat/);
  assert.equal(byId['1B-CASH'].exportMeta.pendingOwnerConfirmation, null);
  assert.equal(byId['1B-EMPTY'].cells['采购商品方法'], null);
  assert.equal(byId['1B-EMPTY'].flags['采购商品方法'], PINK);
  const blob = await buildV2XlsxBlob(result);
  const parsed = await readV2Workbook(blob);
  const apple = parsed.rows.find(r => r.values['采购小票id'] === '1B-APPLE');
  assert.equal(apple.values['采购商品方法'], 'Card');
  assert.equal(apple.fills['采购商品方法'], undefined);
  assert.equal(apple.comments['采购商品方法'], undefined);
  assert.equal(apple.baseline.pendingOwnerConfirmation, null);
});

test('2: a concession code never stays in 品牌货号; an official id, an EAN and a printed style ref follow the look-up', async () => {
  const env = makeEnv();
  const hit = (itemId, matchType, name, price) => ({
    candidates: [{ brand: 'Synthetic', officialName: name, itemId, price, currency: 'GBP', matchType, confidence: 0.8, sourceUrls: ['https://synthetic.example/id'], matchedFields: matchType === 'id' ? ['itemId'] : [], onOfficialSite: matchType !== 'price-fallback', weightGrams: matchType === 'price-fallback' ? 100 : null }],
    cacheHit: false, cacheKey: itemId, sourcesQueried: ['brave'], printedItemId: itemId, canonicalBrand: 'Synthetic',
  });
  const lookup = async (_env, body) => {
    if (body.itemId === '9999999100') return hit('BR-100', 'id', 'Official Coat', 30);
    if (body.itemId === '9999999200') return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
    if (body.itemId === '4000000000037') return { candidates: [], cacheHit: false, cacheKey: 'ean-only', sourcesQueried: [] };
    if (body.itemId === 'SYN-STYLE') return hit('SYN-STYLE', 'id', 'Printed Style', 40);
    if (body.itemId === 'SYN-PF') return hit('OFF-99', 'price-fallback', 'Guessed Coat', 40);
    if (body.itemId === '9999999300') return hit('BR-55', 'price-fallback', 'Fallback Coat', 22);
    return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
  };
  const { result } = await runSanity(env, { batchId: 'id2', mode: 'round1', receipts: [{
    receiptKey: 'id2', merchant: 'Synthetic Store', receiptReference: 'ID2', date: '2026-07-07', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'id-official', brand: 'Synthetic', item: 'Coat', itemId: '9999999100', unitPrice: 30, amount: 30 },
      { rowId: 'id-none', brand: 'Synthetic', item: 'Scarf', itemId: '9999999200', unitPrice: 12, amount: 12 },
      { rowId: 'id-ean', brand: 'Synthetic', item: 'Soap', itemId: '4000000000037', ean: '4000000000037', unitPrice: 5, amount: 5 },
      { rowId: 'id-style', brand: 'Synthetic', item: 'Printed Style', itemId: 'SYN-STYLE', unitPrice: 40, amount: 40 },
      { rowId: 'id-pf-style', brand: 'Synthetic', item: 'Bag', itemId: 'SYN-PF', unitPrice: 40, amount: 40 },
      { rowId: 'id-pf-cc', brand: 'Synthetic', item: 'Hat', itemId: '9999999300', unitPrice: 22, amount: 22 },
    ],
  }] }, { lookup });
  const by = Object.fromEntries(result.agreedRows.map(r => [r.rowId, r]));
  assert.equal(by['id-official'].cells['品牌货号'], 'BR-100');
  assert.equal(by['id-official'].flags['品牌货号'], AMBER);
  assert.match(by['id-official'].exportMeta.comments['品牌货号'], /9999999100/);
  assert.equal(by['id-official'].exportMeta.alternates['品牌货号'].receipt, '9999999100');
  assert.doesNotMatch(String(by['id-official'].cells['品牌货号']), /9999999/);
  assert.equal(by['id-none'].cells['品牌货号'], null);
  assert.equal(by['id-none'].flags['品牌货号'], PINK);
  assert.equal(by['id-none'].flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(by['id-none'].exportMeta.comments['品牌货号'], /9999999200/);
  assert.equal(by['id-none'].exportMeta.alternates['品牌货号'].receipt, '9999999200');
  assert.equal(by['id-ean'].cells['品牌货号'], '4000000000037');
  assert.equal(by['id-ean'].exportMeta.comments['品牌货号'], 'Only an EAN is available; the brand item id was not found.');
  assert.equal(by['id-ean'].flags['品牌货号'], AMBER);
  assert.equal(by['id-style'].cells['品牌货号'], 'SYN-STYLE');
  assert.equal(by['id-style'].flags['品牌货号'], undefined);
  assert.equal(by['id-pf-style'].cells['品牌货号'], 'SYN-PF');
  assert.equal(by['id-pf-style'].flags['品牌货号'], AMBER);
  assert.match(by['id-pf-style'].exportMeta.comments['品牌货号'], /OFF-99/);
  assert.match(by['id-pf-style'].exportMeta.comments['品牌货号'], /Candidates/);
  assert.equal(by['id-pf-cc'].cells['品牌货号'], 'BR-55');
  assert.equal(by['id-pf-cc'].flags['品牌货号'], AMBER);
  assert.match(by['id-pf-cc'].exportMeta.comments['品牌货号'], /9999999300/);
  assert.match(by['id-pf-cc'].exportMeta.comments['品牌货号'], /Candidates/);
  assert.equal(by['id-pf-cc'].exportMeta.alternates['品牌货号'].official, 'BR-55');
});

test("P6: Chanel confirmed only on chanel.cn or chanel.com/gb gets the blocked-site comment", async () => {
  const env = makeEnv();
  const row = (itemId, name, official, urls) => ({
    candidates: [{ brand: 'Chanel', officialName: official, itemId, price: 10, currency: 'GBP', matchType: 'id', confidence: 0.95, sourceUrls: urls, matchedFields: ['itemId', 'price'], onOfficialSite: true, weightGrams: null }],
    cacheHit: false, cacheKey: itemId, sourcesQueried: ['brave'], printedItemId: itemId, canonicalBrand: 'Chanel',
  });
  const lookup = async (_env, body) => {
    if (body.itemId === 'CH-SAME') return row('CH-SAME', 'Coat', 'Coat', ['https://www.chanel.cn/zh/p/CH-SAME']);
    if (body.itemId === 'CH-DIFF') return row('CH-DIFF', 'Coat', 'Classic Coat', ['https://www.chanel.com/gb/fashion/p/CH-DIFF']);
    if (body.itemId === 'CH-FR') return row('CH-FR', 'Coat', 'Coat', ['https://www.chanel.com/fr/mode/p/CH-FR']);
    return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
  };
  const { result } = await runSanity(env, { batchId: 'p6', mode: 'round1', receipts: [{
    receiptKey: 'p6', merchant: 'Synthetic Store', receiptReference: 'P6-1', date: '2026-07-04', time: '13:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'p6-same', brand: 'Chanel', item: 'Coat', itemId: 'CH-SAME', unitPrice: 10, amount: 10 },
      { rowId: 'p6-diff', brand: 'Chanel', item: 'Short', itemId: 'CH-DIFF', unitPrice: 10, amount: 10 },
      { rowId: 'p6-fr', brand: 'Chanel', item: 'Coat', itemId: 'CH-FR', unitPrice: 10, amount: 10 },
    ],
  }] }, { lookup });
  const same = result.agreedRows.find(r => r.rowId === 'p6-same');
  const diff = result.agreedRows.find(r => r.rowId === 'p6-diff');
  const fr = result.agreedRows.find(r => r.rowId === 'p6-fr');
  assert.equal(same.exportMeta.comments['品名'], 'chanel.com blocked; confirmed on chanel.cn/gb');
  assert.match(diff.exportMeta.comments['品名'], /Receipt printed: Short/);
  assert.match(diff.exportMeta.comments['品名'], /chanel.com blocked; confirmed on chanel.cn\/gb/);
  assert.equal(fr.exportMeta.comments['品名'], undefined);
});

const noLookup = async () => ({ candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] });

test('Harrods 4+10 concession code stays out of 品牌货号; 000001 stays a style ref', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'h4', mode: 'round1', receipts: [{
    receiptKey: 'h4', merchant: 'Harrods', receiptReference: 'H4-1', date: '2026-07-08', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'h-pair', brand: 'Synthetic', item: 'Coat', styleRef: 'AB12', concessionCode: '2574', internalCode: '1234567890', unitPrice: 40, amount: 40 },
      { rowId: 'h-style', brand: 'Synthetic', item: 'Belt', styleRef: '000001', unitPrice: 40, amount: 40 },
    ],
  }] }, { lookup: noLookup });
  const pair = result.agreedRows.find(r => r.rowId === 'h-pair');
  const style = result.agreedRows.find(r => r.rowId === 'h-style');
  assert.equal(pair.cells['品牌货号'], 'AB12');
  assert.doesNotMatch(String(pair.cells['品牌货号']), /2574|1234567890/);
  assert.match(pair.exportMeta.comments['品牌货号'], /2574/);
  assert.match(pair.exportMeta.comments['品牌货号'], /1234567890/);
  assert.match(pair.exportMeta.alternates['品牌货号'].receipt, /2574/);
  assert.match(pair.exportMeta.alternates['品牌货号'].receipt, /1234567890/);
  assert.equal(style.cells['品牌货号'], '000001');
  assert.notEqual(style.flagReasons['品牌货号'], 'no brand item ID printed');
});

test('a reader concessionCode label never stays in the 品牌货号 cell', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'cc', mode: 'round1', receipts: [{
    receiptKey: 'cc', merchant: 'Synthetic Store', receiptReference: 'CC-1', date: '2026-07-08', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'cc-only', brand: 'Synthetic', item: 'Scarf', itemId: 'DEPT-77', concessionCode: 'DEPT-77', unitPrice: 15, amount: 15 },
      { rowId: 'cc-keep', brand: 'Synthetic', item: 'Hat', itemId: 'ST-KEEP', concessionCode: '2574', internalCode: '1234567890', unitPrice: 15, amount: 15 },
    ],
  }] }, { lookup: noLookup });
  const only = result.agreedRows.find(r => r.rowId === 'cc-only');
  const keep = result.agreedRows.find(r => r.rowId === 'cc-keep');
  assert.equal(only.cells['品牌货号'], null);
  assert.equal(only.flags['品牌货号'], PINK);
  assert.equal(only.flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(only.exportMeta.comments['品牌货号'], /DEPT-77/);
  assert.match(only.exportMeta.alternates['品牌货号'].receipt, /DEPT-77/);
  assert.equal(keep.cells['品牌货号'], 'ST-KEEP');
  assert.match(keep.exportMeta.comments['品牌货号'], /2574/);
  assert.match(keep.exportMeta.comments['品牌货号'], /1234567890/);
  assert.doesNotMatch(String(keep.cells['品牌货号']), /2574|1234567890/);
});

test('gate (a): an empty 品牌 that look-up did not fill is Pink, reason Brand not read', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'ga', mode: 'round1', receipts: [{
    receiptKey: 'ga', merchant: 'Synthetic Store', receiptReference: 'GA-1', date: '2026-07-09', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [{ rowId: 'ga-1', brand: null, item: 'Pencil', itemId: 'SYN-GA', unitPrice: 4, amount: 4 }],
  }] }, { lookup: noLookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌'], null);
  assert.equal(row.flags['品牌'], PINK);
  assert.equal(row.flagReasons['品牌'], 'Brand not read');
  assert.equal(row.cells['品名'], 'Pencil');
  assert.notEqual(row.flagReasons['品名'], 'Name needs checking');
});

test('gate (b): a name that still holds a brand, a code, or no product word is Pink and unchanged', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'gb', mode: 'round1', receipts: [{
    receiptKey: 'gb', merchant: 'Synthetic Store', receiptReference: 'GB-1', date: '2026-07-09', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'gb-alias', brand: 'Dior', item: 'Christian Dior Saddle', itemId: 'SYN-GB1', unitPrice: 10, amount: 10 },
      { rowId: 'gb-empty', brand: null, item: 'Christian Dior Book', itemId: 'SYN-GB2', unitPrice: 10, amount: 10 },
      { rowId: 'gb-cc', brand: 'Dior', item: 'Saddle 9999999001', itemId: 'SYN-GB3', unitPrice: 10, amount: 10 },
      { rowId: 'gb-ean', brand: 'Dior', item: 'Saddle 5012345678901', itemId: 'SYN-GB4', unitPrice: 10, amount: 10 },
      { rowId: 'gb-digits', brand: 'Dior', item: 'Saddle 123456', itemId: 'SYN-GB5', unitPrice: 10, amount: 10 },
      { rowId: 'gb-only', brand: 'Dior', item: 'Christian Dior', itemId: 'SYN-GB6', unitPrice: 10, amount: 10 },
      { rowId: 'gb-ok', brand: 'Dior', item: 'Saddle bag', itemId: 'SYN-GB7', unitPrice: 10, amount: 10 },
    ],
  }] }, { lookup: noLookup });
  const by = Object.fromEntries(result.agreedRows.map(r => [r.rowId, r]));
  for (const [id, name] of [['gb-alias', 'Christian Dior Saddle'], ['gb-empty', 'Christian Dior Book'], ['gb-cc', 'Saddle 9999999001'], ['gb-ean', 'Saddle 5012345678901'], ['gb-digits', 'Saddle 123456'], ['gb-only', 'Christian Dior']]) {
    assert.equal(by[id].cells['品名'], name);
    assert.equal(by[id].flags['品名'], PINK);
    assert.match(by[id].flagReasons['品名'], /Name needs checking/);
    assert.match(by[id].exportMeta.comments['品名'], /Name needs checking/);
  }
  assert.equal(by['gb-ok'].cells['品名'], 'Saddle Bag');
  assert.notEqual(by['gb-ok'].flagReasons['品名'], 'Name needs checking');
});

test('gate (c): a non-numeric price is empty, Pink, and never inline text', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'gc', mode: 'round1', receipts: [{
    receiptKey: 'gc', merchant: 'Synthetic Store', receiptReference: 'GC-1', date: '2026-07-09', time: '12:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'gc-bad', brand: 'Synthetic', item: 'Pencil', itemId: 'SYN-GC', unitPrice: 'twelve', amount: 'n/a' },
      { rowId: 'gc-ok', brand: 'Synthetic', item: 'Pen', itemId: 'SYN-GC2', unitPrice: 10, amount: 10 },
      { rowId: 'gc-pound', brand: 'Synthetic', item: 'Ink', itemId: 'SYN-GC3', unitPrice: '£12.00', amount: 12 },
    ],
  }] }, { lookup: noLookup });
  const bad = result.agreedRows.find(r => r.rowId === 'gc-bad');
  const ok = result.agreedRows.find(r => r.rowId === 'gc-ok');
  const pound = result.agreedRows.find(r => r.rowId === 'gc-pound');
  for (const col of ['采购商品原价', '采购商品金额', '销售金额']) {
    assert.equal(bad.cells[col], null);
    assert.equal(bad.flags[col], PINK);
    assert.equal(bad.flagReasons[col], 'Price not numeric');
  }
  assert.match(bad.exportMeta.comments['采购商品原价'], /twelve/);
  assert.match(bad.exportMeta.alternates['采购商品原价'].receipt, /twelve/);
  assert.match(bad.exportMeta.comments['采购商品金额'], /n\/a/);
  assert.equal(ok.cells['采购商品原价'], 10);
  assert.equal(ok.cells['销售金额'], 8.8);
  assert.notEqual(ok.flagReasons['采购商品原价'], 'Price not numeric');
  assert.equal(pound.cells['采购商品原价'], 12);
  assert.notEqual(pound.flagReasons['采购商品原价'], 'Price not numeric');
  const { sheet, comments } = await sheetXml(await buildV2XlsxBlob(result));
  const badRow = sheet.match(/<row r="2"[\s\S]*?<\/row>/)[0];
  for (const col of ['G', 'H', 'J']) {
    const cell = badRow.match(new RegExp(`<c r="${col}2"[\\s\\S]*?(?:/>|<\\/c>)`))[0];
    assert.equal(cell.includes('inlineStr'), false, col);
    assert.equal(cell.includes('twelve'), false, col);
    assert.equal(cell.includes('n/a'), false, col);
  }
  assert.match(comments, /twelve/);
});

test('gate (d): a human_verified_unflagged cell is not re-flagged by the gate', async () => {
  const env = makeEnv();
  const verified = '2026-11-25T17:51:00.000Z';
  for (const col of ['品牌', '品名', '采购商品原价']) {
    await env.DB.prepare('INSERT INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind('gate-locked', col, verified).run();
  }
  const { result } = await runSanity(env, { batchId: 'gd', mode: 'round1', receipts: [{
    receiptKey: 'gd', merchant: 'Synthetic Store', receiptReference: 'GD-1', date: '2026-07-09', time: '13:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'gate-locked', brand: null, item: 'Christian Dior Saddle', itemId: 'SYN-GD', unitPrice: 'twelve', amount: 10 },
      { rowId: 'gate-open', brand: null, item: 'Pencil', itemId: 'SYN-GD2', unitPrice: 4, amount: 4 },
    ],
  }] }, { lookup: noLookup });
  const locked = result.agreedRows.find(r => r.rowId === 'gate-locked');
  const open = result.agreedRows.find(r => r.rowId === 'gate-open');
  assert.equal(locked.cells['品牌'], null);
  assert.equal(locked.cells['品名'], 'Christian Dior Saddle');
  assert.equal(locked.flags['品牌'], undefined);
  assert.equal(locked.flags['品名'], undefined);
  assert.equal(locked.flags['采购商品原价'], undefined);
  assert.equal(locked.flagReasons['品牌'], undefined);
  assert.equal(locked.flagReasons['品名'], undefined);
  assert.equal(locked.flagReasons['采购商品原价'], undefined);
  assert.equal(open.flags['品牌'], PINK);
  assert.equal(open.flagReasons['品牌'], 'Brand not read');
});

test('an unlabelled numeric-only 10-digit id stays out of 品牌货号 unless the format hook or look-up fills it', async () => {
  const env = makeEnv();
  const lookup = async (_env, body) => {
    if (body.itemId === '1234567890') return { candidates: [{ brand: 'Synthetic', officialName: 'Official Coat', itemId: 'BR-10', price: 30, currency: 'GBP', matchType: 'id', confidence: 0.8, sourceUrls: ['https://synthetic.example/ten'], matchedFields: ['itemId'], onOfficialSite: true, weightGrams: null }], cacheHit: false, cacheKey: 'ten', sourcesQueried: ['brave'], printedItemId: body.itemId, canonicalBrand: 'Synthetic' };
    return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
  };
  const { result } = await runSanity(env, { batchId: 'ten', mode: 'round1', receipts: [{
    receiptKey: 'ten', merchant: 'Synthetic Store', receiptReference: 'TEN-1', date: '2026-07-10', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'ten-none', brand: 'Synthetic', item: 'Scarf', itemId: '2222222222', unitPrice: 12, amount: 12 },
      { rowId: 'ten-fill', brand: 'Synthetic', item: 'Coat', itemId: '1234567890', unitPrice: 30, amount: 30 },
      { rowId: 'ten-style', brand: 'Synthetic', item: 'Belt', styleRef: '000001', unitPrice: 40, amount: 40 },
    ],
  }] }, { lookup });
  const none = result.agreedRows.find(r => r.rowId === 'ten-none');
  const fill = result.agreedRows.find(r => r.rowId === 'ten-fill');
  const style = result.agreedRows.find(r => r.rowId === 'ten-style');
  assert.equal(none.cells['品牌货号'], null);
  assert.equal(none.flags['品牌货号'], PINK);
  assert.equal(none.flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(none.exportMeta.comments['品牌货号'], /2222222222/);
  assert.match(none.exportMeta.alternates['品牌货号'].receipt, /2222222222/);
  assert.equal(fill.cells['品牌货号'], 'BR-10');
  assert.equal(fill.flags['品牌货号'], AMBER);
  assert.match(fill.exportMeta.comments['品牌货号'], /1234567890/);
  assert.equal(style.cells['品牌货号'], '000001');
  const matched = await runSanity(env, { batchId: 'ten-fmt', mode: 'round1', receipts: [{
    receiptKey: 'ten-fmt', merchant: 'Synthetic Store', receiptReference: 'TEN-FMT', date: '2026-07-10', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [{ rowId: 'ten-fmt', brand: 'Synthetic', item: 'Clip', itemId: '1111111111', unitPrice: 8, amount: 8 }],
  }] }, { lookup: noLookup, brandIdFormat: (brand, value) => (brand === 'Synthetic' && value === '1111111111' ? 'synthetic' : 'no match') });
  const kept = matched.result.agreedRows[0];
  assert.equal(kept.cells['品牌货号'], null);
  assert.equal(kept.flags['品牌货号'], PINK);
});

test('short brand aliases pink only at the start or end, and not inside the look-up official name', async () => {
  const env = makeEnv();
  const lookup = async (_env, body) => {
    if (body.itemId !== 'SYN-OFF') return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
    return { candidates: [{ brand: 'MAC', officialName: 'MAC Rouge Coco', itemId: 'SYN-OFF', price: 20, currency: 'GBP', matchType: 'id', confidence: 0.95, sourceUrls: ['https://synthetic.example/mac'], matchedFields: ['itemId', 'price'], onOfficialSite: true, weightGrams: null }], cacheHit: false, cacheKey: 'mac', sourcesQueried: ['brave'], printedItemId: body.itemId, canonicalBrand: 'MAC' };
  };
  const { result } = await runSanity(env, { batchId: 'alias', mode: 'round1', receipts: [{
    receiptKey: 'alias', merchant: 'Synthetic Store', receiptReference: 'AL-1', date: '2026-07-11', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'al-start', brand: null, item: 'MAC lipstick', itemId: 'SYN-A1', unitPrice: 20, amount: 20 },
      { rowId: 'al-mid', brand: null, item: 'Big Mac print tee', itemId: 'SYN-A2', unitPrice: 20, amount: 20 },
      { rowId: 'al-official', brand: null, item: 'lipstick', itemId: 'SYN-OFF', unitPrice: 20, amount: 20 },
    ],
  }] }, { lookup });
  const start = result.agreedRows.find(r => r.rowId === 'al-start');
  const mid = result.agreedRows.find(r => r.rowId === 'al-mid');
  const official = result.agreedRows.find(r => r.rowId === 'al-official');
  assert.equal(start.cells['品名'], 'Mac Lipstick');
  assert.equal(start.flags['品名'], PINK);
  assert.match(start.flagReasons['品名'], /Name needs checking/);
  assert.equal(mid.cells['品名'], 'Big Mac Print Tee');
  assert.notEqual(mid.flagReasons['品名'], undefined);
  assert.doesNotMatch(String(mid.flagReasons['品名'] || ''), /Name needs checking/);
  assert.equal(official.cells['品名'], 'Mac Rouge Coco');
  assert.equal(official.flags['品名'], undefined);
  assert.doesNotMatch(String(official.flagReasons['品名'] || ''), /Name needs checking/);
});

test('cd is a Dior alias only as its own token at the start or end of a non-official name', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'cd', mode: 'round1', receipts: [{
    receiptKey: 'cd', merchant: 'Synthetic Store', receiptReference: 'CD-1', date: '2026-07-15', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'cd-start', brand: null, item: 'CD saddle bag', itemId: 'CDSADDLE', unitPrice: 20, amount: 20 },
      { rowId: 'cd-inside', brand: null, item: 'ABCD bag', itemId: 'ABCDBAG', unitPrice: 20, amount: 20 },
    ],
  }] }, { lookup: noLookup });
  const start = result.agreedRows.find(r => r.rowId === 'cd-start');
  const inside = result.agreedRows.find(r => r.rowId === 'cd-inside');
  assert.equal(start.cells['品名'], 'Cd Saddle Bag');
  assert.equal(start.cells['品牌'], null);
  assert.equal(start.flags['品名'], PINK);
  assert.match(start.flagReasons['品名'], /Name needs checking/);
  assert.equal(inside.cells['品名'], 'Abcd Bag');
  assert.notEqual(inside.flags['品名'], PINK);
  assert.doesNotMatch(String(inside.flagReasons['品名'] || ''), /Name needs checking/);
});

test('a gate Pink keeps the look-up Amber reason and candidates in the comment and hidden metadata', async () => {
  const env = makeEnv();
  const lookup = async () => ({
    candidates: [{ brand: 'Dior', officialName: null, itemId: 'OFF-1', price: 10, currency: 'GBP', matchType: 'price-fallback', confidence: 0.4, sourceUrls: ['https://synthetic.example/dior'], matchedFields: [], onOfficialSite: false, weightGrams: 100 }],
    cacheHit: false, cacheKey: 'both', sourcesQueried: ['brave'], printedItemId: 'SYN-BOTH', canonicalBrand: 'Dior',
  });
  const { result } = await runSanity(env, { batchId: 'both', mode: 'round1', receipts: [{
    receiptKey: 'both', merchant: 'Synthetic Store', receiptReference: 'BOTH-1', date: '2026-07-11', time: '12:00', payment: 'Card', currency: 'GBP',
    items: [{ rowId: 'both-1', brand: 'Dior', item: 'Dior tote', itemId: 'SYN-BOTH', unitPrice: 10, amount: 10 }],
  }] }, { lookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品名'], 'Dior Tote');
  assert.equal(row.flags['品名'], PINK);
  assert.match(row.flagReasons['品名'], /Name needs checking/);
  assert.match(row.flagReasons['品名'], /Price-fallback look-up/);
  assert.match(row.exportMeta.comments['品名'], /Name needs checking/);
  assert.match(row.exportMeta.comments['品名'], /Price-fallback look-up/);
  assert.match(row.exportMeta.comments['品名'], /OFF-1/);
  assert.equal(row.exportMeta.gateNotes['品名'].gate, 'Name needs checking');
  assert.match(row.exportMeta.gateNotes['品名'].lookup, /Price-fallback look-up/);
  assert.equal(row.exportMeta.gateNotes['品名'].candidates[0].itemId, 'OFF-1');
  const parsed = await readV2Workbook(await buildV2XlsxBlob(result));
  const saved = parsed.rows.find(r => r.rowId === 'both-1');
  assert.equal(saved.baseline.gateNotes['品名'].gate, 'Name needs checking');
  assert.match(saved.baseline.gateNotes['品名'].lookup, /Price-fallback look-up/);
  assert.equal(saved.baseline.gateNotes['品名'].candidates[0].itemId, 'OFF-1');
  assert.match(saved.comments['品名'], /Name needs checking/);
  assert.match(saved.comments['品名'], /Price-fallback look-up/);
});

test('a scheme-less wallet stays Card with no flag through the gate and Round 2', async () => {
  const env = makeEnv();
  const base = { receiptKey: 'wal', merchant: 'Synthetic Store', receiptReference: 'WAL-1', date: '2026-07-13', time: '10:00', currency: 'GBP' };
  const r1 = await runSanity(env, { batchId: 'wal', mode: 'round1', receipts: [{ ...base, payment: 'Samsung Pay', items: [
    { rowId: 'wal-1', brand: null, item: 'Pencil', itemId: 'SYN-WAL', unitPrice: 4, amount: 4 },
  ] }] }, { lookup: noLookup });
  const first = r1.result.agreedRows[0];
  assert.equal(first.cells['采购商品方法'], 'Card');
  assert.equal(first.flags['采购商品方法'], undefined);
  assert.equal(first.flags['品牌'], PINK);
  const r2 = await runSanity(env, { batchId: 'wal', mode: 'round2', receipts: [{ ...base, payment: 'Apple Pay', items: [{
    rowId: first.rowId, unitSettled: true, brand: null, item: 'Pencil', itemId: 'SYN-WAL', unitPrice: 4, amount: 4,
    previousCells: first.cells,
  }] }] }, { lookup: noLookup });
  const second = r2.result.agreedRows[0];
  assert.equal(second.cells['采购商品方法'], 'Card');
  assert.equal(second.flags['采购商品方法'], undefined);
  assert.equal(second.exportMeta.comments['采购商品方法'], undefined);
});

test('4-digit and 9999999 concession codes never land in 品牌货号', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'cc4', mode: 'round1', receipts: [{
    receiptKey: 'cc4', merchant: 'Harrods', receiptReference: 'CC4-1', date: '2026-07-13', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'cc-last4', brand: 'Synthetic', item: 'Pencil', itemId: '1234', unitPrice: 4, amount: 4 },
      { rowId: 'cc-label', brand: 'Synthetic', item: 'Scarf', itemId: '4321', concessionCode: '4321', unitPrice: 4, amount: 4 },
      { rowId: 'cc-layout', brand: 'Synthetic', item: 'Coat', itemId: '2574 1234567890', unitPrice: 40, amount: 40 },
      { rowId: 'cc-family', brand: 'Synthetic', item: 'Bag', itemId: '9999999123', unitPrice: 12, amount: 12 },
      { rowId: 'cc-style', brand: 'Synthetic', item: 'Belt', styleRef: '000001', unitPrice: 40, amount: 40 },
    ],
  }] }, { lookup: noLookup });
  const by = Object.fromEntries(result.agreedRows.map(r => [r.rowId, r]));
  for (const id of ['cc-last4', 'cc-label', 'cc-layout', 'cc-family']) {
    assert.equal(by[id].cells['品牌货号'], null);
    assert.doesNotMatch(String(by[id].cells['品牌货号'] ?? ''), /^\d{4}$/);
  }
  assert.equal(by['cc-last4'].flags['品牌货号'], PINK);
  assert.equal(by['cc-last4'].flagReasons['品牌货号'], 'Item ID looks like card last-4.');
  assert.match(by['cc-last4'].exportMeta.comments['品牌货号'], /1234/);
  assert.match(by['cc-last4'].exportMeta.alternates['品牌货号'].receipt, /1234/);
  assert.equal(by['cc-label'].flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(by['cc-label'].exportMeta.comments['品牌货号'], /4321/);
  assert.equal(by['cc-layout'].flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(by['cc-layout'].exportMeta.comments['品牌货号'], /2574/);
  assert.match(by['cc-layout'].exportMeta.comments['品牌货号'], /1234567890/);
  assert.equal(by['cc-family'].flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(by['cc-family'].exportMeta.comments['品牌货号'], /9999999123/);
  assert.equal(by['cc-style'].cells['品牌货号'], '000001');
});

test('a card last-four stays Pink when an official lookup returns a catalogue id', async () => {
  const env = makeEnv(KEYS);
  const lookup = async () => ({ candidates: [{
    brand: 'Chanel', officialName: 'Synthetic Pencil', itemId: 'AS1234', price: 4, currency: 'GBP',
    sourceUrls: ['https://www.chanel.com/gb/p/AS1234'], onOfficialSite: true,
    matchedFields: ['name'], confidence: 0.9, matchType: 'id',
  }] });
  const { result } = await runSanity(env, { batchId: 'last4-official', mode: 'round1', receipts: [{
    receiptKey: 'last4-official', merchant: 'Chanel', receiptReference: 'L4-1', date: '2026-07-13', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [{ rowId: 'last4-official-1', brand: 'Chanel', item: 'Pencil', itemId: '1234', unitPrice: 4, amount: 4 }],
  }] }, { lookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌货号'], null);
  assert.equal(row.flags['品牌货号'], PINK);
  assert.equal(row.flagReasons['品牌货号'], 'Item ID looks like card last-4.');
  assert.match(row.exportMeta.comments['品牌货号'], /1234/);
  assert.doesNotMatch(JSON.stringify(row.cells), /AS1234/);
});

test('a code found only in the product name does not become 品牌货号', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'name-code', mode: 'round1', receipts: [{
    receiptKey: 'name-code', merchant: 'Synthetic Store', receiptReference: 'NC-1', date: '2026-07-13', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [{ rowId: 'name-code-1', brand: 'Synthetic', item: 'Synthetic Shirt / RM0003', itemId: '1000600098', sku: '1000600098', unitPrice: 53, amount: 53 }],
  }] }, { lookup: noLookup });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌货号'], null);
  assert.equal(row.flags['品牌货号'], PINK);
  assert.equal(row.flagReasons['品牌货号'], 'no brand item ID printed');
  assert.match(row.exportMeta.comments['品牌货号'], /1000600098/);
  assert.notEqual(row.cells['品牌货号'], 'RM0003');
});

test('builder per-unit item id is exported as given, and a Chanel cn/gb source keeps the P6 comment', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'bld', mode: 'round1', receipts: [{
    receiptKey: 'bld', merchant: 'Synthetic Store', receiptReference: 'BLD-1', date: '2026-07-13', time: '12:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'bld-keep', brand: 'Chanel', item: 'Coat', itemId: '9999999001', unitPrice: 10, amount: 10, brandItemId: 'A111', brandItemIdSource: 'https://www.chanel.com/gb/fashion/p/A111', brandItemIdFlag: '#FDE68A', brandItemIdReason: 'Builder chose the style ref.' },
      { rowId: 'bld-fr', brand: 'Chanel', item: 'Coat', unitPrice: 10, amount: 10, brandItemId: 'A222', brandItemIdSource: 'https://www.chanel.com/fr/mode/p/A222', brandItemIdFlag: null, brandItemIdReason: null },
      { rowId: 'bld-fallback', brand: 'Synthetic', item: 'Scarf', itemId: '9999999002', unitPrice: 8, amount: 8 },
    ],
  }] }, { lookup: noLookup });
  const keep = result.agreedRows.find(r => r.rowId === 'bld-keep');
  const fr = result.agreedRows.find(r => r.rowId === 'bld-fr');
  const fallback = result.agreedRows.find(r => r.rowId === 'bld-fallback');
  assert.equal(keep.cells['品牌货号'], 'A111');
  assert.equal(keep.flags['品牌货号'], AMBER);
  assert.equal(keep.flagReasons['品牌货号'], 'Builder chose the style ref.');
  assert.equal(keep.exportMeta.brandItemId, 'A111');
  assert.equal(keep.exportMeta.brandItemIdSource, 'https://www.chanel.com/gb/fashion/p/A111');
  assert.equal(keep.exportMeta.brandItemIdFlag, '#FDE68A');
  assert.equal(keep.exportMeta.brandItemIdReason, 'Builder chose the style ref.');
  for (const col of ['品名', '品牌', '品牌货号']) assert.equal(keep.exportMeta.comments[col], 'chanel.com blocked; confirmed on chanel.cn/gb');
  assert.equal(fr.cells['品牌货号'], 'A222');
  assert.equal(fr.exportMeta.comments['品名'], undefined);
  assert.equal(fallback.cells['品牌货号'], null);
  assert.equal(fallback.flags['品牌货号'], PINK);
  assert.equal(fallback.flagReasons['品牌货号'], 'no brand item ID printed');
});

test('03/04/2026 is 3 April in 采购时间', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, { batchId: 'dmy', mode: 'round1', receipts: [{
    receiptKey: 'dmy', merchant: 'Synthetic Store', receiptReference: 'DMY-1', date: '03/04/2026', time: '09:15', payment: 'Card', currency: 'GBP',
    items: [{ brand: 'Synthetic', item: 'Pencil', itemId: 'SYN-DMY', unitPrice: 4, amount: 4 }],
  }] }, { lookup: noLookup });
  assert.equal(result.agreedRows[0].cells['采购时间'], '2026-04-03 09:15:00');
});

test('a receipt price within max(2% of price, £5) of the official price is not an Amber mismatch', async () => {
  const env = makeEnv();
  const official = { 'SYN-IN5': 104, 'SYN-OUT5': 106, 'SYN-IN2': 1019, 'SYN-OUT2': 1021 };
  const lookup = async (_env, body) => ({
    candidates: [{ brand: 'Synthetic', officialName: 'Pencil', itemId: body.itemId, price: official[body.itemId], currency: 'GBP', matchType: 'id', confidence: 0.9, sourceUrls: ['https://synthetic.example/tol'], matchedFields: ['itemId'], onOfficialSite: true, weightGrams: null }],
    cacheHit: false, cacheKey: body.itemId, sourcesQueried: ['brave'], printedItemId: body.itemId, canonicalBrand: 'Synthetic',
  });
  const item = (rowId, itemId, unitPrice) => ({ rowId, brand: 'Synthetic', item: 'Pencil', itemId, unitPrice, amount: unitPrice });
  const { result } = await runSanity(env, { batchId: 'tol', mode: 'round1', receipts: [{
    receiptKey: 'tol', merchant: 'Synthetic Store', receiptReference: 'TOL-1', date: '2026-07-12', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [item('tol-in5', 'SYN-IN5', 100), item('tol-out5', 'SYN-OUT5', 100), item('tol-in2', 'SYN-IN2', 1000), item('tol-out2', 'SYN-OUT2', 1000)],
  }] }, { lookup });
  const by = Object.fromEntries(result.agreedRows.map(r => [r.rowId, r]));
  assert.equal(by['tol-in5'].flags['采购商品原价'], undefined);
  assert.equal(by['tol-in5'].flags['品名'], undefined);
  assert.equal(by['tol-out5'].flags['采购商品原价'], AMBER);
  assert.equal(by['tol-in2'].flags['采购商品原价'], undefined);
  assert.equal(by['tol-out2'].flags['采购商品原价'], AMBER);
});

test('an official look-up name that contains the brand keeps its Amber and is not Name needs checking', async () => {
  const env = makeEnv();
  const rows = {
    CIGALE: { brand: 'Dior', officialName: 'Dior Aurora folio, sage', price: 400 },
    CH25BAG: { brand: 'Chanel', officialName: 'Chanel Meridian satchel, slate', price: 800 },
  };
  const lookup = async (_env, body) => {
    const hit = rows[body.itemId];
    if (!hit) return { candidates: [], cacheHit: false, cacheKey: 'none', sourcesQueried: [] };
    return {
      candidates: [{ brand: hit.brand, officialName: hit.officialName, itemId: body.itemId, price: hit.price, currency: 'GBP', matchType: 'id', confidence: 0.8, sourceUrls: ['https://synthetic.example/official'], matchedFields: ['itemId'], onOfficialSite: true, weightGrams: null }],
      cacheHit: false, cacheKey: body.itemId, sourcesQueried: ['brave'], printedItemId: body.itemId, canonicalBrand: hit.brand,
    };
  };
  const { result } = await runSanity(env, { batchId: 'off', mode: 'round1', receipts: [{
    receiptKey: 'off', merchant: 'Synthetic Store', receiptReference: 'OFF-1', date: '2026-07-14', time: '10:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'off-dior', brand: 'Dior', item: 'bag', itemId: 'CIGALE', unitPrice: 100, amount: 100 },
      { rowId: 'off-chanel', brand: 'Chanel', item: 'bag', itemId: 'CH25BAG', unitPrice: 100, amount: 100 },
      { rowId: 'off-plain', brand: null, item: 'Dior tote', itemId: 'SYN-PLAIN', unitPrice: 100, amount: 100 },
    ],
  }] }, { lookup });
  const dior = result.agreedRows.find(r => r.rowId === 'off-dior');
  const chanel = result.agreedRows.find(r => r.rowId === 'off-chanel');
  const plain = result.agreedRows.find(r => r.rowId === 'off-plain');
  assert.equal(dior.cells['品名'], 'Dior Aurora Folio, Sage');
  assert.equal(dior.flags['品名'], AMBER);
  assert.doesNotMatch(String(dior.flagReasons['品名'] || ''), /Name needs checking/);
  assert.doesNotMatch(String(dior.exportMeta.comments['品名'] || ''), /Name needs checking/);
  assert.equal(chanel.cells['品名'], 'Chanel Meridian Satchel, Slate');
  assert.equal(chanel.flags['品名'], AMBER);
  assert.doesNotMatch(String(chanel.flagReasons['品名'] || ''), /Name needs checking/);
  assert.equal(plain.cells['品名'], 'Dior Tote');
  assert.equal(plain.flags['品名'], PINK);
  assert.match(plain.flagReasons['品名'], /Name needs checking/);
});

test('a name already Pink for a missing or undescriptive value does not also get Name needs checking', async () => {
  const env = makeEnv();
  const lookup = async () => ({
    candidates: [{ brand: 'Synthetic', officialName: 'Real Pencil', itemId: 'PENCIL', price: 4, currency: 'GBP', matchType: 'multi-field', confidence: 0.4, sourceUrls: ['https://synthetic.example/p'], matchedFields: ['name'], onOfficialSite: false, weightGrams: null }],
    cacheHit: false, cacheKey: 'pink', sourcesQueried: ['brave'], printedItemId: 'PINK', canonicalBrand: 'Synthetic',
  });
  const { result } = await runSanity(env, { batchId: 'pink', mode: 'round1', receipts: [{
    receiptKey: 'pink', merchant: 'Synthetic Store', receiptReference: 'PINK-1', date: '2026-07-14', time: '11:00', payment: 'Card', currency: 'GBP',
    items: [
      { rowId: 'pink-missing', brand: 'Synthetic', item: '', itemId: 'SYN-MISS', unitPrice: 4, amount: 4 },
      { rowId: 'pink-junk', brand: 'Synthetic', item: 'total', itemId: 'SYN-JUNK', unitPrice: 4, amount: 4 },
    ],
  }] }, { lookup });
  for (const row of result.agreedRows) {
    assert.equal(row.flags['品名'], PINK);
    assert.match(row.flagReasons['品名'], /failed the column sanity check/);
    assert.doesNotMatch(row.flagReasons['品名'], /Name needs checking/);
    assert.equal(row.exportMeta.gateNotes, null);
    assert.doesNotMatch(String(row.exportMeta.comments['品名'] || ''), /Name needs checking/);
  }
  const { zip } = await sheetXml(await buildV2XlsxBlob(result));
  const flags = await zip.file('xl/worksheets/sheet3.xml').async('string');
  assert.equal(flags.includes('Name needs checking'), false);
  assert.match(flags, /failed the column sanity check/);
});
