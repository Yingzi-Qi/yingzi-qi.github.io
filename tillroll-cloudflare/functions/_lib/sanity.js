// Server-side review loop behind /api/sanity-run. Encodes the Operating Manual
// roles (Reader & Sanity Checker -> Look-up Verifier -> Reader cross-check ->
// Excel Sync audit) and iterates until the audit converges. Only the final
// agreed version leaves this module; the internal trail is stored in D1 only.
import { canonicalBrand, brandSearchPhrases, CHANEL_FALLBACK_NOTE } from './brands.js';
import { brandHasItemIdFormat, chooseItemId, isConcessionCode, isEan, isStoreCode, matchesBrandItemId, ITEM_ID_GUARD_NOTE } from '../../../tillroll/brand-item-ids.js';
import { lookup as defaultLookup, invalidate, priceFallbackIsTie, priceTolerance, isExactOfficialIdPriceMatch } from './lookup.js';
import { nowIso, sha256Hex } from './http.js';
import { expandReceipt, isConfirmedZero, joinPurchaseTime, supplierVisibleName } from '../../../tillroll/units.js';
import { isGtin } from '../../../tillroll/product-code.js';
import { sortItemFields, isNumericPrice } from '../../../tillroll/field-sorter.js';
import { matchBrandIdFormat } from '../../../tillroll/brand-id-format.js';
import { NAME_NEEDS_CHECKING, concessionReading, gateFindings, isUnlabelledTenDigits, selectBrandItem } from '../../../tillroll/export-gate.js';
import { ALLOWED_TENDERS, TENDER_REASON, normaliseTender } from '../../../tillroll/tender.js';
export { ALLOWED_TENDERS, TENDER_REASON, normaliseTender };

export const COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
export const PINK = '#FECDD3', AMBER = '#FDE68A';
const MAX_LOOKUPS_PER_RUN = 60, MAX_ITERATIONS = 3;
const str = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[£$€,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

// Shared with the workbook exporter so a receipt's 采购时间 is identical in both.
export const normaliseTimestamp = joinPurchaseTime;

const JUNK_NAME = /^(amount|total|sub-?total|vat|tax|change|cash|card|balance|due|tender|discount|9{3,}|[\d\s.,£$€-]+)$/i;
export function itemIdProblem(id) {
  if (!id) return null;
  const s = String(id).trim();
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) return 'looks like a date';
  if (/^\d+[.,]\d{2}$/.test(s)) return 'looks like a price';
  if (/^(\+?44|0)\d{9,10}$/.test(s.replace(/\s/g, ''))) return 'looks like a phone number';
  if (/^\d{4}$/.test(s)) return 'looks like card last-4';
  return null;
}
export function stripBrandFromItemId(itemId, brand) {
  const id = str(itemId);
  if (!id || !brand) return id;
  const names = [...new Set([brand, canonicalBrand(brand)].filter(Boolean))];
  let out = id;
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^${esc}[\\s:#-]*`, 'i'), '').replace(new RegExp(`[\\s:#-]*${esc}$`, 'i'), '');
  }
  return out.trim() || id;
}
// ---- Follow-up 品牌货号 helpers (#19), adapted so #20's guard stays effective ----
const STORE_INTERNAL = /^(?:\d{4}|\d{10})$/;
const CONCESSION_PREFIX = /^9999999\d*$/i;

export function isBarcodeOrEan(value) {
  const s = str(value);
  if (!s) return false;
  const compact = s.replace(/[\s-]/g, '');
  if (isStoreCode(compact)) return false;
  return isEan(compact) || isGtin(compact);
}
export function isConcessionOrStoreCode(value, item = {}) {
  const s = str(value);
  if (!s) return false;
  const compact = s.replace(/[\s-]/g, '');
  if (item.concessionCode && str(item.concessionCode) === s) return true;
  if (item.storeSku && str(item.storeSku) === s) return true;
  if (item.retailerSku && str(item.retailerSku) === s) return true;
  if (item.departmentCode && str(item.departmentCode) === s) return true;
  if (item.concession === true && (s === str(item.itemId) || s === str(item.sku))) return true;
  if (isStoreCode(compact) || STORE_INTERNAL.test(compact)) return true;
  return CONCESSION_PREFIX.test(s) || CONCESSION_PREFIX.test(compact);
}

// Never use a 4-digit department code, a 10-digit internal code, or 9999999xxx as 品牌货号.
export function isForbiddenBrandItemCode(value, item = {}) {
  const s = str(value);
  if (!s) return false;
  const compact = s.replace(/[\s-]/g, '');
  if (isStoreCode(compact) || STORE_INTERNAL.test(compact) || CONCESSION_PREFIX.test(compact)) return true;
  return isConcessionOrStoreCode(s, item);
}

// Chanel optional season prefix: "24P AS1234" → style ref AS1234 (group 1).
export const CHANEL_STYLE_REF = /^(?:\d{2}[A-Z]\s+)?([A-Z]{1,3}\d{4,5})\b/;
export function extractChanelStyleRef(value) {
  const s = str(value);
  if (!s) return null;
  const direct = s.match(CHANEL_STYLE_REF);
  if (direct) return direct[1];
  const upper = s.toUpperCase().match(CHANEL_STYLE_REF);
  if (!upper) return null;
  const idx = s.toUpperCase().indexOf(upper[1]);
  return idx >= 0 ? s.slice(idx, idx + upper[1].length) : upper[1];
}
function isChanelBrandName(brand) {
  const c = canonicalBrand(brand) || str(brand) || '';
  return /^chanel$/i.test(c);
}

// Classify a printed code. The raw reader itemId is never passed through as-is:
// it is only used when it classifies as a style ref, brand product code, or EAN,
// and never when it is a concession / store code. Chanel season prefixes are
// stripped to capture-group 1; characters are never auto-corrected (I/1, O/0).
export function readerBrandItemIdCandidate(item = {}, brand) {
  const classify = (value, sourceIfStyle) => {
    if (!value) return null;
    if (isForbiddenBrandItemCode(value, item)) return null;
    let cleaned = stripBrandFromItemId(value, brand) || value;
    const printed = cleaned;
    if (isChanelBrandName(brand)) {
      const style = extractChanelStyleRef(cleaned);
      if (style) cleaned = style;
    }
    if (!cleaned || isForbiddenBrandItemCode(cleaned, item)) return null;
    if (isBarcodeOrEan(cleaned)) return { value: cleaned.replace(/[\s-]/g, ''), source: 'ean', printed };
    return { value: cleaned, source: sourceIfStyle, printed };
  };
  const styleRef = classify(str(item.styleRef) || str(item.style), 'styleRef');
  if (styleRef && styleRef.source !== 'ean') return styleRef;
  const sku = classify(str(item.sku), 'styleRef');
  if (sku && sku.source !== 'ean') return sku;
  const own = classify(str(item.productId), 'brandProductCode')
    || classify(str(item.itemId), 'brandProductCode');
  if (own && own.source !== 'ean') return own;
  const ean = classify(str(item.ean) || str(item.barcode) || str(item.gtin) || str(item.upc), 'ean')
    || (styleRef?.source === 'ean' ? styleRef : null)
    || (sku?.source === 'ean' ? sku : null)
    || (own?.source === 'ean' ? own : null);
  return ean || null;
}

// Exported, empty by default. Do not copy a table from PR #3. The Verifier can
// wire a table later via setBrandItemIdFormat() or deps.brandItemIdFormat.
export const BRAND_ITEM_ID_FORMAT = {};
let injectedBrandItemIdFormat = null;
export function setBrandItemIdFormat(table) {
  injectedBrandItemIdFormat = (table && typeof table === 'object') ? table : null;
}
export function getBrandItemIdFormat(override) {
  return override || injectedBrandItemIdFormat || BRAND_ITEM_ID_FORMAT;
}
const compactId = v => String(v ?? '').replace(/[\s-]/g, '').toUpperCase();
function formatPattern(brand, table) {
  if (!table) return null;
  return table[canonicalBrand(brand) || brand] || table[brand] || table[str(brand)] || null;
}
export function fitsBrandItemIdFormat(brand, value, table) {
  if (!str(value) || isForbiddenBrandItemCode(value)) return false;
  const formats = getBrandItemIdFormat(table);
  const pattern = formatPattern(brand, formats);
  if (pattern) return pattern.test(str(value)) || pattern.test(compactId(value));
  return true;
}

// Possible I/1 or O/0 readings that would fit the table. Never written to the cell.
export function suggestedPrintedCodeAlternative(value, brand, table) {
  const printed = str(value);
  const formats = getBrandItemIdFormat(table);
  const pattern = formatPattern(brand, formats);
  if (!printed || !pattern || fitsBrandItemIdFormat(brand, printed, formats)) return null;
  const variants = new Set();
  const swap = (s, a, b) => s.replace(new RegExp(a, 'g'), b);
  for (const v of [
    swap(printed, 'I', '1'), swap(printed, 'l', '1'), swap(printed, 'O', '0'),
    swap(printed, '1', 'I'), swap(printed, '0', 'O'),
    swap(swap(printed, 'I', '1'), 'O', '0'),
  ]) if (v !== printed) variants.add(v);
  const fits = [...variants].filter(v => fitsBrandItemIdFormat(brand, v, formats));
  return fits.length === 1 ? fits[0] : null;
}

export function officialSiteShowsReason(officialId) {
  return `official site shows ${officialId}`;
}
export function printedValueKeptReason(alternative) {
  return alternative ? `Printed value kept; alternative ${alternative}.` : 'Printed value kept.';
}

