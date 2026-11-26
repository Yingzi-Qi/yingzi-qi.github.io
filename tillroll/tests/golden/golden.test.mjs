import test from 'node:test';
import assert from 'node:assert/strict';
import {goldenDataset} from './fixtures.mjs';
import {GOLDEN_COLUMNS, scoreGolden} from './golden-scorer.mjs';

test('production golden batch exports only passing receipts and reports every field', async () => {
  const score = await scoreGolden(goldenDataset);
  assert.equal(score.columns.length, GOLDEN_COLUMNS.length);
  assert.equal(score.wrong, 0);
  assert.equal(score.unsupportedFlags, 0);
  assert.equal(score.exported, 1);
  assert.equal(score.exportedPass, 1);
  assert.equal(score.clean, 1);
  assert.equal(score.cleanPct, 33.33);
  assert.equal(score.receipts, 3);
  assert.equal(score.exportedGatePassPct, 100);
});

test('a synthetic mutation is WRONG and cannot be clean', async () => {
  const mutated = structuredClone(goldenDataset);
  mutated.fixtures[0].expected.rows[0]['品名'] = 'Synthetic wrong name';
  const score = await scoreGolden(mutated);
  assert.ok(score.wrong > 0);
  assert.equal(score.clean, 0);
});

