import test from 'node:test';
import assert from 'node:assert/strict';
import {extractStrictReceipt} from '../extract.js';
import {makeOcr} from './ocr-fixture.mjs';

const rows = {
  harrods: ['HARRODS', '15/11/2026 10:04 NT1234-567890', '2469 9999991234 CHANEL A12345 Synthetic wool coat 120.00 120.00', 'TOTAL (1 item) 120.00', 'VISA', 'StaffNo 4821 120.00', 'Customer copy 120.00'],
  selfridges: ['SELFRIDGES & CO', '15/11/2026 10:04', 'A12345 Synthetic wool coat 120.00 120.00', 'TOTAL (1 item) 120.00', 'VISA', {text: '|||| |||| |||', h: .06, confidence: .3}, '123456789012'],
  chanel: ['CHANEL', '15/11/2026 10:04', 'Receipt # SYN-CH-0001', 'A12345 Synthetic wool coat 120.00 120.00', 'T0TAL (1 item) 120.00', 'VISA', 'Rewards points 120.00'],
  watches: ['WATCHES OF SWITZERLAND', '15/11/2026 10:04', 'Receipt # WS-0001', 'STYLE AB1234 Synthetic watch 120.00 120.00', 'TOTAL (1 item) 120.00', 'VISA', 'Operator Mira 120.00'],
};

test('strict layouts whitelist coded priced item rows and attach OCR evidence', () => {
  for (const [name, input] of Object.entries(rows)) {
    const data = extractStrictReceipt(makeOcr(input));
    assert.equal(data.layoutStatus, 'known', name);
    assert.equal(data.items.length, 1, name);
    assert.ok(data.items[0].sourceLines?.length, name);
    assert.ok(!/staff|customer|reward|operator/i.test(data.items.map(item => item.item).join(' ')), name);
  }
});

test('strict layouts reject unknown mastheads instead of guessing a boutique parser', () => {
  const data = extractStrictReceipt(makeOcr(['SYNTHETIC SHOP', '15/11/2026 10:04', 'A12345 Synthetic coat 120.00', 'TOTAL 120.00', 'VISA']));
  assert.equal(data.layoutStatus, 'unknown');
  assert.deepEqual(data.items, []);
  assert.ok(data.parserReasons.some(reason => /unknown|supported/i.test(reason)));
});

test('Selfridges tolerates OCR masthead marks and reads a text-only barcode reference', () => {
  const data = extractStrictReceipt(makeOcr([
    '###',
    'SELFRIDGES&C®',
    '15/11/2026 10:04',
    'A12345 Synthetic wool coat 120.00',
    'TOTAL (1 item) 120.00',
    'VISA',
    'SYNREF20261115',
    'Customer Copy',
  ]));
  assert.equal(data.layoutStatus, 'known');
  assert.equal(data.layout, 'selfridges');
  assert.equal(data.receiptReference, 'SYNREF20261115');
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].item, 'Synthetic wool coat');
});

test('Selfridges keeps the layout known when the barcode text is unreadable', () => {
  const data = extractStrictReceipt(makeOcr([
    'noise before masthead',
    'SELFRIDGES&CO',
    'Sales Voucher',
    'Customer Copy',
    'Date B/11/26 8:37 pm',
    'Synthetic coat 120.00',
    'TOTAL 120.00',
    'Customer Copy',
  ]));
  assert.equal(data.layoutStatus, 'known');
  assert.equal(data.layout, 'selfridges');
  assert.equal(data.receiptReference, null);
  assert.ok(data.parserReasons.some(reason => /low confidence|missing|ambiguous/i.test(reason)));
});

test('Selfridges uses Product labels to join each item with its nearby price', () => {
  const data = extractStrictReceipt(makeOcr([
    'SELFRIDGES&CO',
    'Sales Voucher',
    'Customer Copy',
    'Date 15/11/26 10:04 pm',
    'Synthetic brand jacket',
    'Product: SYN-PROD-0007',
    '£120.00',
    'Synthetic brand scarf',
    'Product: SYN-PROD-0008',
    '£80.00',
    'Tax % 20%',
    'Total 2 £200.00',
    'VISA',
  ]));
  assert.equal(data.layoutStatus, 'known');
  assert.deepEqual(data.items.map(item => item.item), ['Synthetic brand jacket', 'Synthetic brand scarf']);
  assert.deepEqual(data.items.map(item => item.itemId), ['SYN-PROD-0007', 'SYN-PROD-0008']);
  assert.deepEqual(data.items.map(item => item.amount), [120, 80]);
});