// Per-row 品牌货号. The receipt is the source of truth for a fitting printed
// style. #20's guard: a store/internal code, or a printed code that misses the
// brand format, must not occupy the cell (empty + Pink). Printed-value-kept:
// an official ID or an OCR I/1,O/0 alternative is never written into the cell;
// it is recorded in the comment/reason only. The printed token itself may be
// quoted in that comment when it is a style-like code or a pure digit store
// code — never card, auth, merchant, terminal or approval text.
export function resolveBrandItemId({ item = {}, brand, officialItemId, exactOfficial = false, formatTable } = {}) {
  const table = getBrandItemIdFormat(formatTable);
  const officialRaw = str(officialItemId);
  const official = officialRaw && !isForbiddenBrandItemCode(officialRaw, item)
    ? (stripBrandFromItemId(officialRaw, brand) || officialRaw)
    : null;
  const usableOfficial = official && !isForbiddenBrandItemCode(official, item) ? official : null;
  const cand = readerBrandItemIdCandidate(item, brand);
  const styleLike = cand && (cand.source === 'styleRef' || cand.source === 'brandProductCode') ? cand : null;
  // An injected format table can reject an unfitting token. Without one, a non-store
  // style-like code is kept (VCA 0012345, Gucci 000001). #20's fallbackItemId still
  // governs the client look-up path; it is not applied wholesale here.
  const fitting = styleLike && fitsBrandItemIdFormat(brand, styleLike.value, table) ? styleLike : null;

  if (fitting) {
    const same = Boolean(usableOfficial && compactId(usableOfficial) === compactId(fitting.value));
    if (usableOfficial && !same) {
      return {
        brandItemId: fitting.value,
        brandItemIdSource: fitting.source,
        flag: AMBER,
        reason: officialSiteShowsReason(usableOfficial),
      };
    }
    return {
      brandItemId: fitting.value,
      brandItemIdSource: fitting.source,
      flag: null,
      reason: null,
    };
  }
  // Unfitting printed style / brand code: #20 empties the cell. The printed
  // value and any official/OCR alternative stay in the reason only.
  if (styleLike) {
    const rawPrinted = styleLike.printed || styleLike.value;
    const alternative = usableOfficial
      || suggestedPrintedCodeAlternative(rawPrinted, brand, table)
      || suggestedPrintedCodeAlternative(styleLike.value, brand, table)
      || null;
    return {
      brandItemId: null,
      brandItemIdSource: styleLike.source,
      flag: PINK,
      reason: alternative ? printedValueKeptReason(alternative) : ITEM_ID_GUARD_NOTE,
      printedValue: rawPrinted,
    };
  }
  if (cand && cand.source === 'ean') {
    return {
      brandItemId: cand.value,
      brandItemIdSource: 'ean',
      flag: AMBER,
      reason: 'EAN used as 品牌货号; not a brand style ref.',
    };
  }
  if (usableOfficial) {
    return {
      brandItemId: usableOfficial,
      brandItemIdSource: 'official',
      flag: exactOfficial ? null : AMBER,
      reason: exactOfficial ? null : 'Official brand item ID from look-up.',
    };
  }
  const raw = [item.styleRef, item.style, item.sku, item.itemId, item.ean, item.barcode, item.concessionCode, item.storeSku]
    .map(str).filter(Boolean);
  const storePrinted = raw.find(c => isForbiddenBrandItemCode(c, item) || isStoreCode(c));
  // Only quote a pure 4- or 10-digit store code, never PAN/auth/MID/TID noise.
  const commentDigit = storePrinted && (/^\d{4}$/.test(String(storePrinted).replace(/\s+/g, '')) || /^\d{10}$/.test(String(storePrinted).replace(/\s+/g, '')))
    ? String(storePrinted).trim()
    : '';
  return {
    brandItemId: null,
    brandItemIdSource: null,
    flag: PINK,
    reason: storePrinted ? ITEM_ID_GUARD_NOTE : 'No brand item ID.',
    printedValue: commentDigit || null,
  };
}
export function chooseBrandItemId(item = {}, brand, formatTable) {
  return resolveBrandItemId({ item, brand, formatTable }).brandItemId;
}
function applyBrandItemIdRecord(row, rec, { replaceFlag = false, keepCell = false } = {}) {
  if (!keepCell) row.cells['品牌货号'] = rec.brandItemId ?? null;
  row.brandItemId = row.cells['品牌货号'] ?? rec.brandItemId ?? null;
  row.brandItemIdSource = rec.brandItemIdSource ?? null;
  row.brandItemIdFlag = rec.flag ?? null;
  row.brandItemIdReason = rec.reason ?? null;
  if (replaceFlag) {
    delete row.flags['品牌货号'];
    row._reading = (row._reading || []).filter(e => e.col !== '品牌货号');
    row._lookup = (row._lookup || []).filter(e => e.col !== '品牌货号');
  }
  // ITEM_ID_GUARD_NOTE is a client-lookup phrase; never use it as a sanity
  // flag reason or comment. Still Pink the empty cell, and quote a safe printed token.
  const flagReason = rec.flag && (rec.reason === ITEM_ID_GUARD_NOTE || !rec.reason)
    ? 'no brand item ID printed'
    : rec.reason;
  if (rec.flag && flagReason) addFlag(row, '品牌货号', rec.flag, flagReason);
  if (!row._comments) row._comments = {};
  const quoted = rec.printedValue && /^(?:\d{4}|\d{10}|[A-Za-z][A-Za-z0-9._-]{1,31})$/.test(String(rec.printedValue).trim())
    ? String(rec.printedValue).trim() : '';
  // Only quote a rejected printed token onto an empty cell. Never prepend a
  // held-out store code onto a builder/style value that already occupies the cell.
  if (!row.cells['品牌货号'] && quoted && !String(row._comments['品牌货号'] || '').includes(quoted)) {
    row._comments['品牌货号'] = row._comments['品牌货号'] ? `${row._comments['品牌货号']}; ${quoted}` : quoted;
  }
  if (flagReason && flagReason !== ITEM_ID_GUARD_NOTE && !row._comments['品牌货号']) {
    row._comments['品牌货号'] = flagReason;
  }
}

const LINE_ID_FIELDS = ['styleRef', 'style', 'barcode', 'ean', 'gtin', 'upc', 'productId',
  'concessionCode', 'storeSku', 'retailerSku', 'departmentCode', 'concession', 'priceNotNumeric', 'internalCode'];

// P4 tender rules live in tillroll/tender.js (imported above) and are applied
// here and on every export path. Cash and an empty tender stay Pink.
const CHANEL_BLOCKED_COMMENT = 'chanel.com blocked; confirmed on chanel.cn/gb';
function priceReading(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { invalid: false, missing: true };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { invalid: false } : { invalid: true, raw: String(raw) };
  const n = Number(String(raw).replace(/[£$€,\s]/g, ''));
  if (Number.isFinite(n) && /\d/.test(String(raw))) return { invalid: false };
  return { invalid: true, raw: String(raw).trim() };
}
function idsMatch(a, b) {
  const n = v => String(v ?? '').replace(/[\s-]/g, '').toUpperCase();
  return Boolean(n(a)) && n(a) === n(b);
}
// Format answers come from brand-item-ids.js. A code taken from an unconfirmed
// product name is not written over the printed 品牌货号.
function brandItemFormat(brand, value) {
  if (isConcessionCode(value)) return 'no match';
  const chosen = chooseItemId({ brand, fields: { itemId: value, sku: value } });
  if (chosen && matchesBrandItemId(brand, chosen) && idsMatch(chosen, value)) return 'match';
  return matchBrandIdFormat(brand, value);
}
function exactIdAndPrice(top, row) {
  const price = row.cells['采购商品原价'];
  if (top?.matchType !== 'id' || typeof price !== 'number' || top.price == null) return false;
  if (top.currency && row.raw?.currency && top.currency !== row.raw.currency) return false;
  return Math.abs(Number(top.price) - price) <= priceTolerance(price);
}
function touchCell(row, col) {
  if (!row._lookupTouched) row._lookupTouched = new Set();
  row._lookupTouched.add(col);
}
function appendComment(row, col, text) {
  if (!text) return;
  if (!row._comments) row._comments = {};
  const cur = row._comments[col];
  if (!cur) row._comments[col] = text;
  else if (!cur.includes(text)) row._comments[col] = `${cur}; ${text}`;
}
function chanelFallbackComment(urls) {
  const parsed = [];
  for (const u of urls || []) { try { parsed.push(new URL(u)); } catch { /* not a URL */ } }
  if (!parsed.length) return null;
  const host = u => u.hostname.replace(/^www\./i, '').toLowerCase();
  const cnOrGb = u => host(u) === 'chanel.cn' || host(u).endsWith('.chanel.cn') || (host(u) === 'chanel.com' && u.pathname.toLowerCase().startsWith('/gb'));
  const otherChanel = u => host(u) === 'chanel.com' && !u.pathname.toLowerCase().startsWith('/gb');
  if (!parsed.some(cnOrGb) || parsed.some(otherChanel)) return null;
  return CHANEL_BLOCKED_COMMENT;
}

