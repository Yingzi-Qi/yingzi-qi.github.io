// Server-side review loop behind /api/sanity-run. Encodes the Operating Manual
// roles (Reader & Sanity Checker -> Look-up Verifier -> Reader cross-check ->
// Excel Sync audit) and iterates until the audit converges. Only the final
// agreed version leaves this module; the internal trail is stored in D1 only.
import { canonicalBrand, brandSearchPhrases, CHANEL_FALLBACK_NOTE } from './brands.js';
import { chooseItemId, isConcessionCode, matchesBrandItemId } from '../../../tillroll/brand-item-ids.js';
import { lookup as defaultLookup, invalidate, priceFallbackIsTie, isExactOfficialIdPriceMatch } from './lookup.js';
import { nowIso, sha256Hex } from './http.js';
import { expandReceipt, joinPurchaseTime, supplierVisibleName } from '../../../tillroll/units.js';
import { isGtin } from '../../../tillroll/product-code.js';
import { sortItemFields, isNumericPrice } from '../../../tillroll/field-sorter.js';

export const COLUMNS = ['采购小票id', '采购时间', '供应商', '品牌', '品名', '品牌货号', '采购商品原价', '采购商品金额', '采购商品方法', '销售金额'];
export const PINK = '#FECDD3', AMBER = '#FDE68A';
const MAX_LOOKUPS_PER_RUN = 60, MAX_ITERATIONS = 3;
const str = v => (v === undefined || v === null || String(v).trim() === '') ? null : String(v).trim();
const num = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[£$€,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;

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
// P4 (Yingzi approved): card schemes and wallets (Apple/Google/Samsung/Garmin Pay,
// or the word "wallet"), with or without a printed scheme, map to Card with no flag.
// Cash, PayPal, Klarna, gift card or empty: keep as printed or null, Pink, TENDER_REASON.
export const TENDER_VALUES = ['UnionPay', 'Card', 'Alipay', 'WeChat'];
export const ALLOWED_TENDERS = TENDER_VALUES;
export const TENDER_REASON = 'Payment method must be UnionPay, Card, Alipay or WeChat.';
const SCHEME = /\b(visa|mastercard|master\s*card|maestro|amex|american express|carte\s*(?:bleue|bancaire)|debit|credit|card)\b/i;
const WALLET = /\b(apple\s*pay|google\s*pay|samsung\s*pay|garmin\s*pay|android\s*pay|wallet)\b/i;
export function normaliseTender(p) {
  const s = str(p);
  if (!s) return null;
  if (/union\s*pay|银联/i.test(s)) return 'UnionPay';
  if (/ali\s*pay|支付宝/i.test(s)) return 'Alipay';
  if (/we\s*chat|weixin|微信/i.test(s)) return 'WeChat';
  // Gift card must not be swallowed by the bare "card" scheme token.
  if (/\bgift\s*card\b|\bgift\s*voucher\b/i.test(s)) return s;
  if (SCHEME.test(s) || WALLET.test(s)) return 'Card';
  return s;
}
const BARCODE_SHAPE = /^(?:\d{8}|\d{12,14})$/;
const STORE_INTERNAL = /^(?:\d{4}|\d{10}|9999999\d*)$/; // concession 4-digit, 10-digit store-internal, 9999999… family
const CONCESSION_PREFIX = /^(?:harrods|selfridges|harvey\s*nichols|\bhn\b|concession|dept(?:artment)?(?:\s*store)?)[-_\s.]/i;
export function isBarcodeOrEan(value) {
  const s = str(value);
  if (!s) return false;
  const compact = s.replace(/[\s-]/g, '');
  return isGtin(compact) || BARCODE_SHAPE.test(compact);
}
export function isConcessionOrStoreCode(value, item = {}) {
  const s = str(value);
  if (!s) return false;
  const compact = s.replace(/\s+/g, '');
  if (item.concessionCode && str(item.concessionCode) === s) return true;
  if (item.storeSku && str(item.storeSku) === s) return true;
  if (item.retailerSku && str(item.retailerSku) === s) return true;
  if (item.departmentCode && str(item.departmentCode) === s) return true;
  if (item.concession === true && (s === str(item.itemId) || s === str(item.sku))) return true;
  if (STORE_INTERNAL.test(compact)) return true;
  return CONCESSION_PREFIX.test(s);
}

// Never use a concession 4-digit code or 9999999xxx as 品牌货号, whatever the label.
export function isForbiddenBrandItemCode(value, item = {}) {
  const s = str(value);
  if (!s) return false;
  const compact = s.replace(/[\s-]/g, '');
  if (/^\d{4}$/.test(compact) || /^9999999\d*$/.test(compact) || /^\d{10}$/.test(compact)) return true;
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
  // Recover the capture from the printed string so we do not rewrite its spelling.
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
  if (!pattern) return true;
  return pattern.test(str(value)) || pattern.test(compactId(value));
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

// Per-row 品牌货号. The receipt is the source of truth:
// 1) a printed style ref / brand product code that fits the brand format table is kept
//    (flag null if the official ID matches / P5; Amber 'official site shows <X>' if it differs);
// 2) only when no such printed code exists, the official look-up ID (Amber unless P5 exact);
// 3) EAN (Amber);
// 4) empty + Pink.
export function resolveBrandItemId({ item = {}, brand, officialItemId, exactOfficial = false, formatTable } = {}) {
  const table = getBrandItemIdFormat(formatTable);
  const officialRaw = str(officialItemId);
  const official = officialRaw && !isForbiddenBrandItemCode(officialRaw, item)
    ? (stripBrandFromItemId(officialRaw, brand) || officialRaw)
    : null;
  const usableOfficial = official && !isForbiddenBrandItemCode(official, item) ? official : null;
  const cand = readerBrandItemIdCandidate(item, brand);
  const styleLike = cand && (cand.source === 'styleRef' || cand.source === 'brandProductCode') ? cand : null;
  const fitting = styleLike && fitsBrandItemIdFormat(brand, styleLike.value, table) ? styleLike : null;

  if (fitting) {
    const idsMatch = Boolean(usableOfficial && compactId(usableOfficial) === compactId(fitting.value));
    if (usableOfficial && !idsMatch) {
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
  // A printed style / brand code that does not fit (or cannot be confirmed) is
  // kept exactly as printed and flagged Pink. Alternatives (OCR I/1, O/0, or
  // an official ID) go in the comment/reason only — never into the cell.
  if (styleLike) {
    const rawPrinted = styleLike.printed || styleLike.value;
    const alternative = suggestedPrintedCodeAlternative(rawPrinted, brand, table)
      || suggestedPrintedCodeAlternative(styleLike.value, brand, table)
      || usableOfficial
      || null;
    return {
      brandItemId: rawPrinted,
      brandItemIdSource: styleLike.source,
      flag: PINK,
      reason: printedValueKeptReason(alternative),
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
  if (cand && cand.source === 'ean') {
    return {
      brandItemId: cand.value,
      brandItemIdSource: 'ean',
      flag: AMBER,
      reason: 'EAN used as 品牌货号; not a brand style ref.',
    };
  }
  const raw = [item.styleRef, item.style, item.sku, item.itemId, item.ean, item.barcode, item.concessionCode, item.storeSku]
    .map(str).filter(Boolean);
  const concession = raw.some(c => isForbiddenBrandItemCode(c, item));
  return {
    brandItemId: null,
    brandItemIdSource: null,
    flag: PINK,
    reason: concession ? 'Department-store or concession code, not a brand item ID.' : 'No brand item ID.',
  };
}
export function chooseBrandItemId(item = {}, brand, formatTable) {
  return resolveBrandItemId({ item, brand, formatTable }).brandItemId;
}

function applyBrandItemIdRecord(row, rec, { replaceFlag = false } = {}) {
  row.brandItemId = rec.brandItemId ?? null;
  row.brandItemIdSource = rec.brandItemIdSource ?? null;
  row.brandItemIdFlag = rec.flag ?? null;
  row.brandItemIdReason = rec.reason ?? null;
  row.cells['品牌货号'] = rec.brandItemId ?? null;
  if (replaceFlag) {
    delete row.flags['品牌货号'];
    row._reading = (row._reading || []).filter(e => e.col !== '品牌货号');
    row._lookup = (row._lookup || []).filter(e => e.col !== '品牌货号');
  }
  if (rec.flag && rec.reason) addFlag(row, '品牌货号', rec.flag, rec.reason);
  if (rec.reason) {
    if (!row._comments) row._comments = {};
    if (!row._comments['品牌货号']) row._comments['品牌货号'] = rec.reason;
  }
}

function prepareReceiptForSplit(source, receiptKey) {
  return {
    ...source,
    receiptKey,
    discount: source.discount ?? source.receiptDiscount ?? source.totalDiscount ?? null,
    items: (source.items || []).map(it => ({
      ...it,
      unitDiscount: it.unitDiscount ?? it.discountEach ?? it.perItemDiscount ?? it.itemDiscount,
      priceNotNumeric: (it.unitPrice != null && it.unitPrice !== '' && isNumericPrice(it.unitPrice) === false)
        || (it.amount != null && it.amount !== '' && isNumericPrice(it.amount) === false),
    })),
  };
}

// units.js expandReceipt copies only sku/itemId (PR #4). Reattach the brand-owned
// identifiers P1 needs so chooseBrandItemId still sees styleRef / barcodes / concession marks.
const LINE_ID_FIELDS = ['styleRef', 'style', 'barcode', 'ean', 'gtin', 'upc', 'productId',
  'concessionCode', 'storeSku', 'retailerSku', 'departmentCode', 'concession', 'priceNotNumeric'];
function reattachLineIdentifiers(expandedItems, originalItems) {
  return (expandedItems || []).map(it => {
    const src = originalItems[it.lineIndex] || originalItems[0] || {};
    const extra = {};
    for (const k of LINE_ID_FIELDS) if (it[k] == null && src[k] != null) extra[k] = src[k];
    return Object.keys(extra).length ? { ...it, ...extra } : it;
  });
}

function addFlag(row, col, colour, reason, extra = {}) {
  const prev = row.flags[col];
  // Mixed reading + look-up uncertainty is Amber (manual 7E.19).
  row.flags[col] = prev && prev !== colour ? AMBER : colour;
  (colour === PINK ? row._reading : row._lookup).push({ col, reason, ...extra });
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
function readerStage(receipt, rIndex, state, formatTable) {
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
    if (confirmedZero) { state.excludedZero.push({ receiptKey: receipt.receiptKey, lineIndex, name: str(it.item) }); return; }
    const sorted = sortItemFields({ brand: str(it.brand), name: str(it.item), itemId: str(it.itemId) }, { canonicalBrand, phrases: brandSearchPhrases() });
    const brandRaw = str(sorted.brand);
    const itemName = str(sorted.name);
    const printedId = stripBrandFromItemId(it.itemId ?? it.sku, brandRaw);
    const chosenId = chooseItemId({ brand: brandRaw, fields: { itemId: it.itemId, sku: it.sku, item: it.item, name: it.name, allowEan: true } });
    const itemCell = chosenId || (printedId && !isConcessionCode(printedId) ? printedId : null);
    const unitCount = it.unitCount || (receipt.items || []).filter(x => (x.lineIndex ?? 0) === lineIndex).length || 1;
    const row = { rowId: it.rowId || `${receipt.receiptKey}:${lineIndex}:u${it.unitIndex ?? 0}`, receiptKey: receipt.receiptKey, lineIndex,
      unitIndex: it.unitIndex ?? 0, unitCount, discountKind: it.discountKind || 'none', estimated: it.estimated === true || it.discountKind === 'estimated',
      flags: {}, notes: [], _reading: [], _lookup: [], lookup: null,
      cells: { '采购小票id': receiptId, '采购时间': ts, '供应商': merchant, '品牌': brandRaw, '品名': itemName, '品牌货号': null,
        '采购商品原价': unit ?? (amount !== null ? round2((amount + discount) / (qty || 1)) : null), '采购商品金额': amount, '采购商品方法': tender, '销售金额': null },
      raw: { style: str(it.sku) !== str(it.itemId) ? str(it.sku) : null, colour: str(it.colour), size: str(it.size), qty, currency: str(receipt.currency),
        amount, lineDiscount: num(it.lineDiscount ?? it.discount), unitDiscount: num(it.unitDiscount ?? it.perItemDiscount ?? it.itemDiscount) },
      _brandIdItem: it };
    if (!receiptId) addFlag(row, '采购小票id', PINK, /selfridges/i.test(merchant || '') ? 'Selfridges receipt number (below the barcode) not read.' : /harrods/i.test(merchant || '') ? 'Harrods receipt number (right of date/time) not read.' : 'Receipt ID not read.');
    if (!ts) addFlag(row, '采购时间', PINK, 'Date/time missing or not a valid date.');
    if (!merchant) addFlag(row, '供应商', PINK, 'Supplier not read.');
    if (!row._comments) row._comments = {};
    if (!tender || !ALLOWED_TENDERS.includes(tender)) {
      addFlag(row, '采购商品方法', PINK, TENDER_REASON);
      row._comments['采购商品方法'] = TENDER_REASON;
    }
    const brandId = resolveBrandItemId({ item: it, brand: brandRaw, formatTable });
    applyBrandItemIdRecord(row, brandId);
    row._readerChosenId = itemCell || null;
    if (!row.cells['品名'] || JUNK_NAME.test(row.cells['品名']) || sorted.junk || !sorted.nameHasNonBrandWord) {
      const why = sorted.codePlusBrand ? 'is only a product code plus the brand'
        : sorted.brandOnly || (sorted.junk && !row.cells['品名']) ? 'has no non-brand word'
        : JUNK_NAME.test(row.cells['品名'] || '') ? 'failed the column sanity check'
        : 'has no non-brand word';
      addFlag(row, '品名', PINK, `Item name "${row.cells['品名'] ?? str(it.item) ?? ''}" ${why}.`);
    }
    if (sorted.brandMoved) addFlag(row, '品牌', PINK, 'Brand was empty and was taken from the item name.');
    const idp = itemIdProblem(row.cells['品牌货号']);
    if (idp) addFlag(row, '品牌货号', PINK, `Item ID ${idp}.`);
    if ((it.fieldIssues || []).some(f => /itemid/i.test(f))) addFlag(row, '品牌货号', PINK, 'Reader marked the item ID as uncertain.');
    if (it.priceNotNumeric) addFlag(row, unit === null ? '采购商品原价' : '采购商品金额', PINK, 'Price is not numeric.');
    else if (unit === null && amount === null) addFlag(row, '采购商品原价', PINK, 'No price read.');
    else if (unit === null) addFlag(row, '采购商品原价', PINK, 'Unit price not printed; derived from line amount.');
    if ((zeroUnit || zeroAmt) && row.flags['采购商品原价'] !== PINK) addFlag(row, '采购商品原价', PINK, 'Doubtful 0 price: may be an OCR miss.');
    if (amount === null) addFlag(row, '采购商品金额', PINK, 'Line amount not read.');
    else if (unit !== null && Math.abs(qty * unit - discount - amount) > 0.02 && Math.abs(qty * unit - amount) > 0.02) addFlag(row, '采购商品金额', PINK, `qty × unit price − discount (${round2(qty * unit - discount)}) does not match amount (${amount}).`);
    for (const col of it.readingFlags || []) if (COLUMNS.includes(col)) addFlag(row, col, PINK, 'Flagged by the reader.');
    if (row.estimated && typeof row.cells['采购商品金额'] === 'number') {
      addFlag(row, '采购商品金额', AMBER, 'Discount allocated proportionally from a line or receipt total (not printed per unit).', { estimated: true });
    }
    rows.push(row);
  });
  return rows;
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
    const visible = supplierVisibleName(printedSupplier, name);
    for (const row of rows) row._officialBranch = name || null;
    if (visible && visible !== printedSupplier) for (const row of rows) {
      if (ctx.locked(row.rowId, '供应商')) continue;
      noteMismatch(row, '供应商', printedSupplier, visible, visible === name ? 'official' : 'receipt');
      row.cells['供应商'] = visible;
      addFlag(row, '供应商', AMBER, 'Official UK branch name from look-up.', { sourceUrls: res.branch.sourceUrls || [] });
    }
  }
  void canon;
  for (const row of rows) {
    const c = row.cells;
    // Brand expansion is applied after /api/lookup via official mismatches (receipt value kept in the request).
    // Review the Reader first: do not burn quota on suspect input.
    if (row.flags['品牌货号'] === PINK || (row.flags['采购商品原价'] === PINK && !c['品牌货号'])) { row.notes.push('Look-up held until the reading error is fixed.'); continue; }
    if (ctx.mode === 'round2' && row.skipLookup) continue;
    if (!c['品牌货号'] && !c['品名']) continue;
    if (ctx.lookupsUsed >= MAX_LOOKUPS_PER_RUN) { addFlag(row, '品名', AMBER, 'Look-up deferred: per-run cap reached.'); continue; }
    // PR #3: look up with the reader-chosen id (EAN when the printed code
    // does not fit the brand table). The printed cell is not overwritten.
    const printedFits = Boolean(c['品牌货号'] && matchesBrandItemId(c['品牌'], c['品牌货号']));
    const lookupItemId = printedFits ? c['品牌货号'] : (row._readerChosenId || c['品牌货号']);
    const req = { brand: c['品牌'], itemId: lookupItemId, name: c['品名'], style: row.raw.style, price: c['采购商品原价'], currency: row.raw.currency };
    const res = await ctx.callLookup(req);
    if (!res) continue;
    if (res.paused || res.unavailableReason) {
      if (!res.candidates?.length) { addFlag(row, '品名', AMBER, `Look-up paused: ${res.unavailableReason || 'quota guard reached'}.`); ctx.paused.add(res.unavailableReason || 'quota guard'); continue; }
    }
    const top = res.candidates?.[0];
    row.lookup = { cacheKey: res.cacheKey, matchType: top?.matchType || null, confidence: top?.confidence ?? null, sourceUrls: top?.sourceUrls || [] };

    if (!top) { addFlag(row, '品名', AMBER, 'No official match found; values kept as printed.'); continue; }
    if (top.matchType === 'multi-field') {
      const ties = res.candidates.filter(x => x.matchType === 'multi-field' && x.matchedFields.length === top.matchedFields.length && x.confidence === top.confidence);
      if (ties.length > 1) {
        addFlag(row, '品名', AMBER, 'Several official items match equally well. Pick one.', { candidates: ties.map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, sourceUrls: x.sourceUrls })) });
        continue;
      }
    }
    if (top.matchType === 'price-fallback') {
      const list = (res.candidates || []).map(x => ({ officialName: x.officialName, itemId: x.itemId, price: x.price, weightGrams: x.weightGrams ?? null, sourceUrls: x.sourceUrls, mismatches: x.mismatches || [] }));
      row._candidates = list;
      row.notes.push(top.weightGrams !== null ? `Closest-price fallback; lightest published weight ${top.weightGrams} g.` : 'Closest-price fallback.');
      if (!ctx.locked(row.rowId, '品名')) {
        addFlag(row, '品名', AMBER, 'Item ID matched nothing; closest-price fallback. Review the candidate list.', { candidates: list });
      }
      // No published weight and no other rank separator: do not guess 品名.
      if (priceFallbackIsTie({ brand: c['品牌'], itemId: c['品牌货号'], name: row.previousName || c['品名'], style: row.raw?.style, price: c['采购商品原价'], currency: row.raw?.currency }, res.candidates)) {
        row._skipOfficialName = true;
      }
    }
    // Receipt is the source of truth for price and item ID. Brand/name take the official value on a mismatch.
    const mismatches = res.mismatches || [];
    row.mismatches = mismatches;
    row.lookup.mismatches = mismatches;
    if (res.sourceNote) row.lookup.sourceNote = res.sourceNote;
    const chanelFallback = Boolean(res.sourceNote === CHANEL_FALLBACK_NOTE || (mismatches || []).some(m => m.field === 'source' && m.reason === CHANEL_FALLBACK_NOTE));
    const exactOfficial = isExactOfficialIdPriceMatch(req, top);
    const p5Exact = exactOfficial && !chanelFallback;
    for (const m of mismatches) {
      if (m.field === 'source') {
        row.notes.push(m.reason || res.sourceNote);
        continue;
      }
      if (m.field === 'brand' && !ctx.locked(row.rowId, '品牌')) {
        noteMismatch(row, '品牌', c['品牌'], m.officialValue, 'official');
        c['品牌'] = m.officialValue;
        if (!p5Exact) addFlag(row, '品牌', AMBER, `Receipt brand "${m.receiptValue ?? ''}" vs official "${m.officialValue}".`, { confidence: top.confidence, sourceUrls: top.sourceUrls, mismatches });
      } else if (m.field === 'name' && !ctx.locked(row.rowId, '品名')) {
        noteMismatch(row, '品名', c['品名'], m.officialValue, row._skipOfficialName ? 'receipt' : 'official');
        if (!row._skipOfficialName) { row.previousName = c['品名']; c['品名'] = m.officialValue; }
        if (!p5Exact) addFlag(row, '品名', AMBER, `Receipt name "${m.receiptValue ?? ''}" vs official "${m.officialValue}".`, { confidence: top.confidence, sourceUrls: top.sourceUrls, mismatches });
      } else if (m.field === 'price' && !ctx.locked(row.rowId, '采购商品原价')) {
        if (m.reason === 'official price unavailable' || m.officialValue === null || m.officialValue === undefined) {
          addFlag(row, '采购商品原价', AMBER, 'official price unavailable', { confidence: top.confidence, sourceUrls: top.sourceUrls, mismatches });
        } else {
          noteMismatch(row, '采购商品原价', m.receiptValue, m.officialValue, 'receipt');
          addFlag(row, '采购商品原价', AMBER, `Receipt price ${m.receiptValue} vs official ${m.officialValue}; receipt value kept.`, { confidence: top.confidence, sourceUrls: top.sourceUrls, mismatches });
        }
      }
      // itemId mismatches are resolved below: the printed style / brand code is kept.
    }
    if (!ctx.locked(row.rowId, '品牌货号')) {
      const rec = resolveBrandItemId({ item: row._brandIdItem || {}, brand: c['品牌'], officialItemId: top.itemId, exactOfficial: p5Exact, formatTable: ctx.formatTable });
      const previous = c['品牌货号'];
      applyBrandItemIdRecord(row, rec, { replaceFlag: true });
      if (rec.reason && rec.reason.startsWith('official site shows ') && previous && top.itemId) {
        noteMismatch(row, '品牌货号', rec.brandItemId, top.itemId, 'receipt');
      }
    }
    if (chanelFallback) {
      const comment = res.sourceNote || CHANEL_FALLBACK_NOTE;
      addFlag(row, '品牌货号', AMBER, comment);
      row.brandItemIdFlag = AMBER;
      if (!row.brandItemIdReason) row.brandItemIdReason = comment;
    }
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


// TODO(PR #1): The Reader will export a pure
//   checkBatchDateOutliers(units, { now = new Date() } = {})
// returning [{ rowId, field: '采购时间', flag: '#FECDD3', reason }].
// Do NOT reimplement that function here. This hook imports that one name from
// tillroll/receipt-rules.js once #1 ships it; until then it is a no-op.
// deps.checkBatchDateOutliers may be injected in tests.
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
      // human_verified_unflagged locks must not be overwritten.
      if (locked(row.rowId, field)) continue;
      addFlag(row, field, item.flag || PINK, item.reason);
    }
    return result;
  } catch (err) {
    trail?.push({ stage: 'pr1-batch-date-outlier', applied: false, error: String(err?.message || err) });
    return null;
  }
}

