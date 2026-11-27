import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { matchInitialItem, normaliseInitialReceipt } from '../functions/_lib/initial-reader.js';
import { onRequestPost } from '../functions/api/initial-reader.js';
import { makeEnv } from './helpers.mjs';

const migration = readFileSync(new URL('../migrations/0003_initial_reader.sql', import.meta.url), 'utf8');
function initialEnv() {
  const env = makeEnv();
  env.DB._db.exec(migration);
  return env;
}
function request(body) {
  return new Request('https://tillroll.test/api/initial-reader', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('normalises a complete synthetic receipt and keeps optional clues', () => {
  const result = normaliseInitialReceipt({
    receiptId: { value: 'SYN-2048', confidence: 0.99 },
    date: { value: '2026-11-27', confidence: 0.98 },
    time: { value: '09:04', confidence: 0.98 },
    paymentMethod: { value: 'Apple Pay', confidence: 0.99 },
    totalPaid: '120.00',
    items: [{ quantity: 1, itemPrice: '120.00', purchasePrice: '120.00', brand: 'Synthetic House', name: 'Canvas Tote', reference: 'SYN-TOTE-1' }],
    evidence: { source: 'synthetic-local-ocr' },
  });
  assert.equal(result.paymentMethod, 'Card');
  assert.equal(result.time, '09:04:00');
  assert.equal(result.items[0].reference, 'SYN-TOTE-1');
  assert.equal(result.flags.length, 0);
  assert.equal(result.reviewRequired, false);
});

test('flags missing fundamentals and a split payment without inventing values', () => {
  const result = normaliseInitialReceipt({
    date: '2026-11-27',
    paymentMethods: ['Card', 'WeChat'],
    totalPaid: '80.00',
    items: [{ price: '80.00', name: 'Synthetic Shirt' }],
  });
  assert.equal(result.receiptId, null);
  assert.equal(result.time, null);
  assert.equal(result.paymentMethod, null);
  assert.equal(result.items[0].purchasePrice, 80);
  assert.ok(result.flags.some(flag => flag.code === 'split_payment'));
  assert.ok(result.flags.some(flag => flag.field === 'receiptId'));
  assert.ok(result.flags.some(flag => flag.field === 'time'));
  assert.ok(result.reviewRequired);
});

test('blanks low-confidence fundamentals and flags a priced line with no search clue', () => {
  const result = normaliseInitialReceipt({
    receiptId: { value: 'SYN-LOW-1', confidence: 0.4 },
    date: '2026-11-27',
    time: '11:11',
    paymentMethod: { value: 'Card', confidence: 0.4 },
    totalPaid: '12.00',
    items: [{ itemPrice: { value: '12.00', confidence: 0.4 }, purchasePrice: '12.00' }],
  });
  assert.equal(result.receiptId, null);
  assert.equal(result.paymentMethod, null);
  assert.equal(result.items[0].itemPrice, null);
  assert.ok(result.flags.some(flag => flag.field === 'items[0].clue' && flag.code === 'missing_item_clue'));
});

test('requires exact price and a clue for an accepted catalogue match', () => {
  const item = { itemPrice: 120, brand: 'Synthetic House', name: 'Canvas Tote', reference: 'SYN-TOTE-1' };
  const exact = matchInitialItem(item, [{ brand: 'Synthetic House', itemId: 'SYN-TOTE-1', officialName: 'Canvas Tote', price: 120, currency: 'GBP', sourceUrl: 'https://synthetic.example/tote' }], '2026-11-27T09:00:00.000Z');
  assert.equal(exact.status, 'accepted');
  assert.equal(exact.officialMatch.reference, 'SYN-TOTE-1');
  assert.equal(exact.officialMatch.sourceUrl, 'https://synthetic.example/tote');

  const mismatch = matchInitialItem(item, [{ brand: 'Synthetic House', itemId: 'SYN-TOTE-1', officialName: 'Canvas Tote', price: 121, currency: 'GBP' }], '2026-11-27T09:00:00.000Z');
  assert.equal(mismatch.status, 'review');
  assert.equal(mismatch.officialMatch, null);
  assert.equal(mismatch.matchType, 'nearest-price-review');
});

test('fallback prefers a more expensive candidate, then lighter weight, and remains review-only', () => {
  const item = { itemPrice: 100, brand: 'Synthetic House', name: 'Pouch' };
  const result = matchInitialItem(item, [
    { brand: 'Synthetic House', itemId: 'SYN-CHEAP', officialName: 'Pouch', price: 99, weightGrams: 90, sourceUrl: 'https://synthetic.example/cheap' },
    { brand: 'Synthetic House', itemId: 'SYN-DEAR', officialName: 'Pouch', price: 101, weightGrams: 140, sourceUrl: 'https://synthetic.example/dear' },
    { brand: 'Synthetic House', itemId: 'SYN-DEAR-LIGHT', officialName: 'Pouch', price: 101, weightGrams: 80, sourceUrl: 'https://synthetic.example/dear-light' },
  ], '2026-11-27T09:00:00.000Z');
  assert.equal(result.status, 'review');
  assert.equal(result.officialMatch, null);
  assert.equal(result.candidates[0].reference, 'SYN-DEAR-LIGHT');
});

test('server endpoint reads the deterministic catalogue and persists the reviewable result', async () => {
  const env = initialEnv();
  env.DB._db.prepare('INSERT INTO catalogue_items (brand, item_id, official_name, price_pence, currency, source_url, weight_grams) VALUES (?, ?, ?, ?, ?, ?, ?)').run('Synthetic House', 'SYN-BAG-2', 'Structured Bag', 25000, 'GBP', 'https://synthetic.example/bag', 300);
  const response = await onRequestPost({ request: request({ reading: {
    receiptId: 'SYN-REC-2', date: '2026-11-27', time: '10:20:00', paymentMethod: 'Card', totalPaid: 250,
    imageHash: 'synthetic-image-hash-2', items: [{ itemPrice: 250, purchasePrice: 250, brand: 'Synthetic House', name: 'Structured Bag', reference: 'SYN-BAG-2' }],
  } }), env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.matches[0].status, 'accepted');
  assert.equal(body.matches[0].officialMatch.sourceUrl, 'https://synthetic.example/bag');
  assert.ok(body.readingId);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM initial_receipt_readings').get().n, 1);
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM initial_receipt_lines').get().n, 1);
});
