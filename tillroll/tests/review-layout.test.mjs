import test from 'node:test';
import assert from 'node:assert/strict';
import {makeOcr} from './ocr-fixture.mjs';
import {extractLocal, cleanReceipt, geminiPrompt} from '../extract.js';
import {checkReceipt, flagCategory} from '../checks.js';
import {kindForFlag, reviewKinds} from '../receipt-policy.js';
import {sortItemFields} from '../field-sorter.js';
import {buildCsvBlob, buildXlsxBlob, buildChinaXlsxBlob} from '../exports.js';
import * as zipPackage from '../export-vendor/jszip.min.js';

const today = new Date('2026-11-25T12:00:00Z');
const read = rows => {
  const ocr = makeOcr(rows);
  const data = extractLocal(ocr);
  return {data, review: checkReceipt(data, ocr, null, {today})};
};

test('P7: a UK ambiguous date is DD/MM and an unambiguous date stays', () => {
  const uk = read(['HARRODS', '04/11/26 14:03', 'Scarf 10.00', 'TOTAL 10.00']);
  assert.equal(uk.data.date, '2026-11-04');
  assert.equal(uk.data.dateIssue, null);
  assert.equal(uk.review.flags.some(flag => flag.field === 'date' && /ambiguous/i.test(flag.message)), false);
  const clue = read(['Atelier', 'Tel 020 7730 1234', '04/11/26 14:03', 'Scarf 10.00', 'TOTAL 10.00']);
  assert.equal(clue.data.date, '2026-11-04');
  const clear = read(['HARRODS', '25/11/26 14:03', 'Scarf 10.00', 'TOTAL 10.00']);
  assert.equal(clear.data.date, '2026-11-25');
  const foreign = read(['Saks', '04/11/26 14:03', 'Soap 4.00', 'TOTAL 4.00']);
  assert.equal(foreign.data.date, null);
  assert.match(foreign.data.dateIssue, /ambiguous/i);
  assert.ok(foreign.review.flags.some(flag => flag.field === 'date' && /ambiguous/i.test(flag.message) && flagCategory(flag) === 'reading'));
  const foreignClear = read(['Saks', '25/11/26 14:03', 'Soap 4.00', 'TOTAL 4.00']);
  assert.equal(foreignClear.data.date, '2026-11-25');
});

test('Selfridges return-policy dates never become the purchase date', () => {
  const broken = read([
    'SELFRIDGES & CO',
    'You are welcome to exchange or refund your purchases by 02/01/2027',
    'Date B/11/26 8:37 pm',
    'Synthetic coat 120.00',
    'TOTAL 120.00',
  ]);
  assert.equal(broken.data.date, null);
  assert.equal(broken.data.dateIssue, null);
  assert.ok(broken.review.flags.some(flag => flag.field === 'date' && /missing|valid date/i.test(flag.message)));
  assert.equal(JSON.stringify(broken.data).includes('2027-01-02'), false);
});

test('Harrods block: codes, brand, description and one Rewards Saving', () => {
  const {data} = read(['HARRODS', '04/11/2026 14:03 NT0682-111111',
    '2469 9999991234 3612345678901 £5,700.00', 'CHANEL', 'WOOL COAT',
    'Rewards Saving -£570.00', 'Customer 10% Day -£570.00', 'TOTAL 5130.00', 'Visa Tendered 5130.00']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].brand, 'Chanel');
  assert.equal(data.items[0].item, 'WOOL COAT');
  assert.equal(data.items[0].concessionCode, '2469');
  assert.equal(data.items[0].internalCode, '9999991234');
  assert.equal(data.items[0].ean, '3612345678901');
  assert.equal(data.items[0].amount, 5700);
  assert.equal(data.items[0].lineDiscount, 570);
  assert.equal(data.items[0].lineDiscountLabel, 'Rewards Saving');
  assert.equal(data.receiptDiscount, null);
  assert.equal(data.total, 5130);
});

