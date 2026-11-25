import test from 'node:test';
import assert from 'node:assert/strict';
import { round2, allocateProportionally, splitLineToUnits, splitReceiptToUnits, unitRowId, printedPerItemDiscount } from '../../tillroll/units.js';

test('unit row ids are distinct per unit of a line', () => {
  assert.equal(unitRowId('r1', 0, 0), 'r1:0:0');
  assert.equal(unitRowId('r1', 0, 1), 'r1:0:1');
});

test('qty 3 with a line discount: proportional by 原价, remainder on last, estimated', () => {
  const units = splitLineToUnits({ lineIndex: 0, qty: 3, unitPrice: 100, amount: 290, lineDiscount: 10, cells: { '采购小票id': 'A', '采购时间': '2026-11-20 15:00:00' } }, { receiptKey: 'r' });
  assert.equal(units.length, 3);
  assert.deepEqual(units.map(u => u.cells['采购商品原价']), [100, 100, 100]);
  assert.deepEqual(units.map(u => u.cells['采购商品金额']), [96.67, 96.67, 96.66]);
  assert.equal(round2(units.reduce((s, u) => s + u.cells['采购商品金额'], 0)), 290);
  assert.ok(units.every(u => u.estimated === true));
  assert.ok(units.every(u => u.flags['采购商品金额'] === '#FDE68A'));
  assert.deepEqual(units.map(u => u.rowId), ['r:0:0', 'r:0:1', 'r:0:2']);
  assert.ok(units.every(u => u.cells['采购小票id'] === 'A' && u.cells['采购时间'] === '2026-11-20 15:00:00'));
  assert.equal(units[0].cells['销售金额'], 88);
});

test('printed per-item discount is used exactly and is not estimated', () => {
  const units = splitLineToUnits({ lineIndex: 1, qty: 3, unitPrice: 100, amount: 270, unitDiscount: 10, cells: {} }, { receiptKey: 'r' });
  assert.equal(units.length, 3);
  assert.deepEqual(units.map(u => u.cells['采购商品金额']), [90, 90, 90]);
  assert.ok(units.every(u => u.estimated === false));
  assert.ok(units.every(u => u.flags['采购商品金额'] === undefined));
  assert.equal(printedPerItemDiscount({ unitDiscount: 10 }), 10);
});

test('qty 1 line discount is exact (no allocation)', () => {
  const units = splitLineToUnits({ lineIndex: 0, qty: 1, unitPrice: 50, amount: 40, lineDiscount: 10, cells: {} }, { receiptKey: 'r' });
  assert.equal(units.length, 1);
  assert.equal(units[0].cells['采购商品金额'], 40);
  assert.equal(units[0].estimated, false);
});

test('mixed-price receipt-level discount is allocated by 原价 across non-excluded units', () => {
  const units = splitReceiptToUnits({ receiptKey: 'mix', receiptDiscount: 20 }, [
    { lineIndex: 0, qty: 1, unitPrice: 100, amount: 100, cells: { '品名': 'A' } },
    { lineIndex: 1, qty: 2, unitPrice: 50, amount: 100, cells: { '品名': 'B' } },
  ]);
  assert.equal(units.length, 3);
  // weights 100, 50, 50 = 200; 20 * share = 10, 5, 5
  assert.deepEqual(units.map(u => u.cells['采购商品原价']), [100, 50, 50]);
  assert.deepEqual(units.map(u => u.cells['采购商品金额']), [90, 45, 45]);
  assert.equal(round2(units.reduce((s, u) => s + u.cells['采购商品金额'], 0)), 180);
  assert.ok(units.every(u => u.estimated === true && u.flags['采购商品金额'] === '#FDE68A'));
});

test('remainder case: leftover pennies land on the last unit row', () => {
  assert.deepEqual(allocateProportionally(10, [10, 10, 10]), [3.33, 3.33, 3.34]);
  const units = splitReceiptToUnits({ receiptKey: 'rem', receiptDiscount: 10 }, [
    { lineIndex: 0, qty: 1, unitPrice: 10, amount: 10, cells: {} },
    { lineIndex: 1, qty: 1, unitPrice: 20, amount: 20, cells: {} },
    { lineIndex: 2, qty: 1, unitPrice: 30, amount: 30, cells: {} },
  ]);
  // 1000 cents over weights 10,20,30: 166 + 333 + 500 = 999, last gets +1 → 1.66, 3.33, 5.01
  assert.deepEqual(units.map(u => u.cells['采购商品金额']), [8.34, 16.67, 24.99]);
  assert.equal(round2(units.reduce((s, u) => s + u.cells['采购商品金额'], 0)), 50);
});
