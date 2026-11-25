// Unit fixtures for each Tillroll v2 reading rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {makeOcr} from './ocr-fixture.mjs';
import {
  normalizePurchaseTime, readPurchaseTime, normalizeTender, readTender, cleanProductCode,
  nonItemName, readStoreClues, mergeStoreClues, storeReceiptId, confirmedStoreReceiptId, classifyZeroPrice, applyZeroPriceExclusion,
} from '../receipt-rules.js';
import {extractLocal, cleanReceipt, geminiSchema, geminiPrompt, prepareModelReading} from '../extract.js';
import {checkReceipt, flagCategory} from '../checks.js';

const today = new Date('2026-11-25T12:00:00Z');
const read = rows => { const ocr = makeOcr(rows); const data = extractLocal(ocr); return {ocr, data, review: checkReceipt(data, ocr, null, {today})}; };
const flagsFor = (review, field) => review.flags.filter(f => f.field === field && f.severity !== 'info');

// ---- 2. 采购时间 -----------------------------------------------------------
test('time: 24-hour HH:MM:SS, seconds default to :00, am/pm converted', () => {
  assert.equal(normalizePurchaseTime('14:03'), '14:03:00');
  assert.equal(normalizePurchaseTime('9:05'), '09:05:00');
  assert.equal(normalizePurchaseTime('11:03:09'), '11:03:09');
  assert.equal(normalizePurchaseTime('2:15 pm'), '14:15:00');
  assert.equal(normalizePurchaseTime('2:15PM'), '14:15:00');
  assert.equal(normalizePurchaseTime('12:00 am'), '00:00:00');
  assert.equal(normalizePurchaseTime('12:30 p.m.'), '12:30:00');
  assert.equal(normalizePurchaseTime('13h37'), '13:37:00');
  assert.equal(normalizePurchaseTime('25:10'), null);
  assert.equal(normalizePurchaseTime('13:10 pm'), null);
  assert.equal(normalizePurchaseTime(''), null);
});
test('time: read from the dated line, not opening hours', () => {
  const {time} = readPurchaseTime('Open 10:00 - 21:00\nDate 12/11/2026 2:15 PM\nTOTAL 34.00');
  assert.equal(time, '14:15:00');
});
test('time: Gemini prompt and schema require HH:MM:SS', () => {
  assert.match(geminiPrompt, /HH:MM:SS/);
  assert.match(geminiSchema.properties.time.description, /HH:MM:SS/);
  assert.equal(cleanReceipt({time: '3:04 pm', items: []}).time, '15:04:00');
});