function addFlag(row, col, colour, reason, extra = {}) {
  const prev = row.flags[col];
  // Mixed reading + look-up uncertainty is Amber (manual 7E.19).
  row.flags[col] = prev && prev !== colour ? AMBER : colour;
  (colour === PINK ? row._reading : row._lookup).push({ col, reason, ...extra });
}
// A look-up on this row produced a new result for this cell. Round 2 may replace the baseline flag.
function lookupFlag(row, col, colour, reason, extra = {}) {
  if (!row._lookupTouched) row._lookupTouched = new Set();
  row._lookupTouched.add(col);
  addFlag(row, col, colour, reason, extra);
}
// Receipt wins on prices and 品牌货号. Official site wins on 品牌 and 品名.
// The value that is NOT in the cell is kept for the Excel comment and hidden column.
function noteMismatch(row, col, receipt, official, shown) {
  if (receipt === null || receipt === undefined || official === null || official === undefined) return;
  if (String(receipt) === String(official)) return;
  if (!row._alternates) row._alternates = {};
  if (!row._comments) row._comments = {};
  row._alternates[col] = { receipt, official, shown };
  row._comments[col] = shown === 'official' ? `Receipt printed: ${receipt}` : `Official site: ${official}`;
}

// ---- Stage 1: Receipt Reader & Sanity Checker ------------------------------
function readerStage(receipt, rIndex, state, ctx) {
  const rows = [];
  const merchant = str(receipt.merchant);
  const receiptId = str(receipt.receiptReference) || str(receipt.orderNumber) || str(receipt.orderId);
  const ts = normaliseTimestamp(receipt.date, receipt.time);
  const tender = normaliseTender(receipt.payment);
  const items = Array.isArray(receipt.items) ? receipt.items : [];
  items.forEach((it, i) => {
    const qty = num(it.qty) ?? 1;
    const unit = num(it.unitPrice), amount = num(it.amount), discount = num(it.discount) ?? 0;
    const lineIndex = it.lineIndex ?? i;
    // Zero-price exclusion: only a confirmed true printed 0 is dropped.
    const zeroUnit = unit === 0, zeroAmt = amount === 0;
    const confirmedZero = (it.zeroConfirmed === true && (zeroUnit || zeroAmt)) || (zeroUnit && zeroAmt && it.zeroConfirmed !== false);
    if (confirmedZero) { state.excludedZero.push(zeroRecord(receipt.receiptKey, it, lineIndex, receipt)); return; }
    const sorted = sortItemFields({ brand: str(it.brand), name: str(it.item), itemId: str(it.itemId) }, { canonicalBrand, phrases: brandSearchPhrases() });
    const previewRowId = it.rowId || `${receipt.receiptKey}:${lineIndex}:u${it.unitIndex ?? 0}`;
    const brandLocked = typeof ctx?.locked === 'function' && ctx.locked(previewRowId, '品牌');
    const nameHasCanonicalBrand = Boolean(sorted.brand && String(it.item || '').toLowerCase().includes(String(sorted.brand).toLowerCase()));
    const brandRaw = brandLocked ? str(it.brand) : (str(it.brand) || (sorted.brandMoved && nameHasCanonicalBrand ? str(sorted.brand) : str(it.brand)));
    const builder = builderBrandItem(it);
    const picked = builder
      ? { cell: builder.id == null || String(builder.id).trim() === '' ? null : String(builder.id).trim(), storeCodes: [], lookupId: builder.id == null ? null : String(builder.id).trim(), idClass: 'builder', builder }
      : selectBrandItem({ brand: brandRaw, concessionCode: it.concessionCode, internalCode: it.internalCode, ean: it.ean, itemId: it.itemId, sku: it.sku, styleRef: it.styleRef }, ctx?.brandIdFormat || brandItemFormat);
    let itemCell = builder ? picked.cell : stripBrandFromItemId(picked.cell, brandRaw);
    if (itemCell && isConcessionCode(itemCell)) itemCell = null;
    // An unfitting printed code yields to a format match, or to the EAN
    // fall-through, from the labelled fields only. A printed value with no
    // better match is left as printed, and a code is not taken from the name.
    let replacedUnfitting = false;
    if (!builder && brandHasItemIdFormat(brandRaw) && itemCell && !matchesBrandItemId(brandRaw, itemCell)) {
      const chosen = chooseItemId({ brand: brandRaw, fields: { itemId: it.itemId, sku: it.sku, styleRef: it.styleRef, ean: it.ean } });
      if (chosen && !isConcessionCode(chosen) && !idsMatch(chosen, itemCell)) {
        itemCell = chosen;
        replacedUnfitting = true;
        if (/^\d{8,14}$/.test(String(chosen).replace(/\s/g, ''))) picked.idClass = 'ean';
        else if (matchesBrandItemId(brandRaw, chosen)) picked.idClass = 'style';
      }
    }
    const formatTable = ctx?.formatTable || getBrandItemIdFormat();
    const readerChosenId = chooseItemId({ brand: brandRaw, fields: { itemId: it.itemId, sku: it.sku, styleRef: it.styleRef, ean: it.ean, item: it.item, name: it.name, allowEan: true } }) || itemCell || null;
    const hasFormat = brandHasItemIdFormat(brandRaw) || Boolean(formatPattern(brandRaw, formatTable));
    const hookKeeps = v => {
      const hook = ctx?.brandIdFormat;
      if (typeof hook !== 'function' || !v) return false;
      const ans = hook(brandRaw, v);
      return Boolean(ans) && ans !== 'no match' && ans !== 'none';
    };
    const usableId = v => {
      if (!v) return false;
      if (hookKeeps(v)) return true;
      if (isStoreCode(v) || isForbiddenBrandItemCode(v, it)) return false;
      if (isEan(v) || isBarcodeOrEan(v)) return true;
      const injected = formatPattern(brandRaw, formatTable);
      if (injected) return injected.test(str(v)) || injected.test(compactId(v));
      return true;
    };
    // Fall through to a labelled EAN or fitting style when the printed token is unfitting.
    if (!usableId(itemCell) && usableId(readerChosenId) && !idsMatch(readerChosenId, itemCell)) itemCell = readerChosenId;
    // #20 guard: store/internal codes and unfitting non-EAN codes must not occupy the cell.
    if (itemCell && !usableId(itemCell)) itemCell = usableId(readerChosenId) ? readerChosenId : null;
    const unitRead = priceReading(it.rawUnitPrice !== undefined ? it.rawUnitPrice : it.unitPrice);
    const amountRead = priceReading(it.rawAmount !== undefined ? it.rawAmount : it.amount);
    const unitCell = unitRead.invalid ? null : unit;
    const amountCell = amountRead.invalid ? null : amount;
    const invalidPrices = {};
    if (unitRead.invalid) invalidPrices['采购商品原价'] = unitRead.raw;
    if (amountRead.invalid) invalidPrices['采购商品金额'] = amountRead.raw;
    const estimated = it.estimated === true || it.discountKind === 'estimated';
    const unitCount = it.unitCount || (receipt.items || []).filter(x => (x.lineIndex ?? 0) === lineIndex).length || 1;
    const row = { rowId: it.rowId || `${receipt.receiptKey}:${lineIndex}:u0`, receiptKey: receipt.receiptKey, lineIndex, unitIndex: it.unitIndex ?? 0, unitCount, estimated, flags: {}, notes: [], _reading: [], _lookup: [], _alternates: {}, _comments: {}, _candidates: null, _officialBranch: null, lookup: null, mismatches: [], discountKind: it.discountKind || (estimated ? 'estimated' : 'none'),
      cells: { '采购小票id': receiptId, '采购时间': ts, '供应商': merchant, '品牌': brandRaw, '品名': str(it.item), '品牌货号': itemCell,
        '采购商品原价': unitCell ?? (amountCell !== null && !unitRead.invalid ? round2((amountCell + discount) / (qty || 1)) : null), '采购商品金额': amountCell, '采购商品方法': tender, '销售金额': null },
      raw: { printedBrand: brandRaw, style: str(it.styleRef) || (str(it.sku) !== str(it.itemId) ? str(it.sku) : null), colour: str(it.colour), size: str(it.size), qty, currency: str(receipt.currency) || 'GBP', storeCodes: picked.storeCodes, idClass: picked.idClass, builder, itemLabels: { concessionCode: it.concessionCode ?? null, internalCode: it.internalCode ?? null, ean: it.ean ?? null, itemId: it.itemId ?? null, sku: it.sku ?? null, styleRef: it.styleRef ?? null }, invalidPrices, printedItemId: replacedUnfitting ? itemCell : ((picked.idClass === 'ean' || picked.idClass === 'concession' || picked.idClass === 'unlabelled10') ? picked.lookupId : (itemCell || picked.lookupId)), extraUrls: builderUrls(it, builder) },
      storeClues: receipt.storeClues || null };
    if (!receiptId) addFlag(row, '采购小票id', PINK, /selfridges/i.test(merchant || '') ? 'Selfridges receipt number (below the barcode) not read.' : /harrods/i.test(merchant || '') ? 'Harrods receipt number (right of date/time) not read.' : 'Receipt ID not read.');
    if (!ts) addFlag(row, '采购时间', PINK, 'Date/time missing or not a valid date.');
    if (!merchant) addFlag(row, '供应商', PINK, 'Supplier not read.');
    if (!tender || !ALLOWED_TENDERS.includes(tender)) {
      addFlag(row, '采购商品方法', PINK, TENDER_REASON);
      row._comments['采购商品方法'] = TENDER_REASON;
    }
    const brandId = resolveBrandItemId({ item: it, brand: brandRaw, formatTable });
    const cellNow = row.cells['品牌货号'];
    const cellUsable = usableId(cellNow);
    const chanelStyle = isChanelBrandName(brandRaw) ? (brandId.brandItemId || extractChanelStyleRef(cellNow)) : null;
    // Builder already chose the exported id, flag, and reason. Do not overlay
    // a resolve() empty-cell / "no brand item ID printed" comment on it.
    if (!builder) {
    if (chanelStyle && cellNow && chanelStyle !== cellNow && extractChanelStyleRef(cellNow) === chanelStyle) {
      applyBrandItemIdRecord(row, { ...brandId, brandItemId: chanelStyle, brandItemIdSource: brandId.brandItemIdSource || 'styleRef', flag: brandId.flag, reason: brandId.reason });
    } else if (cellUsable && (isEan(cellNow) || isBarcodeOrEan(cellNow) || matchesBrandItemId(brandRaw, cellNow))) {
      applyBrandItemIdRecord(row, {
        brandItemId: cellNow,
        brandItemIdSource: (isEan(cellNow) || isBarcodeOrEan(cellNow)) ? 'ean' : (brandId.brandItemIdSource || 'styleRef'),
        flag: (isEan(cellNow) || isBarcodeOrEan(cellNow)) ? AMBER : brandId.flag,
        reason: (isEan(cellNow) || isBarcodeOrEan(cellNow)) ? 'EAN used as 品牌货号; not a brand style ref.' : brandId.reason,
        printedValue: brandId.printedValue,
      }, { keepCell: true });
    } else if (cellUsable && hookKeeps(cellNow)) {
      // A brand-format hook can keep a 10-digit token the store-code guard would reject.
      applyBrandItemIdRecord(row, {
        brandItemId: cellNow,
        brandItemIdSource: brandId.brandItemIdSource || 'brandProductCode',
        flag: null,
        reason: null,
      }, { keepCell: true });
    } else if (cellUsable) {
      applyBrandItemIdRecord(row, { ...brandId, brandItemId: cellNow, flag: brandId.flag, reason: brandId.reason, printedValue: brandId.printedValue }, { keepCell: true });
    } else if (picked.idClass === 'concession' || picked.idClass === 'unlabelled10' || picked.idClass === 'last4') {
      // #4 already held the token out of the cell. Do not write a resolved EAN
      // or official id back; settleBrandItemId / last4 set the Pink reason.
      row.cells['品牌货号'] = null;
      row.brandItemId = null;
      row.brandItemIdSource = null;
    } else {
      // Store code or injected-table miss: keep the cell empty + Pink.
      // Never write a forbidden / store-shaped resolved id.
      const writeId = brandId.brandItemId && usableId(brandId.brandItemId) && !isStoreCode(brandId.brandItemId) && !isForbiddenBrandItemCode(brandId.brandItemId, it)
        ? brandId.brandItemId : null;
      applyBrandItemIdRecord(row, {
        ...brandId,
        brandItemId: writeId,
        brandItemIdSource: writeId ? brandId.brandItemIdSource : null,
        flag: writeId ? brandId.flag : PINK,
        reason: writeId ? brandId.reason : (brandId.reason && brandId.reason !== ITEM_ID_GUARD_NOTE ? brandId.reason : 'no brand item ID printed'),
      });
    }
    }
    row._readerChosenId = readerChosenId || row.raw?.printedItemId || null;
    if (!row.raw.printedItemId && readerChosenId) row.raw.printedItemId = readerChosenId;
    if (!row.cells['品名'] || JUNK_NAME.test(row.cells['品名'])) {
      addFlag(row, '品名', PINK, `Item name "${row.cells['品名'] ?? ''}" failed the column sanity check.`);
    } else if (sorted.junk || !sorted.nameHasNonBrandWord) {
      const why = sorted.codePlusBrand ? 'is only a product code plus the brand' : 'has no non-brand word';
      addFlag(row, '品名', PINK, `Item name "${row.cells['品名'] ?? str(it.item) ?? ''}" ${why}.`);
    }
    if (sorted.brandMoved) addFlag(row, '品牌', PINK, 'Brand was empty and was taken from the item name.');
    if (builder) {
      const colour = builderFlagColour(builder.flag);
      if (colour) addFlag(row, '品牌货号', colour, builder.reason || 'Builder item id.');
    } else if (picked.idClass === 'last4') {
      addFlag(row, '品牌货号', PINK, 'Item ID looks like card last-4.');
    }
    const idp = builder || picked.idClass === 'last4' ? null : itemIdProblem(row.cells['品牌货号']);
    if (idp) addFlag(row, '品牌货号', PINK, `Item ID ${idp}.`);
    if ((it.fieldIssues || []).some(f => /itemid/i.test(f))) addFlag(row, '品牌货号', PINK, 'Reader marked the item ID as uncertain.');
    if (!unitRead.invalid && unit === null && amount === null) addFlag(row, '采购商品原价', PINK, 'No price read.');
    else if (!unitRead.invalid && unit === null) addFlag(row, '采购商品原价', PINK, 'Unit price not printed; derived from line amount.');
    if ((zeroUnit || zeroAmt) && !unitRead.invalid && row.flags['采购商品原价'] !== PINK) addFlag(row, '采购商品原价', PINK, 'Doubtful 0 price: may be an OCR miss.');
    if (!amountRead.invalid && amount === null) addFlag(row, '采购商品金额', PINK, 'Line amount not read.');
    else if (unit !== null && Math.abs(qty * unit - discount - amount) > 0.02 && Math.abs(qty * unit - amount) > 0.02) addFlag(row, '采购商品金额', PINK, `qty × unit price − discount (${round2(qty * unit - discount)}) does not match amount (${amount}).`);
    for (const col of it.readingFlags || []) if (COLUMNS.includes(col)) addFlag(row, col, PINK, it.baselineFlagReasons?.[col] || it.flagReasons?.[col] || 'Flagged by the reader.');
    // Printed per-unit discounts are exact. Only a proportional estimate is Amber.
    if (row.estimated && typeof row.cells['采购商品金额'] === 'number') {
      addFlag(row, '采购商品金额', AMBER, 'Discount allocated proportionally from a line or receipt total (not printed per unit).', { estimated: true });
    }
    rows.push(row);
  });
  return rows;
}

