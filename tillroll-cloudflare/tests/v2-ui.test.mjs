import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  receiptsFromBatch,
  buildSanityPayload,
  readingNetworkPolicy,
  setNeedsChecking,
  clearNeedsChecking,
  receiptSelectId,
} from '../../tillroll/v2.js';
import { makeOcr } from '../../tillroll/tests/ocr-fixture.mjs';

function shouldCallServerOcr(apiKey) {
  return String(apiKey ?? '').trim() === '__server__';
}

const tillrollDir = join(dirname(fileURLToPath(import.meta.url)), '../../tillroll');
const indexHtml = readFileSync(join(tillrollDir, 'index.html'), 'utf8');
const appJs = readFileSync(join(tillrollDir, 'app.js'), 'utf8');
const extractJs = readFileSync(join(tillrollDir, 'extract.js'), 'utf8');
const v2Js = readFileSync(join(tillrollDir, 'v2.js'), 'utf8');

function receipt(id, extra = {}) {
  return {
    id,
    state: 'done',
    hash: `ab${id}`.padEnd(64, '0'),
    filename: `r${id}.jpg`,
    data: {
      merchant: 'CHANEL',
      merchantDisplay: 'CHANEL',
      date: '2024-12-01',
      time: '12:00',
      orderNumber: `ORD${id}`,
      currency: 'GBP',
      payment: 'Visa',
      items: [{ brand: 'Chanel', item: 'Bag', itemId: 'A69900', amount: 4950, qty: 1 }],
    },
    ...extra,
  };
}

test('#v2-run is present in the workspace actions row after Refresh from Excel', () => {
  const actions = indexHtml.match(/<div class="actions">([\s\S]*?)<\/div><\/div>\s*<div id="summary"/);
  assert.ok(actions, 'workspace actions row missing');
  const row = actions[1];
  const button = '<button id="v2-run" class="v2-only" title="Start the bots\' review and show only the final agreed version">Run sanity checks</button>';
  assert.equal(row.includes(button), true, 'exact bbc1220 #v2-run button in the workspace actions row');
  assert.ok(row.indexOf('id="refresh-excel"') < row.indexOf('id="v2-run"'), 'button should follow Refresh from Excel');
  assert.ok(row.indexOf('id="v2-run"') < row.indexOf('id="excel"'), 'button should precede Export Excel');
  assert.equal(/id="v2-run"[^>]*\bhidden\b/.test(row), false);
  assert.match(indexHtml, /id="v2-check-all"/);
  assert.match(indexHtml, /All in this batch/);
});

test('buildSanityPayload sends the whole batch when nothing is selected', () => {
  const batch = [receipt(1), receipt(2)];
  const payload = buildSanityPayload(batch, new Set());
  assert.equal(payload.scope, 'batch');
  assert.equal(payload.receipts.length, 2);
  assert.equal(payload.selectedCount, 0);
  assert.equal(payload.batchCount, 2);
  assert.match(payload.label, /whole batch \(2 receipts\)/);
  assert.deepEqual(payload.receipts.map(r => r.id), [1, 2]);
});

test('buildSanityPayload sends only receipts marked as needing checking', () => {
  const batch = [receipt(1), receipt(2), receipt(3)];
  const payload = buildSanityPayload(batch, new Set([2, 3]));
  assert.equal(payload.scope, 'selected');
  assert.equal(payload.receipts.length, 2);
  assert.deepEqual(payload.receipts.map(r => receiptSelectId(r)), [2, 3]);
  assert.match(payload.label, /2 selected receipts marked as needing checking/);
});

test('needs-checking helpers feed the same selection payload used by runSanity', () => {
  clearNeedsChecking();
  setNeedsChecking(1, true);
  const payload = buildSanityPayload([receipt(1), receipt(2)]);
  assert.equal(payload.scope, 'selected');
  assert.deepEqual(payload.receipts.map(r => r.id), [1]);
  clearNeedsChecking();
});

test('receiptsFromBatch keeps the receipt id used for selection', () => {
  const [row] = receiptsFromBatch([receipt(7)]);
  assert.equal(row.id, 7);
  assert.ok(row.receiptKey);
  assert.equal(row.items.length, 1);
});