// ---- 3. 采购小票id -----------------------------------------------------------
const barcode = {text: '|||| ||| |||| || ||||| |||', h: 0.06, confidence: 0.3, gap: 0.01};
test('store id: Selfridges uses the code directly below the barcode', () => {
  const {data, review} = read(['SELFRIDGES & CO', '400 Oxford Street', 'London W1A 1AB', 'Date 12/11/2026 2:15 PM',
    'Aster Studio Linen tote', 'AS-028 1 x 34.00 34.00', 'TOTAL GBP 34.00', 'VISA', barcode, '04112601532281']);
  assert.equal(data.receiptReference, '04112601532281');
  assert.equal(flagsFor(review, 'receiptReference').length, 0);
});
test('store id: Selfridges with several codes below the barcode gets a reading flag', () => {
  const ocr = makeOcr(['SELFRIDGES & CO', 'TOTAL GBP 34.00', barcode, '041126 0153 2281']);
  assert.equal(storeReceiptId('Selfridges', ocr).status, 'unclear');
  const {review} = read(['SELFRIDGES & CO', 'Date 12/11/2026 2:15 PM', 'Tote 34.00', 'TOTAL GBP 34.00', 'VISA', barcode, '041126 0153 2281']);
  const flags = flagsFor(review, 'receiptReference');
  assert.ok(flags.length && flags.every(f => flagCategory(f) === 'reading'));
});
test('store id: Harrods uses the code right of the date/time line', () => {
  const {data, review} = read(['HARRODS', '87-135 Brompton Road', 'London SW1X 7XL', '12/11/2026 14:03 R0012345',
    'Field Fold Pocket notebook', 'FF-008 1 x 7.00 7.00', 'TOTAL GBP 7.00', 'AMERICAN EXPRESS ending 3005']);
  assert.equal(data.receiptReference, 'R0012345');
  assert.equal(flagsFor(review, 'receiptReference').length, 0);
});
test('store id: Harrods without a code beside the date/time is flagged', () => {
  const ocr = makeOcr(['HARRODS', '12/11/2026 14:03', 'TOTAL GBP 7.00']);
  assert.equal(storeReceiptId('Harrods', ocr).status, 'missing');
});
test('store id: other retailers keep the existing heuristics', () => {
  assert.equal(storeReceiptId('Liberty London', makeOcr(['Liberty London'])), null);
});
test('store id: a found store rule overrides a generic reference', () => {
  const {data, review} = read(['SELFRIDGES & CO', '400 Oxford Street', 'London W1A 1AB', 'Date 12/11/2026 2:15 PM',
    'Tote 34.00', 'TOTAL GBP 34.00', 'VISA', barcode, '04112601532281', 'REF AB12CD34']);
  assert.equal(data.receiptReference, '04112601532281');
  assert.notEqual(data.receiptReference, 'AB12CD34');
  assert.equal(flagsFor(review, 'receiptReference').length, 0);
});
test('store id: missing or unclear flags even when a generic id is printed', () => {
  const missing = read(['HARRODS', '87-135 Brompton Road', 'London SW1X 7XL', '12/11/2026 14:03',
    'Notebook 7.00', 'TOTAL GBP 7.00', 'REF AB12CD34']);
  assert.equal(storeReceiptId('Harrods', missing.ocr).status, 'missing');
  assert.notEqual(missing.data.receiptReference, 'AB12CD34');
  const missingFlags = flagsFor(missing.review, 'receiptReference');
  assert.ok(missingFlags.length && missingFlags.every(f => flagCategory(f) === 'reading'));
  const unclear = read(['SELFRIDGES & CO', 'Date 12/11/2026 2:15 PM', 'Tote 34.00', 'TOTAL GBP 34.00',
    'REF AB12CD34', barcode, '041126 0153 2281']);
  assert.equal(storeReceiptId('Selfridges', unclear.ocr).status, 'unclear');
  assert.notEqual(unclear.data.receiptReference, 'AB12CD34');
  const unclearFlags = flagsFor(unclear.review, 'receiptReference');
  assert.ok(unclearFlags.length && unclearFlags.every(f => flagCategory(f) === 'reading'));
});