function candidateText(list) {
  if (!list?.length) return '';
  return 'Candidates: ' + list.map(c => [c.officialName, c.itemId, c.price].filter(v => v != null && v !== '').join(' ')).join(' | ');
}
// Held-out codes are the Reader's concessionCode / internalCode / ean labels,
// plus an unlabelled numeric-only 10-digit value the brand-format hook did not match.
// A styleRef, including 000001, is not held out.
function noteStoreCodes(row) {
  const codes = row.raw?.storeCodes || [];
  if (!codes.length) return;
  const cell = row.cells['品牌货号'];
  if (cell && codes.some(code => idsMatch(code, cell))) row.cells['品牌货号'] = null;
  for (const code of codes) appendComment(row, '品牌货号', code);
  const joined = codes.join(' ');
  const alt = row._alternates['品牌货号'];
  if (!alt) row._alternates['品牌货号'] = { receipt: joined, official: null, shown: 'receipt' };
  else if (!codes.every(code => String(alt.receipt ?? '').includes(code))) {
    row._alternates['品牌货号'] = { ...alt, receipt: [joined, alt.receipt].filter(Boolean).join('; ') };
  }
}
function officialItemId(top, row) {
  const id = str(top?.itemId);
  if (!id || isConcessionCode(id)) return null;
  const held = row.raw?.storeCodes || [];
  if (concessionReading(id, row.raw?.itemLabels || {})) return null;
  if (row.raw?.idClass === 'unlabelled10' && isUnlabelledTenDigits(id) && idsMatch(id, row.raw.printedItemId)) return null;
  if (held.some(code => idsMatch(code, id) && (idsMatch(code, row.raw?.itemLabels?.concessionCode) || idsMatch(code, row.raw?.itemLabels?.internalCode)))) return null;
  return id;
}

function syncBrandItemIdMetadata(row, top) {
  const cell = row.cells['品牌货号'] ?? null;
  const official = officialItemId(top, row) || str(top?.itemId);
  row.brandItemId = cell;
  if (row.flags['品牌货号'] === PINK) {
    row.brandItemIdFlag = PINK;
    return;
  }
  if (cell && official && idsMatch(cell, official) && (row.brandItemIdSource === 'ean' || row.raw?.idClass === 'ean' || isEan(row.raw?.printedItemId))) {
    row.brandItemIdSource = 'official';
    row.brandItemIdFlag = row._exactIdPrice ? null : (row.flags['品牌货号'] ?? AMBER);
    row.brandItemIdReason = row._exactIdPrice ? null : (row.brandItemIdReason && /Official brand item ID/.test(row.brandItemIdReason) ? row.brandItemIdReason : 'Official brand item ID from look-up.');
  } else if (cell && official && !idsMatch(cell, official)) {
    const why = officialSiteShowsReason(official);
    row.brandItemIdFlag = AMBER;
    if (!row.brandItemIdReason || !/official site shows/.test(row.brandItemIdReason)) row.brandItemIdReason = why;
    const lookups = row._lookup || [];
    const hasCandidates = lookups.some(e => e.col === '品牌货号' && /Candidate/i.test(e.reason || ''));
    if (!hasCandidates) {
      if (row.flags['品牌货号'] !== PINK) row.flags['品牌货号'] = AMBER;
      // Remap #4's "Official item id differs" uncertainty to the official-site-shows phrase.
      row._lookup = lookups.filter(e => e.col !== '品牌货号');
      row._lookup.push({ col: '品牌货号', reason: why, sourceUrls: top?.sourceUrls || [] });
    }
  } else if (!cell) {
    row.brandItemIdFlag = row.brandItemIdFlag || row.flags['品牌货号'] || PINK;
  } else {
    row.brandItemIdFlag = row.brandItemIdFlag ?? row.flags['品牌货号'] ?? null;
  }
}

