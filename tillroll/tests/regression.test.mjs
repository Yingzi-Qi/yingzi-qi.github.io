// Regression gate over the cached OCR in samples/ and real-samples/.
// Every scored metric must stay at or above the baseline recorded before the v2 reader changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sets, scoreSet, scoredMetrics} from './harness.mjs';

const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'));
const hits = value => typeof value === 'object' && value ? value.hits : value;

for (const name of sets) {
  test(`${name}: no scored metric falls below the baseline`, async () => {
    const now = await scoreSet(name);
    const before = baseline[name];
    assert.equal(now.receipts, before.receipts, 'fixture count changed');
    for (const metric of scoredMetrics)
      assert.ok(hits(now[metric]) >= hits(before[metric]),
        `${name}.${metric}: ${JSON.stringify(now[metric])} < baseline ${JSON.stringify(before[metric])}`);
  });
}