// ---- 4. storeClues ---------------------------------------------------------
test('storeClues: printed header/footer only, null where absent, merchant untouched', () => {
  const lines = makeOcr(['SELFRIDGES & CO', '400 Oxford Street', 'London W1A 1AB', 'Tel: 020 7160 6222', 'Store 001',
    'Tote 34.00', 'TOTAL 34.00']).lines;
  assert.deepEqual(readStoreClues(lines, 'Selfridges'),
    {addressLines: ['400 Oxford Street', 'London W1A 1AB'], postcode: 'W1A 1AB', storeNumber: '001', phone: '020 7160 6222'});
  assert.deepEqual(readStoreClues(makeOcr(['MAC', 'Lipstick 25.00', 'TOTAL 25.00']).lines, 'MAC'),
    {addressLines: [], postcode: null, storeNumber: null, phone: null});
  const {data} = read(['HARRODS', '87-135 Brompton Road', 'London SW1X 7XL', '12/11/2026 14:03 R0012345', 'Notebook 7.00', 'TOTAL 7.00']);
  assert.equal(data.merchant, 'HARRODS');
  assert.equal(data.storeClues.postcode, 'SW1X 7XL');
});
test('storeClues: Gemini schema requires it; prompt forbids branch inference; ids stay separate', () => {
  assert.ok(geminiSchema.required.includes('storeClues'));
  assert.deepEqual(Object.keys(geminiSchema.properties.storeClues.properties).sort(), ['addressLines', 'phone', 'postcode', 'storeNumber']);
  assert.match(geminiPrompt, /branch/i);
  const item = geminiSchema.properties.items.items.properties;
  for (const key of ['itemId', 'sku', 'unitPrice', 'amount', 'lineDiscount']) assert.ok(item[key], key);
  const out = cleanReceipt({merchant: 'Harrods', storeClues: {addressLines: ['87-135 Brompton Road', ''], postcode: 'SW1X 7XL'}, items: []});
  assert.deepEqual(out.storeClues, {addressLines: ['87-135 Brompton Road'], postcode: 'SW1X 7XL', storeNumber: null, phone: null});
  assert.equal(out.merchant, 'Harrods');
});
test('storeClues: Gemini phone is kept and the other fields are filled from OCR', () => {
  const ocr = makeOcr(['HARRODS', '87-135 Brompton Road', 'London SW1X 7XL', 'Tel: 020 7730 1234', 'Store 12',
    'Notebook 7.00', 'TOTAL 7.00']);
  const printed = readStoreClues(ocr.lines, 'Harrods');
  const merged = mergeStoreClues({addressLines: [], postcode: null, storeNumber: null, phone: '020 7000 0000'}, printed);
  assert.equal(merged.phone, '020 7000 0000');
  assert.equal(merged.postcode, 'SW1X 7XL');
  assert.equal(merged.storeNumber, '12');
  assert.ok(merged.addressLines.includes('87-135 Brompton Road'));
  assert.equal(merged.addressLines.join(' '), printed.addressLines.join(' '));
});

// ---- 5. 品牌货号 -----------------------------------------------------------
test('codes: strip repeated brand prefix, keep digits and leading zeros', () => {
  assert.equal(cleanProductCode('GUCCI 0123456', {brand: 'Gucci'}).code, '0123456');
  assert.equal(cleanProductCode('0012345', {brand: 'Gucci'}).code, '0012345');
  assert.equal(cleanProductCode('AS-028').code, 'AS-028');
});
test('codes: reject dates, prices, phones and card last-4', () => {
  for (const [value, ctx] of [['12/05/2026', {}], ['2026-11-12', {}], ['34.00', {}], ['20261112', {date: '2026-11-12'}],
    ['3005', {card: '3005'}], ['020 7160 6222', {}], ['02071606222', {phone: '020 7160 6222'}]])
    assert.ok(cleanProductCode(value, ctx).rejected, value);
});
test('codes: a doubtful code is kept with a Pink reading flag', () => {
  const data = {merchant: 'Gucci', date: '2026-11-12', total: 100, card: '3005',
    items: [{brand: 'Gucci', item: 'Belt', itemId: '', sku: 'GUCCI0123456', qty: 1, unitPrice: 100, amount: 100}]};
  const ocr = makeOcr(['GUCCI', 'Belt GUCCI0123456 100.00', 'TOTAL 100.00']);
  const flags = flagsFor(checkReceipt(data, ocr, null, {today}), 'items.0.sku');
  assert.ok(flags.length && flags.every(f => flagCategory(f) === 'reading'));
});
test('codes: Gemini output with a rejected code is cleared and flagged', () => {
  const out = cleanReceipt({items: [{item: 'Belt', itemId: '12/05/2026', amount: 100}]});
  assert.equal(out.items[0].itemId, null);
  assert.ok(out.fieldIssues.some(f => f.field === 'items.0.itemId' && f.reason === 'rejected_code'));
});