test('money: thousands, European cents, and qty 1', () => {
  const {data} = read(['SHOP', '25/11/2026 10:00', 'Parka 1 x £1.295,00', '1 Unit(s)', 'TOTAL 1295.00']);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].item, 'Parka');
  assert.equal(data.items[0].qty, 1);
  assert.equal(data.items[0].amount, 1295);
  const split = read(['SHOP', '25/11/2026 10:00', 'Coat £5, 700.00', 'TOTAL 5700.00']);
  assert.equal(split.data.items[0].amount, 5700);
  assert.equal(split.data.items.length, 1);
});

test('EMV footer lines are not items', () => {
  const {data} = read(['SHOP', '25/11/2026 10:00', 'Scarf 18.00', 'TOTAL 18.00', 'Visa Tendered 18.00',
    'Cryptogram AB12', 'ogram CD34', 'AID A00001', 'PAN Seq 01', 'Auth Code 445566',
    'Merchant ID M1', 'Terminal ID T9', '40/12345', '80/ABC']);
  assert.deepEqual(data.items.map(row => row.item), ['Scarf']);
});

test('identifiers: REF, Chanel style, boutique SKU, and a confusable letter', () => {
  const {data} = read(['CHANEL', '25/11/2026 10:00', 'Wool coat 80.00', 'REF# AB1O23', '24A A12345', 'TOTAL 80.00']);
  assert.equal(data.items[0].styleRef, 'A12345');
  const ref = data.items[0].identifiers.find(entry => entry.label === 'REF');
  assert.equal(ref.value, 'AB1O23');
  assert.ok(ref.alternatives.includes('AB1023'));
  const style = data.identifiers.find(entry => entry.value === '24A A12345');
  assert.equal(style.class, 'style_or_model_reference');
  const sku = read(['SHOP', '25/11/2026 10:00', 'Hat 20.00', 'ABC12345', 'TOTAL 20.00']);
  assert.ok(sku.data.identifiers.some(entry => entry.value === 'ABC12345' && entry.class === 'product_code'));
  const serial = read(['SHOP', '25/11/2026 10:00', 'Hat 20.00', 'SERIAL NUMBER SN-9', 'ID# 00077', 'TOTAL 20.00']);
  assert.ok(serial.data.items[0].identifiers.some(entry => entry.class === 'serial_number' && entry.value === 'SN-9'));
  assert.equal(serial.data.items[0].primaryItemId, '00077');
});

test('brands: CG, N.PEAL and the next description line', () => {
  assert.equal(sortItemFields({item: 'CG Parka', amount: 10}).item.brand, 'Canada Goose');
  assert.equal(sortItemFields({item: 'YCA Necklace', amount: 10}).item.brand, 'Van Cleef & Arpels');
  assert.equal(sortItemFields({item: 'THE ROW Coat', amount: 10}).item.brand, 'The Row');
  const {data} = read(['N.PEAL / LONDON', '25/11/2026 10:00', 'N.PEAL 40.00', 'CREAM SCARF', 'TOTAL 40.00']);
  assert.equal(data.merchant, 'N.Peal');
  assert.equal(data.items[0].brand, 'N.Peal');
  assert.equal(data.items[0].item, 'CREAM SCARF');
});

test('Harrods id: a damaged prefix and a disagreeing barcode stay printed', () => {
  const damaged = read(['HARRODS', '25/11/2026 14:03 NR0123-456789', 'Scarf 10.00', 'TOTAL 10.00']);
  assert.equal(damaged.data.receiptReference, 'NR0123-456789');
  assert.ok(damaged.data.receiptReferenceAlternatives.includes('NT0123-456789'));
  assert.ok(damaged.review.flags.some(flag => flag.field === 'receiptReference' && flagCategory(flag) === 'reading'));
  const shaped = read(['HARRODS', '25/11/2026 14:03 NT0123-456789', 'Scarf 10.00', 'TOTAL 10.00', '999888777666']);
  assert.equal(shaped.data.receiptReference, 'NT0123-456789');
  assert.ok(shaped.data.receiptReferenceAlternatives.includes('999888777666'));
  assert.ok(shaped.review.flags.some(flag => flag.field === 'receiptReference'));
});

