import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBrand, brandSearchPhrases } from '../functions/_lib/brands.js';
import { sortItemFields, hasNonBrandWord, isNumericPrice } from '../../tillroll/field-sorter.js';
import { runSanity, PINK } from '../functions/_lib/sanity.js';
import { makeEnv } from './helpers.mjs';

const opts = { canonicalBrand, phrases: brandSearchPhrases() };

function receipt(items, extra = {}) {
  return {
    receiptKey: extra.receiptKey || 'fs1', merchant: 'Selfridges', receiptReference: 'F1',
    date: '2026-11-20', time: '12:00', payment: 'Visa', currency: 'GBP', items, ...extra,
  };
}

test('field-sorter: brand-only and code+brand names have no non-brand word', () => {
  const brandOnly = sortItemFields({ brand: '', name: 'Christian Dior' }, opts);
  assert.equal(brandOnly.brand, 'Dior');
  assert.equal(brandOnly.brandMoved, true);
  assert.equal(brandOnly.brandOnly, true);
  assert.equal(brandOnly.nameHasNonBrandWord, false);
  assert.equal(brandOnly.junk, true);

  const codeBrand = sortItemFields({ brand: '', name: '9999991234 Christian Dior' }, opts);
  assert.equal(codeBrand.brand, 'Dior');
  assert.equal(codeBrand.brandMoved, true);
  assert.equal(codeBrand.codePlusBrand, true);
  assert.equal(codeBrand.nameHasNonBrandWord, false);
  assert.equal(hasNonBrandWord('9999991234 Christian Dior', 'Christian Dior', opts), false);
});

test('field-sorter: derive 品牌 from 品名 and leave the non-brand words', () => {
  const s = sortItemFields({ brand: '', name: 'Christian Dior Saddle bag' }, opts);
  assert.equal(s.brand, 'Dior');
  assert.equal(s.name, 'Saddle bag');
  assert.equal(s.brandMoved, true);
  assert.equal(s.nameHasNonBrandWord, true);
  assert.equal(s.junk, false);
});

test('field-sorter: prices must be numeric', () => {
  assert.equal(isNumericPrice(4950), true);
  assert.equal(isNumericPrice('£4,950.00'), true);
  assert.equal(isNumericPrice(''), null);
  assert.equal(isNumericPrice(null), null);
  assert.equal(isNumericPrice('N/A'), false);
  assert.equal(isNumericPrice('twelve'), false);
});

test('readerStage runs field-sorter before verifier: brand moved from 品名 is Pink, leftover name kept', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, {
    mode: 'round1',
    receipts: [receipt([{ brand: '', item: 'Christian Dior Saddle bag', itemId: 'M0565', qty: 1, unitPrice: 3500, amount: 3500 }])],
  });
  const row = result.agreedRows[0];
  assert.equal(row.cells['品牌'], 'Dior');
  assert.match(row.cells['品名'], /Saddle bag/);
  assert.equal(row.flags['品牌'], PINK);
  assert.ok(result.readingErrors.some(e => e.col === '品牌' && /taken from the item name/.test(e.reason)));
});

test('readerStage: brand-only and code+brand 品名 are Pink; non-numeric prices are Pink', async () => {
  const env = makeEnv();
  const { result } = await runSanity(env, {
    mode: 'round1',
    receipts: [
      receipt([
        { brand: 'Dior', item: 'Christian Dior', itemId: 'X1', qty: 1, unitPrice: 10, amount: 10 },
        { brand: '', item: '9999991234 Christian Dior', itemId: 'X2', qty: 1, unitPrice: 10, amount: 10 },
        { brand: 'Dior', item: 'Saddle bag', itemId: 'X3', qty: 1, unitPrice: 'twelve pounds', amount: 'twelve pounds' },
      ], { receiptKey: 'fs-gates' }),
    ],
  });
  const byName = name => result.agreedRows.find(r => r.cells['品名'] === name);
  const x1 = byName('Christian Dior'), x2 = result.agreedRows.find(r => /9999991234/.test(r.cells['品名'] || '')), x3 = byName('Saddle bag');
  assert.ok(x1 && x2 && x3);
  // Look-ups are paused without keys, so a later Amber on 品名 is mixed-colour; the reader still recorded Pink.
  assert.ok(result.readingErrors.some(e => e.rowId === x1.rowId && e.col === '品名' && /no non-brand word/.test(e.reason)));
  assert.ok(result.readingErrors.some(e => e.rowId === x2.rowId && e.col === '品名' && /product code plus the brand|no non-brand word/.test(e.reason)));
  assert.equal(x2.cells['品牌'], 'Dior');
  assert.equal(x2.flags['品牌'], PINK);
  assert.ok(result.readingErrors.some(e => e.rowId === x2.rowId && e.col === '品牌' && /taken from the item name/.test(e.reason)));
  assert.ok(x3.flags['采购商品原价'] === PINK || x3.flags['采购商品金额'] === PINK);
  assert.ok(result.readingErrors.some(e => e.rowId === x3.rowId && /Price (is )?not numeric/.test(e.reason)));
});