// ---- 6. 采购商品方法 --------------------------------------------------------
test('tender: allowlist with normalisation', () => {
  const cases = {'VISA DEBIT': 'Visa', 'MASTERCARD': 'Mastercard', 'AMERICAN EXPRESS': 'Amex', 'Alipay': 'Alipay',
    'WeChat Pay': 'WeChat', 'APPLE PAY': 'Apple Pay', 'Google Pay': 'Google Pay', 'CASH': 'Cash',
    'UnionPay': 'UnionPay', 'Maestro': 'Maestro', 'CB': 'Carte Bancaire'};
  for (const [value, tender] of Object.entries(cases)) assert.equal(normalizeTender(value).tender, tender, value);
});
test('tender: channel terms are rejected and flagged', () => {
  for (const value of ['Online', 'In-store', 'Click & Collect', 'harrods.com'])
    assert.ok(normalizeTender(value).channel, value);
  const out = cleanReceipt({payment: 'Online', items: []});
  assert.equal(out.payment, null);
  assert.ok(out.fieldIssues.some(f => f.field === 'payment' && f.reason === 'channel_not_tender'));
  assert.match(geminiPrompt, /tender/i);
});
test('tender: OCR text prefers the wallet over the scheme and ignores cash back', () => {
  assert.equal(readTender('Apple Pay\nVISA ****1234'), 'Apple Pay');
  assert.equal(readTender('We accept Visa Mastercard Amex\nCASH BACK 0.00\nMASTERCARD 1234'), 'Mastercard');
});

