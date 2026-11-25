// Strip payment-card details from a sanity-run payload before it is stored in D1.
// Tender is reduced to UnionPay, Card, Alipay, WeChat, or null. Card / PAN / last4,
// auth and approval codes, merchant IDs, terminal IDs and similar fields are
// masked so no digit sequences from those fields remain. General: not receipt-specific.
import { maskCardField, maskPaymentIdentifier } from '../../../tillroll/item-identifiers.js';
import { toPaymentMethod, dropCardDigits } from '../../../tillroll/receipt-rules.js';

const TENDER_KEYS = /^(?:payment|tender|payment[_-]?method|采购商品方法)$/i;

const CARD_KEYS = /^(?:card(?:[_-]?number|[_-]?no|[_-]?pan|[_-]?last[_-]?4)?|pan|primary[_-]?account(?:[_-]?number)?|last[_-]?4|last[_-]?four|ending(?:[_-]?in)?)$/i;

const AUTH_KEYS = /^(?:auth(?:orisation|orization)?(?:[_-]?code)?|approval(?:[_-]?code)?)$/i;

const MID_TID_KEYS = /^(?:merchant[_-]?id|terminal[_-]?id|acquirer(?:[_-]?id)?|mid|tid|rrn|stan|retrieval[_-]?reference(?:[_-]?number)?)$/i;

const OTHER_PAYMENT_KEYS = /^(?:cvv|cvc|cid|security[_-]?code|payment[_-]?reference)$/i;

const PAYMENT_ID_CLASSES = new Set(['payment_card', 'payment_auth', 'payment_merchant', 'payment_terminal', 'payment_reference']);

function isTenderKey(key) { return TENDER_KEYS.test(String(key)); }
function isCardKey(key) { return CARD_KEYS.test(String(key)); }
function isAuthKey(key) { return AUTH_KEYS.test(String(key)); }
function isMidTidKey(key) { return MID_TID_KEYS.test(String(key)); }
function isOtherPaymentKey(key) { return OTHER_PAYMENT_KEYS.test(String(key)); }
function isSensitiveKey(key) {
  return isCardKey(key) || isAuthKey(key) || isMidTidKey(key) || isOtherPaymentKey(key);
}

function collectDigitSequences(value, into) {
  const text = String(value ?? '');
  if (!text) return;
  for (const m of text.match(/\d+/g) || []) {
    if (m.length >= 3) into.add(m);
  }
  const compact = text.replace(/\D/g, '');
  if (compact.length >= 3) into.add(compact);
}

function maskSensitiveValue(key, value) {
  if (value == null) return value;
  if (typeof value === 'number') return null;
  if (isCardKey(key)) return maskCardField(value);
  if (isAuthKey(key) || isMidTidKey(key) || isOtherPaymentKey(key)) {
    return maskPaymentIdentifier('payment_auth', value);
  }
  return String(value).replace(/\d/g, '');
}

function canonicalTender(value) {
  if (value == null || value === '') return null;
  const cleaned = dropCardDigits(value);
  const { method } = toPaymentMethod(cleaned || value);
  return method ?? null;
}

function identifierClassOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const cls = node.class || node.identifierClass || node.kind;
  return PAYMENT_ID_CLASSES.has(cls) ? cls : null;
}

function walkMask(node, sequences) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (v && typeof v === 'object') walkMask(v, sequences);
    }
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  const idClass = identifierClassOf(node);
  if (idClass && node.value != null) {
    collectDigitSequences(node.value, sequences);
    node.value = idClass === 'payment_card'
      ? maskCardField(node.value)
      : maskPaymentIdentifier(idClass, node.value);
  }
  for (const [key, value] of Object.entries(node)) {
    if (value == null) continue;
    if (isTenderKey(key) && (typeof value === 'string' || typeof value === 'number')) {
      collectDigitSequences(value, sequences);
      node[key] = canonicalTender(value);
      continue;
    }
    if (isSensitiveKey(key) && (typeof value === 'string' || typeof value === 'number')) {
      collectDigitSequences(value, sequences);
      node[key] = maskSensitiveValue(key, value);
      continue;
    }
    if (value && typeof value === 'object') walkMask(value, sequences);
  }
  return node;
}

function scrubString(text, sequences) {
  let out = String(text);
  const ordered = [...sequences].sort((a, b) => b.length - a.length);
  for (const seq of ordered) {
    if (!seq || !out.includes(seq)) continue;
    out = out.split(seq).join('');
  }
  return out;
}

function walkScrub(node, sequences) {
  if (!sequences.size) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') node[i] = scrubString(v, sequences);
      else if (v && typeof v === 'object') walkScrub(v, sequences);
    }
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && !isSensitiveKey(key) && !isTenderKey(key)) {
      node[key] = scrubString(value, sequences);
    } else if (value && typeof value === 'object') {
      walkScrub(value, sequences);
    }
  }
  return node;
}

function hasRemainingSensitiveDigits(node, sequences) {
  const blob = JSON.stringify(node);
  for (const seq of sequences) {
    if (seq && blob.includes(seq)) return seq;
  }
  return null;
}

export function sanitiseRunInput(input) {
  const clone = structuredClone(input);
  const sequences = new Set();
  walkMask(clone, sequences);
  walkScrub(clone, sequences);
  // Last pass: if a distinctive digit sequence from a sensitive field is still
  // present anywhere, strip it from every remaining string.
  const leftover = hasRemainingSensitiveDigits(clone, sequences);
  if (leftover) walkScrub(clone, sequences);
  return clone;
}
