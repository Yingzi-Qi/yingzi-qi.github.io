import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitiseRunInput } from '../functions/_lib/sanitise-run-input.js';
import { createRun } from '../functions/_lib/runs.js';
import { makeEnv } from './helpers.mjs';

const LAST4 = '8491';
const AUTH = '92B4471';
const MID = '5510238891';
const TID = '87654321';
const PAN = '4111111111111111';

function stored(env, runId) {
  return env.DB._db.prepare('SELECT input_json FROM sanity_runs WHERE run_id=?').get(runId).input_json;
}

test('sanitiseRunInput: card last4, auth codes, MID/TID never appear and tender is canonical', () => {
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
      pan: PAN,
      authCode: AUTH,
      approvalCode: AUTH,
      merchantId: MID,
      terminalId: TID,
      mid: MID,
      tid: TID,
      currency: 'GBP',
      items: [{ item: 'Synthetic scarf', unitPrice: 95, amount: 95 }],
      ocr: { text: `Visa ****${LAST4} auth ${AUTH} MID ${MID} TID ${TID} PAN ${PAN}` },
    }],
  });
  const json = JSON.stringify(input);
  for (const secret of [LAST4, AUTH, MID, TID, PAN]) {
    assert.equal(json.includes(secret), false, `${secret} must not remain in stored JSON`);
  }
  assert.equal(input.receipts[0].payment, 'Card');
  assert.equal(input.receipts[0].merchant, 'Synthetic Boutique');
  assert.equal(input.receipts[0].items[0].unitPrice, 95);
  assert.equal(input.receipts[0].receiptReference, 'SYN-1001');
});

test('sanitiseRunInput: wallet+scheme variants become Card and drop card digits', () => {
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
    assert.equal(JSON.stringify(input).includes('8491'), false, 'last4 digits must not remain');
  }
});

test('sanitiseRunInput: UnionPay, Alipay, WeChat stay canonical; cash becomes null', () => {
  const cases = [
    ['China UnionPay', 'UnionPay'],
    ['银联', 'UnionPay'],
    ['Alipay', 'Alipay'],
    ['支付宝', 'Alipay'],
    ['WeChat Pay', 'WeChat'],
    ['微信', 'WeChat'],
    ['Cash', null],
    ['PayPal', null],
    ['Gift card', null],
    ['', null],
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

test('createRun stores the sanitised payload in sanity_runs.input_json', async () => {
  const env = makeEnv();
  const start = await createRun(env, {
    batchId: 'b_store',
    mode: 'round1',
    receipts: [{
      merchant: 'Synthetic Hall',
      payment: 'Apple Pay Visa ending 8491',
      last4: '8491',
      authCode: '92B4471',
      merchantId: '5510238891',
      terminalId: '87654321',
      card: '4111111111111111',
      items: [{ item: 'Ribbon', unitPrice: 20, amount: 20 }],
    }],
  });
  const json = stored(env, start.runId);
  const parsed = JSON.parse(json);
  assert.equal(parsed.receipts[0].payment, 'Card');
  for (const secret of ['8491', '92B4471', '5510238891', '87654321', '4111111111111111']) {
    assert.equal(json.includes(secret), false, `${secret} must not be stored in input_json`);
  }
  assert.equal(parsed.receipts[0].merchant, 'Synthetic Hall');
});
