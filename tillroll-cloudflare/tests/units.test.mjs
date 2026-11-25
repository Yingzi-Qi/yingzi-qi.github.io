import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { round2, allocateProportional, expandReceipt, fromPence, supplierVisibleName } from '../../tillroll/units.js';

const SAMPLES = JSON.parse(readFileSync(new URL('../../tillroll/real-samples/index.json', import.meta.url), 'utf8'));

test('rowId format is {receiptKey}:{lineIndex}:u{unitIndex}', () => {
  const { items } = expandReceipt({
    receiptKey: 'r1',
    items: [{ item: 'A', qty: 2, unitPrice: 10, amount: 20 }],
  });
  assert.deepEqual(items.map(it => it.rowId), ['r1:0:u0', 'r1:0:u1']);
  assert.equal(items[0].unitIndex, 0);
  assert.equal(items[1].unitIndex, 1);
  assert.equal(items[0].lineIndex, 0);
});

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

test('qty 3 with a line discount: proportional by 原价, remainder on last, estimated: true', () => {
  const { items } = expandReceipt({
    receiptKey: 'r',
    items: [{ item: 'A', lineIndex: 0, qty: 3, unitPrice: 100, amount: 290 }],
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(it => it.unitPrice), [100, 100, 100]);
  assert.deepEqual(items.map(it => it.amount), [96.67, 96.67, 96.66]);
  assert.equal(round2(items.reduce((s, it) => s + it.amount, 0)), 290);
  assert.ok(items.every(it => it.estimated === true && it.discountKind === 'estimated'));
  assert.deepEqual(items.map(it => it.rowId), ['r:0:u0', 'r:0:u1', 'r:0:u2']);
});

test('printed per-item discount is used exactly and is not estimated', () => {
  const { items } = expandReceipt({
    receiptKey: 'r',
    items: [{ item: 'A', lineIndex: 1, qty: 3, unitPrice: 100, amount: 270, unitDiscount: 10 }],
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(it => it.amount), [90, 90, 90]);
  assert.ok(items.every(it => it.estimated === false && it.discountKind === 'printed'));
});

test('printed per-item discount takes precedence over a conflicting line total', () => {
  // amount 250 would imply a 50 split; unitDiscount 10 must win (90 each).
  const { items } = expandReceipt({
    receiptKey: 'r',
    items: [{ item: 'A', qty: 3, unitPrice: 100, amount: 250, unitDiscount: 10 }],
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(it => it.amount), [90, 90, 90]);
  assert.ok(items.every(it => it.estimated === false && it.discountKind === 'printed'));
});

test('qty 1 line discount is exact (no allocation, not estimated)', () => {
  const { items } = expandReceipt({
    receiptKey: 'r',
    items: [{ item: 'A', qty: 1, unitPrice: 50, amount: 40 }],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].amount, 40);
  assert.equal(items[0].unitPrice, 50);
  assert.equal(items[0].estimated, false);
  assert.equal(items[0].discountKind, 'printed');
});

test('mixed-price receipt-level discount is allocated by 原价 across non-excluded units', () => {
  const { items } = expandReceipt({
    receiptKey: 'mix',
    discount: 20,
    total: 180,
    items: [
      { item: 'A', lineIndex: 0, qty: 1, unitPrice: 100, amount: 100 },
      { item: 'B', lineIndex: 1, qty: 2, unitPrice: 50, amount: 100 },
    ],
  });
  assert.equal(items.length, 3);
  assert.deepEqual(items.map(it => it.unitPrice), [100, 50, 50]);
  assert.deepEqual(items.map(it => it.amount), [90, 45, 45]);
  assert.equal(round2(items.reduce((s, it) => s + it.amount, 0)), 180);
  assert.ok(items.every(it => it.estimated === true && it.discountKind === 'estimated'));
});

test('remainder case: leftover pennies land on the last weighted row', () => {
  // allocateProportional rounds earlier rows, remainder on last weighted row.
  const shares = allocateProportional([1000, 2000, 3000], 1000);
  assert.equal(shares.reduce((a, b) => a + b, 0), 1000);
  assert.equal(shares[2], 1000 - shares[0] - shares[1]);
  const { items } = expandReceipt({
    receiptKey: 'rem',
    discount: 10,
    total: 50,
    items: [
      { item: 'A', lineIndex: 0, qty: 1, unitPrice: 10, amount: 10 },
      { item: 'B', lineIndex: 1, qty: 1, unitPrice: 20, amount: 20 },
      { item: 'C', lineIndex: 2, qty: 1, unitPrice: 30, amount: 30 },
    ],
  });
  const paid = items.map(it => it.amount);
  assert.equal(round2(paid.reduce((a, b) => a + b, 0)), 50);
  assert.ok(items.every(it => it.estimated === true));
});
