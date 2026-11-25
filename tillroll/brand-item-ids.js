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
  {
    brand: 'Dior',
    // Dior prints the reference as the dior.com product path, and on the page
    // as "Reference:". Handbags keep a letter in fixed places: a leading M,
    // four digits, then four letters, then "_" and a four-character colour.
    // https://www.dior.com/en_gb/fashion/products/M0456CTZQ_M928
    // Other lines use the same style_colour shape. 2ESWS011YKY is eleven
    // characters with a letter fixed in position 4 (xxxNxxxxxxx), then _H03E:
    // https://www.dior.com/en_gb/fashion/products/2ESWS011YKY_H03E
    // Sunglasses use the same join, for example Reference DRIBS2IXR_70D1:
    // https://www.dior.com/en_us/fashion/products/DRIBS2IXR_70D1
    // A trailing _TU on some URLs is a size, not part of the reference.
    test: isDiorRef,
    normalise: value => diorText(value).toUpperCase(),
  },
];

function diorText(value) {
  return compact(value).replace(/_TU$/i, '');
}

function isDiorRef(value) {
  const text = diorText(value);
  if (/^M\d{4}[A-Z]{4}(?:_[A-Z0-9]{4})?$/i.test(text)) return true;
  if (/^[A-Z0-9]{3}[A-Z][A-Z0-9]{7}(?:_[A-Z0-9]{4})?$/i.test(text) && /\d/.test(text)) return true;
  const parts = text.split('_');
  if (parts.length === 2 && /^[A-Z0-9]{8,12}$/i.test(parts[0]) && /^[A-Z0-9]{4}$/i.test(parts[1])) {
    return /[A-Z]/i.test(parts[0]) && /\d/.test(parts[0]);
  }
  return false;
}

const CODE = /\b(?:(?:AP|AS|AAC)\d{3,8}(?:\s+B\d{3,8})?(?:\s+[A-Z]\d{2,6})?|(?:1BA|1BC|1BD|2VZ)[A-Z0-9]+(?:\s+[A-Z0-9]+)*|VCAR[A-Z0-9]{4,}|M\d{4}[A-Z]{4}(?:_[A-Z0-9]{4})?(?:_TU)?|[A-Z0-9]{3}[A-Z][A-Z0-9]{7}(?:_[A-Z0-9]{4})?(?:_TU)?|[A-Z0-9]{8,12}_[A-Z0-9]{4}(?:_TU)?|9999999\d+|\d{8,14})\b/gi;

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
  CODE.lastIndex = 0;
  return [...text.matchAll(CODE)].map(match => match[0]);
}

export function stripProductCodes(text) {
  CODE.lastIndex = 0;
  return String(text ?? '').replace(CODE, ' ');
}

export function chooseItemId({ brand, fields = {} } = {}) {
  const raw = [fields.itemId, fields.sku, fields.item, fields.name, ...(fields.codes || [])];
  const found = [...new Set(raw.flatMap(codesIn).map(squash).filter(Boolean))];
  const rule = ruleFor(brand);
  const branded = rule ? found.filter(rule.test) : [];
  if (branded.length) {
    const best = branded.sort((left, right) => compact(right).length - compact(left).length)[0];
    return rule.normalise ? rule.normalise(best) : best;
  }
  const style = found.filter(value => looksLikeCode(value) && !isEan(value));
  if (style.length) return style.sort((left, right) => compact(right).length - compact(left).length)[0];
  if (rule && !fields.allowEan) return '';
  return found.find(isEan) || '';
}