// ---- 7. holistic sanity ----------------------------------------------------
test('item names: label words and bare numbers are blocked', () => {
  for (const value of ['TOTAL', 'Subtotal', '9999', 'VAT 20%', 'amount: 45.00', 'Change', 'Tax']) assert.ok(nonItemName(value), value);
  for (const value of ['Silk scarf', 'Total Repair Serum', 'No. 5 Eau de Parfum']) assert.equal(nonItemName(value), null, value);
});
test('lineDiscount: folded into the product row and arithmetic reconciles', () => {
  const {data, review} = read(['MAC Brompton', 'Date 12/11/2026 11:03:09', 'Studio Fix Foundation 1 45.00 31.50',
    'BLACK FRIDAY OFFER -13.50', 'TOTAL 31.50', 'Mastercard']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].lineDiscount, 13.5);
  assert.equal(data.time, '11:03:09');
  assert.equal(review.flags.filter(f => /^items\.0\.(amount|unitPrice|qty)$/.test(f.field) && f.severity !== 'info').length, 0);
  assert.ok(geminiSchema.properties.items.items.properties.lineDiscount);
});
test('lineDiscount: qty × unitPrice − lineDiscount ≠ amount is flagged', () => {
  const data = {merchant: 'MAC', total: 40, items: [{item: 'Foundation', qty: 1, unitPrice: 45, lineDiscount: 10, amount: 40}]};
  const flags = checkReceipt(data, makeOcr(['MAC', 'Foundation 1 45.00 40.00', 'TOTAL 40.00']), null, {today}).flags;
  assert.ok(flags.some(f => f.field.startsWith('items.0.') && f.severity !== 'info'));
});
test('line discount: Rewards Saving -£131 under an item is kept raw on that line', () => {
  const {data, review} = read(['BOOTS', 'Date 12/11/2026 14:03', 'No7 Serum 1 x 262.00 131.00', 'Rewards Saving -£131', 'TOTAL 131.00', 'VISA']);
  assert.equal(data.items.length, 1);
  const item = data.items[0];
  assert.equal(item.qty, 1);
  assert.equal(item.unitPrice, 262);
  assert.equal(item.amount, 131);
  assert.equal(item.lineDiscount, 131);
  assert.equal(item.lineDiscountLabel, 'Rewards Saving');
  assert.deepEqual(item.lineDiscounts, [{label: 'Rewards Saving', amount: 131}]);
  assert.equal(data.receiptDiscount, null);
  assert.equal(review.flags.filter(f => f.field === 'items.0.amount' && f.severity !== 'info').length, 0);
  assert.equal(review.flags.filter(f => f.field === 'total' && f.severity !== 'info').length, 0);
});
test('line discount: several printed lines stay raw and sum', () => {
  const {data} = read(['MAC', 'Date 12/11/2026 11:03', 'Foundation 1 30.00 22.00', 'Staff saving -5.00', 'Rewards Saving -3.00', 'TOTAL 22.00']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].unitPrice, 30);
  assert.equal(data.items[0].amount, 22);
  assert.equal(data.items[0].lineDiscount, 8);
  assert.deepEqual(data.items[0].lineDiscounts, [{label: 'Staff saving', amount: 5}, {label: 'Rewards Saving', amount: 3}]);
  assert.equal(data.items[0].lineDiscountLabel, 'Staff saving + Rewards Saving');
});
test('line discount: qty 3 stays one raw line', () => {
  const {data} = read(['SHOP', 'Date 12/11/2026 11:03', 'Tote 3 x 10.00 29.00', 'Offer -1.00', 'TOTAL 29.00']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].qty, 3);
  assert.equal(data.items[0].unitPrice, 10);
  assert.equal(data.items[0].amount, 29);
  assert.equal(data.items[0].lineDiscount, 1);
  assert.equal(data.items[0].lineDiscountLabel, 'Offer');
});
test('line discount: an untied discount stays raw and is flagged, not moved to the receipt', () => {
  const {data, review} = read(['MAC', 'Date 12/11/2026 11:03', 'Foundation 1 45.00 40.00', 'Rewards Saving -10.00', 'TOTAL 40.00']);
  assert.equal(data.receiptDiscount, null);
  assert.deepEqual(data.receiptDiscounts, []);
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].qty, 1);
  assert.equal(data.items[0].unitPrice, 45);
  assert.equal(data.items[0].amount, 40);
  assert.equal(data.items[0].lineDiscount, null);
  assert.equal(data.items[1].item, 'Rewards Saving');
  assert.equal(data.items[1].amount, -10);
  const flags = review.flags.filter(f => /discount line unclear/i.test(f.message));
  assert.ok(flags.length && flags.every(f => flagCategory(f) === 'reading'));
});
test('receipt discount: a basket promo is not allocated across items', () => {
  const {data, review} = read(['LIBERTY', 'Date 12/11/2026 11:03', 'Silk scarf 50.00', 'Wool hat 40.00', 'Basket promo -10.00', 'TOTAL 80.00', 'Visa']);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items.map(row => row.amount), [50, 40]);
  assert.deepEqual(data.items.map(row => row.unitPrice), [null, null]);
  assert.ok(data.items.every(row => row.lineDiscount == null));
  assert.equal(data.receiptDiscount, 10);
  assert.deepEqual(data.receiptDiscounts, [{label: 'Basket promo', amount: 10}]);
  assert.equal(review.flags.filter(f => f.field === 'total' && f.severity !== 'info').length, 0);
  const model = cleanReceipt({
    merchant: 'Liberty', total: 80, receiptDiscount: 10,
    receiptDiscounts: [{label: 'Basket promo', amount: -10}],
    items: [
      {item: 'Silk scarf', qty: 1, unitPrice: 50, amount: 50, lineDiscount: null, lineDiscounts: []},
      {item: 'Wool hat', qty: 1, unitPrice: 40, amount: 40, lineDiscount: null, lineDiscounts: []},
    ],
  });
  assert.deepEqual(model.items.map(row => [row.unitPrice, row.amount, row.lineDiscount]), [[50, 50, null], [40, 40, null]]);
  assert.equal(model.receiptDiscount, 10);
  assert.deepEqual(model.receiptDiscounts, [{label: 'Basket promo', amount: 10}]);
  assert.match(geminiPrompt, /Never allocate a receipt-level discount/);
  assert.ok(geminiSchema.properties.receiptDiscount);
  assert.ok(geminiSchema.properties.receiptDiscounts);
  assert.ok(geminiSchema.properties.items.items.properties.lineDiscountLabel);
  assert.ok(geminiSchema.properties.items.items.properties.lineDiscounts);
});

