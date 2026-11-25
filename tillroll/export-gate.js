// Defensive export gate for the v2 workbook. It reports problems. It does not
// move a brand into 品牌, strip a code out of 品名, or rewrite a description.
// That work belongs to the Reader's tillroll/field-sorter.js (PR #1).
//
// TODO: after the rebase onto PR #1 and PR #2, replace these validators with
// the matching exports from ./field-sorter.js wherever that module provides
// them. Keep the export caller flag-only: never auto-edit 品牌 or 品名.

import { BRANDS, canonicalBrand } from '../tillroll-cloudflare/functions/_lib/brands.js';
import { chooseItemId, isConcessionCode, matchesBrandItemId } from './brand-item-ids.js';

export const BRAND_NOT_READ = 'Brand not read';
export const NAME_NEEDS_CHECKING = 'Name needs checking';
export const PRICE_NOT_NUMERIC = 'Price not numeric';

const PRICE_COLUMNS = ['采购商品原价', '采购商品金额', '销售金额'];
const fold = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const compact = v => String(v ?? '').replace(/[\s-]/g, '');
const wordsOf = text => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

const clean = value => {
  const text = String(value ?? '').trim();
  return text || null;
};
const sameCode = (a, b) => compact(a) && compact(a).toUpperCase() === compact(b).toUpperCase();

// Numeric-only 10 digits, with no reader label. Not a classification of any
// other length: a styleRef such as 000001 is never decided here.
export function isUnlabelledTenDigits(value) {
  return /^\d{10}$/.test(compact(value));
}
export function isConcessionFamily(value) {
  return isConcessionCode(value);
}
export function isBareFourDigits(value) {
  return /^\d{4}$/.test(compact(value));
}
// Harrods layout: a 4-digit department/concession code, then a 10-digit code.
export function harrodsConcessionPair(value) {
  const match = /^(\d{4})\s+(\d{10})\b/.exec(String(value ?? '').trim());
  return match ? { concessionCode: match[1], internalCode: match[2] } : null;
}
function pairOn(item) {
  return harrodsConcessionPair(item.itemId) || harrodsConcessionPair(item.sku)
    || harrodsConcessionPair(`${clean(item.concessionCode) || ''} ${clean(item.internalCode) || ''}`.trim());
}
// 'concession' for a labelled concession/internal code, the 9999999… family, or
// the Harrods 4+10 layout. 'last4' for any other bare 4-digit value.
export function concessionReading(value, item = {}) {
  const text = clean(value);
  if (!text) return null;
  const pair = pairOn(item) || harrodsConcessionPair(text);
  const labelled = sameCode(text, item.concessionCode) || sameCode(text, item.internalCode);
  const inPair = pair && (sameCode(text, pair.concessionCode) || sameCode(text, pair.internalCode) || Boolean(harrodsConcessionPair(text)));
  if (labelled || inPair || isConcessionFamily(text)) return 'concession';
  if (isBareFourDigits(text)) return 'last4';
  return null;
}

function formatMiss(item, value, brandIdFormat) {
  const chosen = chooseItemId({ brand: item.brand, fields: { itemId: value, sku: value, styleRef: item.styleRef } });
  if (chosen && matchesBrandItemId(item.brand, chosen) && compact(chosen).toUpperCase() === compact(value).toUpperCase()) return false;
  const verdict = brandIdFormat(item.brand, value);
  return verdict == null || verdict === false || verdict === 'no match';
}

// Reader labels, the 9999999… family, a bare 4-digit value, and the Harrods
// 4+10 layout stay out of the cell. An unlabelled numeric-only 10-digit value
// stays out unless the brand ID-format hook matches it. Any other styleRef,
// including 000001, stays eligible.
export function heldOutOfBrandItem(value, item, brandIdFormat = () => 'no match') {
  const text = clean(value);
  if (!text) return true;
  if (concessionReading(text, item)) return true;
  if (sameCode(text, item.styleRef)) return false;
  if (sameCode(text, item.ean)) return true;
  if (isUnlabelledTenDigits(text)) return formatMiss(item, text, brandIdFormat);
  return false;
}

