import test from 'node:test';
import assert from 'node:assert/strict';
import {formatVisibleCells, titleCaseWords} from '../text-format.js';

test('format-only cleaning title-cases each human text word', () => {
  assert.equal(titleCaseWords('harrods london'), 'Harrods London');
  assert.equal(titleCaseWords('WALLET ON CHAIN'), 'Wallet On Chain');
  assert.equal(titleCaseWords("loro-piana's scarf"), "Loro-Piana's Scarf");
  assert.equal(titleCaseWords("O'NEIL WALLET"), "O'Neil Wallet");
  assert.equal(titleCaseWords('hermès'), 'Hermès');
});

test('format-only cleaning leaves structured identifiers and numbers unchanged', () => {
  const cells = formatVisibleCells({
    '采购小票id': 'nt1234-abcdef',
    '采购时间': '2026-11-15 10:04:00',
    '供应商': 'harrods london',
    '品牌': 'loro piana',
    '品名': 'WALLET ON CHAIN',
    '品牌货号': 'aB-001x',
    '采购商品原价': 120,
    '采购商品金额': 110,
    '采购商品方法': 'card',
    '销售金额': 105.6,
  });
  assert.equal(cells['采购小票id'], 'nt1234-abcdef');
  assert.equal(cells['采购时间'], '2026-11-15 10:04:00');
  assert.equal(cells['供应商'], 'Harrods London');
  assert.equal(cells['品牌'], 'Loro Piana');
  assert.equal(cells['品名'], 'Wallet On Chain');
  assert.equal(cells['品牌货号'], 'aB-001x');
  assert.equal(cells['采购商品原价'], 120);
  assert.equal(cells['采购商品方法'], 'Card');
});