test('production sanity payload preserves strict layout, gate, totals, and OCR line evidence', () => {
  const row = receipt(8, {
    url: 'blob:synthetic-receipt',
    ocr: makeOcr([
      'HARRODS',
      '15/11/2026 10:04 NT1234-567890',
      '2469 9999991234 Chanel A12345 Synthetic wool coat 120.00 120.00',
      'TOTAL (1 item) 120.00',
      'VISA',
    ]),
  });
  const [payload] = receiptsFromBatch([row]);
  assert.equal(payload.layout, 'harrods');
  assert.equal(payload.layoutStatus, 'known');
  assert.equal(payload.gateRequired, true);
  assert.equal(payload.total, 120);
  assert.equal(payload.itemCount, 1);
  assert.equal(payload.receiptReference, 'NT1234-567890');
  assert.deepEqual(payload.items[0].sourceLines, [3]);
  assert.equal(payload.imageLink, 'blob:synthetic-receipt');
});

// Upload network policy: app.js run() + extract.js extractAI, with a mocked fetch.
async function simulateUploadReads({ mode, apiKey }, fetchImpl) {
  const policy = readingNetworkPolicy(mode, apiKey);
  const modelEnabled = mode === 'server' && !!apiKey;
  // Mirror app.js: extractAI is only scheduled when the server reader is on.
  if (modelEnabled && shouldCallServerOcr(apiKey)) {
    await fetchImpl('/api/ocr', { method: 'POST', body: '{}' });
  }
  // /api/sanity-run and /api/lookup must not be called from upload, regardless of reader.
  if (policy.mayCallSanityRun) await fetchImpl('/api/sanity-run', { method: 'POST' });
  if (policy.mayCallLookup) await fetchImpl('/api/lookup', { method: 'POST' });
  return policy;
}

test('default local upload never calls /api/sanity-run, /api/lookup or /api/ocr (mocked fetch)', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    return { ok: true, json: async () => ({}) };
  };
  assert.equal(readingNetworkPolicy('local', '').mayCallOcr, false);
  await simulateUploadReads({ mode: 'local', apiKey: '' }, fetchImpl);
  assert.deepEqual(calls, []);
});

test('Tillroll server reader upload may call /api/ocr only (mocked fetch)', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({}) };
  };
  assert.equal(shouldCallServerOcr('__server__'), true);
  assert.equal(shouldCallServerOcr('AIza-client-key'), false);
  await simulateUploadReads({ mode: 'server', apiKey: '__server__' }, fetchImpl);
  assert.deepEqual(calls, ['/api/ocr']);
  assert.ok(!calls.some(u => u.includes('/api/sanity-run') || u.includes('/api/lookup')));
});

test('app.js upload path does not call /api/sanity-run or /api/lookup; /api/ocr is server-reader only', () => {
  const runFn = appJs.match(/async function run\(r\)\{[\s\S]*?finally\{r\.elapsed=/);
  assert.ok(runFn, 'run() not found');
  assert.doesNotMatch(runFn[0], /\/api\/sanity-run/);
  assert.doesNotMatch(runFn[0], /\/api\/lookup/);
  assert.doesNotMatch(appJs, /fetch\(['`]\/api\/(?:sanity-run|lookup)/);
  assert.doesNotMatch(extractJs, /\/api\/sanity-run|\/api\/lookup/);
  // extractAI posts /api/ocr only when shouldCallServerOcr (Settings reader = Tillroll server).
  assert.match(extractJs, /const viaServer = shouldCallServerOcr\(apiKey\);/);
  assert.match(extractJs, /viaServer\s*\n\s*\? await fetch\('\/api\/ocr'/);
  // v2.js is the only client caller of sanity-run / lookup, from the button handlers.
  assert.match(v2Js, /\$\('#v2-run'\)\?\.addEventListener\('click', runSanity\)/);
  assert.match(v2Js, /api\('\/api\/sanity-run'/);
  assert.equal(appJs.includes("let mode='local'"), true);
});