// ---- 8. true zero vs OCR miss ----------------------------------------------
test('zero price: confirmed printed 0.00 moves to excludedZeroItems', () => {
  const {data} = read(['SELFRIDGES & CO', 'Date 12/11/2026 2:15 PM', 'Aster Studio Linen tote', 'AS-028 1 x 34.00 34.00',
    'Carrier bag 0.00', 'TOTAL GBP 34.00', 'VISA']);
  assert.deepEqual(data.items.map(i => i.item), ['Aster Studio Linen tote']);
  assert.equal(data.excludedZeroItems.length, 1);
  assert.equal(data.excludedZeroItems[0].item.item, 'Carrier bag');
});
test('zero price: doubtful zero stays with a Pink flag', () => {
  const {data, review} = read(['Liberty London', 'Date 12/11/2026 11:03', 'Silk scarf 120.00', 'Gift wrap 0.00', 'TOTAL GBP 125.00', 'Visa']);
  assert.equal(data.items.length, 2);
  assert.equal(data.excludedZeroItems.length, 0);
  const flags = flagsFor(review, 'items.1.amount');
  assert.ok(flags.length && flags.every(f => flagCategory(f) === 'reading'));
});
test('zero price: a low-confidence 0.00 is doubtful', () => {
  const ocr = makeOcr(['Shop', 'Scarf 34.00', {text: 'Bag 0.00', wordConfidence: {'0.00': 0.5}}, 'TOTAL 34.00']);
  const data = {total: 34, items: [{item: 'Scarf', amount: 34}, {item: 'Bag', amount: 0}]};
  assert.equal(classifyZeroPrice(data.items[1], data, ocr).status, 'doubtful');
  assert.equal(applyZeroPriceExclusion(data, ocr).items.length, 2);
});

// ---- 9. flag categories ----------------------------------------------------
test('flag categories: reading vs lookup vs info', () => {
  assert.equal(flagCategory({severity: 'info'}), 'info');
  assert.equal(flagCategory({severity: 'check'}), 'reading');
  assert.equal(flagCategory({severity: 'check', category: 'lookup'}), 'lookup');
});

