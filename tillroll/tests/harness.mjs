// Regression harness over the cached OCR stored with samples/ and real-samples/.
// It runs the on-device extraction and checks exactly as the browser does, without
// a DOM, and scores the result against the hand-verified `data` of each fixture.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {extractLocal} from '../extract.js';
import {inspectReference} from '../reference.js';
import {checkReceipt} from '../checks.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export const sets = ['samples', 'real-samples'];
export function loadSet(name) {
  return JSON.parse(fs.readFileSync(root + name + '/index.json', 'utf8'));
}

const loose = v => String(v ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const tenderAlias = {americanexpress:'amex', cartebleue:'cartebancaire', cb:'cartebancaire', mastercard:'mastercard'};
const tender = v => { const k = loose(v); return tenderAlias[k] ?? k; };
// Compare clock times to the minute: the fixtures predate the HH:MM:SS format.
const minute = v => {
  const m = /(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
  return m ? m[1].padStart(2, '0') + ':' + m[2] : '';
};
function multisetHits(expected, actual) {
  const pool = [...actual];
  let hits = 0;
  for (const value of expected) {
    const i = pool.findIndex(v => v === value);
    if (i >= 0) { hits++; pool.splice(i, 1); }
  }
  return hits;
}

export function scoreEntry(entry) {
  const want = entry.data || {};
  const got = extractLocal(entry.ocr);
  const reference = inspectReference(got, entry.ocr);
  const review = checkReceipt(got, entry.ocr, null, {reference, today: new Date('2026-11-25T12:00:00Z')});
  // Confirmed true-zero lines are audited separately but still count as read.
  const rows = [...(got.items || []), ...(got.excludedZeroItems || []).map(z => z.item ?? z)];
  const wantRows = want.items || [];
  const amounts = r => r.map(i => i.amount).filter(v => v != null).map(Number);
  const ids = r => r.map(i => loose(i.itemId)).filter(Boolean);
  const wantRefs = ['orderId', 'orderNumber', 'receiptReference'].map(k => loose(want[k])).filter(Boolean);
  const gotRefs = ['orderId', 'orderNumber', 'receiptReference'].map(k => loose(got[k]))
    .concat(reference.status === 'found' ? [loose(reference.value)] : []).filter(Boolean);
  const merchant = loose(want.merchant), gotMerchant = loose(got.merchant);
  return {
    filename: entry.filename,
    merchant: Boolean(merchant) && Boolean(gotMerchant) && (merchant.includes(gotMerchant) || gotMerchant.includes(merchant)),
    hasMerchant: Boolean(merchant),
    date: Boolean(want.date) && got.date === want.date,
    hasDate: Boolean(want.date),
    time: Boolean(want.time) && minute(got.time) === minute(want.time),
    hasTime: Boolean(want.time),
    total: want.total != null && Number(got.total) === Number(want.total),
    hasTotal: want.total != null,
    payment: Boolean(want.payment) && tender(got.payment) === tender(want.payment),
    hasPayment: Boolean(want.payment),
    reference: wantRefs.length > 0 && wantRefs.some(r => gotRefs.includes(r)),
    hasReference: wantRefs.length > 0,
    itemCount: rows.length === wantRows.length,
    amountHits: multisetHits(amounts(wantRows), amounts(rows)),
    amountsExpected: amounts(wantRows).length,
    itemIdHits: multisetHits(ids(wantRows), ids(rows)),
    itemIdsExpected: ids(wantRows).length,
    readingFlags: review.flags.filter(f => f.severity !== 'info').length,
    got, review,
  };
}

export function scoreSet(name) {
  const rows = loadSet(name).map(scoreEntry);
  const count = key => rows.filter(r => r[key]).length;
  const sum = key => rows.reduce((t, r) => t + r[key], 0);
  return {
    receipts: rows.length,
    merchant: count('merchant'), merchantExpected: count('hasMerchant'),
    date: count('date'), dateExpected: count('hasDate'),
    time: count('time'), timeExpected: count('hasTime'),
    total: count('total'), totalExpected: count('hasTotal'),
    payment: count('payment'), paymentExpected: count('hasPayment'),
    reference: count('reference'), referenceExpected: count('hasReference'),
    exactItemCount: count('itemCount'),
    amountHits: sum('amountHits'), amountsExpected: sum('amountsExpected'),
    itemIdHits: sum('itemIdHits'), itemIdsExpected: sum('itemIdsExpected'),
    nonInfoFlags: sum('readingFlags'),
  };
}
// Metrics where a higher number is better. Flags are informational only.
export const scoredMetrics = ['merchant', 'date', 'time', 'total', 'payment', 'reference', 'exactItemCount', 'amountHits', 'itemIdHits'];
