import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitiseRunInput } from '../functions/_lib/sanitise-run-input.js';
import { createRun, processRun, getRun } from '../functions/_lib/runs.js';
import { PINK, TENDER_REASON } from '../functions/_lib/sanity.js';
import { makeEnv } from './helpers.mjs';

const LAST4 = '8491';
const AUTH = '92B4471';
const SHORT_AUTH = '44B2';
const SHORT_CVV = '123';
const MID = '5510238891';
const TID = '87654321';
const PAN = '4111111111111111';
const SPACED_PAN = '4111 1111 1111 1111';
const STYLE = 'ST8491';
const RECEIPT_REF = 'SYN-8491';
const EAN = '1238491999990';
const AMOUNT_TEXT = '8491.00';
const PRODUCT = 'Pendant 8491';
const BOX_NOTE = 'BOX-123';

function storedJson(env, runId) {
  return env.DB._db.prepare('SELECT input_json FROM sanity_runs WHERE run_id=?').get(runId).input_json;
}

test('sanitiseRunInput clones the payload and leaves the original intact', () => {
  const original = {
    batchId: 'b_clone',
    mode: 'round1',
    receipts: [{
      merchant: 'Synthetic Boutique',
      payment: 'Cash',
      last4: LAST4,
      cardNumber: PAN,
      styleRef: STYLE,
      receiptReference: RECEIPT_REF,
      items: [{ item: PRODUCT, unitPrice: 95, amount: 95 }],
    }],
  };
  const snap = structuredClone(original);
  const stored = sanitiseRunInput(original);
  assert.deepEqual(original, snap);
  assert.notEqual(stored, original);
  assert.equal(original.receipts[0].payment, 'Cash');
  assert.equal(original.receipts[0].cardNumber, PAN);
  assert.equal(original.receipts[0].last4, LAST4);
  assert.equal(stored.receipts[0].payment, 'Cash');
  assert.notEqual(stored.receipts[0].cardNumber, PAN);
});

test('sanitiseRunInput: unique long PAN/auth/MID/TID are absent from stored JSON; tender is canonical', () => {
  const input = sanitiseRunInput({
    batchId: 'b_synth',
    mode: 'round1',
    receipts: [{
      merchant: 'Synthetic Boutique',
      receiptReference: 'SYN-1001',
      date: '2026-11-20',
      time: '12:00',
      payment: `Visa ending ${LAST4}`,
      last4: LAST4,
      cardNumber: PAN,
      pan: SPACED_PAN,
      authCode: AUTH,
      approvalCode: AUTH,
      merchantId: MID,
      terminalId: TID,
      mid: MID,
      tid: TID,
      cvv: SHORT_CVV,
      currency: 'GBP',
      items: [{ item: 'Synthetic scarf', unitPrice: 95, amount: 95 }],
      ocr: { text: `Visa PAN ${SPACED_PAN} auth ${AUTH} MID ${MID} TID ${TID}` },
      identifiers: [{ class: 'payment_card', value: PAN }],
    }],
  });
  const json = JSON.stringify(input);
  for (const secret of [AUTH, MID, TID, PAN, SPACED_PAN.replace(/\s/g, '')]) {
    assert.equal(json.includes(secret), false, 'unique long secret must not remain in stored JSON');
  }
  assert.equal(String(input.receipts[0].pan || '').includes('4111'), false);
  assert.equal(input.receipts[0].payment, 'Card');
  assert.equal(input.receipts[0].merchant, 'Synthetic Boutique');
  assert.equal(input.receipts[0].items[0].unitPrice, 95);
  assert.equal(input.receipts[0].receiptReference, 'SYN-1001');
  assert.equal(String(input.receipts[0].cvv || '').includes(SHORT_CVV), false);
  assert.equal(String(input.receipts[0].last4 || '').includes(LAST4), false);
});

test('collision fields keep overlapping last-4 and short CVV/auth digits; unique secrets are gone', () => {
  const original = {
    batchId: 'b_collide',
    mode: 'round1',
    receipts: [{
      merchant: 'Synthetic Boutique',
      receiptReference: RECEIPT_REF,
      date: '2026-11-20',
      time: '12:00',
      payment: `Visa ending ${LAST4}`,
      last4: LAST4,
      cardNumber: SPACED_PAN,
      pan: PAN,
      authCode: SHORT_AUTH,
      approvalCode: AUTH,
      cvv: SHORT_CVV,
      merchantId: MID,
      terminalId: TID,
      currency: 'GBP',
      notes: `ref ${RECEIPT_REF} box ${BOX_NOTE} paid ${AMOUNT_TEXT}`,
      items: [{
        item: PRODUCT,
        styleRef: STYLE,
        ean: EAN,
        unitPrice: 8491,
        amount: AMOUNT_TEXT,
      }],
    }],
  };
  const snap = structuredClone(original);
  const stored = sanitiseRunInput(original);
  assert.deepEqual(original, snap, 'run input must stay intact');

  const rec = stored.receipts[0];
  const item = rec.items[0];
  assert.equal(rec.receiptReference, RECEIPT_REF);
  assert.equal(item.styleRef, STYLE);
  assert.equal(item.ean, EAN);
  assert.equal(item.unitPrice, 8491);
  assert.equal(item.amount, AMOUNT_TEXT);
  assert.equal(item.item, PRODUCT);
  assert.equal(rec.notes.includes(RECEIPT_REF), true);
  assert.equal(rec.notes.includes(BOX_NOTE), true);
  assert.equal(rec.notes.includes(AMOUNT_TEXT), true);
  assert.equal(rec.payment, 'Card');
  assert.equal(String(rec.last4 || '').includes(LAST4), false);
  assert.equal(String(rec.cardNumber || '').includes('4111'), false);
  assert.equal(String(rec.authCode || '').includes('44') || String(rec.authCode || '').includes('2'), false);
  assert.equal(String(rec.cvv || '').includes(SHORT_CVV), false);

  const json = JSON.stringify(stored);
  for (const secret of [AUTH, MID, TID, PAN]) {
    assert.equal(json.includes(secret), false, 'unique long secret must be absent from stored JSON');
  }
  // Overlapping short last-4 digits stay in the collision fields only.
  for (const value of [RECEIPT_REF, STYLE, EAN, AMOUNT_TEXT, PRODUCT]) {
    assert.equal(json.includes(value), true, 'collision value must survive in input_json');
  }
  assert.equal(json.includes(BOX_NOTE), true);
});