test('Selfridges leaves a style-only description blank instead of exporting the code as the name', () => {
  const data = extractStrictReceipt(makeOcr([
    'SELFRIDGES&CO', 'Sales Voucher', 'Customer Copy', 'Date 15/11/26 10:04 pm',
    'Moncler 5660', 'Product: SYN-PROD-0009', '£120.00', 'Total 1 £120.00', 'VISA',
  ]));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].item, null);
  assert.equal(data.items[0].itemId, 'SYN-PROD-0009');
});

test('strict layouts exclude a priced staff or customer line when the total is OCR-confusable', () => {
  const data = extractStrictReceipt(makeOcr(['CHANEL', '15/11/2026 10:04', 'Receipt # SYN-CH-0002', 'A12345 Synthetic coat 120.00', 'T0TAL 120.00', 'StaffNo 4821 120.00', 'Customer copy 120.00']));
  assert.deepEqual(data.items.map(item => item.item), ['Synthetic coat']);
  assert.ok(!data.items.some(item => /staff|customer|total/i.test(item.item || '')));
});

test('strict Harrods blocks join split description, code, and price rows only', () => {
  const data = extractStrictReceipt(makeOcr([
    'HARRODS',
    '15/11/2026 10:04 NT1234-567890',
    '2317 9999999308 SYNTHETIC BRAND',
    'Synthetic wool coat',
    'Product Info: SYN001',
    '£120.00',
    'TOTAL (1 item) £120.00',
    'StaffNo: 4821 £120.00',
    'Citcon Payment Reference: SYN-PAY-001',
    'VISA',
  ]));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].itemId, 'SYN001');
  assert.equal(data.items[0].item, 'Synthetic wool coat');
  assert.equal(data.items[0].amount, 120);
  assert.ok(!/staff|payment|total/i.test(data.items[0].item));
});

test('strict evidence ignores footer prices and leaves tied identifiers blank', () => {
  const data = extractStrictReceipt(makeOcr([
    'HARRODS',
    '15/11/2026 10:04 NT1234-567890',
    'Synthetic wool coat',
    'Product Info: A1234',
    'Product Info: B5678',
    '£120.00',
    'TOTAL (1 item) £120.00',
    'StaffNo 4821 £120.00',
    'Customer copy £120.00',
  ]));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].item, 'Synthetic wool coat');
  assert.equal(data.items[0].itemId, null);
  assert.equal(data.items[0].brandItemId, null);
  assert.deepEqual(data.items[0].itemIdCandidates.sort(), ['A1234', 'B5678']);
  assert.ok(data.parserReasons.some(reason => /competing product identifiers/i.test(reason)));
});

test('strict evidence keeps two distinct same-price products as two rows', () => {
  const data = extractStrictReceipt(makeOcr([
    'CHANEL',
    '15/11/2026 10:04',
    'Receipt # SYN-CH-0003',
    'SYN-A1001 Synthetic coat £120.00',
    'SYN-B2002 Synthetic scarf £120.00',
    'TOTAL (2 items) £240.00',
    'VISA',
  ]));
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items.map(item => item.item), ['Synthetic coat', 'Synthetic scarf']);
  assert.deepEqual(data.items.map(item => item.itemId), ['SYN-A1001', 'SYN-B2002']);
});

test('strict evidence carries a fixed-list brand from the nearby product block', () => {
  const data = extractStrictReceipt(makeOcr([
    'HARRODS',
    '15/11/2026 10:04 NT1234-567890',
    'BULGARI',
    'Synthetic bracelet A3001 £120.00',
    'TOTAL (1 item) £120.00',
    'VISA',
  ]));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].brand, 'Bulgari');
  assert.equal(data.items[0].item, 'Synthetic bracelet');
});

test('strict evidence prefers a product description over a short colour line', () => {
  const data = extractStrictReceipt(makeOcr([
    'CHANEL',
    '15/11/2026 10:04',
    'Receipt # SYN-CH-0004',
    'CHANEL BEANIE',
    'BLK ECRU',
    'A4001 £120.00',
    'TOTAL (1 item) £120.00',
    'VISA',
  ]));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].item, 'BEANIE');
});

test('strict evidence promotes a labelled product code over a serial candidate', () => {
  const data = extractStrictReceipt(makeOcr([
    'HARRODS',
    '15/11/2026 10:04 NT1234-567890',
    'Synthetic bracelet',
    'SAP 123456',
    'SN Z9999',
    '£120.00',
    'TOTAL (1 item) £120.00',
    'VISA',
  ]));
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].itemId, '123456');
  assert.equal(data.items[0].brandItemId, '123456');
});