function settleBrandItemId(row, top, ctx) {
  if (row.raw?.idClass === 'builder' || row.raw?.idClass === 'last4') {
    noteStoreCodes(row);
    return;
  }
  noteStoreCodes(row);
  const c = row.cells;
  if (ctx.locked(row.rowId, '品牌货号')) return;
  const printed = row.raw.printedItemId ?? c['品牌货号'];
  const kind = row.raw?.idClass === 'concession' || row.raw?.idClass === 'unlabelled10' ? 'concession' : row.raw?.idClass === 'ean' ? 'ean' : 'style';
  const styleId = officialItemId(top, row);
  if (kind === 'concession') {
      if (c['品牌货号'] && (row.raw?.storeCodes || []).some(code => idsMatch(code, c['品牌货号']))) c['品牌货号'] = null;
    if (styleId && top) {
      c['品牌货号'] = styleId;
      row._alternates['品牌货号'] = { receipt: printed, official: styleId, shown: 'official' };
      row._comments['品牌货号'] = `Concession code ${printed} is not a brand item id. Official item id ${styleId}.`;
      if (top.matchType === 'price-fallback') appendComment(row, '品牌货号', candidateText(row._candidates?.length ? row._candidates : [top]));
      if (row.flags['品牌货号'] === PINK) {
        delete row.flags['品牌货号'];
        row._reading = row._reading.filter(e => e.col !== '品牌货号');
      }
      lookupFlag(row, '品牌货号', AMBER, 'Official brand item id from look-up.', { sourceUrls: top.sourceUrls || [], ...(row._candidates ? { candidates: row._candidates } : {}) });
    } else if (row.flags['品牌货号'] !== PINK) {
      c['品牌货号'] = null;
      appendComment(row, '品牌货号', printed);
      appendComment(row, '品牌货号', 'no brand item ID printed');
      addFlag(row, '品牌货号', PINK, 'no brand item ID printed');
      row._alternates['品牌货号'] = { receipt: printed, official: null, shown: 'receipt' };
    } else {
      c['品牌货号'] = null;
      appendComment(row, '品牌货号', printed);
      if (!row._alternates['品牌货号']) row._alternates['品牌货号'] = { receipt: printed, official: null, shown: 'receipt' };
    }
    return;
  }
  if (row.flags['品牌货号'] === PINK) return;
  if (kind === 'ean') {
    if (styleId && !idsMatch(styleId, printed)) {
      noteMismatch(row, '品牌货号', printed, styleId, 'official');
      c['品牌货号'] = styleId;
      if (top?.matchType === 'price-fallback') appendComment(row, '品牌货号', candidateText(row._candidates?.length ? row._candidates : [top]));
      lookupFlag(row, '品牌货号', AMBER, 'Style reference used instead of an EAN.', { sourceUrls: top?.sourceUrls || [] });
    } else if (printed) {
      if (!c['品牌货号']) c['品牌货号'] = printed;
      appendComment(row, '品牌货号', 'Only an EAN is available; the brand item id was not found.');
      if (!row._alternates['品牌货号']) row._alternates['品牌货号'] = { receipt: printed, official: null, shown: 'receipt' };
      lookupFlag(row, '品牌货号', AMBER, 'Only an EAN is available; the brand item id was not found.', { sourceUrls: top?.sourceUrls || [] });
    }
    return;
  }
  if (kind === 'style' && top?.matchType === 'price-fallback') {
    if (top.itemId && printed && !idsMatch(top.itemId, printed)) {
      noteMismatch(row, '品牌货号', printed, top.itemId, 'receipt');
      lookupFlag(row, '品牌货号', AMBER, `Official item id ${top.itemId} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls || [], ...(row._candidates ? { candidates: row._candidates } : {}) });
    } else if (printed) {
      lookupFlag(row, '品牌货号', AMBER, 'Price-fallback look-up.', { sourceUrls: top.sourceUrls || [], ...(row._candidates ? { candidates: row._candidates } : {}) });
    }
    appendComment(row, '品牌货号', candidateText(row._candidates?.length ? row._candidates : [top]));
    return;
  }
  if (top?.itemId && printed && !idsMatch(top.itemId, printed) && top.matchType !== 'price-fallback') {
    noteMismatch(row, '品牌货号', printed, top.itemId, 'receipt');
    lookupFlag(row, '品牌货号', AMBER, `Official item id ${top.itemId} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls || [] });
  }
}