export function selectBrandItem(item = {}, brandIdFormat = () => 'no match') {
  const format = typeof brandIdFormat === 'function' ? brandIdFormat : () => 'no match';
  const storeCodes = [];
  const push = value => {
    const text = clean(value);
    if (!text || storeCodes.some(code => sameCode(code, text))) return;
    storeCodes.push(text);
  };
  push(item.concessionCode);
  push(item.internalCode);
  push(item.ean);
  const pair = pairOn(item);
  if (pair) { push(pair.concessionCode); push(pair.internalCode); }
  for (const value of [item.itemId, item.sku, item.styleRef]) {
    if (clean(value) && heldOutOfBrandItem(value, item, format)) push(value);
  }
  const cell = [item.styleRef, item.itemId, item.sku].map(clean).find(value => value && !heldOutOfBrandItem(value, item, format)) || null;
  const lookupId = clean(item.itemId) || clean(item.ean) || clean(item.sku) || clean(item.styleRef);
  const reading = concessionReading(lookupId, item);
  let idClass = 'printed';
  if (cell && sameCode(cell, item.styleRef) && !concessionReading(cell, item)) idClass = 'style';
  else if (reading === 'last4') idClass = 'last4';
  else if (reading === 'concession') idClass = 'concession';
  else if (lookupId && sameCode(lookupId, item.ean)) idClass = 'ean';
  else if (lookupId && isUnlabelledTenDigits(lookupId) && heldOutOfBrandItem(lookupId, item, format)) idClass = 'unlabelled10';
  else if (cell && sameCode(cell, item.styleRef)) idClass = 'style';
  return { cell, storeCodes, lookupId, idClass };
}

function phraseIsRowBrand(phrase, rowBrand) {
  const known = canonicalBrand(phrase);
  const knownBrand = known && BRANDS[known] ? known : null;
  const rowText = String(rowBrand ?? '').trim();
  if (!rowText) return Boolean(knownBrand);
  if (fold(phrase) === fold(rowText)) return true;
  const rowKnown = canonicalBrand(rowText);
  if (knownBrand && rowKnown && BRANDS[rowKnown] && knownBrand === rowKnown) return true;
  return false;
}

function brandHits(name, brand) {
  const words = wordsOf(name);
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const phrase = words.slice(i, i + n).join(' ');
      if (phraseIsRowBrand(phrase, brand)) hits.push({ start: i, length: n, phrase });
    }
  }
  return hits;
}

// An alias of 3 characters or fewer counts only as its own token at the start
// or end of 品名. A brand or alias of 4 or more characters matches as a whole
// word anywhere. Neither applies once 品名 is the look-up's official name.
function shortAliasCounts(hit, words) {
  const letters = hit.phrase.replace(/[^a-z0-9]/g, '');
  if (letters.length > 3) return true;
  return hit.length === 1 && (hit.start === 0 || hit.start + hit.length === words.length);
}

// True when a non-official 品名 still contains the row's brand or a canonical
// alias, a 9999999… code, an EAN or any run of 6+ digits, or no non-brand word.
// An official look-up name is already approved, so this check does not flag it.
export function nameNeedsChecking(name, brand, options = {}) {
  const officialName = options.officialName || null;
  const text = String(name ?? '').trim();
  const official = options.official === true || (officialName && fold(text) === fold(officialName));
  if (official) return false;
  if (!text) return true;
  if (/9999999\d*/.test(compact(text)) || /\d{6,}/.test(compact(text))) return true;
  const words = wordsOf(text);
  const hits = brandHits(text, brand).filter(hit => shortAliasCounts(hit, words));
  if (hits.length) return true;
  const letterIndexes = words.map((word, index) => (/[a-z]/.test(word) ? index : -1)).filter(index => index >= 0);
  if (!letterIndexes.length) return true;
  const consumed = new Set();
  for (const hit of hits) for (let i = hit.start; i < hit.start + hit.length; i++) consumed.add(i);
  return letterIndexes.every(index => consumed.has(index));
}

export function gateFindings(row) {
  const cells = row?.cells || {};
  const findings = [];
  if (!String(cells['品牌'] ?? '').trim()) findings.push({ col: '品牌', reason: BRAND_NOT_READ });
  const officialName = row?.raw?.officialName || null;
  const nameText = String(cells['品名'] ?? '').trim();
  const official = row?.raw?.nameFromOfficial === true || row?._exactIdPrice === true
    || (officialName && fold(nameText) === fold(officialName));
  if (nameNeedsChecking(cells['品名'], cells['品牌'], { officialName, official })) findings.push({ col: '品名', reason: NAME_NEEDS_CHECKING });
  const invalid = row?.raw?.invalidPrices || {};
  for (const col of PRICE_COLUMNS) {
    const value = cells[col];
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    const raw = invalid[col] || (col === '销售金额' ? invalid['采购商品原价'] : null)
      || (typeof value === 'string' && value.trim() ? value.trim() : null);
    if (!raw) continue;
    findings.push({ col, reason: PRICE_NOT_NUMERIC, clear: true, raw: String(raw) });
  }
  return findings;
}
