// 品牌货号 is the brand's own item id. When a line prints several numbers, pick the
// one that matches that brand's known format. A style reference beats an EAN.
// A concession or department code (9999999…) is never the item id.
// The table is the place to add another brand's pattern.

import { canonicalBrand } from './brand-aliases.js';

export const BRAND_ITEM_ID_FORMATS = [
  {
    brand: 'Chanel',
    // AP/AS/AAC + digits, optional B-ref, optional colour code.
    test: value => /^(?:AP|AS|AAC)\d{3,8}(?:\s+B\d{3,8})?(?:\s+[A-Z]\d{2,6})?$/i.test(squash(value)),
  },
  {
    brand: 'Prada',
    test: value => /^(?:1BA|1BC|1BD|2VZ)[A-Z0-9]+(?:\s+[A-Z0-9]+)*$/i.test(squash(value)),
  },
  {
    brand: 'Van Cleef & Arpels',
    test: value => /^VCAR[A-Z0-9]{4,}$/i.test(compact(value)),
  },
];

const CODE = /\b(?:(?:AP|AS|AAC)\d{3,8}(?:\s+B\d{3,8})?(?:\s+[A-Z]\d{2,6})?|(?:1BA|1BC|1BD|2VZ)[A-Z0-9]+(?:\s+[A-Z0-9]+)*|VCAR[A-Z0-9]{4,}|9999999\d+|\d{8,14})\b/gi;

const squash = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const compact = value => squash(value).replace(/\s+/g, '');

export function isConcessionCode(value) {
  return /^9999999\d*$/i.test(compact(value));
}

export function isEan(value) {
  return /^\d{8,14}$/.test(compact(value));
}

export function brandHasItemIdFormat(brand) {
  return Boolean(ruleFor(brand));
}

function ruleFor(brand) {
  const name = canonicalBrand(brand);
  if (!name) return null;
  return BRAND_ITEM_ID_FORMATS.find(entry => canonicalBrand(entry.brand) === name) || null;
}

function looksLikeCode(value) {
  const text = compact(value);
  if (!text || isConcessionCode(text)) return false;
  if (isEan(text)) return true;
  return /[A-Za-z]/.test(text) && /\d/.test(text);
}

function codesIn(value) {
  const text = String(value ?? '');
  return [...text.matchAll(CODE)].map(match => match[0]);
}

export function chooseItemId({ brand, fields = {} } = {}) {
  const raw = [fields.itemId, fields.sku, fields.item, fields.name, ...(fields.codes || [])];
  const found = [...new Set(raw.flatMap(codesIn).map(squash).filter(Boolean))];
  const rule = ruleFor(brand);
  const branded = rule ? found.filter(rule.test) : [];
  if (branded.length) return branded.sort((left, right) => compact(right).length - compact(left).length)[0];
  const style = found.filter(value => looksLikeCode(value) && !isEan(value));
  if (style.length) return style.sort((left, right) => compact(right).length - compact(left).length)[0];
  if (rule) return '';
  return found.find(isEan) || '';
}
