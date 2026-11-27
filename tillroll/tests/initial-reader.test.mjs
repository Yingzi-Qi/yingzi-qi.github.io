import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseInitialReceipt,
  normaliseInitialDate,
  normaliseInitialTime,
  parseInitialMoney,
} from '../initial-reader.js';

test('normalises a complete synthetic receipt without guessing optional clues', () => {
  const result = normaliseInitialReceipt({
    receiptId: { value: 'SYN-2048-19', confidence: 0.98, method: 'ocr' },
    date: '14/02/2026',
    time: '2:07 pm',
    paymentMethod: 'Apple Pay',
    totalPaid: '£128.40',
    items: [{
      itemPrice: '£160.00',
      purchasePrice: '£128.40',
      brand: 'Example Atelier',
      name: 'Canvas Weekender',
      reference: 'EA-2048',
    }],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.reviewRequired, false);
  assert.equal(result.receiptId, 'SYN-2048-19');
  assert.equal(result.date, '2026-02-14');
  assert.equal(result.time, '14:07:00');
  assert.equal(result.paymentMethod, 'Card');
  assert.equal(result.totalPaid, 128.4);
  assert.deepEqual(result.items[0], {
    index: 0,
    quantity: 1,
    itemPrice: 160,
    purchasePrice: 128.4,
    brand: 'Example Atelier',
    name: 'Canvas Weekender',
    reference: 'EA-2048',
    evidence: result.items[0].evidence,
  });
  assert.deepEqual(result.flags, []);
});

test('flags unreadable fundamentals and keeps all uncertain values blank', () => {
  const result = normaliseInitialReceipt({
    receiptId: { candidates: ['SYN-A', 'SYN-B'], confidence: 0.91 },
    date: { value: '31/02/2026', confidence: 0.95 },
    time: { value: '25:71', confidence: 0.99 },
    paymentMethod: { value: 'mystery tender', confidence: 0.99 },
    items: [{ itemPrice: { value: 'noise', confidence: 0.92 }, purchasePrice: '£0.00' }],
  });

  assert.equal(result.status, 'review');
  assert.equal(result.receiptId, null);
  assert.equal(result.date, null);
  assert.equal(result.time, null);
  assert.equal(result.paymentMethod, null);
  assert.equal(result.items[0].itemPrice, null);
  assert.equal(result.items[0].purchasePrice, null);
  assert.ok(result.flags.some(flag => flag.code === 'ambiguous_receipt_id'));
  assert.ok(result.flags.some(flag => flag.code === 'invalid_date'));
  assert.ok(result.flags.some(flag => flag.code === 'invalid_time'));
  assert.ok(result.flags.some(flag => flag.code === 'unsupported_payment_method'));
  assert.ok(result.flags.some(flag => flag.code === 'invalid_items_0_item_price'));
  assert.ok(result.flags.some(flag => flag.code === 'invalid_purchase_price'));
});

test('flags split tender payments instead of selecting one payment method', () => {
  const result = normaliseInitialReceipt({
    receiptId: 'SYN-SPLIT-1',
    date: '2026-03-05',
    time: '09:10',
    payments: ['Visa', 'UnionPay'],
    totalPaid: '£75.00',
    items: [{ itemPrice: '£75.00', purchasePrice: '£75.00' }],
  });

  assert.equal(result.paymentMethod, null);
  assert.deepEqual(result.paymentMethods, ['Card', 'UnionPay']);
  assert.equal(result.flags.filter(flag => flag.code === 'split_payment').length, 1);
  assert.equal(result.status, 'review');
});

test('supports aliases and preserves optional brand, name, and reference independently', () => {
  const result = normaliseInitialReceipt({
    orderNumber: 'SYN-ALIAS-5',
    purchaseDate: '2026/04/09',
    purchaseTime: '00:05:09',
    tender: 'WeChat',
    amountPaid: 42.5,
    items: [{ unitPrice: 50, lineAmount: 42.5, brandName: 'Example House', productName: 'Zip Pouch', sku: 'EH-5' }],
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.receiptId, 'SYN-ALIAS-5');
  assert.equal(result.date, '2026-04-09');
  assert.equal(result.time, '00:05:09');
  assert.equal(result.paymentMethod, 'WeChat');
  assert.equal(result.items[0].brand, 'Example House');
  assert.equal(result.items[0].name, 'Zip Pouch');
  assert.equal(result.items[0].reference, 'EH-5');
});

test('date, time, and money helpers reject malformed values deterministically', () => {
  assert.equal(normaliseInitialDate('29/02/2025'), null);
  assert.equal(normaliseInitialDate('2026-02-29'), null);
  assert.equal(normaliseInitialDate('09.04.2026'), '2026-04-09');
  assert.equal(normaliseInitialTime('12:00 am'), '00:00:00');
  assert.equal(normaliseInitialTime('12:00 pm'), '12:00:00');
  assert.equal(normaliseInitialTime('24:00'), null);
  assert.equal(parseInitialMoney('£1,204.50'), 1204.5);
  assert.equal(parseInitialMoney('12.345'), null);
});
