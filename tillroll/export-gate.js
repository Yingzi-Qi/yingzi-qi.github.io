// Defensive export gate for the v2 workbook. It reports problems. It does not
// move a brand into 品牌, strip a code out of 品名, or rewrite a description.
// That work belongs to the Reader's tillroll/field-sorter.js (PR #1).
//
// TODO: after the rebase onto PR #1 and PR #2, replace these validators with
// the matching exports from ./field-sorter.js wherever that module provides
// them. Keep the export caller flag-only: never auto-edit 品牌 or 品名.

import { BRANDS, canonicalBrand } from '../tillroll-cloudflare/functions/_lib/brands.js';

export const BRAND_NOT_READ = 'Brand not read';
export const NAME_NEEDS_CHECKING = 'Name needs checking';
export const PRICE_NOT_NUMERIC = 'Price not numeric';

const PRICE_COLUMNS = ['采购商品原价', '采购商品金额', '销售金额'];
const fold = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const compact = v => String(v ?? '').replace(/[\s-]/g, '');
const wordsOf = text => fold(text).split(/[^a-z0-9]+/).filter(Boolean);

// 9999999… family. A standalone numeric style ref such as 000001 is not this.
export function isConcessionFamily(value) {
  return /^9999999\d*$/.test(compact(value));
}

// Harrods layout: a leading 4-digit concession/department code, then a 10-digit code.
export function harrodsConcessionPair(value) {
  const match = /^(\d{4})\s+(\d{10})\b/.exec(String(value ?? '').trim());
  return match ? { concessionCode: match[1], internalCode: match[2] } : null;
}

function pushCode(codes, value) {
  const text = String(value ?? '').trim();
  if (!text) return;
  if (!codes.some(code => compact(code) === compact(text))) codes.push(text);
}

// Codes that must never be written into 品牌货号. Labels win even when the
// value is not a 9999999… code. The 4-digit Harrods code counts only inside
// the 4+10 layout, or when the reader labelled it.
export function labelledStoreCodes(item = {}) {
  const codes = [];
  pushCode(codes, item.concessionCode);
  pushCode(codes, item.internalCode);
  const pair = harrodsConcessionPair(item.itemId) || harrodsConcessionPair(item.sku)
    || harrodsConcessionPair(`${item.concessionCode || ''} ${item.internalCode || ''}`.trim());
  if (pair) {
    pushCode(codes, pair.concessionCode);
    pushCode(codes, pair.internalCode);
  }
  if (isConcessionFamily(item.itemId)) pushCode(codes, item.itemId);
  if (isConcessionFamily(item.sku)) pushCode(codes, item.sku);
  return codes;
}

export function isStoreInternalValue(value, item) {
  const code = compact(value);
  if (!code) return false;
  if (isConcessionFamily(code)) return true;
  if (harrodsConcessionPair(value)) return true;
  return labelledStoreCodes(item).some(labelled => compact(labelled) === code);
}

// Prefer a printed style ref. A store-internal code is not a candidate.
export function brandItemCell(item = {}) {
  const storeCodes = labelledStoreCodes(item);
  const blocked = value => {
    const text = String(value ?? '').trim();
    if (!text) return true;
    return isStoreInternalValue(text, item) || Boolean(harrodsConcessionPair(text));
  };
  const cell = [item.styleRef, item.itemId, item.sku].find(value => !blocked(value));
  return { cell: cell == null ? null : String(cell).trim(), storeCodes };
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
      if (phraseIsRowBrand(phrase, brand)) hits.push({ start: i, length: n });
    }
  }
  return hits;
}

// True when 品名 still contains the row's brand or a canonical alias, a
// 9999999… code, an EAN or any run of 6+ digits, or no non-brand word.
// An empty 品牌 still counts a known brand or alias left in the name.
export function nameNeedsChecking(name, brand) {
  const text = String(name ?? '').trim();
  if (!text) return true;
  if (/9999999\d*/.test(compact(text)) || /\d{6,}/.test(compact(text))) return true;
  const hits = brandHits(text, brand);
  if (hits.length) return true;
  const words = wordsOf(text);
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
  if (nameNeedsChecking(cells['品名'], cells['品牌'])) findings.push({ col: '品名', reason: NAME_NEEDS_CHECKING });
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
