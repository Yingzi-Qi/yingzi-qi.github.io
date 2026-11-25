// Build a redacted deep clone of a sanity-run payload for D1 input_json only.
// The live run input is not mutated. Mask card / PAN / last4, auth / approval,
// MID / TID and similar fields. Canonicalise known tenders in the clone only;
// Cash / PayPal / Klarna / gift card and other unknown tenders are kept (with
// card digits dropped from the tender string). Other strings are only stripped of distinctive long (>= 6 digit) secrets taken from those masked fields, never short last-4 or CVV groups.
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

function maskSensitiveValue(key, value) {
  if (value == null) return value;
  if (typeof value === 'number') return null;
  if (isCardKey(key)) return maskCardField(value);
  return maskPaymentIdentifier('payment_auth', value);
}

// Known tenders become UnionPay / Card / Alipay / WeChat. Unknown tenders stay
// as-is (after dropping any card digits in the tender string) so P4 can flag them.
function storedTender(value) {
  if (value == null || value === '') return value == null ? null : '';
  const cleaned = dropCardDigits(value);
  const { method } = toPaymentMethod(cleaned || value);
  if (method) return method;
  return cleaned || String(value);
}

// Distinctive secrets only (length >= 6). Short last-4 / CVV groups are not
// stripped from other strings, so overlapping receipt refs and style codes survive.
const LONG_SECRET_MIN = 6;

function collectLongSecrets(value, into) {
  const text = String(value ?? '');
  if (!text) return;
  for (const m of text.match(/\d+/g) || []) {
    if (m.length >= LONG_SECRET_MIN) into.add(m);
  }
  const compact = text.replace(/\D/g, '');
  if (compact.length >= LONG_SECRET_MIN) {
    into.add(compact);
    into.add(text); // original form, e.g. an alphanumeric auth code
  }
}

function scrubLongSecrets(text, secrets) {
  let out = String(text);
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  for (const seq of ordered) {
    if (!seq) continue;
    if (out.includes(seq)) out = out.split(seq).join('');
    const spaced = new RegExp(seq.split('').join('[\\s-]*'), 'g');
    out = out.replace(spaced, '');
  }
  return out;
}

function walkScrubLong(node, secrets) {
  if (!secrets.size) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const v = node[i];
      if (typeof v === 'string') node[i] = scrubLongSecrets(v, secrets);
      else if (v && typeof v === 'object') walkScrubLong(v, secrets);
    }
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && !isSensitiveKey(key) && !isTenderKey(key)) {
      node[key] = scrubLongSecrets(value, secrets);
    } else if (value && typeof value === 'object') {
      walkScrubLong(value, secrets);
    }
  }
  return node;
}

function identifierClassOf(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  const cls = node.class || node.identifierClass || node.kind;
  return PAYMENT_ID_CLASSES.has(cls) ? cls : null;
}

function walkMask(node, secrets) {
  if (Array.isArray(node)) {
    for (const v of node) if (v && typeof v === 'object') walkMask(v, secrets);
    return node;
  }
  if (!node || typeof node !== 'object') return node;
  const idClass = identifierClassOf(node);
  if (idClass && node.value != null) {
    collectLongSecrets(node.value, secrets);
    node.value = idClass === 'payment_card'
      ? maskCardField(node.value)
      : maskPaymentIdentifier(idClass, node.value);
  }
  for (const [key, value] of Object.entries(node)) {
    if (value == null) continue;
    if (isTenderKey(key) && (typeof value === 'string' || typeof value === 'number')) {
      collectLongSecrets(value, secrets);
      node[key] = storedTender(value);
      continue;
    }
    if (isSensitiveKey(key) && (typeof value === 'string' || typeof value === 'number')) {
      collectLongSecrets(value, secrets);
      node[key] = maskSensitiveValue(key, value);
      continue;
    }
    if (value && typeof value === 'object') walkMask(value, secrets);
  }
  return node;
}

export function sanitiseRunInput(input) {
  const clone = structuredClone(input);
  const secrets = new Set();
  walkMask(clone, secrets);
  walkScrubLong(clone, secrets);
  return clone;
}
