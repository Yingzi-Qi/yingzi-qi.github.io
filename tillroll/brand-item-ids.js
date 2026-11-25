// 品牌货号 is the brand's own item id. When a line prints several numbers, pick the
// one that matches that brand's known format. A style reference beats an EAN.
// A concession or department code (9999999…) is never the item id.
// The table is the place to add another brand's pattern.

import { canonicalBrand } from './brand-aliases.js';

export const BRAND_ITEM_ID_FORMATS = [
  {
    brand: 'Chanel',
    // AP/AS/AAC + digits, optional B-ref, optional colour code.
    // AP/AS/AAC, or a season prefix such as "25C " in front of a short style code.
    // ^(?:\d{2}[A-Z]\s+)?([A-Z]{1,3}\d{4,5})\b
    test: isChanelRef,
    normalise: value => chanelText(value),
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

function chanelText(value) {
  const text = squash(value);
  const season = text.match(/^\d{2}[A-Z]\s+(.+)$/i);
  return season ? season[1] : text;
}

function isChanelRef(value) {
  const text = chanelText(value);
  if (/^(?:AP|AS|AAC)\d{3,8}(?:\s+B\d{3,8})?(?:\s+[A-Z]\d{2,6})?$/i.test(text)) return true;
  return /^(?:\d{2}[A-Z]\s+)?([A-Z]{1,3}\d{4,5})$/i.test(text);
}

const CHANEL_SEASON = /(?:^|\s)(?:\d{2}[A-Z]\s+)?([A-Z]{1,3}\d{4,5})\b/gi;

function seasonRefs(value) {
  const text = String(value ?? '');
  CHANEL_SEASON.lastIndex = 0;
  return [...text.matchAll(CHANEL_SEASON)].map(match => match[1]);
}

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

// A 4-digit department code, or a 10-digit internal code.
// The concession family is the same kind of store code.
export function isStoreCode(value) {
  const text = compact(value);
  return /^\d{4}$/.test(text) || /^\d{10}$/.test(text) || isConcessionCode(text);
}

// Product barcodes only. A 10-digit store code is not an EAN.
export function isEan(value) {
  const text = compact(value);
  if (!text || isStoreCode(text)) return false;
  return /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(text);
}

export const ITEM_ID_GUARD_NOTE = 'No brand style ref found; store/internal code not used';

export function brandHasItemIdFormat(brand) {
  return Boolean(ruleFor(brand));
}

export function matchesBrandItemId(brand, value) {
  const rule = ruleFor(brand);
  if (!rule || value === undefined || value === null || String(value).trim() === '') return false;
  const text = rule.normalise ? rule.normalise(value) : value;
  return rule.test(text);
}

// chooseItemId returned nothing. Do not keep a store code, or a raw printed
// id that misses the brand's own format. An EAN is still a P1 item id.
export function fallbackItemId(brand, raw) {
  const text = squash(raw);
  if (!text) return { itemId: '', rejected: false };
  if (isEan(text)) return { itemId: compact(text), rejected: false };
  if (isStoreCode(text) || (brandHasItemIdFormat(brand) && !matchesBrandItemId(brand, text))) {
    return { itemId: '', rejected: true };
  }
  return { itemId: text, rejected: false };
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

function parkedCodes(value) {
  const text = squash(value);
  const tight = compact(text);
  if (!text || isConcessionCode(text) || /^\d{4}$/.test(tight) || /^\d{10}$/.test(tight)) return [];
  if (looksLikeCode(text) || isEan(text)) return [text];
  return [];
}

export function chooseItemId({ brand, fields = {} } = {}) {
  const raw = [fields.itemId, fields.sku, fields.item, fields.name, ...(fields.codes || [])];
  const parked = [fields.styleRef, fields.brandItemId].flatMap(parkedCodes);
  const found = [...new Set([...raw.flatMap(codesIn), ...raw.flatMap(seasonRefs), ...parked].map(squash).filter(Boolean))];
  const rule = ruleFor(brand);
  const branded = rule ? found.filter(rule.test) : [];
  if (branded.length) {
    const best = branded.sort((left, right) => compact(right).length - compact(left).length)[0];
    return rule.normalise ? rule.normalise(best) : best;
  }
  // A brand with its own format does not keep an unfitting code. The EAN is
  // the fall-through. A concession code is never returned.
  if (!rule) {
    const style = found.filter(value => looksLikeCode(value) && !isEan(value));
    if (style.length) return style.sort((left, right) => compact(right).length - compact(left).length)[0];
  }
  return found.find(isEan) || '';
}