test('TOTAL is checked against Tendered', () => {
  const same = read(['SHOP', '25/11/2026 10:00', 'Scarf 18.00', 'TOTAL 18.00', 'Visa Tendered 18.00']);
  assert.equal(same.review.flags.some(flag => /tendered amount/i.test(flag.message)), false);
  const differ = read(['SHOP', '25/11/2026 10:00', 'Scarf 18.00', 'TOTAL 18.00', 'Visa Tendered 17.00']);
  assert.ok(differ.review.flags.some(flag => flag.field === 'total' && /tendered amount/i.test(flag.message) && flagCategory(flag) === 'reading'));
});

test('boutique: merchant, receipt number, and the printed footer', () => {
  const {data, review} = read(['N.PEAL / LONDON', 'Date 15/11/2026 10:00', 'Cashmere scarf 40.00',
    'Receipt # NP-100', 'TOTAL 40.00', 'Printed: 2026-11-16 09:15:00']);
  assert.equal(data.merchant, 'N.Peal');
  assert.equal(data.receiptReference, 'NP-100');
  assert.equal(data.date, '2026-11-16');
  assert.equal(data.time, '09:15:00');
  assert.ok(review.flags.some(flag => /Printed footer/i.test(flag.message) && flagCategory(flag) === 'info'));
});

test('card output has no digits in the reading or the export row', async () => {
  const pan = '4111111111111234';
  const {data, review} = read(['ATELIER', '25/11/2026 11:40', 'Bowl 9.00', 'Visa CARD NUMBER: ' + pan, 'TOTAL 9.00']);
  const card = [...(data.identifiers || []), ...data.items.flatMap(item => item.identifiers || [])].find(entry => entry.class === 'payment_card');
  assert.equal(card.value, '[card]');
  assert.equal(card.scheme, 'Visa');
  assert.equal(/\d/.test(JSON.stringify({value: card.value, scheme: card.scheme, evidence: card.evidence})), false);
  assert.equal(data.card, 'Visa');
  assert.equal(/\d/.test(String(data.card)), false);
  const reading = JSON.stringify(data);
  assert.equal(reading.includes(pan), false);
  assert.equal(reading.includes('1234'), false);
  data.card = pan;
  data.payment = 'Visa ' + pan;
  const receipt = {data, record: data, review, filename: 'synthetic.jpg', origin: ''};
  const csv = await buildCsvBlob([receipt]).text();
  const JSZip = zipPackage.default ?? globalThis.JSZip;
  const english = await (await JSZip.loadAsync(await (await buildXlsxBlob([receipt])).arrayBuffer())).file('xl/worksheets/sheet1.xml').async('string');
  const chinese = await (await JSZip.loadAsync(await (await buildChinaXlsxBlob([receipt])).arrayBuffer())).file('xl/worksheets/sheet1.xml').async('string');
  for (const row of [csv, english, chinese]) {
    assert.equal(row.includes(pan), false, row.slice(0, 80));
    assert.equal(row.includes('1234'), false);
  }
});