test('sanitiseRunInput: wallet+scheme variants become Card and drop card digits from tender and last4', () => {
  const variants = [
    'Apple Pay Mastercard ****8491',
    'Google Pay Visa ending in 8491',
    'Samsung Pay Amex 8491',
    'Apple Pay',
  ];
  for (const payment of variants) {
    const input = sanitiseRunInput({
      batchId: 'b_wallet',
      mode: 'round1',
      receipts: [{ merchant: 'Shop', payment, last4: payment.includes('8491') ? '8491' : undefined, items: [{ item: 'X', amount: 10 }] }],
    });
    assert.equal(input.receipts[0].payment, 'Card', `${payment} should canonicalise to Card`);
    assert.equal(String(input.receipts[0].last4 || '').includes('8491'), false, 'last4 field must be masked');
    if (!payment.includes('8491')) {
      assert.equal(JSON.stringify(input).includes('8491'), false);
    }
  }
});

test('sanitiseRunInput: UnionPay, Alipay, WeChat stay canonical; Cash/PayPal/Klarna/gift card are kept', () => {
  const cases = [
    ['China UnionPay', 'UnionPay'],
    ['银联', 'UnionPay'],
    ['Alipay', 'Alipay'],
    ['支付宝', 'Alipay'],
    ['WeChat Pay', 'WeChat'],
    ['微信', 'WeChat'],
    ['Cash', 'Cash'],
    ['PayPal', 'PayPal'],
    ['Klarna', 'Klarna'],
    ['Gift card', 'Gift card'],
    ['gift card', 'gift card'],
    ['', ''],
  ];
  for (const [payment, expected] of cases) {
    const input = sanitiseRunInput({
      batchId: 'b_tender',
      mode: 'round1',
      receipts: [{ merchant: 'Shop', payment, items: [{ item: 'X', amount: 1 }] }],
    });
    assert.equal(input.receipts[0].payment, expected, `${payment || '(empty)'} -> ${expected}`);
  }
});

test('createRun stores a sanitised clone; processRun still sees Cash so P4 can flag it', async () => {
  const env = makeEnv();
  const body = {
    batchId: 'b_store',
    mode: 'round1',
    receipts: [{
      receiptKey: 'cash-live',
      merchant: 'Synthetic Hall',
      payment: 'Cash',
      last4: LAST4,
      authCode: AUTH,
      merchantId: MID,
      terminalId: TID,
      card: PAN,
      currency: 'GBP',
      date: '2026-11-20',
      time: '12:00',
      receiptReference: RECEIPT_REF,
      items: [{ item: PRODUCT, styleRef: STYLE, ean: EAN, unitPrice: 20, amount: 20 }],
    }],
  };
  const start = await createRun(env, body);
  const json = storedJson(env, start.runId);
  const parsed = JSON.parse(json);
  assert.equal(parsed.receipts[0].payment, 'Cash');
  assert.equal(parsed.receipts[0].receiptReference, RECEIPT_REF);
  assert.equal(parsed.receipts[0].items[0].styleRef, STYLE);
  assert.equal(parsed.receipts[0].items[0].ean, EAN);
  assert.equal(parsed.receipts[0].items[0].item, PRODUCT);
  for (const secret of [AUTH, MID, TID, PAN]) {
    assert.equal(json.includes(secret), false, 'unique long secret must not be stored in input_json');
  }
  assert.equal(String(parsed.receipts[0].last4 || '').includes(LAST4), false);
  assert.equal(body.receipts[0].payment, 'Cash');
  assert.equal(body.receipts[0].card, PAN);

  await processRun(env, start.runId);
  const got = await getRun(env, start.runId, () => {});
  assert.equal(got.status, 'completed');
  const row = got.agreedRows.find(r => r.receiptKey === 'cash-live') || got.agreedRows[0];
  assert.equal(row.cells['采购商品方法'], 'Cash');
  assert.equal(row.flags['采购商品方法'], PINK);
  assert.ok(got.readingErrors.some(e => e.rowId === row.rowId && e.col === '采购商品方法' && e.reason === TENDER_REASON));
});