// ---- Stage 2: Brand & Catalogue Look-up Verifier --------------------------
async function verifierStage(rows, receipt, ctx) {
  const canon = canonicalBrand(rows[0]?.cells['供应商']);
  // Branch suffix once per receipt (multi-store UK suppliers).
  const sc = receipt.storeClues;
  if (rows.length && sc && (sc.postcode || (sc.addressLines || []).length || sc.storeNumber) && rows[0].cells['供应商']) {
    const res = await ctx.callLookup({ supplier: rows[0].cells['供应商'], storeClues: sc });
    const name = res?.branch?.officialStoreName;
    const printedSupplier = rows[0].cells['供应商'];
    const visible = name ? supplierVisibleName(printedSupplier, name) : printedSupplier;
    for (const row of rows) row._officialBranch = name || null;
    if (name && visible && visible !== printedSupplier) for (const row of rows) {
      if (ctx.locked(row.rowId, '供应商')) continue;
      noteMismatch(row, '供应商', printedSupplier, visible, 'official');
      row.cells['供应商'] = visible;
      lookupFlag(row, '供应商', AMBER, 'Official UK branch name from look-up.', { sourceUrls: res.branch.sourceUrls || [] });
    }
  }
  void canon;
  for (const row of rows) {
    const c = row.cells;
    // Brand canonicalisation (abbreviation expansion / sub-department collapse).
    if (c['品牌']) {
      const printedBrand = c['品牌'];
      const cb = canonicalBrand(printedBrand);
      if (cb && cb !== printedBrand && !ctx.locked(row.rowId, '品牌')) {
        noteMismatch(row, '品牌', printedBrand, cb, 'official');
        c['品牌'] = cb;
        lookupFlag(row, '品牌', AMBER, 'Brand expanded to the official name.');
      }
    }
    // Review the Reader first: do not burn quota on suspect input.
    if (!row.raw.printedItemId) row.raw.printedItemId = c['品牌货号'];
    if ((row.flags['品牌货号'] === PINK && !row._readerChosenId) || (row.flags['采购商品原价'] === PINK && !c['品牌货号'] && !row._readerChosenId)) { row.notes.push('Look-up held until the reading error is fixed.'); settleBrandItemId(row, null, ctx); continue; }
    if (ctx.mode === 'round2' && row.skipLookup) { settleBrandItemId(row, null, ctx); continue; }
    if (!row.raw.printedItemId && !c['品名']) { settleBrandItemId(row, null, ctx); continue; }
    if (ctx.lookupsUsed >= MAX_LOOKUPS_PER_RUN) { lookupFlag(row, '品名', AMBER, 'Look-up deferred: per-run cap reached.'); settleBrandItemId(row, null, ctx); continue; }
    const printedFits = Boolean(c['品牌货号'] && matchesBrandItemId(row.raw.printedBrand || c['品牌'], c['品牌货号']));
    const lookupItemId = printedFits ? c['品牌货号'] : (row._readerChosenId || row.raw.printedItemId || c['品牌货号']);
    const req = { brand: row.raw.printedBrand || c['品牌'], itemId: lookupItemId, name: c['品名'], style: row.raw.style, price: c['采购商品原价'], currency: row.raw.currency };
    const res = await ctx.callLookup(req);
    if (!res) { settleBrandItemId(row, null, ctx); continue; }
    if (res.paused || res.unavailableReason) {
      // A paused or unavailable look-up stays Amber, even when nothing came back.
      lookupFlag(row, '品名', AMBER, `Look-up paused: ${res.unavailableReason || 'quota guard reached'}.`);
      ctx.paused.add(res.unavailableReason || 'quota guard');
      if (!res.candidates?.length) { settleBrandItemId(row, null, ctx); continue; }
    }
    const top = res.candidates?.[0];
    if (top?.officialName) row.raw.officialName = top.officialName;
    row.lookup = { cacheKey: res.cacheKey, matchType: top?.matchType || null, confidence: top?.confidence ?? null, sourceUrls: top?.sourceUrls || [] };
    row.mismatches = Array.isArray(res.mismatches) ? res.mismatches : [];
    row.lookup.mismatches = row.mismatches;
    if ((res.candidates || []).some(x => x.matchType === 'price-fallback')) {
      row._candidates = res.candidates.map(x => ({ officialName: x.officialName, itemId: x.itemId, brand: x.brand, price: x.price, currency: x.currency, weightGrams: x.weightGrams, sourceUrls: x.sourceUrls || [] }));
    }
    if (!top) { lookupFlag(row, '品名', AMBER, 'No official match found; values kept as printed.'); settleBrandItemId(row, null, ctx); continue; }
    if (top.matchType === 'multi-field') {
      const ties = res.candidates.filter(x => x.matchType === 'multi-field' && x.matchedFields.length === top.matchedFields.length && x.confidence === top.confidence);
      if (ties.length > 1) {
        lookupFlag(row, '品名', AMBER, 'Several official items match equally well. Pick one.', { candidates: ties.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        settleBrandItemId(row, top, ctx); continue;
      }
    }
    if (top.matchType === 'price-fallback') {
      if (priceFallbackIsTie({ brand: row.raw.printedBrand || c['品牌'], itemId: row.raw.printedItemId, name: c['品名'], style: row.raw.style, price: c['采购商品原价'], currency: row.raw.currency }, res.candidates)) row._skipOfficialName = true;
      const samePrice = res.candidates.filter(x => Math.abs(x.price - top.price) < 0.005);
      if (samePrice.length > 1 && samePrice.every(x => x.weightGrams === null)) {
        lookupFlag(row, '品名', AMBER, 'Item ID matched nothing; several official items at this price and no published weight. Pick one.', { candidates: samePrice.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        settleBrandItemId(row, top, ctx); continue;
      }
      row.notes.push(top.weightGrams !== null ? `Closest-price fallback; lightest published weight ${top.weightGrams} g.` : 'Closest-price fallback.');
    }
    // P5: an exact item-id and price match writes the official 品名 with no fill.
    // Amber is only for a partial match, a price-fallback, or no identified item.
    // A Pink reading flag on any other cell is left in place. A lock is not overwritten.
    const exact = exactIdAndPrice(top, row);
    if (exact) row._exactIdPrice = true;
    if (!c['品牌'] && top.brand && !ctx.locked(row.rowId, '品牌')) {
      noteMismatch(row, '品牌', c['品牌'], top.brand, 'official');
      c['品牌'] = top.brand;
      lookupFlag(row, '品牌', AMBER, 'Brand recovered by look-up.', { confidence: top.confidence, sourceUrls: top.sourceUrls });
    }
    if (!ctx.locked(row.rowId, '品名') && row.flags['品名'] !== PINK) {
      if (!row._skipOfficialName && top.officialName && top.officialName !== c['品名']) {
        noteMismatch(row, '品名', c['品名'], top.officialName, 'official');
        row.previousName = c['品名'];
        c['品名'] = top.officialName;
        row.raw.nameFromOfficial = true;
      } else if (top.officialName && c['品名'] && String(c['品名']).trim().toLowerCase() === String(top.officialName).trim().toLowerCase()) {
        row.raw.nameFromOfficial = true;
      }
      if (exact || top.onOfficialSite === true && top.officialName && c['品名'] === top.officialName) row.raw.nameFromOfficial = true;
      if (exact) {
        touchCell(row, '品名');
        if (row.flags['品名'] === AMBER) delete row.flags['品名'];
      } else {
        const why = top.matchType === 'price-fallback' ? 'Price-fallback look-up.'
          : top.matchType === 'id' ? 'Item id matched but the price does not match the official site exactly.'
          : `Partial or unidentified look-up (${top.matchType}).`;
        lookupFlag(row, '品名', AMBER, why, { confidence: top.confidence, sourceUrls: top.sourceUrls, ...(row._candidates ? { candidates: row._candidates } : {}) });
      }
    }
    const exactOfficial = exact || isExactOfficialIdPriceMatch(req, top);
    if (exactOfficial) row._exactIdPrice = true;
    if (top.price === null || top.price === undefined) {
      if (!ctx.locked(row.rowId, '采购商品原价')) lookupFlag(row, '采购商品原价', AMBER, 'official price unavailable', { confidence: top.confidence, sourceUrls: top.sourceUrls });
    } else if (typeof c['采购商品原价'] === 'number' && Math.abs(Number(top.price) - c['采购商品原价']) > priceTolerance(c['采购商品原价'])) {
      for (const col of ['采购商品原价', '采购商品金额']) {
        if (ctx.locked(row.rowId, col)) continue;
        noteMismatch(row, col, c[col], top.price, 'receipt');
        lookupFlag(row, col, AMBER, `Official price ${top.price} differs from the receipt. Receipt value kept.`, { sourceUrls: top.sourceUrls });
      }
    }
    settleBrandItemId(row, top, ctx);
    syncBrandItemIdMetadata(row, top);
    noteChanel(row, top.sourceUrls || []);
    row._candidatePrice = top.price; row._candidateCurrency = top.currency;
  }
}

// ---- Stage 3: Reader cross-checks the Look-up Verifier --------------------
function readerReview(rows, trail) {
  for (const row of rows) {
    if (row._candidateCurrency && row.raw.currency && row._candidateCurrency !== row.raw.currency) { row.notes.push(`Official price is in ${row._candidateCurrency}; receipt is ${row.raw.currency}. Printed price kept.`); trail.push({ stage: 'reader-review', rowId: row.rowId, issue: 'currency' }); continue; }
    const p = row.cells['采购商品原价'];
    if (row._candidatePrice && p && Math.abs(row._candidatePrice - p) / p > 0.3 && row.lookup?.matchType === 'id') {
      row.notes.push(`Official price ${row._candidatePrice} differs from printed ${p}; printed price kept.`);
      row.lookup.confidence = Math.max(0, round2((row.lookup.confidence || 0) - 0.2));
      trail.push({ stage: 'reader-review', rowId: row.rowId, issue: 'price-gap' });
    }
  }
}

// ---- Stage 4: Excel Sync & History Manager audit ---------------------------
function excelAudit(rows, ctx) {
  const issues = [];
  for (const row of rows) {
    const c = row.cells;
    if (typeof c['采购商品原价'] === 'number' && c['采购商品原价'] === 0 && row.flags['采购商品原价'] !== PINK) issues.push({ rowId: row.rowId, fix: 'zero-leak' });
    c['销售金额'] = typeof c['采购商品原价'] === 'number' ? round2(c['采购商品原价'] * 0.88) : null;
    if (c['采购时间'] && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(c['采购时间'])) issues.push({ rowId: row.rowId, fix: 'timestamp' });
    for (const [col, colour] of Object.entries(row.flags)) {
      if (![PINK, AMBER].includes(colour) || !COLUMNS.includes(col)) issues.push({ rowId: row.rowId, fix: 'bad-flag', col });
      if (ctx.locked(row.rowId, col)) delete row.flags[col]; // human_verified_unflagged: never re-flag
    }
    if (Object.keys(c).join('|') !== COLUMNS.join('|')) issues.push({ rowId: row.rowId, fix: 'columns' });
  }
  return issues;
}
// Round 2 keeps every baseline flag. A flag changes only when a person cleared
// the fill, edited the value, or a look-up of this row produced a new result
// for that cell. A cleared fill is a lock and is never put back.
function restoreBaselineFlags(row, ctx) {
  const base = row._baselineFlags;
  if (!base) return;
  const edited = row._editedCols || new Set();
  const cleared = row._clearedCols || new Set();
  const touched = row._lookupTouched || new Set();
  for (const col of COLUMNS) {
    const locked = cleared.has(col) || ctx.locked(row.rowId, col);
    if (locked) { delete row.flags[col]; continue; }
    if (edited.has(col) || touched.has(col)) continue;
    const was = base[col];
    if (was === PINK || was === AMBER) {
      if (row.flags[col] === was) continue;
      row.flags[col] = was;
      const reason = row._baselineFlagReasons?.[col] || 'Kept from the previous export.';
      const list = was === PINK ? row._reading : row._lookup;
      if (!list.some(e => e.col === col)) list.push({ col, reason });
    } else if (was === null && Object.prototype.hasOwnProperty.call(base, col)) {
      delete row.flags[col];
    }
  }
}

function zeroRecord(receiptKey, it, i, receipt) {
  const printedId = str(it?.receiptId) || str(it?.['采购小票id']) || str(receipt?.receiptReference) || str(receipt?.orderNumber) || str(receipt?.orderId);
  const printedTime = str(it?.purchaseTime) || str(it?.['采购时间']);
  const purchaseTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(printedTime || '')
    ? printedTime
    : normaliseTimestamp(printedTime || receipt?.date, printedTime ? null : receipt?.time);
  return {
    receiptKey: it.receiptKey || receiptKey, lineIndex: it.lineIndex ?? i, name: str(it.item) || str(it.name),
    qty: num(it.qty), unitPrice: num(it.unitPrice), amount: num(it.amount),
    reason: it.reason || 'Confirmed printed zero.',
    receiptId: printedId, purchaseTime,
  };
}
function dedupeZero(list) {
  const seen = new Set();
  return list.filter(z => {
    const key = `${z.receiptKey}|${z.lineIndex}|${z.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Flag-only. Locked human_verified_unflagged cells are left alone. 品名 and 品牌
// are not rewritten; a non-numeric price is cleared to empty.
function noteChanel(row, urls) {
  const note = chanelFallbackComment([...(row.raw?.extraUrls || []), ...(urls || []), ...(row.lookup?.sourceUrls || [])]);
  if (!note || canonicalBrand(row.cells['品牌']) !== 'Chanel') return;
  for (const col of ['品名', '品牌', '品牌货号']) if (row.cells[col]) appendComment(row, col, note);
}
function builderBrandItem(it) {
  const meta = it?.exportMeta && typeof it.exportMeta === 'object' ? it.exportMeta : null;
  const onItem = it && Object.prototype.hasOwnProperty.call(it, 'brandItemId');
  const onMeta = meta && Object.prototype.hasOwnProperty.call(meta, 'brandItemId');
  if (!onItem && !onMeta) return null;
  return {
    id: onItem ? it.brandItemId : meta.brandItemId,
    source: it.brandItemIdSource ?? meta?.brandItemIdSource ?? null,
    flag: it.brandItemIdFlag ?? meta?.brandItemIdFlag ?? null,
    reason: it.brandItemIdReason ?? meta?.brandItemIdReason ?? null,
  };
}
function builderFlagColour(flag) {
  const text = String(flag ?? '').trim().toLowerCase();
  if (flag === PINK || text === '#fecdd3' || text === 'pink') return PINK;
  if (flag === AMBER || text === '#fde68a' || text === 'amber') return AMBER;
  return null;
}
function builderUrls(it, builder) {
  const urls = [];
  const meta = it?.exportMeta;
  if (Array.isArray(meta?.sourceUrls)) urls.push(...meta.sourceUrls);
  if (Array.isArray(it?.sourceUrls)) urls.push(...it.sourceUrls);
  if (typeof builder?.source === 'string' && /^https?:\/\//i.test(builder.source)) urls.push(builder.source);
  return urls;
}
function applyExportGate(row, ctx) {
  for (const finding of gateFindings(row)) {
    if (ctx.locked(row.rowId, finding.col)) continue;
    if (finding.col === '品牌货号' && row.raw?.idClass === 'builder') continue;
    // A cell already Pink for another reason keeps that fill, reason, comment and Flags entry.
    if (finding.reason === NAME_NEEDS_CHECKING && row.flags[finding.col] === PINK) continue;
    const prior = (row._lookup || []).filter(e => e.col === finding.col);
    const priorReading = (row._reading || []).filter(e => e.col === finding.col);
    const lookupReason = [...new Set(prior.map(e => e.reason).filter(Boolean))].join('; ');
    const readingReason = [...new Set(priorReading.map(e => e.reason).filter(Boolean))].join('; ');
    const candidates = prior.flatMap(e => e.candidates || []);
    if (finding.clear) row.cells[finding.col] = null;
    row.flags[finding.col] = PINK;
    row._lookup = (row._lookup || []).filter(e => e.col !== finding.col);
    row._reading = (row._reading || []).filter(e => e.col !== finding.col);
    const combined = [readingReason, finding.reason, lookupReason].filter(Boolean).join('; ');
    row._reading.push({ col: finding.col, reason: combined });
    if (lookupReason || candidates.length) {
      if (!row._gateNotes) row._gateNotes = {};
      row._gateNotes[finding.col] = { gate: finding.reason, lookup: lookupReason || null, candidates };
    }
    appendComment(row, finding.col, finding.reason);
    if (lookupReason) appendComment(row, finding.col, lookupReason);
    if (candidates.length) appendComment(row, finding.col, candidateText(candidates));
    if (!finding.raw) continue;
    appendComment(row, finding.col, finding.raw);
    const alt = row._alternates[finding.col];
    if (!alt) row._alternates[finding.col] = { receipt: finding.raw, official: null, shown: 'receipt' };
    else if (!String(alt.receipt ?? '').includes(finding.raw)) row._alternates[finding.col] = { ...alt, receipt: `${alt.receipt}; ${finding.raw}` };
  }
}

function applyFixes(rows, issues) {
  for (const is of issues) {
    const row = rows.find(r => r.rowId === is.rowId);
    if (!row) continue;
    if (is.fix === 'zero-leak') addFlag(row, '采购商品原价', PINK, 'A 0 price reached the table without a reading flag.');
    if (is.fix === 'timestamp') { addFlag(row, '采购时间', PINK, 'Timestamp not in YYYY-MM-DD HH:MM:SS.'); }
    if (is.fix === 'bad-flag') delete row.flags[is.col];
    if (is.fix === 'columns') row.cells = Object.fromEntries(COLUMNS.map(k => [k, row.cells[k] ?? null]));
  }
}

export async function receiptKeyFor(r, batchId, i) {
  if (r.receiptKey) return String(r.receiptKey);
  if (r.sha256) return 'sha:' + String(r.sha256).slice(0, 16);
  return 'r:' + (await sha256Hex(JSON.stringify([batchId, i, r.merchant, r.receiptReference, r.date, r.time, (r.items || []).length]))).slice(0, 16);
}

export function validateInput(body) {
  if (!body || typeof body !== 'object') throw Object.assign(new Error('Body must be an object.'), { status: 400 });
  const mode = body.mode || 'round1';
  if (!['round1', 'round2'].includes(mode)) throw Object.assign(new Error('mode must be round1 or round2.'), { status: 400 });
  if (!Array.isArray(body.receipts) || !body.receipts.length) throw Object.assign(new Error('receipts must be a non-empty array.'), { status: 400 });
  if (body.receipts.length > 200) throw Object.assign(new Error('At most 200 receipts per run.'), { status: 400 });
  const batchId = str(body.batchId) || 'b_' + Date.now().toString(36);
  return { batchId, mode, receipts: body.receipts };
}

// Main loop. env gives D1 for locks; deps.lookup can be swapped in tests.

const PR1_DATE_OUTLIER_MODULE = '../../../tillroll/receipt-rules.js';
const PR1_DATE_OUTLIER_NAME = 'checkBatchDateOutliers';
export async function loadPr1BatchDateOutlierCheck() {
  try {
    const mod = await import(PR1_DATE_OUTLIER_MODULE);
    if (typeof mod[PR1_DATE_OUTLIER_NAME] === 'function') return mod[PR1_DATE_OUTLIER_NAME];
  } catch {
    // receipt-rules.js is not on this branch yet, or the export has not landed.
  }
  return null;
}
export async function maybeApplyPr1BatchDateOutlierCheck(units, trail, deps = {}, locked = () => false) {
  const fn = typeof deps.checkBatchDateOutliers === 'function'
    ? deps.checkBatchDateOutliers
    : await loadPr1BatchDateOutlierCheck();
  if (typeof fn !== 'function') {
    trail?.push({ stage: 'pr1-batch-date-outlier', applied: false, reason: 'PR #1 checkBatchDateOutliers not available yet' });
    return null;
  }
  try {
    const now = deps.now instanceof Date ? deps.now : new Date();
    const result = fn(units, { now });
    trail?.push({ stage: 'pr1-batch-date-outlier', applied: true, name: PR1_DATE_OUTLIER_NAME });
    if (!Array.isArray(result)) return result;
    for (const item of result) {
      const field = item.field || '采购时间';
      if (field !== '采购时间') continue;
      const row = (units || []).find(r => r.rowId === item.rowId);
      if (!row || !item.reason) continue;
      if (locked(row.rowId, field)) continue;
      addFlag(row, field, item.flag || PINK, item.reason);
    }
    return result;
  } catch (err) {
    trail?.push({ stage: 'pr1-batch-date-outlier', applied: false, error: String(err?.message || err) });
    return null;
  }
}

export async function runSanity(env, input, deps = {}) {
  const { batchId, mode } = input;
  const trail = [];
  const locks = new Set();
  // Round 2: persist cleared fills as permanent locks before anything else.
  if (env?.DB) {
    for (const r of input.receipts) for (const it of r.items || []) for (const col of it.clearedCols || []) {
      if (!COLUMNS.includes(col) || !it.rowId) continue;
      await env.DB.prepare('INSERT OR IGNORE INTO human_verified_unflagged (row_id, col_key, verified_at) VALUES (?,?,?)').bind(String(it.rowId), col, nowIso()).run();
    }
  }
  const receipts = [];
  for (let i = 0; i < input.receipts.length; i++) {
    const source = input.receipts[i];
    const receiptKey = await receiptKeyFor(source, batchId, i);
    const settled = mode === 'round2' && (source.items || []).length > 0 && (source.items || []).every(it => it.unitSettled || (it.rowId && !(Number(it.qty) > 1)));
    const expanded = expandReceipt({
      ...source, receiptKey,
      items: (source.items || []).map(it => ({ ...it, rawUnitPrice: it?.unitPrice, rawAmount: it?.amount })),
    }, { settled });
    for (const it of expanded.items) {
      const src = (source.items || []).find((line, i) => (line.lineIndex ?? i) === it.lineIndex);
      if (src?.flagReasons) it.flagReasons = { ...src.flagReasons, ...it.flagReasons };
      // expandReceipt keeps the priced columns and drops reader labels. Put them back
      // so a concessionCode, a Harrods 4+10 line, and a non-numeric price are still visible.
      if (!src) continue;
      it.concessionCode = src.concessionCode ?? null;
      it.internalCode = src.internalCode ?? null;
      it.ean = src.ean ?? null;
      it.styleRef = src.styleRef ?? null;
      if (Object.prototype.hasOwnProperty.call(src, 'brandItemId')) it.brandItemId = src.brandItemId;
      if (src.brandItemIdSource !== undefined) it.brandItemIdSource = src.brandItemIdSource;
      if (src.brandItemIdFlag !== undefined) it.brandItemIdFlag = src.brandItemIdFlag;
      if (src.brandItemIdReason !== undefined) it.brandItemIdReason = src.brandItemIdReason;
      if (src.exportMeta) it.exportMeta = src.exportMeta;
      if (src.sourceUrls) it.sourceUrls = src.sourceUrls;
      it.itemId = src.itemId ?? it.itemId;
      it.sku = src.sku ?? it.sku;
      it.rawUnitPrice = src.unitPrice;
      it.rawAmount = src.amount;
      for (const k of LINE_ID_FIELDS) if (it[k] == null && src[k] != null) it[k] = src[k];
      it.priceNotNumeric = src.priceNotNumeric || (src.unitPrice != null && src.unitPrice !== '' && isNumericPrice(src.unitPrice) === false)
        || (src.amount != null && src.amount !== '' && isNumericPrice(src.amount) === false);
    }
    const fromItems = settled ? [] : (source.items || []).flatMap((it, i) => isConfirmedZero(it) ? [zeroRecord(receiptKey, it, i, source)] : []);
    const fromPayload = Array.isArray(source.excludedZero) ? source.excludedZero.map(z => zeroRecord(z.receiptKey || receiptKey, z, z.lineIndex ?? 0, source)) : [];
    receipts.push({ ...source, receiptKey, items: expanded.items, _unitAudit: expanded.audit, _excludedBySplit: expanded.excludedZero, _carriedZero: fromItems.length ? fromItems : fromPayload });
  }
  const rowIds = receipts.flatMap(r => (r.items || []).map(it => it.rowId).filter(Boolean));
  if (env?.DB && rowIds.length) {
    for (let k = 0; k < rowIds.length; k += 90) {
      const chunk = rowIds.slice(k, k + 90);
      const res = await env.DB.prepare(`SELECT row_id, col_key FROM human_verified_unflagged WHERE row_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
      for (const l of res.results || []) locks.add(`${l.row_id}\u0000${l.col_key}`);
    }
  }
  const memo = new Map();
  const ctx = {
    mode, lookupsUsed: 0, paused: new Set(),
    formatTable: getBrandItemIdFormat(deps.brandItemIdFormat),
    brandIdFormat: typeof deps.brandIdFormat === 'function' ? deps.brandIdFormat : matchBrandIdFormat,
    locked: (rowId, col) => locks.has(`${rowId}\u0000${col}`),
    callLookup: async req => {
      const k = JSON.stringify(req);
      if (memo.has(k)) return memo.get(k);
      ctx.lookupsUsed++;
      let res;
      try { res = await (deps.lookup || defaultLookup)(env, req, deps); } catch (e) { res = { candidates: [], unavailableReason: e.message }; }
      memo.set(k, res);
      return res;
    },
  };
  // Round 2: invalidate cache for edited 品牌货号 and set the skip gate.
  const state = { excludedZero: receipts.flatMap(r => (r._carriedZero && r._carriedZero.length) ? r._carriedZero : (r._excludedBySplit || [])) };
  let allRows = [];
  for (const r of receipts) {
    const rows = readerStage(r, 0, state, ctx);
    const byId = new Map((r.items || []).filter(it => it.rowId).map(it => [it.rowId, it]));
    const byLine = new Map((r.items || []).map((it, i) => [it.lineIndex ?? i, it]));
    for (const row of rows) {
      const it = byId.get(row.rowId) || byLine.get(row.lineIndex) || {};
      if (mode === 'round2') {
        const edited = new Set(it.editedCols || []);
        if (edited.has('品牌货号') && it.previousItemId) {
          await invalidate(env, { brand: row.raw?.printedBrand || row.cells['品牌'], itemId: row.cells['品牌货号'], previousItemId: it.previousItemId, price: row.cells['采购商品原价'], currency: row.raw?.currency || r.currency, name: row.cells['品名'], style: row.raw?.style, supplier: row.cells['供应商'], storeClues: r.storeClues });
        }
        const complete = row.cells['品牌'] && row.cells['品名'] && typeof row.cells['采购商品原价'] === 'number';
        const verified = ['品牌', '品名', '采购商品原价'].every(col => !(it.flaggedCols || []).includes(col) || ctx.locked(row.rowId, col) || (it.clearedCols || []).includes(col));
        row.skipLookup = Boolean(complete && verified && !edited.has('品牌货号'));
        row.previous = it.previousCells || null;
        row._baselineFlags = it.baselineFlags || null;
        row._baselineFlagReasons = it.baselineFlagReasons || {};
        row._editedCols = edited;
        row._clearedCols = new Set(it.clearedCols || []);
        row._baselineConfidence = it.baselineConfidence ?? null;
        row._baselineSourceUrls = it.baselineSourceUrls || [];
        row._baselineMatchType = it.baselineMatchType || null;
        for (const col of it.clearedCols || []) locks.add(`${row.rowId}\u0000${col}`);
      }
    }
    await verifierStage(rows, r, ctx);
    allRows.push(...rows);
  }
  await maybeApplyPr1BatchDateOutlierCheck(allRows, trail, deps, ctx.locked);
  readerReview(allRows, trail);
  let iterations = 0, issues = [];
  do {
    iterations++;
    issues = excelAudit(allRows, ctx);
    trail.push({ stage: 'excel-audit', iteration: iterations, issues: issues.length });
    if (issues.length) applyFixes(allRows, issues);
  } while (issues.length && iterations < MAX_ITERATIONS);
  const finalIssues = excelAudit(allRows, ctx);
  const readingErrors = [], lookupUncertainties = [];
  const agreedRows = allRows.map(row => {
    const round2Changed = row.previous ? COLUMNS.filter(col => row.previous[col] !== undefined && row.previous[col] !== row.cells[col]) : [];
    // Cells the look-up changed in Round 2 are Amber, and never over a human lock.
    if (mode === 'round2') for (const col of round2Changed) {
      if (ctx.locked(row.rowId, col)) { delete row.flags[col]; continue; }
      // P5: an exact item-id and price match leaves 品名 with no fill, even when the official name changed.
      if (col === '品名' && row._exactIdPrice) continue;
      if (!row.flags[col]) { row.flags[col] = AMBER; row._lookup.push({ col, reason: 'Changed in Round 2.' }); }
    }
    if (row._exactIdPrice && row.flags['品名'] === AMBER && !ctx.locked(row.rowId, '品名')) delete row.flags['品名'];
    if (mode === 'round2') restoreBaselineFlags(row, ctx);
    noteChanel(row, []);
    applyExportGate(row, ctx);
    const flagReasons = {};
    const pendingOwnerConfirmation = {};
    for (const e of row._reading) if (row.flags[e.col]) flagReasons[e.col] = e.reason;
    for (const e of row._lookup) if (row.flags[e.col]) flagReasons[e.col] = e.reason;
    for (const e of [...row._reading, ...row._lookup]) if (e.pendingOwnerConfirmation && row.flags[e.col]) pendingOwnerConfirmation[e.col] = true;
    for (const e of row._reading) if (row.flags[e.col]) readingErrors.push({ rowId: row.rowId, col: e.col, reason: e.reason });
    for (const e of row._lookup) if (row.flags[e.col]) lookupUncertainties.push({ rowId: row.rowId, col: e.col, reason: e.reason, confidence: e.confidence ?? row.lookup?.confidence ?? null, sourceUrls: e.sourceUrls || row.lookup?.sourceUrls || [], estimated: Boolean(e.estimated || row.estimated), ...(e.candidates ? { candidates: e.candidates } : {}), ...(e.mismatches || row.mismatches?.length ? { mismatches: e.mismatches || row.mismatches } : {}) });
    const exportMeta = {
      discountKind: row.discountKind || 'none',
      currency: row.raw?.currency || 'GBP',
      matchType: row.lookup?.matchType || row._baselineMatchType || null,
      confidence: row.lookup?.confidence ?? row._baselineConfidence ?? null,
      sourceUrls: (row.lookup?.sourceUrls && row.lookup.sourceUrls.length) ? row.lookup.sourceUrls : (row._baselineSourceUrls || []),
      candidates: row._candidates,
      alternates: row._alternates || {},
      comments: row._comments || {},
      officialBranch: row._officialBranch || null,
      flagReasons,
      gateNotes: row._gateNotes || null,
      brandItemId: row.raw?.builder ? (row.raw.builder.id ?? null) : (row.brandItemId ?? row.cells['品牌货号'] ?? null),
      brandItemIdSource: row.raw?.builder?.source ?? row.brandItemIdSource ?? null,
      brandItemIdFlag: row.raw?.builder?.flag ?? row.brandItemIdFlag ?? row.flags['品牌货号'] ?? null,
      brandItemIdReason: row.raw?.builder?.reason ?? row.brandItemIdReason ?? flagReasons['品牌货号'] ?? null,
      pendingOwnerConfirmation: Object.keys(pendingOwnerConfirmation).length ? pendingOwnerConfirmation : null,
      storeClues: row.storeClues || null,
    };
    const brandItemId = exportMeta.brandItemId ?? null;
    const brandItemIdSource = exportMeta.brandItemIdSource ?? null;
    const brandItemIdFlag = exportMeta.brandItemIdFlag ?? null;
    const brandItemIdReason = exportMeta.brandItemIdReason ?? null;
    return { rowId: row.rowId, receiptKey: row.receiptKey, lineIndex: row.lineIndex, unitIndex: row.unitIndex ?? 0, unitCount: row.unitCount, cells: row.cells, flags: row.flags, flagReasons, notes: row.notes,
      lookup: row.lookup, estimated: Boolean(row.estimated), mismatches: row.mismatches || [],
      brandItemId, brandItemIdSource, brandItemIdFlag, brandItemIdReason,
      exportMeta, ...(mode === 'round2' ? { round2Changed } : {}) };
  });
  state.excludedZero = dedupeZero(state.excludedZero);
  const result = { agreedRows, excludedZero: state.excludedZero, excludedZeroCount: state.excludedZero.length, readingErrors, lookupUncertainties, workbookExportReady: finalIssues.length === 0 };
  if (ctx.paused.size) { result.lookupsPaused = true; result.pausedReasons = [...ctx.paused]; }
  return { result, audit: { batchId, mode, iterations, trail, excludedZero: state.excludedZero, lookupsUsed: ctx.lookupsUsed } };
}
