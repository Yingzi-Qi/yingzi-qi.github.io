import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeReadings } from '../reading-comparison.js';

test('typographic apostrophe changes do not create an item-name reading error', () => {
  const first = {
    merchant: 'Fnac',
    items: [{ item: "AFFAIRES D'E/PENET/R", itemId: '9782344057339', amount: 14.95 }],
  };
  const second = {
    merchant: 'Fnac',
    items: [{ item: 'AFFAIRES D’E/PENET/R', itemId: '9782344057339', amount: 14.95 }],
  };

  const { conflicts } = mergeReadings(first, second);

  assert.equal(conflicts.length, 0);
});

test('hyphen glyph changes do not create a product-line pairing error', () => {
  const first = {
    items: [{ item: 'Warm-up jacket', itemId: 'STYLE-1', amount: 49.9 }],
  };
  const second = {
    items: [{ item: 'Warm‑up jacket', itemId: 'STYLE-1', amount: 49.9 }],
  };

  const { conflicts } = mergeReadings(first, second);

  assert.equal(conflicts.length, 0);
});

test('a unique one-character item-name OCR typo keeps the row paired', () => {
  const first = {
    items: [
      { item: 'AIRism cotton T', qty: 1, amount: 49.9 },
      { item: "W's briefs", qty: 1, amount: 24.9 },
    ],
  };
  const second = {
    items: [
      { item: 'AlIRism cotton T', qty: 1, amount: 49.9 },
      { item: "W's briefs", qty: 1, amount: 24.9 },
    ],
  };

  const { conflicts } = mergeReadings(first, second);

  assert.equal(conflicts.some(issue => issue.field === 'items'), false);
  assert.ok(conflicts.some(issue => issue.field === 'items.0.item'));
});

test('a positional fallback refuses contradictory item identifiers', () => {
  const first = { items: [{ item: 'AIRism cotton T', itemId: 'A1', qty: 1, amount: 49.9 }] };
  const second = { items: [{ item: 'AlIRism cotton T', itemId: 'B2', qty: 1, amount: 49.9 }] };

  const { conflicts } = mergeReadings(first, second);

  assert.ok(conflicts.some(issue => issue.field === 'items'));
});