// Main loop. env gives D1 for locks; deps.lookup can be swapped in tests.
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
  const state = { excludedZero: [] };
  for (let i = 0; i < input.receipts.length; i++) {
    const source = input.receipts[i];
    const receiptKey = await receiptKeyFor(source, batchId, i);
    const settled = mode === 'round2' && (source.items || []).length > 0 && (source.items || []).every(it => it.unitSettled || (it.rowId && !(Number(it.qty) > 1)));
    const prepared = prepareReceiptForSplit(source, receiptKey);
    const expanded = expandReceipt(prepared, { settled });
    state.excludedZero.push(...(expanded.excludedZero || []));
    const items = reattachLineIdentifiers(expanded.items, prepared.items || []);
    receipts.push({ ...source, ...prepared, receiptKey, items, _unitAudit: expanded.audit });
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
  const formatTable = getBrandItemIdFormat(deps.brandItemIdFormat);
  const ctx = {
    mode, lookupsUsed: 0, paused: new Set(), formatTable,
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
  let allRows = [];
  for (const r of receipts) {
    const rows = readerStage(r, 0, state, formatTable);
    const byId = new Map((r.items || []).filter(it => it.rowId).map(it => [it.rowId, it]));
    const byLine = new Map((r.items || []).map((it, i) => [it.lineIndex ?? i, it]));
    for (const row of rows) {
      const it = byId.get(row.rowId) || byLine.get(row.lineIndex) || {};
      if (mode === 'round2') {
        const edited = new Set(it.editedCols || []);
        if (edited.has('品牌货号') && it.previousItemId) await invalidate(env, { brand: row.cells['品牌'], itemId: row.cells['品牌货号'], previousItemId: it.previousItemId, price: row.cells['采购商品原价'], currency: row.raw?.currency, name: row.cells['品名'], style: row.raw?.style, supplier: row.cells['供应商'], storeClues: r.storeClues });
        const complete = row.cells['品牌'] && row.cells['品名'] && typeof row.cells['采购商品原价'] === 'number';
        const verified = ['品牌', '品名', '采购商品原价'].every(col => !(it.flaggedCols || []).includes(col) || ctx.locked(row.rowId, col) || (it.clearedCols || []).includes(col));
        row.skipLookup = Boolean(complete && verified && !edited.has('品牌货号'));
        row.previous = it.previousCells || null;
        for (const col of it.clearedCols || []) locks.add(`${row.rowId}\u0000${col}`);
      }
    }
    await verifierStage(rows, r, ctx);
    allRows.push(...rows);
  }
  // TODO(PR #1): optional checkBatchDateOutliers hook — no local reimplementation.
  await maybeApplyPr1BatchDateOutlierCheck(allRows, trail, deps, ctx.locked);
  readerReview(allRows, trail);
  // Locks apply to unit rowIds (Excel Sync lines up row for row).
  for (const row of allRows) {
    for (const col of Object.keys(row.flags || {})) if (ctx.locked(row.rowId, col)) delete row.flags[col];
  }
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
    for (const e of row._reading) if (row.flags[e.col]) readingErrors.push({ rowId: row.rowId, col: e.col, reason: e.reason });
    for (const e of row._lookup) if (row.flags[e.col]) lookupUncertainties.push({ rowId: row.rowId, col: e.col, reason: e.reason, confidence: e.confidence ?? row.lookup?.confidence ?? null, sourceUrls: e.sourceUrls || row.lookup?.sourceUrls || [], estimated: Boolean(e.estimated), ...(e.candidates ? { candidates: e.candidates } : {}), ...(e.mismatches || row.mismatches ? { mismatches: e.mismatches || row.mismatches } : {}) });
    const round2Changed = row.previous ? COLUMNS.filter(col => row.previous[col] !== undefined && row.previous[col] !== row.cells[col]) : [];
    const brandItemId = row.brandItemId ?? row.cells['品牌货号'] ?? null;
    const brandItemIdSource = row.brandItemIdSource ?? null;
    const brandItemIdFlag = row.brandItemIdFlag ?? row.flags['品牌货号'] ?? null;
    const brandItemIdReason = row.brandItemIdReason ?? null;
    const exportMeta = {
      discountKind: row.discountKind || (row.estimated ? 'estimated' : 'none'),
      currency: row.raw?.currency || null,
      matchType: row.lookup?.matchType || null,
      confidence: row.lookup?.confidence ?? null,
      sourceUrls: row.lookup?.sourceUrls || [],
      candidates: row._candidates || null,
      alternates: row._alternates || {},
      comments: row._comments || {},
      officialBranch: row._officialBranch || null,
      brandItemId, brandItemIdSource, brandItemIdFlag, brandItemIdReason,
    };
    return { rowId: row.rowId, receiptKey: row.receiptKey, lineIndex: row.lineIndex, unitIndex: row.unitIndex, unitCount: row.unitCount,
      cells: row.cells, flags: row.flags, notes: row.notes, lookup: row.lookup, estimated: Boolean(row.estimated),
      brandItemId, brandItemIdSource, brandItemIdFlag, brandItemIdReason,
      exportMeta, mismatches: row.mismatches || [], ...(mode === 'round2' ? { round2Changed } : {}) };
  });
  const result = { agreedRows, excludedZeroCount: state.excludedZero.length, readingErrors, lookupUncertainties, workbookExportReady: finalIssues.length === 0 };
  if (ctx.paused.size) { result.lookupsPaused = true; result.pausedReasons = [...ctx.paused]; }
  return { result, audit: { batchId, mode, iterations, trail, excludedZero: state.excludedZero, lookupsUsed: ctx.lookupsUsed } };
}
