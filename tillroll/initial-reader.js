import { normaliseTender, tenderIsAllowed } from './tender.js';

// The initial reader is deliberately small and deterministic. OCR supplies the
// raw fields and confidence. This module validates and normalises those fields
// without looking up products or inventing missing values.
export const INITIAL_READER_CONFIDENCE = 0.8;

const str = value => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
};

function envelope(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const values = raw.values ?? raw.candidates;
    if (Array.isArray(values)) {
      return {
        value: values.length === 1 ? values[0] : null,
        ambiguous: values.length > 1,
        confidence: raw.confidence,
        rawText: str(raw.rawText ?? raw.text),
        method: str(raw.method),
      };
    }
    if ('value' in raw || 'confidence' in raw || 'rawText' in raw || 'text' in raw || 'method' in raw) {
      return {
        value: raw.value,
        ambiguous: raw.ambiguous === true,
        confidence: raw.confidence,
        rawText: str(raw.rawText ?? raw.text),
        method: str(raw.method),
      };
    }
  }
  return { value: raw, ambiguous: false, confidence: undefined, rawText: null, method: null };
}

function confidenceIssue(field, confidence) {
  if (confidence === undefined || confidence === null || confidence === '') return null;
  const number = Number(confidence);
  if (!Number.isFinite(number) || number < INITIAL_READER_CONFIDENCE) {
    return { code: 'ambiguous_' + field, severity: 'Pink', reason: `The ${field} reading is below the confidence threshold.` };
  }
  return null;
}

function fieldKey(field) {
  return String(field).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function fieldResult(field, raw, { required = true, parser = value => value } = {}) {
  const key = fieldKey(field);
  const read = envelope(raw);
  const value = parser(read.value);
  let issue = null;
  if (read.ambiguous) issue = { code: 'ambiguous_' + key, severity: 'Pink', reason: `More than one ${field} candidate was read.` };
  else if (read.value === undefined || read.value === null || str(read.value) === '') {
    if (required) issue = { code: 'missing_' + key, severity: 'Pink', reason: `The receipt does not provide a readable ${field}.` };
  } else if (value === null || value === undefined || value === '') {
    issue = { code: 'invalid_' + key, severity: 'Pink', reason: `The printed ${field} could not be validated.` };
  } else issue = confidenceIssue(field, read.confidence);
  return { value: issue ? null : value, confidence: read.confidence ?? null, rawText: read.rawText, method: read.method, issue };
}

function validDateParts(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function normaliseInitialDate(value) {
  const text = str(value);
  if (!text) return null;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) return validDateParts(match[1], match[2], match[3]);
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (!match) return null;
  const year = match[3].length === 2 ? (Number(match[3]) >= 70 ? `19${match[3]}` : `20${match[3]}`) : match[3];
  return validDateParts(year, match[2], match[1]);
}

export function normaliseInitialTime(value) {
  const text = str(value);
  if (!text) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]), minute = Number(match[2]), second = Number(match[3] || 0);
  if (minute > 59 || second > 59) return null;
  if (match[4]) {
    if (hour < 1 || hour > 12) return null;
    if (match[4].toLowerCase() === 'am' && hour === 12) hour = 0;
    if (match[4].toLowerCase() === 'pm' && hour !== 12) hour += 12;
  } else if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

export function parseInitialMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const text = str(value);
  if (!text) return null;
  const cleaned = text.replace(/[£$€\s]/g, '').replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function aliases(source, names) {
  for (const name of names) if (source && source[name] !== undefined) return source[name];
  return null;
}

function addIssue(list, issue, field, extra = {}) {
  if (!issue) return;
  list.push({ field, ...issue, ...extra });
}

function normalisePayment(raw, issues) {
  const source = raw && typeof raw === 'object' ? raw : {};
  let values = aliases(source, ['payments', 'paymentBreakdown', 'tenders']);
  if (!Array.isArray(values)) values = null;
  const single = aliases(source, ['paymentMethod', 'payment', 'tender']);
  if (values && values.length > 1) {
    issues.push({ field: 'paymentMethod', code: 'split_payment', severity: 'Amber', reason: 'The receipt total is split across multiple payment entries.' });
    return { value: null, methods: values.map(value => normaliseTender(envelope(value).value)).filter(Boolean), split: true };
  }
  if (values && values.length === 1 && single === null) return normalisePayment({ paymentMethod: values[0] }, issues);
  const read = fieldResult('payment method', single, { parser: normaliseTender });
  if (read.issue) {
    if (read.issue.code === 'missing_payment method') read.issue = { code: 'missing_payment_method', severity: 'Pink', reason: 'The receipt does not provide a readable payment method.' };
    addIssue(issues, read.issue, 'paymentMethod');
    return { value: null, methods: [], split: false };
  }
  if (!tenderIsAllowed(read.value)) {
    issues.push({ field: 'paymentMethod', code: 'unsupported_payment_method', severity: 'Amber', reason: `The printed tender “${read.value}” is outside the supported payment methods.` });
    return { value: null, methods: [read.value], split: false };
  }
  return { value: read.value, methods: [read.value], split: false, confidence: read.confidence, rawText: read.rawText, method: read.method };
}

