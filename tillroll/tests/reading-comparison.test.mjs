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