test('a model card number does not survive normalisation, flags or exports', async () => {
  const pan = '4000000000009753';
  assert.doesNotMatch(geminiPrompt, /last four card digits/i);
  assert.match(geminiPrompt, /Never record any card digits/);
  const data = cleanReceipt({
    merchant: 'Atelier', date: '2026-11-25', time: '11:40:00', total: 12, payment: 'Visa', card: pan,
    items: [{item: 'Bowl', itemId: '9753', qty: 1, unitPrice: 12, amount: 12, brand: null, sku: null, colour: null, size: null, lineDiscount: null, lineDiscountLabel: null, lineDiscounts: []}],
    fieldIssues: [{field: 'card', reason: 'noted', evidence: 'Printed card ' + pan}],
  });
  const review = checkReceipt(data, makeOcr(['ATELIER', 'Bowl 12.00', 'TOTAL 12.00']), null, {today});
  const leaked = {...data, card: pan, payment: 'Visa ' + pan};
  const receipt = {data: leaked, record: leaked, review, filename: 'synthetic.jpg', origin: ''};
  const csv = await buildCsvBlob([receipt]).text();
  const JSZip = zipPackage.default ?? globalThis.JSZip;
  const english = await (await JSZip.loadAsync(await (await buildXlsxBlob([receipt])).arrayBuffer())).file('xl/worksheets/sheet1.xml').async('string');
  const chinese = await (await JSZip.loadAsync(await (await buildChinaXlsxBlob([receipt])).arrayBuffer())).file('xl/worksheets/sheet1.xml').async('string');
  const packed = [JSON.stringify(data), JSON.stringify(data.fieldIssues), JSON.stringify(review.flags), csv, english, chinese].join('\n');
  assert.equal(packed.includes(pan), false);
  assert.equal(packed.includes('9753'), false);
  assert.equal(data.card, '[card]');
  assert.equal(data.items[0].itemId, null);
  assert.match(JSON.stringify(data.fieldIssues), /matches the card and was cleared/);
});

test('a stripped brand prefix keeps the printed item for audit', () => {
  const sorted = sortItemFields({item: 'CHANEL WOOL CREW SZ 36', amount: 80});
  assert.equal(sorted.item.brand, 'Chanel');
  assert.equal(sorted.item.item, 'WOOL CREW SZ 36');
  assert.equal(sorted.item.receiptItem, 'CHANEL WOOL CREW SZ 36');
  const kept = sortItemFields({item: 'CHANEL WOOL CREW SZ 36', receiptItem: 'printed earlier', amount: 80});
  assert.equal(kept.item.receiptItem, 'printed earlier');
  assert.equal(sortItemFields({item: 'Mini Acme Widget', amount: 10}).item.receiptItem, undefined);
});

test('reading and lookup flags carry the kind the policy classifier expects', () => {
  const reading = checkReceipt({merchant: null, total: null, items: []}, makeOcr(['SHOP']), null, {today});
  const missing = reading.flags.find(flag => flag.field === 'merchant');
  assert.equal(missing.category, 'reading');
  assert.equal(missing.kind, 'reading');
  assert.equal(kindForFlag(missing), reviewKinds.reading);
  const lookup = checkReceipt({
    merchant: 'Harrods', date: '2026-11-25', time: '10:00:00', total: 10, payment: 'Visa', orderNumber: 'NOT-A-MATCH',
    items: [{item: 'Scarf', amount: 10, qty: 1}],
  }, makeOcr(['HARRODS', 'Scarf 10.00', 'TOTAL 10.00']), null, {today, demoFormats: true});
  const format = lookup.flags.find(flag => flag.field === 'orderNumber' && flag.category === 'lookup');
  assert.ok(format);
  assert.equal(format.kind, 'lookup');
  assert.equal(kindForFlag(format), reviewKinds.lookup);
});

test('filled item names skip labels and staff, then go through the sorter', () => {
  const serial = read(['HARRODS', '25/11/2026 10:00', 'CHANEL 80.00', 'SERIAL NUMBER SN-100', 'TOTAL 80.00']);
  assert.equal(serial.data.items[0].item, null);
  assert.notEqual(serial.data.items[0].item, 'SERIAL NUMBER SN-100');
  const staff = read(['HARRODS', '25/11/2026 10:00', 'CHANEL 80.00', 'Salesperson: Alex', 'TOTAL 80.00']);
  assert.notEqual(staff.data.items[0].item, 'Alex');
  assert.equal(JSON.stringify(staff.data.items).includes('Alex'), false);
  const named = read(['HARRODS', '25/11/2026 10:00', 'CHANEL 80.00', 'CHANEL WOOL CREW SZ 36', 'TOTAL 80.00']);
  assert.equal(named.data.items[0].brand, 'Chanel');
  assert.equal(named.data.items[0].item, 'WOOL CREW SZ 36');
  assert.ok(named.review.flags.some(flag => flag.field === 'items.0.item' && flag.message === 'item-name-filled-from-block' && flagCategory(flag) === 'reading'));
});