function normaliseItem(item, index, issues) {
  const source = item && typeof item === 'object' ? item : {};
  const itemPriceRead = fieldResult(`items[${index}].itemPrice`, aliases(source, ['itemPrice', 'unitPrice', 'originalPrice', 'listPrice', 'price']), { parser: parseInitialMoney });
  const paidRead = fieldResult(`items[${index}].purchasePrice`, aliases(source, ['purchasePrice', 'paidAmount', 'lineAmount', 'amount', 'paidPrice']), { parser: parseInitialMoney });
  if (!itemPriceRead.issue && itemPriceRead.value <= 0) { itemPriceRead.value = null; itemPriceRead.issue = { code: 'invalid_item_price', severity: 'Pink', reason: 'Item price must be greater than zero.' }; }
  if (!paidRead.issue && paidRead.value <= 0) { paidRead.value = null; paidRead.issue = { code: 'invalid_purchase_price', severity: 'Pink', reason: 'Purchase price must be greater than zero.' }; }
  addIssue(issues, itemPriceRead.issue, `items[${index}].itemPrice`);
  addIssue(issues, paidRead.issue, `items[${index}].purchasePrice`);
  const quantity = parseInitialMoney(aliases(source, ['quantity', 'qty'])) ?? 1;
  return {
    index,
    quantity,
    itemPrice: itemPriceRead.value,
    purchasePrice: paidRead.value,
    brand: str(aliases(source, ['brand', 'brandName'])),
    name: str(aliases(source, ['name', 'description', 'productName'])),
    reference: str(aliases(source, ['reference', 'ref', 'itemId', 'sku', 'productId'])),
    evidence: { itemPrice: itemPriceRead, purchasePrice: paidRead },
  };
}

export function normaliseInitialReceipt(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const issues = [];
  const receiptIdRead = fieldResult('receipt ID', aliases(source, ['receiptId', 'receiptReference', 'orderNumber', 'transactionId', 'id']));
  const dateRead = fieldResult('date', aliases(source, ['date', 'purchaseDate', 'transactionDate']), { parser: normaliseInitialDate });
  const timeRead = fieldResult('time', aliases(source, ['time', 'purchaseTime', 'transactionTime']), { parser: normaliseInitialTime });
  addIssue(issues, receiptIdRead.issue, 'receiptId');
  addIssue(issues, dateRead.issue, 'date');
  addIssue(issues, timeRead.issue, 'time');
  const payment = normalisePayment(source, issues);
  const totalRead = fieldResult('total paid', aliases(source, ['totalPaid', 'purchaseTotal', 'receiptTotal', 'total', 'amountPaid']), { required: false, parser: parseInitialMoney });
  if (totalRead.issue && totalRead.issue.code !== 'missing_total paid') addIssue(issues, totalRead.issue, 'totalPaid');
  const rawItems = Array.isArray(source.items) ? source.items : [];
  if (!rawItems.length) issues.push({ field: 'items', code: 'missing_items', severity: 'Pink', reason: 'No item line with a readable price was supplied.' });
  const items = rawItems.map((item, index) => normaliseItem(item, index, issues));
  const flags = issues.map(issue => issue.severity);
  return {
    receiptId: receiptIdRead.value,
    date: dateRead.value,
    time: timeRead.value,
    paymentMethod: payment.value,
    paymentMethods: payment.methods,
    totalPaid: totalRead.value,
    items,
    fundamentals: {
      receiptId: receiptIdRead,
      date: dateRead,
      time: timeRead,
      paymentMethod: { ...payment, issue: issues.find(issue => issue.field === 'paymentMethod') || null },
      totalPaid: totalRead,
      itemPrice: items.every(item => item.itemPrice !== null) ? { value: true, issue: null } : { value: false, issue: { code: 'missing_item_price', severity: 'Pink', reason: 'At least one item has no validated item price.' } },
      purchasePrice: items.every(item => item.purchasePrice !== null) ? { value: true, issue: null } : { value: false, issue: { code: 'missing_purchase_price', severity: 'Pink', reason: 'At least one item has no validated purchase price.' } },
    },
    flags: issues,
    reviewRequired: flags.length > 0,
    status: flags.length ? 'review' : 'ready',
  };
}

export const normalizeInitialReceipt = normaliseInitialReceipt;
export const validateInitialReceipt = normaliseInitialReceipt;