// ---- Synthetic Harrods layouts (no real receipt text) ----------------------
test('store id: a found Harrods id is not cleared by a generic ambiguous suggestion', () => {
  const ocr = makeOcr(['HARRODS', '12/11/2026 14:03 NT01234-567890', 'Scarf 20.00', 'TOTAL GBP 20.00', 'REF AB12CD34']);
  const data = extractLocal(ocr);
  assert.equal(data.receiptReference, 'NT01234-567890');
  assert.equal(confirmedStoreReceiptId('HARRODS', ocr, data.receiptReference), true);
  assert.equal(confirmedStoreReceiptId('HARRODS', ocr, 'AB12CD34'), false);
});
test('Harrods id: NTO and N10 prefixes normalise to NT0 and stay unclear', () => {
  const oto = storeReceiptId('Harrods', makeOcr(['HARRODS', '12/11/2026 14:03 NTO1234-567890', 'TOTAL 20.00']));
  assert.equal(oto.value, 'NT01234-567890');
  assert.equal(oto.status, 'unclear');
  const n10 = storeReceiptId('Harrods', makeOcr(['HARRODS', '12/11/2026 14:03 N101234-567890', 'TOTAL 20.00']));
  assert.equal(n10.value, 'NT01234-567890');
  assert.equal(n10.status, 'unclear');
  const {review} = read(['HARRODS', '12/11/2026 14:03 NTO1234-567890', 'Scarf 20.00', 'TOTAL GBP 20.00']);
  const flags = flagsFor(review, 'receiptReference');
  assert.ok(flags.length && flags.every(f => flagCategory(f) === 'reading'));
});
test('items stop at TOTAL: payment lines are not items and genuine zeros are excluded', () => {
  const {data, review} = read(['HARRODS', '12/11/2026 14:03 NT01234-567890',
    '1234 9999999001 Silk scarf 20.00', 'Carrier Bag 0.00', 'By Appointment 0.00', 'TOTAL GBP 20.00',
    'AMOUNT', 'Citcon QR Tendered 20.00', 'UnionPay Tendered 20.00', 'Item Total: 20.00', 'Adyen: 20.00', 'ARQC 99.00']);
  assert.deepEqual(data.items.map(row => row.item), ['Silk scarf']);
  assert.equal(data.total, 20);
  assert.ok(!data.items.some(row => /citcon|unionpay|adyen|arqc|amount|item total/i.test(row.item || '')));
  const excluded = data.excludedZeroItems.map(row => row.item.item).sort();
  assert.deepEqual(excluded, ['By Appointment', 'Carrier Bag']);
  assert.equal(review.flags.filter(f => f.reason === 'doubtful_zero_price' || /zero price/i.test(f.message)).length, 0);
});
test('Harrods line: concession, internal code, style and EAN stay out of itemId', () => {
  const {data} = read(['HARRODS', '12/11/2026 14:03 NT01234-567890',
    '1234 9999999001 CHANEL A12345 Wool coat 85.00', 'Product Info: 5001111222333',
    'You have been served today by', 'Alex Example', 'TOTAL GBP 85.00']);
  assert.equal(data.items.length, 1);
  const item = data.items[0];
  assert.equal(item.concessionCode, '1234');
  assert.equal(item.internalCode, '9999999001');
  assert.equal(item.styleRef, 'A12345');
  assert.equal(item.ean, '5001111222333');
  assert.equal(item.item, 'CHANEL Wool coat');
  assert.equal(item.itemId, null);
  assert.notEqual(item.brand, 'Alex Example');
  assert.ok(!/alex example/i.test([item.brand, item.item, item.concessionCode].filter(Boolean).join(' ')));
});
test('storeClues: a Harrods till number is not a phone and policy text is not an address', () => {
  const lines = makeOcr(['HARRODS', 'Scarf 20.00', 'TOTAL GBP 20.00', '1000-000111',
    'Please return goods. pl Ln policy applies.']).lines;
  const clues = readStoreClues(lines, 'Harrods');
  assert.equal(clues.phone, null);
  assert.deepEqual(clues.addressLines, []);
});
test('receipt discount: a saving after TOTAL and before balance due is not a line flag', () => {
  const {data, review} = read(['SHOP', 'Date 12/11/2026 11:03', 'Soup 10.00', 'TOTAL 8.80', 'Fruit Offer -1.20', 'BALANCE DUE 8.80']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].amount, 10);
  assert.equal(data.receiptDiscount, 1.2);
  assert.deepEqual(data.receiptDiscounts, [{label: 'Fruit Offer', amount: 1.2}]);
  assert.equal(review.flags.filter(f => /discount line unclear/i.test(f.message)).length, 0);
});
test('line discount: trailing OCR junk is kept, folded when it reconciles, flagged when it does not', () => {
  const folded = read(['MAC', 'Date 12/11/2026 11:03', 'Foundation 1 45.00 31.50', 'BLACK FRIDAY WEEK OFFER -13.50 wile', 'TOTAL 31.50']);
  assert.equal(folded.data.items.length, 1);
  assert.equal(folded.data.items[0].lineDiscount, 13.5);
  assert.equal(folded.data.items[0].amount, 31.5);
  const raw = read(['MAC', 'Date 12/11/2026 11:03', 'Foundation 1 45.00 40.00', 'BLACK FRIDAY WEEK OFFER -13.50 wile', 'TOTAL 40.00']);
  assert.equal(raw.data.items.length, 2);
  assert.equal(raw.data.items[1].amount, -13.5);
  assert.match(raw.data.items[1].item, /BLACK FRIDAY WEEK OFFER/);
  const flags = raw.review.flags.filter(f => /discount line unclear/i.test(f.message));
  assert.ok(flags.length && flags.every(f => flagCategory(f) === 'reading'));
  assert.equal(raw.data.receiptDiscount, null);
});
test('Gemini reading: the store rule replaces a generic Harrods id', () => {
  const ocr = makeOcr(['HARRODS', '12/11/2026 14:03 NT01234-567890', 'Scarf 20.00', 'TOTAL GBP 20.00']);
  const out = prepareModelReading({merchant: 'Harrods', receiptReference: 'AB12CD34', items: [{item: 'Scarf', amount: 20}], storeClues: {phone: '020 7000 0000'}}, ocr);
  assert.equal(out.receiptReference, 'NT01234-567890');
  assert.equal(out.storeClues.phone, '020 7000 0000');
});
